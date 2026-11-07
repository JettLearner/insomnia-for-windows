import type { AutopilotSettings } from '../../shared/autopilot';
import type { GuardState } from './autopilot-engine';
import type { Logger } from './logger';

/** Window titles or process names that mean someone else owns the desktop. */
const REMOTE_HINTS = [
  'todesk',
  'sunlogin',
  '向日葵',
  'teamviewer',
  'rustdesk',
  'anydesk',
  'parsec',
  'mstsc',
  'remote desktop',
  '远程桌面',
  'leoworkspace',
];

const CAPTURE_HINTS = ['obs64', 'obs studio', 'screen rec', '屏幕录制', 'bandicam', 'camtasia', 'snipping'];

export interface GuardWindow {
  title: string;
  process: string;
}

export interface ProtectionGateOptions {
  settings: () => AutopilotSettings;
  /** Snapshot of the desktop; polled, because the guard callback is synchronous. */
  listWindows: () => Promise<GuardWindow[]>;
  /** 0..1 total CPU busy ratio. */
  cpuBusy: () => Promise<number>;
  /** Soft stop or a teaching scan already owns input and screen. */
  desktopBusy: () => boolean;
  /** False when nothing could run anyway, so the desktop is never probed. */
  active?: () => boolean;
  log: Logger;
  onBusy?: (state: GuardState) => void;
  now?: () => number;
  setIntervalMs?: number;
  /** How long a busy reading keeps deferring work after it goes away. */
  coolDownMs?: number;
}

/**
 * Decides whether GUI automation may touch the desktop right now. Screen
 * capture, remote control and a loaded machine all mean "wait", and the
 * autopilot window hides itself so nothing is revealed on a shared screen.
 */
export class ProtectionGate {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly coolDownMs: number;
  private state: GuardState = 'ok';
  private busyUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly options: ProtectionGateOptions) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.setIntervalMs ?? 5000;
    this.coolDownMs = options.coolDownMs ?? 20_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Synchronous view used by the engine before every delivery. */
  current(): GuardState {
    return this.state;
  }

  async sample(): Promise<GuardState> {
    if (this.polling) return this.state;
    if (this.options.active && !this.options.active()) {
      this.state = 'ok';
      this.busyUntil = 0;
      return this.state;
    }
    this.polling = true;
    const settings = this.options.settings();
    let next: GuardState = 'ok';
    try {
      if (this.options.desktopBusy()) {
        next = 'capturing';
      } else {
        const windows = await this.options.listWindows();
        if (settings.protection.hideOnRemoteControl && matches(windows, REMOTE_HINTS)) {
          next = 'taken_over';
        } else if (settings.protection.hideOnCapture && matches(windows, CAPTURE_HINTS)) {
          next = 'capturing';
        } else if (settings.protection.throttleOnLoad) {
          const cpu = await this.options.cpuBusy().catch(() => 0);
          if (cpu > settings.protection.cpuBusyThreshold) next = 'hot';
        }
      }
    } catch (error) {
      this.options.log.debug('guard sample failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }

    const at = this.now();
    if (next !== 'ok') {
      this.busyUntil = at + this.coolDownMs;
    } else if (at < this.busyUntil) {
      // Hold the previous verdict so a flapping reading cannot start a run.
      next = this.state;
    }

    if (next !== this.state) {
      this.state = next;
      if (next !== 'ok') this.options.onBusy?.(next);
    }
    return this.state;
  }
}

function matches(windows: readonly GuardWindow[], hints: readonly string[]): boolean {
  return windows.some((win) => {
    const haystack = `${win.process} ${win.title}`.toLowerCase();
    return hints.some((hint) => haystack.includes(hint));
  });
}
