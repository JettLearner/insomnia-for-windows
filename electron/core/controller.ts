import { app, dialog, nativeTheme, Notification, powerMonitor, powerSaveBlocker, screen, shell } from 'electron';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, release, totalmem, type } from 'node:os';
import {
  APP_VERSION,
  INACTIVE_SESSION,
  type Bootstrap,
  type Capabilities,
  type Command,
  type CommandResult,
  type DisplayInfo,
  type EffectiveLocale,
  type PowerInfo,
  type RuntimeState,
  type SessionState,
  type Settings,
  type SettingsPatch,
} from '../../shared/types';
import { translate, type MessageKey } from '../../shared/i18n';
import { formatRemaining } from '../../shared/format';
import { sanitizeTimerDuration } from '../../shared/settings';
import type {
  AiActivitySnapshot,
  GuiPreview,
  GuiProfile,
  GuiRecordResult,
  GuiRecordStartResult,
  GuiRecordStatus,
  SoftStopAdapterInfo,
  SoftStopAuditEntry,
  SoftStopSendResult,
} from '../../shared/soft-stop';
import { canonicalize, isValidAccelerator } from '../../shared/shortcut';
import type { Logger } from './logger';
import { hasLidRecovery, readLidRecovery, SessionStore, SettingsStore } from './store';
import { HelperClient, HelperError, type HelperStatus } from './helper-client';
import { SoftStopEngine, type SoftStopScanOptions } from './soft-stop-engine';

export interface ShortcutBinder {
  /** Unregisters the current accelerator and registers the next one. Returns false if taken. */
  apply(accelerator: string): boolean;
}

interface ControllerOptions {
  userDataDir: string;
  helperExe: string;
  recoveryPath: string;
  helperLog: string;
  logger: Logger;
  autopilotEnabled?: boolean;
}

type DeactivateReason = 'manual' | 'expired' | 'low-battery' | 'unplugged' | 'shutdown' | 'soft-stop';

const APP_STORE_URL = 'https://apps.apple.com/app/insomniaz-never-sleep/id1447041581';
const DEVELOPER_URL = 'https://pawandixit.com';

export class Controller extends EventEmitter {
  readonly helper: HelperClient;
  readonly settings: SettingsStore;
  readonly softStopEngine: SoftStopEngine;
  private readonly sessionStore: SessionStore;
  private readonly log: Logger;
  private readonly options: ControllerOptions;
  private session: SessionState = { ...INACTIVE_SESSION };
  private tickTimer: NodeJS.Timeout | null = null;
  private jiggleTimer: NodeJS.Timeout | null = null;
  private blockerId: number | null = null;
  private busyCount = 0;
  private elevationAttempted = false;
  private lidError: string | null = null;
  private lastLidSupported: boolean | null = null;
  private shortcutBinder: ShortcutBinder | null = null;
  private initialized = false;
  private shuttingDown = false;
  private lastHelperSync = 0;
  private lastHelperEnsure = 0;
  private lastBatteryPoll = 0;
  private lastSoftStopTick = 0;
  private lastTickSecond = 0;
  private reapplyingLid = false;
  private lidChain: Promise<unknown> = Promise.resolve();
  private readonly helperListeners: Array<[string, (...args: unknown[]) => void]> = [];

  constructor(options: ControllerOptions) {
    super();
    this.options = options;
    this.log = options.logger;
    this.settings = new SettingsStore(join(options.userDataDir, 'settings.json'), options.logger);
    this.sessionStore = new SessionStore(join(options.userDataDir, 'session.json'), options.logger);
    this.helper = new HelperClient({
      exePath: options.helperExe,
      recoveryPath: options.recoveryPath,
      logPath: options.helperLog,
      logger: options.logger,
    });
    this.softStopEngine = new SoftStopEngine({
      userDataDir: options.userDataDir,
      helper: this.helper,
      getSettings: () => this.settings.get(),
      getSession: () => this.session,
      getPower: () => this.getPowerInfo(),
      logger: options.logger,
      performSleep: (percent) => this.protectiveSleep(percent),
      notifySent: (target, percent) =>
        this.notify('notifySoftStopTitle', 'notifySoftStopBody', {
          target,
          percent: percent === null ? '—' : Math.round(percent),
        }),
      notifyFailed: (detail) => this.notify('notifySoftStopFailTitle', 'notifySoftStopFailBody', { detail }),
      onChange: () => this.emitState(),
    });
  }

  setShortcutBinder(binder: ShortcutBinder): void {
    this.shortcutBinder = binder;
  }

  get locale(): EffectiveLocale {
    const language = this.settings.get().language;
    if (language === 'zh-CN' || language === 'en-US') return language;
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
  }

  t(key: MessageKey, vars?: Record<string, string | number>): string {
    return translate(this.locale, key, vars);
  }

  async init(): Promise<void> {
    const settings = this.settings.load();
    this.log.info('controller starting', { version: APP_VERSION, locale: this.locale });
    try {
      nativeTheme.themeSource = settings.theme;
    } catch {
      /* ignore */
    }

    this.attachHelperEvents();
    this.attachPowerEvents();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.initialized = true;

    await this.restorePersistedSession();

    if (!this.session.active && settings.startActiveOnLaunch) {
      this.log.info('starting active on launch');
      await this.activate(settings.lastDurationMs, { interactive: false, silent: true });
    }

    this.emitState();
    void this.bootstrapHelper();
  }

