import { join } from 'node:path';
import type {
  AiActivitySnapshot,
  GuiPreview,
  GuiProfile,
  GuiRecordResult,
  GuiRecordStartResult,
  GuiRecordStatus,
  SoftStopAdapterInfo,
  SoftStopAuditAction,
  SoftStopAuditEntry,
  SoftStopCycle,
  SoftStopPhase,
  SoftStopSendResult,
  SoftStopStatus,
} from '../../shared/soft-stop';
import {
  EMPTY_SOFT_STOP_CYCLE,
  SOFT_STOP_MAX_ATTEMPTS,
  normalizeProfileId,
  normalizeSoftStopPrompt,
  planSoftStopTick,
  renderTemplate,
  requestHasAiActivity,
  shouldResetSoftStopCycle,
  softStopCycleActive,
} from '../../shared/soft-stop';
import type { PowerInfo, SessionState, Settings } from '../../shared/types';
import { AiActivityDetector, emptySnapshot } from './ai-detect';
import { GuiAgent } from './gui-agent';
import { GuiProfileStore } from './gui-profile-store';
import type { HelperClient } from './helper-client';
import { loadKnowledgeBase } from './knowledge';
import type { Logger } from './logger';
import { SoftStopSender, type SoftStopTarget } from './soft-stop-sender';
import { SoftStopAuditStore, SoftStopCycleStore, SoftStopSecretStore } from './soft-stop-store';

export interface SoftStopEngineOptions {
  userDataDir: string;
  helper: HelperClient;
  getSettings: () => Settings;
  getSession: () => SessionState;
  getPower: () => PowerInfo;
  logger: Logger;
  performSleep: (percent: number | null) => Promise<{ ok: boolean; error?: string }>;
  notifySent: (target: string, percent: number | null) => void;
  notifyFailed: (detail: string) => void;
  onChange: () => void;
}

export interface SoftStopScanOptions {
  capture?: boolean;
}

interface DispatchOutcome {
  ok: boolean;
  dryRun: boolean;
  target: string | null;
  detail: string;
  error?: string;
  /** Configuration gap (allowlist, no window, helper offline). Retried on cooldown without burning attempts. */
  blocked: boolean;
}

const SAMPLE_TTL_MS = 45_000;

const BLOCKED_CODES = new Set([
  'NO_TARGET',
  'NO_TARGET_CONTROLS',
  'NOT_ALLOWLISTED',
  'NEEDS_CONFIRMATION',
  'GUI_DISABLED',
  'HELPER_OFFLINE',
  'EMPTY_PROMPT',
  'NO_ADAPTER',
  'NO_MODEL',
]);

function percentLabel(percent: number | null): string {
  return percent === null ? '—' : `${Math.round(percent)}%`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
}

export class SoftStopEngine {
  private readonly options: SoftStopEngineOptions;
  private readonly audit: SoftStopAuditStore;
  private readonly secrets: SoftStopSecretStore;
  private readonly cycleStore: SoftStopCycleStore;
  readonly profiles: GuiProfileStore;
  private readonly detector: AiActivityDetector;
  private readonly sender: SoftStopSender;
  private readonly gui: GuiAgent;

  private cycle: SoftStopCycle = { ...EMPTY_SOFT_STOP_CYCLE };
  private cycleLoaded = false;
  private phase: SoftStopPhase = 'idle';
  private lastError: string | null = null;
  private lastAction: SoftStopStatus['lastAction'] = 'none';
  private lastActionAt: number | null = null;
  private lastActionTarget: string | null = null;
  private lastSample: AiActivitySnapshot | null = null;
  private lastSampleAt = 0;
  private ticking = false;
  private sampling = false;
  private sleeping = false;

  constructor(options: SoftStopEngineOptions) {
    this.options = options;
    const { knowledge } = loadKnowledgeBase(options.userDataDir, options.logger);
    this.audit = new SoftStopAuditStore(join(options.userDataDir, 'soft-stop-audit.json'), options.logger);
    this.secrets = new SoftStopSecretStore(join(options.userDataDir, 'soft-stop-key.json'), options.logger);
    this.cycleStore = new SoftStopCycleStore(join(options.userDataDir, 'soft-stop-cycle.json'), options.logger);
    this.profiles = new GuiProfileStore(join(options.userDataDir, 'profiles.json'), options.logger);
    this.detector = new AiActivityDetector({ knowledge, logger: options.logger });
    this.sender = new SoftStopSender({
      knowledge,
      getSettings: options.getSettings,
      secrets: this.secrets,
      logger: options.logger,
    });
    this.gui = new GuiAgent({
      helper: options.helper,
      profiles: this.profiles,
      getSettings: options.getSettings,
      logger: options.logger,
    });
  }

