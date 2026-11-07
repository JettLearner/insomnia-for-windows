import type { Logger } from './logger';

export interface AutosaveOptions {
  /** Fastest allowed interval (idle machine). */
  baseIntervalMs?: number;
  /** Slowest allowed interval (machine under load). */
  maxIntervalMs?: number;
  /** 0..1 load estimate, sampled when the next write is scheduled. */
  load: () => number;
  /** Performs the write. Must be synchronous and fast (atomic rename). */
  write: () => void;
  log?: Logger;
}

/**
 * Coalesces frequent state changes into periodic writes whose interval grows
 * with machine load. Terminal transitions call flushNow() and bypass the timer.
 */
export class AutosaveController {
  private readonly base: number;
  private readonly max: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private started = false;
  private failing = false;

  constructor(private readonly options: AutosaveOptions) {
    this.base = Math.max(50, options.baseIntervalMs ?? 500);
    this.max = Math.max(this.base, options.maxIntervalMs ?? 15_000);
  }

  /** Interval that would be used for a write scheduled right now. */
  intervalFor(load: number): number {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(load) ? load : 0));
    return Math.round(Math.min(this.max, this.base * (1 + 4 * clamped)));
  }

  get pending(): boolean {
    return this.dirty;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  markDirty(): void {
    this.dirty = true;
    if (!this.started) return;
    this.arm();
  }

  /** Immediate write; used on state transitions, quit, suspend and shutdown. */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.options.write();
      this.failing = false;
    } catch (error) {
      this.dirty = true;
      if (!this.failing) this.options.log?.error('autosave write failed', error);
      this.failing = true;
    }
  }

  private arm(): void {
    if (this.timer) return;
    const delay = this.intervalFor(safeLoad(this.options.load));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}

function safeLoad(load: () => number): number {
  try {
    return load();
  } catch {
    return 0;
  }
}