  private async bootstrapHelper(): Promise<void> {
    try {
      const status = await this.helper.start(false, 18_000);
      this.absorbStatus(status);
      await this.syncHelperExecution();
      this.emitState();
    } catch (error) {
      this.log.warn('power helper unavailable at startup', { message: (error as Error).message });
      this.emitState();
    }
  }

  private attachHelperEvents(): void {
    const onConnected = (status: HelperStatus): void => {
      this.absorbStatus(status);
      void this.syncHelperExecution();
      this.emitState();
    };
    const onDisconnected = (reason: string): void => {
      this.log.warn('helper disconnected', { reason });
      if (this.session.lid) {
        this.session.lid = false;
        this.lidError = 'HELPER_OFFLINE';
      }
      this.emitState();
    };
    this.helper.on('connected', onConnected);
    this.helper.on('disconnected', onDisconnected);
    this.helperListeners.push(
      ['connected', onConnected as unknown as (...args: unknown[]) => void],
      ['disconnected', onDisconnected as unknown as (...args: unknown[]) => void],
    );
  }

  private attachPowerEvents(): void {
    powerMonitor.on('on-ac', () => {
      this.log.info('power cable connected');
      void this.refreshPowerStatus();
    });
    powerMonitor.on('on-battery', () => {
      this.log.info('running on battery');
      void this.refreshPowerStatus();
    });
    powerMonitor.on('resume', () => {
      this.log.info('system resumed');
      this.lastHelperSync = 0;
      this.softStopEngine.onResume();
      void this.syncHelperExecution();
      this.reassertLidIfNeeded();
      this.emitState();
    });
    powerMonitor.on('suspend', () => {
      this.log.info('system is suspending');
    });
    powerMonitor.on('shutdown', () => {
      this.log.info('Windows is shutting down');
    });
  }

  private absorbStatus(status: HelperStatus): void {
    if (typeof status.lidSupported === 'boolean') this.lastLidSupported = status.lidSupported;
    if (status.elevated === true) this.elevationAttempted = true;
    if (status.lidApplied === true && this.session.active) {
      this.session.lid = true;
    }
  }

  async restorePersistedSession(): Promise<void> {
    const settings = this.settings.get();
    const stored = this.sessionStore.load();
    if (!stored) {
      this.sessionStore.clear();
      return;
    }
    if (!settings.restoreSession) {
      this.log.info('session restore disabled; clearing stale session');
      this.sessionStore.clear();
      return;
    }
    if (stored.endsAt !== null && stored.endsAt <= Date.now()) {
      this.log.info('persisted session already expired');
      this.sessionStore.clear();
      return;
    }
    this.session = { ...stored, lid: false };
    this.log.info('restored session after restart', { endsAt: stored.endsAt });
    this.applyPowerBlocker();
    void this.syncHelperExecution();
    this.startJiggleIfNeeded();
    this.emitState();
  }

  getSettings(): Settings {
    return this.settings.get();
  }

  getRecoveryPending(): boolean {
    return !this.session.lid && hasLidRecovery(this.options.recoveryPath);
  }

  getState(): RuntimeState {
    const settings = this.settings.get();
    const power = this.getPowerInfo();
    const capabilities: Capabilities = {
      helperConnected: this.helper.connected,
      elevated: this.helper.elevated,
      lidPolicySupported: this.lastLidSupported,
      lidActive: this.session.lid,
      lidError: this.lidError,
      recoveryPending: this.getRecoveryPending(),
      helperVersion: this.helper.lastStatus?.version ?? null,
    };
    return {
      session: { ...this.session },
      settings,
      power,
      capabilities,
      displays: this.getDisplays(),
      softStop: this.softStopEngine.getStatus(),
      now: Date.now(),
      busy: this.busyCount > 0,
      locale: this.locale,
      version: APP_VERSION,
    };
  }

  getBootstrap(): Bootstrap {
    return {
      state: this.getState(),
      isDev: process.env.NODE_ENV === 'development',
      notificationSupported: Notification.isSupported(),
      loginItemSupported: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE,
      dataDir: this.options.userDataDir,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      platform: 'win32',
      autopilotEnabled: this.isAutopilotEnabled(),
    };
  }

  /** Autopilot is hidden unless it was explicitly enabled for this launch. */
  isAutopilotEnabled(): boolean {
    return this.options.autopilotEnabled === true;
  }

  private getDisplays(): DisplayInfo {
    try {
      const displays = screen.getAllDisplays();
      return { count: displays.length, external: displays.length > 1 };
    } catch {
      return { count: 1, external: false };
    }
  }

