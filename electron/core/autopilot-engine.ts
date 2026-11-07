import { createHash } from 'node:crypto';
import {
  MAX_SEND_CLICKS,
  errorMeta,
  nextDueAt,
  retryDelayMs,
  type AutopilotCatchUp,
  type AutopilotErrorCode,
  type AutopilotJob,
  type AutopilotRoute,
  type AutopilotRun,
  type AutopilotRunStep,
  type AutopilotSettings,
} from '../../shared/autopilot';
import type { AttachmentPreparation, AttachmentService, ResolvedAttachment } from './autopilot-attachments';
import type { AutopilotScheduler } from './autopilot-scheduler';
import type { AutopilotStore } from './autopilot-store';
import type { Logger } from './logger';

export type GuardState = 'ok' | 'capturing' | 'taken_over' | 'hot';

export interface DeliveryRequest {
  job: AutopilotJob;
  /** Prompt with the missing-attachment note already appended. */
  prompt: string;
  attachments: ResolvedAttachment[];
  settings: AutopilotSettings;
  runId: string;
  /** Milliseconds since the run started; adapters may use it for pacing. */
  elapsed: () => number;
  shouldCancel: () => boolean;
  onStep: (step: Omit<AutopilotRunStep, 't'>) => void;
}

export type DeliveryResult =
  | {
      ok: true;
      /** Set when the adapter knows which transport actually carried the prompt. */
      route?: AutopilotRoute;
    }
  | { ok: false; code: AutopilotErrorCode; message?: string; /** Do not retry the whole run. */ fatal?: boolean };

export interface TargetAdapter {
  id: string;
  deliver(request: DeliveryRequest): Promise<DeliveryResult>;
}

export interface EngineNotification {
  kind: 'sent' | 'failed' | 'deferred' | 'blocked' | 'skipped';
  job: AutopilotJob;
  run: AutopilotRun;
}

export interface AutopilotEngineOptions {
  store: AutopilotStore;
  scheduler: AutopilotScheduler;
  attachments: AttachmentService;
  adapters: Record<string, TargetAdapter>;
  /** Emergency transport used after the GUI route gives up. */
  fallback?: TargetAdapter;
  log: Logger;
  notify?: (event: EngineNotification) => void;
  /** Protection gate; returns 'ok' when automation may proceed. */
  guard?: () => GuardState;
  softStopActive?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a deferred job waits before it is retried automatically. */
  deferMs?: number;
}

interface QueuedJob {
  job: AutopilotJob;
  scheduledAt: number;
  manual: boolean;
}

const MAX_STEPS_PER_RUN = 200;

/**
 * Owns execution of scheduled deliveries. Runs live entirely in the main
 * process; no BrowserWindow reference is held, so hiding or closing the UI
 * cannot interrupt a delivery.
 */
export class AutopilotEngine {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deferMs: number;
  private readonly listeners = new Set<(runs: AutopilotRun[]) => void>();
  private queue: QueuedJob[] = [];
  private readonly cancelled = new Set<string>();
  private readonly defers = new Map<string, number>();
  private pumping = false;
  private paused = false;
  private disposed = false;
  private activeRunId: string | null = null;

  constructor(private readonly options: AutopilotEngineOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
    this.deferMs = Math.max(1000, options.deferMs ?? 5 * 60_000);
  }