  getStatus(): SoftStopStatus {
    const settings = this.options.getSettings();
    const session = this.options.getSession();
    let phase: SoftStopPhase;
    if (!settings.softStopEnabled) phase = 'off';
    else if (this.phase === 'sleeping' || this.phase === 'error') phase = this.phase;
    else if (!session.active) phase = 'idle';
    else phase = this.phase;
    return {
      phase,
      triggeredThisCycle: session.active && this.cycle.triggered,
      attempts: this.cycle.attempts,
      lastSample: this.lastSample,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      lastActionTarget: this.lastActionTarget,
      lastError: this.lastError,
      hasHttpKey: this.secrets.hasKey(),
      profileCount: this.profiles.list().length,
    };
  }

  onSessionStart(startedAt: number | null): void {
    this.cycle = this.cycleStore.load(startedAt);
    this.cycleLoaded = true;
    this.lastSample = null;
    this.lastSampleAt = 0;
    this.lastError = null;
    this.lastAction = 'none';
    this.lastActionAt = null;
    this.lastActionTarget = null;
    this.sleeping = false;
    this.phase = 'monitoring';
    this.cycleStore.save(this.cycle);
    this.options.onChange();
  }

  onSessionEnd(): void {
    this.cycle = { ...EMPTY_SOFT_STOP_CYCLE };
    this.cycleLoaded = true;
    this.cycleStore.clear();
    this.lastSample = null;
    this.lastSampleAt = 0;
    this.lastError = null;
    this.phase = 'idle';
    this.sleeping = false;
    this.options.onChange();
  }

  onResume(): void {
    if (this.phase !== 'sleeping' && this.phase !== 'error') return;
    this.phase = this.options.getSession().active ? 'monitoring' : 'idle';
    if (!this.options.getSession().active) this.lastError = null;
    this.options.onChange();
  }

  private ensureCycle(startedAt: number | null): void {
    if (!this.cycleLoaded) {
      this.cycle = this.cycleStore.load(startedAt);
      this.cycleLoaded = true;
      return;
    }
    this.cycle = softStopCycleActive(this.cycle, startedAt);
  }

  private persistCycle(): void {
    this.cycleStore.save(this.cycle);
  }

  private setPhase(phase: SoftStopPhase, error?: string | null): void {
    const nextError = error === undefined ? this.lastError : error;
    if (this.phase === phase && this.lastError === nextError) return;
    this.phase = phase;
    this.lastError = nextError;
    this.options.onChange();
  }

  private record(action: SoftStopAuditAction, target: string, result: 'ok' | 'failed' | 'info', detail: string): void {
    this.audit.append({ ts: Date.now(), action, target: target.slice(0, 200), result, detail: detail.slice(0, 300) });
  }

  private sampleFresh(now: number): boolean {
    return this.lastSample !== null && now - this.lastSampleAt < SAMPLE_TTL_MS;
  }

  private hasActivity(): boolean {
    return requestHasAiActivity(this.lastSample);
  }

  private async refreshSample(): Promise<AiActivitySnapshot | null> {
    if (this.sampling) return this.lastSample;
    this.sampling = true;
    try {
      const snapshot = await this.detector.snapshot(true);
      this.lastSample = snapshot;
      this.lastSampleAt = Date.now();
      const locals = snapshot.local.map((runtime) => runtime.id).join(',');
      this.record(
        'detect',
        snapshot.streaming === 'none' ? 'network' : `ai:${snapshot.streaming}`,
        'info',
        `streaming=${snapshot.streaming} local=${locals || 'none'} remote=${snapshot.remote.length} ` +
          `throughput=${Math.round(snapshot.network.throughputBps / 1024)}KB/s`,
      );
      return snapshot;
    } catch (error) {
      this.options.logger.warn('soft stop: detection failed', { message: errorText(error) });
      this.lastError = 'DETECT_FAILED';
      return this.lastSample;
    } finally {
      this.sampling = false;
    }
  }