  private getPowerInfo(): PowerInfo {
    const battery = this.helper.lastStatus?.battery;
    if (battery?.available) {
      return {
        ac: battery.ac === true,
        batteryPercent: typeof battery.percent === 'number' ? battery.percent : null,
        charging: battery.charging === true,
        batteryPresent: battery.present !== false,
      };
    }
    let onBattery = false;
    try {
      onBattery = powerMonitor.isOnBatteryPower();
    } catch {
      /* ignore */
    }
    return {
      ac: !onBattery,
      batteryPercent: null,
      charging: false,
      batteryPresent: false,
    };
  }

  private emitState(): void {
    if (!this.initialized) return;
    this.emit('state', this.getState());
  }

  private setBusy(delta: 1 | -1): void {
    if (delta === 1) this.busyCount += 1;
    else this.busyCount = Math.max(0, this.busyCount - 1);
    this.emitState();
  }

  private persistSession(): void {
    if (this.session.active) this.sessionStore.save(this.session);
    else this.sessionStore.clear();
  }

  private tick(): void {
    const now = Date.now();
    if (this.session.active && this.session.endsAt !== null && this.session.endsAt <= now) {
      void this.deactivate('expired');
      return;
    }
    if (now - this.lastTickSecond >= 1000) {
      this.lastTickSecond = now;
      this.emitState();
    }
    if (now - this.lastHelperSync > 20_000) {
      this.lastHelperSync = now;
      void this.syncHelperExecution();
      this.reassertLidIfNeeded();
    }
    if (!this.helper.connected && now - this.lastHelperEnsure > 30_000) {
      this.lastHelperEnsure = now;
      void this.helper.ensure().then((ok) => {
        if (ok) {
          this.absorbStatus(this.helper.lastStatus ?? {});
          void this.syncHelperExecution();
          this.emitState();
        }
      });
    }
    if (now - this.lastSoftStopTick > 5_000) {
      this.lastSoftStopTick = now;
      void this.softStopEngine.tick(now);
    }
    const batteryInterval = this.settings.get().softStopEnabled ? 10_000 : 25_000;
    if (now - this.lastBatteryPoll > batteryInterval) {
      this.lastBatteryPoll = now;
      void this.refreshPowerStatus();
    }
  }

  private applyPowerBlocker(): void {
    this.stopPowerBlocker();
    if (!this.session.active) return;
    try {
      const type = this.session.displayMode === 'on' ? 'prevent-display-sleep' : 'prevent-app-suspension';
      this.blockerId = powerSaveBlocker.start(type);
      this.log.info('power save blocker started', { type, id: this.blockerId });
    } catch (error) {
      this.log.error('could not start power save blocker', error);
    }
  }

  private stopPowerBlocker(): void {
    if (this.blockerId === null) return;
    try {
      if (powerSaveBlocker.isStarted(this.blockerId)) powerSaveBlocker.stop(this.blockerId);
    } catch (error) {
      this.log.warn('could not stop power save blocker', { message: (error as Error).message });
    }
    this.blockerId = null;
  }