  // -- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.disposed) return;
    this.paused = false;
    this.options.scheduler.start();
  }

  stop(): void {
    this.options.scheduler.stop();
    this.queue = [];
    this.options.store.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  pause(): void {
    this.paused = true;
    this.options.scheduler.stop();
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    this.options.scheduler.start();
    this.pump();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get active(): string | null {
    return this.activeRunId;
  }

  onChange(listener: (runs: AutopilotRun[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- public actions -------------------------------------------------------

  /** Fired by the scheduler. Never throws. */
  enqueue(job: AutopilotJob, scheduledAt: number, decision: AutopilotCatchUp | 'run'): void {
    if (this.disposed) return;
    if (!this.options.store.getSettings().enabled) return;
    if (decision === 'skip') {
      const run = this.createRun(job, scheduledAt, 'skipped');
      this.finish(job, run, { state: 'skipped' });
      this.advance(job);
      this.notify({ kind: 'skipped', job, run });
      return;
    }
    if (decision === 'ask') {
      const run = this.createRun(job, scheduledAt, 'deferred');
      this.patchJobStatus(job.id, 'blocked');
      this.finish(job, run, { state: 'deferred', error: { code: 'UNEXPECTED_EXCEPTION', message: 'catch-up requires confirmation' } });
      this.notify({ kind: 'blocked', job, run });
      return;
    }
    this.queue = [...this.queue.filter((entry) => !(entry.job.id === job.id && entry.scheduledAt === scheduledAt)), {
      job,
      scheduledAt,
      manual: false,
    }];
    void this.pump();
  }

  /** Manual "run now". Returns the finished run, or null when it could not start. */
  async runNow(jobId: string): Promise<AutopilotRun | null> {
    const job = this.options.store.getJob(jobId);
    if (!job) return null;
    const scheduledAt = this.now();
    this.options.scheduler.release(job.id);
    return this.execute(job, scheduledAt, true);
  }

  /** Run currently being executed, if any. */
  activeRun(): string | null {
    return this.activeRunId;
  }

  cancelRun(runId: string): boolean {
    if (!this.options.store.getRun(runId)) return false;
    this.cancelled.add(runId);
    return true;
  }

  /** Wakes deferred jobs early; called when the protection gate clears. */
  resumeDeferred(): void {
    for (const [jobId] of this.defers) {
      this.defers.delete(jobId);
      this.options.scheduler.release(jobId);
    }
    this.pump();
  }

  // -- queue ----------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed || this.paused) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const next = this.queue[0];
        const holdUntil = this.defers.get(next.job.id) ?? 0;
        if (holdUntil > this.now()) {
          this.queue = this.queue.slice(1);
          continue;
        }
        this.queue = this.queue.slice(1);
        const job = this.options.store.getJob(next.job.id) ?? next.job;
        if (!job.enabled) continue;
        if (this.skipForGuard(job, next.scheduledAt)) continue;
        await this.execute(job, next.scheduledAt, next.manual);
      }
    } finally {
      this.pumping = false;
    }
  }

  private skipForGuard(job: AutopilotJob, scheduledAt: number): boolean {
    const guard = this.options.guard?.() ?? 'ok';
    if (guard !== 'ok') {
      this.defer(job, scheduledAt, 'PROTECTION_DEFERRED');
      return true;
    }
    if (this.options.softStopActive?.()) {
      this.defer(job, scheduledAt, 'SOFT_STOP_INTERCEPT');
      return true;
    }
    return false;
  }

  // -- execution ------------------------------------------------------------

  private async execute(job: AutopilotJob, scheduledAt: number, manual: boolean): Promise<AutopilotRun> {
    const settings = this.options.store.getSettings();
    const runId = manual ? `${job.id}:manual:${scheduledAt}` : `${job.id}:${scheduledAt}`;
    const existing = this.options.store.getRun(runId);
    if (existing && (existing.state === 'sent' || existing.state === 'failed')) return existing;

    let run = existing ?? this.createRun(job, scheduledAt, 'running', runId);
    this.activeRunId = runId;
    this.patchJobStatus(job.id, 'running');

    const attachments = this.prepareAttachments(job, runId, settings);
    if (!attachments) {
      return this.finishRun(job, run, 'failed', 'UNEXPECTED_EXCEPTION', 'attachment preparation failed');
    }

    let sendClicks = 0;
    const attempts = new Map<AutopilotErrorCode, number>();
    const deadline = this.now() + Math.max(1, job.attemptsBudget) * 60_000;
    let lastCode: AutopilotErrorCode = 'UNEXPECTED_EXCEPTION';
    let lastMessage = '';

    for (let attempt = 1; attempt <= job.attemptsBudget; attempt += 1) {
      if (this.disposed) break;
      if (this.cancelled.has(runId)) {
        return this.finishRun(job, run, 'skipped', 'UNEXPECTED_EXCEPTION', 'cancelled by user');
      }
      if (this.now() > deadline) {
        return this.finishRun(job, run, 'failed', 'UNEXPECTED_EXCEPTION', 'run deadline exceeded');
      }
      const guard = this.options.guard?.() ?? 'ok';
      if (guard !== 'ok') {
        return this.deferExistingRun(job, run, scheduledAt, 'PROTECTION_DEFERRED');
      }
      if (this.options.softStopActive?.()) {
        return this.deferExistingRun(job, run, scheduledAt, 'SOFT_STOP_INTERCEPT');
      }

      run = { ...run, attempts: attempt, state: 'running', heartbeatAt: new Date(this.now()).toISOString() };
      this.options.store.recordRun(run);

      const adapter = this.options.adapters[job.target] ?? this.options.adapters.generic;
      if (!adapter) {
        return this.finishRun(job, run, 'failed', 'TARGET_NOT_RUNNING', 'no adapter for target');
      }

      let result: DeliveryResult;
      try {
        result = await adapter.deliver({
          job,
          prompt: attachments.prompt,
          attachments: attachments.items,
          settings,
          runId,
          elapsed: () => this.now() - scheduledAt,
          shouldCancel: () => this.cancelled.has(runId) || this.disposed,
          onStep: (step) => {
            run = this.appendStep(run, step);
            if (step.step === 'send' && step.ok) sendClicks += 1;
          },
        });
      } catch (error) {
        result = {
          ok: false,
          code: 'UNEXPECTED_EXCEPTION',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (result.ok) {
        if (this.cancelled.has(runId)) {
          return this.finishRun(job, run, 'skipped', 'UNEXPECTED_EXCEPTION', 'cancelled by user');
        }
        return this.finishRun(job, run, 'sent');
      }

      lastCode = result.code;
      lastMessage = result.message ?? '';
      run = this.appendStep(run, {
        step: 'error',
        ok: false,
        code: result.code,
        ms: 0,
        detail: truncate(lastMessage, 200),
      });

      if (sendClicks >= MAX_SEND_CLICKS && result.code === 'SEND_UNCONFIRMED') {
        const stopped = this.finishRun(job, run, 'failed', 'DUPLICATE_RISK', 'send already attempted twice');
        this.patchJobStatus(job.id, 'blocked');
        return stopped;
      }

      const meta = errorMeta(result.code);
      const used = (attempts.get(result.code) ?? 0) + 1;
      attempts.set(result.code, used);
      if (result.fatal || !meta.retryable || used > meta.maxAttempts) {
        if (meta.terminal === 'deferred' || meta.terminal === 'blocked') {
          return this.deferExistingRun(job, run, scheduledAt, result.code);
        }
        if (meta.terminal === 'skip') {
          return this.finishRun(job, run, 'skipped', result.code, lastMessage);
        }
        const rescued = await this.tryFallback(job, run, settings, attachments, scheduledAt, result.code);
        return rescued ?? this.finishRun(job, run, 'failed', result.code, lastMessage);
      }

      const wait = retryDelayMs(result.code, used);
      run = this.appendStep(run, {
        step: 'retry',
        ok: true,
        code: result.code,
        ms: wait,
        detail: `attempt ${used}/${meta.maxAttempts}`,
      });
      if (wait > 0) await this.sleep(wait);
    }

    const rescued = await this.tryFallback(job, run, settings, attachments, scheduledAt, lastCode);
    return rescued ?? this.finishRun(job, run, 'failed', lastCode, lastMessage || 'attempt budget exhausted');
  }

  /**
   * The GUI route exhausted its retries. If an emergency channel is enabled,
   * a different model still answers the prompt, which is what the operator asked
   * for; the run records which transport carried it.
   */
  private async tryFallback(
    job: AutopilotJob,
    initial: AutopilotRun,
    settings: AutopilotSettings,
    attachments: AttachmentPreparation,
    scheduledAt: number,
    reason: AutopilotErrorCode,
  ): Promise<AutopilotRun | null> {
    const fallback = this.options.fallback;
    if (!fallback || job.target === 'fallback-only') return null;
    if (!settings.fallback.ollamaEnabled && !settings.fallback.remoteEnabled) return null;
    if (this.cancelled.has(initial.id) || this.disposed) return null;
    let run = this.appendStep(initial, {
      step: 'fallback-reason',
      ok: true,
      ms: 0,
      detail: reason,
    });
    let result: DeliveryResult;
    try {
      result = await fallback.deliver({
        job,
        prompt: attachments.prompt,
        attachments: attachments.items,
        settings,
        runId: initial.id,
        elapsed: () => this.now() - scheduledAt,
        shouldCancel: () => this.cancelled.has(initial.id) || this.disposed,
        onStep: (step) => {
          run = this.appendStep(run, step);
        },
      });
    } catch (error) {
      this.options.log.warn('fallback delivery threw', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!result.ok) return null;
    run = { ...run, route: result.route ?? run.route };
    return this.finishRun(job, run, 'sent');
  }

  private prepareAttachments(
    job: AutopilotJob,
    runId: string,
    settings: AutopilotSettings,
  ): AttachmentPreparation | null {
    try {
      return this.options.attachments.prepare(runId, job.prompt, job.attachments, {
        backupEnabled: settings.backupEnabled,
        backupMaxBytes: settings.backupMaxBytes,
        maxAttachmentBytes: settings.maxAttachmentBytes,
      });
    } catch (error) {
      this.options.log.error('attachment preparation failed', error);
      return null;
    }
  }

  private defer(job: AutopilotJob, scheduledAt: number, code: AutopilotErrorCode): void {
    const run = this.createRun(job, scheduledAt, 'deferred');
    this.patchJobStatus(job.id, 'deferred');
    this.finish(job, run, { state: 'deferred', error: { code, message: 'deferred' } });
    this.hold(job, code);
    this.notify({ kind: 'deferred', job, run });
  }

  private deferExistingRun(
    job: AutopilotJob,
    run: AutopilotRun,
    scheduledAt: number,
    code: AutopilotErrorCode,
  ): AutopilotRun {
    this.patchJobStatus(job.id, 'deferred');
    const finished = this.finish(job, { ...run, scheduledAt: new Date(scheduledAt).toISOString() }, {
      state: 'deferred',
      error: { code, message: 'deferred' },
    });
    this.hold(job, code);
    this.notify({ kind: 'deferred', job, run: finished });
    return finished;
  }

  private hold(job: AutopilotJob, code: AutopilotErrorCode): void {
    const until = this.now() + this.deferMs;
    this.defers.set(job.id, until);
    this.options.scheduler.hold(job.id, until);
    this.options.store.patchJob(job.id, { lastStatus: 'deferred' });
    this.options.log.warn('autopilot job deferred', { jobId: job.id, code, until });
  }

  private finishRun(
    job: AutopilotJob,
    run: AutopilotRun,
    state: AutopilotRun['state'],
    code?: AutopilotErrorCode,
    message?: string,
  ): AutopilotRun {
    const error = code ? { code, message: truncate(message ?? '', 400) } : undefined;
    this.patchJobStatus(job.id, state === 'sent' ? 'sent' : state === 'skipped' ? 'skipped' : 'failed');
    const finished = this.finish(job, run, { state, error });
    if (state === 'sent' || state === 'skipped' || state === 'failed') {
      this.advance(job);
    }
    this.options.store.patchJob(job.id, { lastRunAt: new Date(this.now()).toISOString() });
    this.notify({ kind: state === 'sent' ? 'sent' : state === 'skipped' ? 'skipped' : 'failed', job, run: finished });
    return finished;
  }

  private createRun(
    job: AutopilotJob,
    scheduledAt: number,
    state: AutopilotRun['state'],
    runId = `${job.id}:${scheduledAt}`,
  ): AutopilotRun {
    return {
      id: runId,
      jobId: job.id,
      startedAt: new Date(this.now()).toISOString(),
      scheduledAt: new Date(scheduledAt).toISOString(),
      state,
      route: job.target === 'zcode' ? 'gui-zcode' : job.target === 'workbuddy' || job.target === 'workbuddy-ai' ? 'gui-workbuddy' : 'gui-zcode',
      attempts: 0,
      steps: [],
      promptDigest: digest(job.prompt),
      heartbeatAt: new Date(this.now()).toISOString(),
    };
  }

  private finish(
    job: AutopilotJob,
    run: AutopilotRun,
    patch: Pick<Partial<AutopilotRun>, 'state' | 'error'>,
  ): AutopilotRun {
    const next: AutopilotRun = {
      ...run,
      ...patch,
      jobId: job.id,
      endedAt: new Date(this.now()).toISOString(),
      heartbeatAt: new Date(this.now()).toISOString(),
    };
    this.options.store.recordRun(next);
    this.options.store.patchRun(next.id, next, { flush: true });
    this.activeRunId = null;
    this.emit();
    return next;
  }

  private appendStep(run: AutopilotRun, step: Omit<AutopilotRunStep, 't'>): AutopilotRun {
    const steps = [...run.steps, { ...step, t: new Date(this.now()).toISOString() }];
    const trimmed = steps.length > MAX_STEPS_PER_RUN ? steps.slice(-MAX_STEPS_PER_RUN) : steps;
    const next = { ...run, steps: trimmed, heartbeatAt: new Date(this.now()).toISOString() };
    this.options.store.patchRun(next.id, { steps: trimmed, heartbeatAt: next.heartbeatAt });
    this.emit();
    return next;
  }

  private advance(job: AutopilotJob): void {
    const due = nextDueAt(job.schedule, this.now());
    this.options.store.patchJob(job.id, { nextDueAt: due === null ? undefined : new Date(due).toISOString() });
    this.options.scheduler.wake();
  }

  private patchJobStatus(jobId: string, status: AutopilotJob['lastStatus']): void {
    this.options.store.patchJob(jobId, { lastStatus: status });
  }

  private notify(event: EngineNotification): void {
    try {
      this.options.notify?.(event);
    } catch (error) {
      this.options.log.error('autopilot notification failed', error);
    }
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const runs = this.options.store.listRuns(50);
    for (const listener of this.listeners) {
      try {
        listener(runs);
      } catch (error) {
        this.options.log.error('autopilot run listener failed', error);
      }
    }
  }
}

export function digest(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
