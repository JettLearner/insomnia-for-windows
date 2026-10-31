import { globalShortcut } from 'electron';
import type { ShortcutBinder } from './controller';
import type { Logger } from './logger';

export class ShortcutManager implements ShortcutBinder {
  private current: string | null = null;

  constructor(
    private readonly onTrigger: () => void,
    private readonly log: Logger,
  ) {}

  apply(accelerator: string): boolean {
    if (this.current === accelerator && globalShortcut.isRegistered(accelerator)) return true;
    const previous = this.current;
    if (previous) {
      try {
        globalShortcut.unregister(previous);
      } catch {
        /* ignore */
      }
      this.current = null;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => this.onTrigger());
    } catch (error) {
      this.log.warn('shortcut registration threw', { message: (error as Error).message });
      ok = false;
    }
    if (!ok) {
      this.log.warn('shortcut unavailable', { accelerator });
      if (previous) {
        try {
          if (globalShortcut.register(previous, () => this.onTrigger())) this.current = previous;
        } catch {
          /* ignore */
        }
      }
      return false;
    }
    this.current = accelerator;
    this.log.info('global shortcut registered', { accelerator });
    return true;
  }

  describe(): { accelerator: string | null; registered: boolean } {
    const accelerator = this.current;
    let registered = false;
    if (accelerator) {
      try {
        registered = globalShortcut.isRegistered(accelerator);
      } catch {
        registered = false;
      }
    }
    return { accelerator, registered };
  }

  dispose(): void {
    if (this.current) {
      try {
        globalShortcut.unregister(this.current);
      } catch {
        /* ignore */
      }
      this.current = null;
    }
  }
}