  async syncHelperExecution(): Promise<void> {
    if (!this.session.active) {
      if (this.helper.connected) {
        try {
          await this.helper.setExecution(false, false);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (!this.helper.connected) {
      if (Date.now() - this.lastHelperEnsure > 10_000) {
        this.lastHelperEnsure = Date.now();
        const ok = await this.helper.ensure();
        if (!ok) return;
      } else {
        return;
      }
    }
    try {
      await this.helper.setExecution(this.session.displayMode === 'on', true);
    } catch (error) {
      this.log.warn('could not set helper execution state', { message: (error as Error).message });
    }
  }

  /**
   * Serializes helper calls that mutate the lid policy. Without this, a
   * heartbeat re-assert could land after the user disabled lid protection and
   * leave "do nothing" applied with no session. Every apply/restore/recover
   * path goes through this queue.
   */
  private withLidLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lidChain.then(operation, operation);
    this.lidChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Re-assert the lid policy on the heartbeat. Windows can switch the active
   * power scheme while we are running (OEM tools, battery saver, the user).
   * The helper detects a scheme mismatch and migrates the "do nothing" value
   * to the new scheme; when nothing changed this is a cheap read/verify.
   */
  private reassertLidIfNeeded(): void {
    if (
      !this.session.active ||
      !this.session.lid ||
      !this.helper.connected ||
      !this.helper.elevated ||
      this.reapplyingLid
    ) {
      return;
    }
    this.reapplyingLid = true;
    void this.withLidLock(async () => {
      if (!this.session.active || !this.session.lid) return;
      await this.helper.applyLid();
    })
      .catch((error: unknown) => {
        this.log.warn('could not re-assert lid policy', { message: (error as Error).message });
      })
      .finally(() => {
        this.reapplyingLid = false;
      });
  }

  private async refreshPowerStatus(): Promise<void> {
    if (!this.helper.connected) {
      const ok = await this.helper.ensure();
      if (!ok) {
        this.emitState();
        return;
      }
    }
    try {
      const status = await this.helper.refreshStatus();
      this.absorbStatus(status);
    } catch (error) {
      this.log.warn('could not refresh power status', { message: (error as Error).message });
    }
    this.evaluateBattery();
    this.emitState();
  }

  private evaluateBattery(): void {
    if (!this.session.active) return;
    const settings = this.settings.get();
    // The two-stage soft stop flow owns battery actions while it is enabled;
    // the legacy guard would otherwise stop the session before stage B.
    if (settings.softStopEnabled) return;
    const power = this.getPowerInfo();
    if (settings.stopOnBattery && !power.ac) {
      this.log.info('stopping session because the PC is on battery');
      void this.deactivate('unplugged');
      return;
    }
    if (
      settings.batteryGuardEnabled &&
      !power.ac &&
      power.batteryPercent !== null &&
      power.batteryPercent <= settings.batteryThreshold
    ) {
      this.log.info('stopping session at battery guard threshold', {
        percent: power.batteryPercent,
        threshold: settings.batteryThreshold,
      });
      void this.deactivate('low-battery');
    }
  }

  private startJiggleIfNeeded(): void {
    if (this.jiggleTimer) {
      clearInterval(this.jiggleTimer);
      this.jiggleTimer = null;
    }
    if (!this.session.active || !this.session.advanced) return;
    const interval = Math.max(15, this.settings.get().activityIntervalSec) * 1000;
    this.jiggleTimer = setInterval(() => {
      if (!this.session.active || !this.session.advanced) return;
      void (async () => {
        try {
          if (!this.helper.connected) {
            const ok = await this.helper.ensure();
            if (!ok) return;
          }
          await this.helper.jiggle();
        } catch (error) {
          this.log.warn('activity simulation failed', { message: (error as Error).message });
        }
      })();
    }, interval);
    void (async () => {
      try {
        if (this.helper.connected) await this.helper.jiggle();
      } catch {
        /* ignore */
      }
    })();
  }

  async toggle(): Promise<CommandResult> {
    if (this.session.active) return this.deactivate('manual');
    return this.activate(this.chooseDuration());
  }

  private chooseDuration(): number | null {
    const settings = this.settings.get();
    return settings.lastDurationMs;
  }

  async activate(
    durationMs: number | null,
    options: { interactive?: boolean; silent?: boolean } = {},
  ): Promise<CommandResult> {
    const { interactive = true, silent = false } = options;
    const duration = sanitizeTimerDuration(durationMs);
    if (duration === undefined) {
      return this.fail('errGeneric', 'INVALID_DURATION');
    }

    const settings = this.settings.get();
    const power = this.getPowerInfo();
    if (!settings.softStopEnabled && settings.stopOnBattery && !power.ac) {
      return this.fail('errOnBattery', 'ON_BATTERY');
    }
    if (
      !settings.softStopEnabled &&
      settings.batteryGuardEnabled &&
      !power.ac &&
      power.batteryPercent !== null &&
      power.batteryPercent <= settings.batteryThreshold
    ) {
      return this.fail('errBatteryLow', 'BATTERY_LOW', {
        percent: Math.round(power.batteryPercent),
        threshold: settings.batteryThreshold,
      });
    }
    if (
      settings.softStopEnabled &&
      !power.ac &&
      power.batteryPercent !== null &&
      power.batteryPercent <= settings.softStopSleepThreshold
    ) {
      return this.fail('errBatteryLow', 'BATTERY_LOW', {
        percent: Math.round(power.batteryPercent),
        threshold: settings.softStopSleepThreshold,
      });
    }

    if (this.session.active) {
      const now = Date.now();
      this.session = {
        ...this.session,
        endsAt: duration === null ? null : now + duration,
        durationMs: duration,
      };
      this.settings.update({ lastDurationMs: duration });
      this.persistSession();
      this.applyPowerBlocker();
      this.startJiggleIfNeeded();
      void this.syncHelperExecution();
      this.emitState();
      return this.ok();
    }

    const now = Date.now();
    this.session = {
      active: true,
      startedAt: now,
      endsAt: duration === null ? null : now + duration,
      durationMs: duration,
      displayMode: settings.defaultDisplayMode,
      advanced: settings.advancedDefault,
      lid: false,
    };
    this.softStopEngine.onSessionStart(now);
    this.settings.update({ lastDurationMs: duration });
    this.persistSession();
    this.applyPowerBlocker();
    void this.syncHelperExecution();
    this.startJiggleIfNeeded();
    this.log.info('session started', { durationMs: duration });
    this.emitState();

    if (!silent) {
      const detail =
        duration === null
          ? this.t('notifyOnDetailInfinite')
          : this.t('notifyOnDetailTimed', { time: formatRemaining(duration, this.locale) });
      this.notify('notifyOnTitle', 'notifyOnBody', { detail });
    }

    if (interactive && settings.lidGuardPreferred) {
      const result = await this.applyLidInternal();
      if (!result.ok) return result;
    }
    return this.ok();
  }

  async deactivate(reason: DeactivateReason = 'manual'): Promise<CommandResult> {
    if (!this.session.active) {
      if (this.session.lid) {
        await this.restoreLidQuiet();
        this.emitState();
      }
      return this.ok();
    }    const wasLid = this.session.lid;
    this.stopPowerBlocker();
    if (this.jiggleTimer) {
      clearInterval(this.jiggleTimer);
      this.jiggleTimer = null;
    }
    if (this.helper.connected) {
      try {
        await this.helper.setExecution(false, false);
      } catch {
        /* ignore */
      }
    }
    if (wasLid) await this.restoreLidQuiet();

    this.session = { ...INACTIVE_SESSION };
    this.sessionStore.clear();
    this.softStopEngine.onSessionEnd();
    this.log.info('session stopped', { reason });
    this.emitState();

    if (reason === 'expired') {
      this.notify('notifyExpiredTitle', 'notifyExpiredBody');
    } else if (reason === 'low-battery') {
      const percent = this.getPowerInfo().batteryPercent;
      this.notify('notifyLowBatteryTitle', 'notifyLowBatteryBody', {
        percent: percent === null ? '—' : Math.round(percent),
      });
    } else if (reason === 'manual' || reason === 'unplugged') {
      this.notify('notifyOffTitle', 'notifyOffBody');
    }
    return this.ok();
  }

  private async restoreLidQuiet(): Promise<void> {
    if (!this.session.lid) return;
    try {
      if (!this.helper.connected) await this.helper.ensure();
      if (!this.helper.connected) throw new HelperError('HELPER_OFFLINE', 'The power helper is offline.');
      if (!this.helper.elevated) throw new HelperError('ELEVATION_REQUIRED', 'Administrator rights are required.');
      await this.withLidLock(() => this.helper.restoreLid());
      this.session.lid = false;
      this.lidError = null;
      this.log.info('lid policy restored');
    } catch (error) {
      const code = error instanceof HelperError ? error.code : 'RESTORE_FAILED';
      this.session.lid = false;
      this.lidError = code;
      this.log.warn('could not restore lid policy', { code, message: (error as Error).message });
      this.notify('notifyLidErrorTitle', 'notifyLidErrorBody', {
        detail: code,
      });
    }
  }

  private async applyLidInternal(): Promise<CommandResult> {
    if (!this.session.active) return this.fail('errNotSupported', 'NOT_ACTIVE');
    this.setBusy(1);
    try {
      let status: HelperStatus | null = this.helper.lastStatus;
      if (!this.helper.connected) {
        status = await this.helper.start(false, 20_000);
        this.absorbStatus(status);
      }
      if (status?.lidSupported === false) {
        throw new HelperError('LID_UNSUPPORTED', 'This PC does not expose a lid power policy.');
      }
      if (!this.helper.elevated) {
        if (this.elevationAttempted) {
          throw new HelperError('ELEVATION_RETRY', 'Administrator approval was declined earlier.');
        }
        const accepted = await this.promptElevation();
        this.elevationAttempted = true;
        if (!accepted) {
          throw new HelperError('ELEVATION_DENIED', 'Administrator approval was not granted.');
        }
        this.log.info('requesting elevated helper');
        const elevatedStatus = await this.helper.restartElevated();
        this.absorbStatus(elevatedStatus);
      }
      if (!this.session.active) {
        throw new HelperError('NOT_ACTIVE', 'The session ended before lid protection could be applied.');
      }
      const data = await this.withLidLock(() => this.helper.applyLid());
      if (data.readable === false) {
        throw new HelperError('LID_WRITE_FAILED', 'Windows did not accept the lid policy change.');
      }
      this.session.lid = true;
      this.lidError = null;
      this.settings.update({ lidGuardPreferred: true });
      this.persistSession();
      this.log.info('lid protection enabled');
      this.notify('notifyOnTitle', 'notifyOnBody', { detail: this.t('lidEnabledNotice') });
      this.emitState();
      return this.ok();
    } catch (error) {
      const code = this.errorCode(error);
      this.session.lid = false;
      this.lidError = code;
      this.settings.update({ lidGuardPreferred: false });
      this.persistSession();
      this.log.warn('lid protection failed', { code, message: (error as Error).message });
      if (code !== 'ELEVATION_RETRY' && code !== 'ELEVATION_DENIED') {
        this.notify('notifyLidErrorTitle', 'notifyLidErrorBody', { detail: code });
      }
      this.emitState();
      return this.fail(this.messageForCode(code), code);
    } finally {
      this.setBusy(-1);
    }
  }

  async setLid(enabled: boolean): Promise<CommandResult> {
    if (enabled) {
      if (!this.session.active) {
        this.settings.update({ lidGuardPreferred: true });
        this.emitState();
        return this.ok();
      }
      return this.applyLidInternal();
    }
    if (!this.session.lid) {
      this.settings.update({ lidGuardPreferred: false });
      this.lidError = null;
      this.emitState();
      return this.ok();
    }
    this.setBusy(1);
    try {
      if (!this.helper.connected) await this.helper.ensure();
      if (!this.helper.connected) throw new HelperError('HELPER_OFFLINE', 'The power helper is offline.');
      if (!this.helper.elevated) {
        if (this.elevationAttempted) {
          throw new HelperError('ELEVATION_RETRY', 'Administrator approval was declined earlier.');
        }
        const accepted = await this.promptElevation();
        this.elevationAttempted = true;
        if (!accepted) throw new HelperError('ELEVATION_DENIED', 'Administrator approval was not granted.');
        await this.helper.restartElevated();
      }
      await this.withLidLock(() => this.helper.restoreLid());
      this.session.lid = false;
      this.lidError = null;
      this.settings.update({ lidGuardPreferred: false });
      this.persistSession();
      this.notify('notifyOffTitle', 'notifyOffBody');
      this.emitState();
      return this.ok();
    } catch (error) {
      const code = this.errorCode(error);
      this.lidError = code;
      this.emitState();
      return this.fail(this.messageForCode(code), code);
    } finally {
      this.setBusy(-1);
    }
  }

  async recoverLid(): Promise<CommandResult> {
    if (!this.getRecoveryPending()) return this.fail('errNoRecovery', 'RECOVERY_NONE');
    this.setBusy(1);
    try {
      if (!this.helper.connected) await this.helper.start(false, 20_000);
      if (!this.helper.elevated) {
        if (this.elevationAttempted) {
          throw new HelperError('ELEVATION_RETRY', 'Administrator approval was declined earlier.');
        }
        const accepted = await this.promptElevation();
        this.elevationAttempted = true;
        if (!accepted) throw new HelperError('ELEVATION_DENIED', 'Administrator approval was not granted.');
        await this.helper.restartElevated();
      }
      await this.withLidLock(() => this.helper.recoverLid());
      this.lidError = null;
      this.settings.update({ lidGuardPreferred: false });
      this.emitState();
      this.notify('notifyOnTitle', 'notifyOnBody', { detail: this.t('recoveryDone') });
      return this.ok();
    } catch (error) {
      const code = this.errorCode(error);
      this.lidError = code;
      this.emitState();
      return this.fail(this.messageForCode(code), code);
    } finally {
      this.setBusy(-1);
    }
  }

  async setDisplayMode(mode: 'on' | 'auto'): Promise<CommandResult> {
    this.settings.update({ defaultDisplayMode: mode });
    if (this.session.active) {
      this.session.displayMode = mode;
      this.persistSession();
      this.applyPowerBlocker();
      await this.syncHelperExecution();
    }
    this.emitState();
    return this.ok();
  }

  async setAdvanced(enabled: boolean): Promise<CommandResult> {
    this.settings.update({ advancedDefault: enabled });
    if (this.session.active) {
      this.session.advanced = enabled;
      this.persistSession();
      this.startJiggleIfNeeded();
      await this.syncHelperExecution();
    }
    this.emitState();
    return this.ok();
  }

  async updateSettings(patch: SettingsPatch): Promise<CommandResult> {
    const previous = this.settings.get();
    if (typeof patch.shortcut === 'string' && patch.shortcut !== previous.shortcut) {
      const canonical = canonicalize(patch.shortcut);
      if (!canonical || !isValidAccelerator(canonical)) {
        return this.fail('shortcutInvalid', 'SHORTCUT_INVALID');
      }
      if (!this.shortcutBinder || !this.shortcutBinder.apply(canonical)) {
        return this.fail('shortcutConflict', 'SHORTCUT_CONFLICT');
      }
      patch = { ...patch, shortcut: canonical };
    }

    let next: Settings;
    try {
      next = this.settings.update(patch);
    } catch (error) {
      this.log.error('could not save settings', error);
      return this.fail('errSettings', 'SETTINGS_FAILED');
    }

    if (patch.theme !== undefined) {
      try {
        nativeTheme.themeSource = next.theme;
      } catch {
        /* ignore */
      }
    }
    if (patch.launchAtLogin !== undefined) this.applyLoginItem(next.launchAtLogin);
    if (patch.activityIntervalSec !== undefined && this.session.active && this.session.advanced) {
      this.startJiggleIfNeeded();
    }
    if (
      patch.stopOnBattery !== undefined ||
      patch.batteryGuardEnabled !== undefined ||
      patch.batteryThreshold !== undefined
    ) {
      this.evaluateBattery();
    }
    if (
      patch.softStopEnabled !== undefined ||
      patch.softStopThreshold !== undefined ||
      patch.softStopSleepThreshold !== undefined ||
      patch.softStopDryRun !== undefined
    ) {
      void this.softStopEngine.tick();
    }
    this.emitState();
    return this.ok();
  }

  async resetSettings(): Promise<CommandResult> {
    const defaults = this.settings.reset();
    if (this.shortcutBinder) this.shortcutBinder.apply(defaults.shortcut);
    this.applyLoginItem(defaults.launchAtLogin);
    try {
      nativeTheme.themeSource = defaults.theme;
    } catch {
      /* ignore */
    }
    this.emitState();
    return this.ok();
  }

  private applyLoginItem(enabled: boolean): void {
    if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) {
      this.log.info('login item not supported in this build');
      return;
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
        path: process.execPath,
        args: ['--hidden'],
      });
    } catch (error) {
      this.log.warn('could not update login item', { message: (error as Error).message });
    }
  }

