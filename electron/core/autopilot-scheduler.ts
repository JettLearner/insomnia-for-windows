import { catchUpDecision, nextDueAt, type AutopilotCatchUp, type AutopilotJob } from '../../shared/autopilot';
import type { Logger } from './logger';

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface AutopilotSchedulerOptions {
  listJobs: () => AutopilotJob[];
  /** Called for every job that reached its due time. Must not throw. */
  onDue: (job: AutopilotJob, scheduledAt: number, decision: AutopilotCatchUp | 'run') => void;
  /** Catch-up grace window; past this the schedule policy decides. */
  graceMs: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  log?: Logger;
  /** Longest single sleep; keeps us within setTimeout limits and detects clock jumps. */
  maxWaitMs?: number;
  toleranceMs?: number;
}

export interface ScheduledEntry {
  jobId: string;
  dueAt: number | null;
}

/**
 * Decides *when* jobs run. Execution lives in AutopilotEngine; this class never
 * touches windows or the filesystem, which keeps it testable with fake timers.
 *
 * The persisted `job.nextDueAt` is authoritative when present. After a job fires
 * the scheduler remembers the fired instant so a slow engine cannot double-fire
 * while re-arming.
 */
export class AutopilotScheduler {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly maxWaitMs: number;
  private readonly toleranceMs: number;
  private readonly lastFired = new Map<string, number>();
  private readonly holds = new Map<string, number>();
  private timer: TimerHandle | null = null;
  private running = false;

  constructor(private readonly options: AutopilotSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.maxWaitMs = Math.max(1000, options.maxWaitMs ?? 60_000);
    this.toleranceMs = Math.max(0, options.toleranceMs ?? 250);
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Re-evaluates after a job edit; does not fire anything by itself. */
  wake(): void {
    if (!this.running) return;
    this.arm();
  }

  /** Forgets the anti-double-fire cursor, e.g. after a manual run. */
  resetJob(jobId: string): void {
    this.lastFired.delete(jobId);
  }

  /** Delays a job until `until` (deferral after a recoverable failure). */
  hold(jobId: string, until: number): void {
    this.holds.set(jobId, until);
    this.wake();
  }

  /** Clears a hold so the job becomes due again immediately. */
  release(jobId: string): void {
    this.holds.delete(jobId);
    this.wake();
  }

  /** Earliest pending due time across enabled jobs, for countdown display. */
  nextDue(): number | null {
    const now = this.now();
    let best: number | null = null;
    for (const job of this.options.listJobs()) {
      if (!job.enabled) continue;
      const due = this.dueAt(job, now);
      if (due === null) continue;
      if (best === null || due < best) best = due;
    }
    return best;
  }

  entries(): ScheduledEntry[] {
    const now = this.now();
    return this.options.listJobs().map((job) => ({
      jobId: job.id,
      dueAt: job.enabled ? this.dueAt(job, now) : null,
    }));
  }

  private dueAt(job: AutopilotJob, now: number): number | null {
    if (job.schedule.kind === 'manual') return null;
    const hold = this.holds.get(job.id);
    if (hold !== undefined) {
      if (hold > now) return hold;
      this.holds.delete(job.id);
    }
    const explicit = job.nextDueAt ? Date.parse(job.nextDueAt) : NaN;
    let due: number | null = Number.isFinite(explicit) ? explicit : nextDueAt(job.schedule, now);
    // A persisted due time in the past is a catch-up candidate, but never one we
    // already fired in this process.
    const fired = this.lastFired.get(job.id);
    if (due !== null && fired !== undefined && due <= fired) {
      due = nextDueAt(job.schedule, Math.max(fired, now - 1));
    }
    return due;
  }

  private arm(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    const now = this.now();
    let earliest: number | null = null;
    for (const job of this.options.listJobs()) {
      if (!job.enabled) continue;
      const due = this.dueAt(job, now);
      if (due === null) continue;
      if (earliest === null || due < earliest) earliest = due;
    }
    if (earliest === null) return;
    const delay = Math.min(this.maxWaitMs, Math.max(0, earliest - now));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.fire();
    }, delay);
  }

  private fire(): void {
    if (!this.running) return;
    const now = this.now();
    const graceMs = this.options.graceMs();
    const candidates = this.options
      .listJobs()
      .filter((job) => job.enabled)
      .map((job) => ({ job, due: this.dueAt(job, now) }))
      .filter((item): item is { job: AutopilotJob; due: number } => item.due !== null && item.due <= now + this.toleranceMs)
      .sort((a, b) => a.due - b.due);

    for (const { job, due } of candidates) {
      this.lastFired.set(job.id, due);
      const decision = catchUpDecision(job.schedule, due, now, graceMs);
      try {
        this.options.onDue(job, due, decision);
      } catch (error) {
        this.options.log?.error('scheduler onDue callback failed', error);
      }
    }
    this.arm();
  }
}

export function delayFor(dueAt: number, now: number, maxWaitMs: number): number {
  return Math.min(Math.max(0, maxWaitMs), Math.max(0, dueAt - now));
}