  /** Runs one state-machine step. Cheap when the feature is off; safe to call every few seconds. */
  async tick(now = Date.now()): Promise<void> {
    const settings = this.options.getSettings();
    const session = this.options.getSession();
    if (!settings.softStopEnabled) {
      this.setPhase('off');
      return;
    }
    if (!session.active || session.startedAt === null) {
      if (this.phase !== 'sleeping' && this.phase !== 'error') this.setPhase('idle');
      return;
    }
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.ensureCycle(session.startedAt);
      const power = this.options.getPower();
      if (shouldResetSoftStopCycle(this.cycle, power.ac, power.batteryPercent, settings.softStopThreshold)) {
        this.cycle = { cycleStartedAt: session.startedAt, triggered: false, attempts: 0, lastAttemptAt: null };
        this.persistCycle();
        this.lastError = null;
        this.record('reset', 'battery', 'info', 'AC connected or battery recovered above the soft stop threshold');
      }

      let decision = this.plan(settings, power, now);
      for (let pass = 0; pass < 2; pass += 1) {
        if (decision.type === 'detect') {
          this.setPhase('detected');
          await this.refreshSample();
          now = Date.now();
          decision = this.plan(settings, power, now);
          continue;
        }
        await this.applyDecision(decision, settings, power, now);
        break;
      }
    } catch (error) {
      this.options.logger.warn('soft stop tick failed', { message: errorText(error) });
      this.setPhase('error', 'TICK_FAILED');
    } finally {
      this.ticking = false;
    }
  }

  private plan(settings: Settings, power: PowerInfo, now: number) {
    return planSoftStopTick({
      enabled: settings.softStopEnabled,
      active: this.options.getSession().active,
      ac: power.ac,
      percent: power.batteryPercent,
      threshold: settings.softStopThreshold,
      sleepThreshold: settings.softStopSleepThreshold,
      dryRun: settings.softStopDryRun,
      cycle: this.cycle,
      hasActivity: this.hasActivity(),
      activityKnown: this.sampleFresh(now),
      now,
    });
  }

  private async applyDecision(
    decision: ReturnType<typeof planSoftStopTick>,
    settings: Settings,
    power: PowerInfo,
    now: number,
  ): Promise<void> {
    switch (decision.type) {
      case 'inactive':
        this.setPhase('idle');
        return;
      case 'wait':
        if (this.phase !== 'error') this.setPhase(this.cycle.triggered ? 'sent' : 'monitoring');
        return;
      case 'wait-activity':
        this.record(
          'detect',
          'activity',
          'info',
          `no AI activity at ${percentLabel(power.batteryPercent)}; waiting before sending`,
        );
        if (this.phase !== 'error') this.setPhase('monitoring');
        return;
      case 'cooldown':
        this.setPhase(this.cycle.triggered ? 'sent' : 'cooldown');
        return;
      case 'exhausted':
        this.setPhase('error', this.lastError ?? 'SEND_EXHAUSTED');
        return;
      case 'sleep':
        await this.performSleep(power.batteryPercent, settings, now);
        return;
      case 'send':
        await this.performSend(decision.dryRun, settings, power, now);
        return;
      case 'detect':
        return;
    }
  }

  private async performSend(
    dryRun: boolean,
    settings: Settings,
    power: PowerInfo,
    now: number,
  ): Promise<void> {
    this.setPhase('sending');
    const snapshot = this.lastSample ?? emptySnapshot();
    const target: SoftStopTarget | null = this.sender.chooseTarget(snapshot);
    if (!target) {
      this.cycle = { ...this.cycle, lastAttemptAt: now };
      this.persistCycle();
      this.lastError = 'NO_TARGET';
      this.lastAction = 'skipped';
      this.lastActionAt = now;
      this.lastActionTarget = null;
      this.record('skip', 'target', 'failed', `no soft stop target at ${percentLabel(power.batteryPercent)}`);
      this.setPhase('error', 'NO_TARGET');
      return;
    }
    const prompt = renderTemplate(settings.softStopPrompt, {
      prompt: '',
      percent: power.batteryPercent,
      threshold: settings.softStopThreshold,
      sleepThreshold: settings.softStopSleepThreshold,
      model: '',
    }).trim();
    const outcome = await this.dispatch(target, power.batteryPercent, dryRun, prompt);
    const label = outcome.target ?? target.label;
    this.lastActionAt = now;
    this.lastActionTarget = label;

    if (outcome.ok) {
      this.cycle = {
        ...this.cycle,
        triggered: true,
        attempts: Math.min(SOFT_STOP_MAX_ATTEMPTS, this.cycle.attempts + 1),
        lastAttemptAt: now,
      };
      this.persistCycle();
      this.lastError = null;
      this.lastAction = outcome.dryRun ? 'dry-run' : 'sent';
      this.record(
        outcome.dryRun ? 'dry-run' : 'send',
        label,
        'ok',
        `${percentLabel(power.batteryPercent)} ${outcome.detail}`.trim(),
      );
      this.setPhase('sent');
      if (!outcome.dryRun) this.options.notifySent(label, power.batteryPercent);
      return;
    }

    this.lastAction = 'failed';
    if (outcome.blocked) {
      this.cycle = { ...this.cycle, lastAttemptAt: now };
      this.persistCycle();
      this.lastError = outcome.error ?? 'BLOCKED';
      this.record('skip', label, 'failed', outcome.detail);
      this.setPhase('error', outcome.error ?? 'BLOCKED');
      return;
    }
    this.cycle = {
      ...this.cycle,
      attempts: Math.min(SOFT_STOP_MAX_ATTEMPTS, this.cycle.attempts + 1),
      lastAttemptAt: now,
    };
    this.persistCycle();
    this.lastError = outcome.error ?? 'SEND_FAILED';
    this.record('send', label, 'failed', outcome.detail);
    this.setPhase('error', this.lastError);
    if (!outcome.dryRun) this.options.notifyFailed(outcome.detail);
  }

  private async dispatch(
    target: SoftStopTarget,
    percent: number | null,
    dryRun: boolean,
    prompt: string,
  ): Promise<DispatchOutcome> {
    const settings = this.options.getSettings();
    if (target.kind === 'gui') {
      if (!settings.softStopGuiEnabled) {
        return { ok: false, dryRun, target: 'GUI', detail: 'GUI automation is disabled', error: 'GUI_DISABLED', blocked: true };
      }
      const result = await this.gui.sendPrompt({ prompt });
      const label = result.target ? `${result.target.process}` : 'GUI';
      if (result.ok) {
        return { ok: true, dryRun: result.dryRun, target: label, detail: result.detail, blocked: false };
      }
      const code = result.blocked ?? result.detail ?? 'GUI_SEND_FAILED';
      return {
        ok: false,
        dryRun: result.dryRun,
        target: label,
        detail: result.detail || code,
        error: code,
        blocked: result.blocked !== null && BLOCKED_CODES.has(result.blocked),
      };
    }
    const result = await this.sender.send(target, percent, dryRun);
    const code = result.error ?? 'SEND_FAILED';
    return {
      ok: result.ok,
      dryRun: result.dryRun,
      target: result.target,
      detail: result.detail,
      error: result.error,
      blocked: !result.ok && BLOCKED_CODES.has(code),
    };
  }

  private async performSleep(percent: number | null, settings: Settings, now: number): Promise<void> {
    if (this.sleeping) return;
    this.sleeping = true;
    this.setPhase('sleeping');
    this.lastAction = 'sleep';
    this.lastActionAt = now;
    this.lastActionTarget = 'system';
    this.record(
      'sleep',
      'system',
      'ok',
      `${percentLabel(percent)} <= sleep threshold ${settings.softStopSleepThreshold}%`,
    );
    const result = await this.options.performSleep(percent);
    if (result.ok) {
      this.lastError = null;
      this.setPhase('sleeping');
    } else {
      this.lastError = result.error ?? 'SUSPEND_FAILED';
      this.record('sleep', 'system', 'failed', this.lastError);
      this.setPhase('error', this.lastError);
    }
  }

  async detect(force = true): Promise<AiActivitySnapshot> {
    const snapshot = await this.detector.snapshot(force);
    this.lastSample = snapshot;
    this.lastSampleAt = Date.now();
    this.options.onChange();
    return snapshot;
  }

  /** Sends the configured prompt once through the current target without touching the battery cycle. */
  async testSend(): Promise<SoftStopSendResult> {
    const settings = this.options.getSettings();
    const prompt = normalizeSoftStopPrompt(
      renderTemplate(settings.softStopPrompt, {
        prompt: '',
        percent: this.options.getPower().batteryPercent,
        threshold: settings.softStopThreshold,
        sleepThreshold: settings.softStopSleepThreshold,
        model: '',
      }),
    );
    const snapshot = await this.detector.snapshot(true).catch(() => emptySnapshot());
    this.lastSample = snapshot;
    this.lastSampleAt = Date.now();
    const target = this.sender.chooseTarget(snapshot);
    if (!target) {
      this.record('skip', 'test', 'failed', 'no soft stop target configured');
      return {
        ok: false,
        dryRun: settings.softStopDryRun,
        adapterId: null,
        target: null,
        model: null,
        detail: 'No target configured for the current settings',
        error: 'NO_TARGET',
      };
    }
    const percent = this.options.getPower().batteryPercent;
    const outcome = await this.dispatch(target, percent, settings.softStopDryRun, prompt);
    const label = outcome.target ?? target.label;
    this.lastActionAt = Date.now();
    this.lastActionTarget = label;
    if (outcome.ok) {
      this.lastAction = outcome.dryRun ? 'dry-run' : 'sent';
      this.record(outcome.dryRun ? 'dry-run' : 'send', label, 'ok', `manual ${percentLabel(percent)} ${outcome.detail}`.trim());
      if (!outcome.dryRun) this.options.notifySent(label, percent);
    } else {
      this.lastAction = 'failed';
      this.lastError = outcome.error ?? 'SEND_FAILED';
      this.record('send', label, 'failed', `manual ${outcome.detail}`);
    }
    this.options.onChange();
    return {
      ok: outcome.ok,
      dryRun: outcome.dryRun,
      adapterId: target.adapter?.id ?? null,
      target: label,
      model: null,
      detail: outcome.detail,
      error: outcome.error,
    };
  }

  auditEntries(limit = 100): SoftStopAuditEntry[] {
    return this.audit.list(limit);
  }

  async scan(options: SoftStopScanOptions = {}): Promise<GuiPreview> {
    try {
      return await this.gui.scan({ capture: options.capture === true });
    } catch (error) {
      const settings = this.options.getSettings();
      return {
        ts: Date.now(),
        windows: [],
        candidates: [],
        target: null,
        allowlisted: false,
        dryRun: settings.softStopDryRun,
        needsConfirmation: false,
        blocked: errorText(error),
        profileId: null,
        screenshot: null,
      };
    }
  }

  recordStart(): Promise<GuiRecordStartResult> {
    return this.gui.recordStart();
  }

  recordStop(): Promise<GuiRecordResult> {
    return this.gui.recordStop();
  }

  recordStatus(): Promise<GuiRecordStatus> {
    return this.gui.recordStatus();
  }

  listProfiles(): GuiProfile[] {
    return this.profiles.list();
  }

  saveProfile(raw: unknown): GuiProfile | null {
    const saved = this.profiles.save(raw);
    if (!saved) return null;
    this.record(
      'profile',
      saved.process,
      'ok',
      `saved ${Object.keys(saved.labels).join(',') || 'empty'} confirmed=${saved.confirmed === true}`,
    );
    this.options.onChange();
    return saved;
  }

  deleteProfile(id: unknown): boolean {
    const profileId = normalizeProfileId(id);
    if (!profileId) return false;
    const removed = this.profiles.delete(profileId);
    if (removed) {
      this.record('profile', profileId, 'info', 'deleted');
      this.options.onChange();
    }
    return removed;
  }

  adapters(): SoftStopAdapterInfo[] {
    return this.sender.listAdapters();
  }

  setHttpKey(key: unknown): { ok: boolean; error?: string } {
    if (key !== null && typeof key !== 'string') return { ok: false, error: 'INVALID_KEY' };
    if (typeof key === 'string' && key.length > 8192) return { ok: false, error: 'INVALID_KEY' };
    const result = this.secrets.setKey(key);
    this.record('profile', 'http-key', result.ok ? 'ok' : 'failed', result.ok ? (key ? 'stored' : 'cleared') : String(result.error));
    this.options.onChange();
    return result;
  }

  async suspendNow(): Promise<{ ok: boolean; error?: string }> {
    this.record('sleep', 'system', 'info', 'manual protective sleep');
    if (this.options.getSession().active) {
      const result = await this.options.performSleep(this.options.getPower().batteryPercent);
      if (result.ok) this.setPhase('sleeping');
      return result;
    }
    try {
      if (!this.options.helper.connected) await this.options.helper.ensure();
      await this.options.helper.suspend();
      this.setPhase('sleeping');
      return { ok: true };
    } catch (error) {
      const message = errorText(error);
      this.record('sleep', 'system', 'failed', message);
      return { ok: false, error: message };
    }
  }
}