  async checkSystem(): Promise<CommandResult> {
    this.setBusy(1);
    try {
      if (!this.helper.connected) {
        const status = await this.helper.start(false, 20_000);
        this.absorbStatus(status);
      } else {
        const status = await this.helper.refreshStatus();
        this.absorbStatus(status);
      }
      this.emitState();
      return this.ok();
    } catch (error) {
      const code = this.errorCode(error);
      this.lidError = code;
      this.emitState();
      return this.fail('errHelper', code);
    } finally {
      this.setBusy(-1);
    }
  }

  async testSession(): Promise<CommandResult> {
    const settings = this.settings.get();
    const result = await this.activate(10_000, { interactive: true, silent: true });
    if (!result.ok) return result;
    this.notify('notifyTestTitle', 'notifyTestBody');
    this.log.info('test session started', { advanced: settings.advancedDefault });
    return this.ok();
  }

  private async protectiveSleep(percent: number | null): Promise<{ ok: boolean; error?: string }> {
    this.notify('notifySoftStopSleepTitle', 'notifySoftStopSleepBody', {
      percent: percent === null ? '—' : Math.round(percent),
    });
    await this.deactivate('soft-stop');
    try {
      if (!this.helper.connected) await this.helper.ensure();
      if (!this.helper.connected) throw new HelperError('HELPER_OFFLINE', 'The power helper is offline.');
      await this.helper.suspend();
      this.log.info('protective sleep requested', { percent });
      return { ok: true };
    } catch (error) {
      const code = this.errorCode(error);
      this.log.warn('protective sleep failed', { code, message: (error as Error).message });
      this.notify('notifySoftStopFailTitle', 'notifySoftStopFailBody', { detail: code });
      return { ok: false, error: code };
    }
  }

