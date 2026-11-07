import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AUTOPILOT_MODEL_SEEDS,
  mergeCatalog,
  sanitizeJob,
  type AutopilotAction,
  type AutopilotErrorCode,
  type AutopilotAttachmentView,
  type AutopilotJob,
  type AutopilotJobSaveResult,
  type AutopilotRunActionResult,
  type AutopilotSettings,
  type AutopilotSnapshot,
  type AutopilotSyncResult,
  type AutopilotTarget,
  type AutopilotWindowInfo,
} from '../../shared/autopilot';
import { AutoBridge } from './auto-bridge';
import { AttachmentService } from './autopilot-attachments';
import {
  AutopilotEngine,
  type EngineNotification,
  type GuardState,
  type TargetAdapter,
} from './autopilot-engine';
import { FallbackAdapter } from './autopilot-fallback';
import { ProtectionGate } from './autopilot-guard';
import { GenericAdapter } from './autopilot-generic';
import { GuiSession } from './autopilot-gui';
import { AutopilotScheduler } from './autopilot-scheduler';
import { AutopilotStore } from './autopilot-store';
import { WorkBuddyAdapter } from './autopilot-workbuddy';
import { ZCodeAdapter } from './autopilot-zcode';
import { SoftStopSecretStore } from './soft-stop-store';
import type { Logger } from './logger';

export interface AutopilotServiceOptions {
  userDataDir: string;
  log: Logger;
  /** InsomniaZAuto.exe; spawned lazily, so a missing file only fails a run. */
  autoHelperExe: string;
  tempDir: () => string;
  /** 0..1 machine load estimate, forwarded to the autosave controller. */
  load?: () => number;
  softStopActive?: () => boolean;
  /** Deferred while a scan/recording owns the desktop (task #26). */
  guard?: () => GuardState;
  /** Only the job title and error code are shown; never the prompt. */
  notify?: (title: string, body: string) => void;
  /** Fired when the desktop becomes busy, so the UI can hide itself. */
  onGuardBusy?: (state: GuardState) => void;
  now?: () => number;
}

const BROADCAST_DEBOUNCE_MS = 150;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

interface SnapshotAdapter {
  snapshotModels?: () => Promise<import('../../shared/autopilot').ModelCatalogEntry[]>;
  snapshotConversations?: () => Promise<string[]>;
}

/**
 * Single owner of the autopilot runtime: persistence, the automation helper,
 * the target adapters and the scheduler. The renderer talks to it through the
 * `autopilot:*` IPC domain and never touches the helper directly.
 */