  softStopDetect(): Promise<AiActivitySnapshot> {
    return this.softStopEngine.detect(true);
  }

  softStopTestSend(): Promise<SoftStopSendResult> {
    return this.softStopEngine.testSend();
  }

  softStopAudit(limit?: number): SoftStopAuditEntry[] {
    return this.softStopEngine.auditEntries(
      typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : 100,
    );
  }

  softStopScan(options: SoftStopScanOptions = {}): Promise<GuiPreview> {
    return this.softStopEngine.scan(options);
  }

  softStopRecordStart(): Promise<GuiRecordStartResult> {
    return this.softStopEngine.recordStart();
  }

  softStopRecordStop(): Promise<GuiRecordResult> {
    return this.softStopEngine.recordStop();
  }

  softStopRecordStatus(): Promise<GuiRecordStatus> {
    return this.softStopEngine.recordStatus();
  }

  softStopProfiles(): GuiProfile[] {
    return this.softStopEngine.listProfiles();
  }

  softStopSaveProfile(raw: unknown): CommandResult {
    const saved = this.softStopEngine.saveProfile(raw);
    if (!saved) return this.fail('errGeneric', 'INVALID_PROFILE');
    return this.ok();
  }

  softStopDeleteProfile(id: unknown): CommandResult {
    if (!this.softStopEngine.deleteProfile(id)) return this.fail('errGeneric', 'PROFILE_NOT_FOUND');
    return this.ok();
  }

  softStopAdapters(): SoftStopAdapterInfo[] {
    return this.softStopEngine.adapters();
  }

  softStopSetKey(key: unknown): CommandResult {
    const result = this.softStopEngine.setHttpKey(key);
    if (!result.ok) return this.fail('errGeneric', result.error ?? 'KEY_STORE_FAILED');
    return this.ok();
  }

  async softStopSuspendNow(): Promise<CommandResult> {
    const result = await this.softStopEngine.suspendNow();
    if (!result.ok) return this.fail('errGeneric', result.error ?? 'SUSPEND_FAILED');
    return this.ok();
  }

  async exportDiagnostics(): Promise<CommandResult> {
    try {
      const dir = join(this.options.userDataDir, 'diagnostics');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(dir, `InsomniaZ-diagnostics-${stamp}.json`);
      const payload = {
        generatedAt: new Date().toISOString(),
        app: {
          name: 'InsomniaZ',
          version: APP_VERSION,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          locale: this.locale,
        },
        system: {
          platform: process.platform,
          arch: process.arch,
          osType: type(),
          osRelease: release(),
          cpus: cpus().length,
          memoryBytes: totalmem(),
        },
        state: this.getState(),
        helperStatus: this.helper.lastStatus,
        recovery: readLidRecovery(this.options.recoveryPath),
        logTail: this.log.tail(200),
      };
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      shell.showItemInFolder(file);
      this.log.info('diagnostics exported');
      return { ok: true, state: this.getState(), path: file };
    } catch (error) {
      this.log.error('diagnostics export failed', error);
      return this.fail('errExport', 'EXPORT_FAILED');
    }
  }