export class AutopilotService {
  private readonly now: () => number;
  private readonly dir: string;
  private readonly store: AutopilotStore;
  private readonly attachments: AttachmentService;
  private readonly bridge: AutoBridge;
  private readonly session: GuiSession;
  private readonly secrets: SoftStopSecretStore;
  private readonly adapters: Record<string, TargetAdapter>;
  private readonly scheduler: AutopilotScheduler;
  private readonly engine: AutopilotEngine;
  private readonly gate: ProtectionGate;
  private readonly listeners = new Set<(snapshot: AutopilotSnapshot) => void>();
  private broadcastTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly options: AutopilotServiceOptions) {
    const { log } = options;
    this.now = options.now ?? Date.now;
    this.dir = join(options.userDataDir, 'autopilot');
    mkdirSync(this.dir, { recursive: true });

    this.store = new AutopilotStore({ dir: this.dir, log, load: options.load });
    this.attachments = new AttachmentService({ dir: this.dir, log });
    this.bridge = new AutoBridge({
      executable: options.autoHelperExe,
      logPath: join(options.userDataDir, 'auto-helper.log'),
      parentPid: process.pid,
      log,
    });
    this.session = new GuiSession(this.bridge);
    this.secrets = new SoftStopSecretStore(join(this.dir, 'autopilot-secret.json'), log);

    const zcode = new ZCodeAdapter({ session: this.session, log });
    const workbuddy = new WorkBuddyAdapter({
      session: this.session,
      log,
      tempDir: options.tempDir,
    });
    const generic = new GenericAdapter({ session: this.session, log, tempDir: options.tempDir });
    const fallback = new FallbackAdapter({ log, apiKey: () => this.secrets.getKey() });
    this.adapters = {
      zcode,
      workbuddy,
      'workbuddy-ai': workbuddy,
      generic,
      'fallback-only': fallback,
    };

    let engine: AutopilotEngine | null = null;
    this.scheduler = new AutopilotScheduler({
      listJobs: () => this.store.listJobs(),
      onDue: (job, scheduledAt, decision) => engine?.enqueue(job, scheduledAt, decision),
      graceMs: () => this.store.getSettings().backlogMs,
      log,
    });
    engine = new AutopilotEngine({
      store: this.store,
      scheduler: this.scheduler,
      attachments: this.attachments,
      adapters: this.adapters,
      fallback,
      log,
      notify: (event) => this.onEngineEvent(event),
      guard: () => this.gate.current(),
      softStopActive: options.softStopActive,
    });
    this.engine = engine;
    this.gate = new ProtectionGate({
      settings: () => this.store.getSettings(),
      active: () => this.store.listJobs().some((job) => job.enabled && job.target !== 'fallback-only'),
      // Probing spawns the helper lazily, which is why the gate only runs while a
      // GUI task is armed: protection has to work before the first delivery.
      listWindows: async () => {
        const windows = await this.session.listWindows({ includeInvisible: false });
        return windows.map((win) => ({ title: win.title, process: win.process }));
      },
      cpuBusy: async () => (await this.session.perf()).cpuBusy,
      desktopBusy: () => this.options.softStopActive?.() ?? false,
      log,
      onBusy: (state) => {
        this.options.onGuardBusy?.(state);
        this.markDirty();
      },
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.store.load();
    this.engine.start();
    this.scheduler.start();
    this.gate.start();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
    this.cleanup();
  }

  /** Debounced so a burst of step updates does not flood the renderer. */
  onChange(listener: (snapshot: AutopilotSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AutopilotSnapshot {
    const settings = this.store.getSettings();
    return {
      settings,
      jobs: this.store.listJobs(),
      runs: this.store.listRuns(60),
      catalog: mergeCatalog([...AUTOPILOT_MODEL_SEEDS, ...this.store.listCatalog()]),
      conversations: this.store.listConversations(),
      attachments: this.attachmentViews(),
      paused: !settings.enabled,
      activeRunId: this.engine.activeRun(),
      helperAlive: this.bridge.alive,
      guard: this.gate.current(),
      now: this.now(),
    };
  }

  // -- jobs -----------------------------------------------------------------

  saveJob(raw: unknown): AutopilotJobSaveResult {
    const incoming = raw as Partial<AutopilotJob> | undefined;
    const existing = typeof incoming?.id === 'string' ? this.store.getJob(incoming.id) : null;
    const job = sanitizeJob(raw, existing?.id ?? randomUUID());
    if (!job || !job.prompt.trim()) return { ok: false, error: 'INVALID_JOB' };
    if (existing) {
      job.createdAt = existing.createdAt;
      job.lastRunAt = existing.lastRunAt;
      job.lastStatus = existing.lastStatus;
    }
    const saved = this.store.upsertJob(job);
    this.scheduler.resetJob(saved.id);
    this.markDirty();
    return { ok: true, job: saved };
  }

  deleteJob(id: string): { ok: boolean } {
    const removed = this.store.deleteJob(id);
    this.scheduler.wake();
    this.markDirty();
    return { ok: removed };
  }

  setEnabled(id: string, enabled: boolean): { ok: boolean } {
    const patched = this.store.patchJob(id, { enabled });
    if (!patched) return { ok: false };
    this.scheduler.resetJob(id);
    this.markDirty();
    return { ok: true };
  }

  runNow(id: string): AutopilotRunActionResult {
    const job = this.store.getJob(id);
    if (!job) return { ok: false, error: 'JOB_NOT_FOUND' };
    this.engine.enqueue(job, this.now(), 'run');
    return { ok: true };
  }

  cancelRun(runId: string): { ok: boolean } {
    return { ok: this.engine.cancelRun(runId) };
  }

  // -- settings -------------------------------------------------------------

  updateSettings(patch: Partial<AutopilotSettings>): AutopilotSettings {
    const next = this.store.updateSettings(patch);
    this.scheduler.wake();
    this.markDirty();
    return next;
  }

  setPaused(paused: boolean): { ok: boolean } {
    this.updateSettings({ enabled: !paused });
    return { ok: true };
  }

  /** DPAPI-backed emergency API key; never logged and never sent to the renderer. */
  setApiKey(key: string | null | undefined): { ok: boolean; error?: string } {
    if (key === undefined) return { ok: false, error: 'INVALID_KEY' };
    return this.secrets.setKey(key);
  }

  hasApiKey(): boolean {
    return this.secrets.hasKey();
  }

  clearRuns(): { ok: boolean } {
    this.store.clearRuns();
    this.markDirty();
    return { ok: true };
  }

  // -- discovery ------------------------------------------------------------

  async windows(): Promise<AutopilotWindowInfo[]> {
    try {
      const list = await this.session.listWindows({ includeInvisible: true });
      return list.map((win) => ({
        hwnd: win.hwnd,
        title: win.title,
        process: win.process,
        className: win.class,
        visible: win.visible,
        minimized: win.minimized,
        rect: win.rect,
      }));
    } catch (error) {
      this.options.log.warn('autopilot window list failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async sync(target: AutopilotTarget): Promise<AutopilotSyncResult> {
    const adapter = this.adapters[target] as (TargetAdapter & SnapshotAdapter) | undefined;
    if (!adapter) return { ok: false, models: 0, conversations: 0, error: 'TARGET_NOT_SUPPORTED' };
    let models = 0;
    let conversations = 0;
    const failures: string[] = [];
    try {
      if (typeof adapter.snapshotModels === 'function') {
        models = this.store.observeCatalog(await adapter.snapshotModels());
      }
    } catch (error) {
      failures.push(codeOf(error));
    }
    try {
      if (typeof adapter.snapshotConversations === 'function') {
        const names = await adapter.snapshotConversations();
        this.store.observeConversations(target, names);
        conversations = names.length;
      }
    } catch (error) {
      failures.push(codeOf(error));
    }
    this.markDirty();
    return {
      ok: failures.length === 0,
      models,
      conversations,
      ...(failures.length ? { error: failures[0] } : {}),
    };
  }

  // -- attachments ----------------------------------------------------------

  attachmentAction(action: AutopilotAction): { ok: boolean; error?: string } {
    const job = this.store.getJob(action.jobId);
    const attachment = job?.attachments.find((item) => item.id === action.attachmentId);
    if (!attachment) return { ok: false, error: 'ATTACHMENT_NOT_FOUND' };
    if (action.type === 'delete') return { ok: this.attachments.deleteBackup(action.attachmentId) };
    if (action.type === 'restore') return this.attachments.restoreBackup(action.attachmentId);
    const limits = this.limits();
    const path = this.attachments.ensureBackup(action.jobId, attachment, limits);
    this.markDirty();
    return path ? { ok: true } : { ok: false, error: 'BACKUP_FAILED' };
  }

  private attachmentViews(): AutopilotAttachmentView[] {
    const limits = this.limits();
    return this.attachments.listLedger().map((entry) => {
      const job = this.store.getJob(entry.jobId);
      const attachment = job?.attachments.find((item) => item.id === entry.attachmentId);
      const resolved = attachment ? this.attachments.prepare(entry.jobId, '', [attachment], limits) : null;
      const source = resolved?.items[0]?.source ?? 'missing';
      return {
        attachmentId: entry.attachmentId,
        jobId: entry.jobId,
        displayName: entry.displayName,
        originalPath: entry.originalPath,
        size: entry.size,
        sha256: entry.sha256,
        backupPath: entry.backupPath,
        updatedAt: entry.updatedAt,
        originalExists: source !== 'missing',
      };
    });
  }

  private limits() {
    const settings = this.store.getSettings();
    return {
      backupEnabled: settings.backupEnabled,
      backupMaxBytes: settings.backupMaxBytes,
      maxAttachmentBytes: settings.maxAttachmentBytes,
    };
  }

  // -- lifecycle ------------------------------------------------------------

  flush(): void {
    this.store.flush();
  }

  dispose(): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.broadcastTimer = null;
    this.cleanupTimer = null;
    this.gate.stop();
    this.engine.dispose();
    this.scheduler.stop();
    this.store.dispose();
    this.bridge.dispose();
    this.listeners.clear();
  }

  private cleanup(): void {
    try {
      const removed = this.attachments.cleanupExpired(this.store.getSettings().backupRetentionDays);
      if (removed > 0) this.markDirty();
    } catch (error) {
      this.options.log.warn('autopilot backup cleanup failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onEngineEvent(event: EngineNotification): void {
    if (event.kind === 'sent') {
      this.options.notify?.(event.job.title, 'AUTOPILOT_SENT');
    } else if (event.kind === 'failed' || event.kind === 'blocked') {
      this.options.notify?.(event.job.title, event.run.error?.code ?? 'AUTOPILOT_FAILED');
    }
    this.markDirty();
  }

  private markDirty(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    }, BROADCAST_DEBOUNCE_MS);
    this.broadcastTimer.unref?.();
  }
}

function codeOf(error: unknown): AutopilotErrorCode | string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