  openExternal(url: string): CommandResult {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return this.fail('errNetwork', 'BAD_URL');
    }
    const isAppStore = parsed.protocol === 'https:' && parsed.hostname === 'apps.apple.com';
    const isDeveloper = parsed.protocol === 'https:' && parsed.hostname === 'pawandixit.com';
    if (!isAppStore && !isDeveloper) return this.fail('errNetwork', 'BLOCKED_URL');
    void shell.openExternal(parsed.toString());
    return this.ok();
  }

  async command(command: Command): Promise<CommandResult> {
    if (this.shuttingDown) return this.fail('errGeneric', 'SHUTTING_DOWN');
    if (this.busyCount > 0 && command.type !== 'export-diagnostics' && command.type !== 'open-external') {
      return this.fail('errGeneric', 'BUSY');
    }
    try {
      switch (command.type) {
        case 'toggle':
          return await this.toggle();
        case 'activate':
          return await this.activate(command.durationMs);
        case 'test':
          return await this.testSession();
        case 'deactivate':
          return await this.deactivate('manual');
        case 'set-display':
          return await this.setDisplayMode(command.mode === 'on' ? 'on' : 'auto');
        case 'set-advanced':
          return await this.setAdvanced(command.enabled === true);
        case 'set-lid':
          return await this.setLid(command.enabled === true);
        case 'update-settings':
          return await this.updateSettings(command.patch ?? {});
        case 'reset-settings':
          return await this.resetSettings();
        case 'check-system':
          return await this.checkSystem();
        case 'recover-lid':
          return await this.recoverLid();
        case 'export-diagnostics':
          return await this.exportDiagnostics();
        case 'open-external':
          return this.openExternal(command.url);
        default:
          return this.fail('errIpc', 'UNKNOWN_COMMAND');
      }
    } catch (error) {
      this.log.error('command failed', error);
      return this.fail('errGeneric', this.errorCode(error));
    }
  }

  async confirmQuit(): Promise<boolean> {
    if (!this.session.active && !this.session.lid) return true;
    const result = await dialog.showMessageBox({
      type: 'question',
      title: this.t('quitConfirmTitle'),
      message: this.t('quitConfirmTitle'),
      detail: this.t('quitConfirmBody'),
      buttons: [this.t('quitConfirmAction'), this.t('cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info('controller shutting down');
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.jiggleTimer) {
      clearInterval(this.jiggleTimer);
      this.jiggleTimer = null;
    }
    try {
      if (this.session.active) {
        await this.deactivate('shutdown');
      } else if (this.session.lid) {
        await this.restoreLidQuiet();
      }
    } catch (error) {
      this.log.warn('shutdown cleanup failed', { message: (error as Error).message });
    }
    try {
      await this.helper.stop();
    } catch (error) {
      this.log.warn('helper stop failed', { message: (error as Error).message });
    }
    for (const [event, listener] of this.helperListeners) {
      this.helper.removeListener(event, listener);
    }
    this.helperListeners.length = 0;
    this.removeAllListeners();
  }

  private async promptElevation(): Promise<boolean> {
    const result = await dialog.showMessageBox({
      type: 'question',
      title: this.t('elevationTitle'),
      message: this.t('elevationTitle'),
      detail: this.t('elevationBody'),
      buttons: [this.t('elevationEnable'), this.t('elevationNotNow')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  }

  private notify(titleKey: MessageKey, bodyKey: MessageKey, vars?: Record<string, string | number>): void {
    if (!this.settings.get().showNotifications) return;
    if (!Notification.isSupported()) return;
    try {
      const notification = new Notification({
        title: this.t(titleKey, vars),
        body: this.t(bodyKey, vars),
        silent: true,
      });
      notification.on('click', () => this.emit('show-panel'));
      notification.show();
    } catch (error) {
      this.log.warn('notification failed', { message: (error as Error).message });
    }
  }

  private ok(): CommandResult {
    return { ok: true, state: this.getState() };
  }

  private fail(key: MessageKey, detail: string, vars?: Record<string, string | number>): CommandResult {
    return { ok: false, state: this.getState(), error: this.t(key, vars), detail };
  }

  private errorCode(error: unknown): string {
    if (error instanceof HelperError) return error.code;
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return 'ELEVATION_DENIED';
    return 'INTERNAL';
  }

  private messageForCode(code: string): MessageKey {
    switch (code) {
      case 'ELEVATION_REQUIRED':
      case 'ELEVATION_DENIED':
        return 'errElevationDenied';
      case 'ELEVATION_RETRY':
        return 'errElevationRetry';
      case 'LID_UNSUPPORTED':
        return 'errLidUnsupported';
      case 'RECOVERY_NONE':
        return 'errNoRecovery';
      case 'HELPER_OFFLINE':
      case 'HELPER_TIMEOUT':
      case 'HELPER_START_FAILED':
      case 'HELPER_MISSING':
      case 'PIPE_ERROR':
        return 'errHelper';
      case 'LID_WRITE_FAILED':
      case 'RESTORE_FAILED':
      case 'RECOVERY_FAILED':
        return 'errPowerWrite';
      case 'SHORTCUT_INVALID':
        return 'shortcutInvalid';
      case 'SHORTCUT_CONFLICT':
        return 'shortcutConflict';
      case 'SHUTTING_DOWN':
        return 'errGeneric';
      default:
        return 'errGeneric';
    }
  }

  getAppLinks(): { appStore: string; developer: string } {
    return { appStore: APP_STORE_URL, developer: DEVELOPER_URL };
  }

  getRecoveryInfo(): ReturnType<typeof readLidRecovery> {
    return readLidRecovery(this.options.recoveryPath);
  }

  get isElevationAttempted(): boolean {
    return this.elevationAttempted;
  }
}
