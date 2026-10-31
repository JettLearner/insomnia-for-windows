import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { Command, SettingsPatch, WindowName } from '../../shared/types';
import type { Controller } from './controller';
import type { WindowManager } from './windows';
import type { Logger } from './logger';

interface IpcOptions {
  controller: Controller;
  windows: WindowManager;
  requestQuit: () => void;
  userDataDir: string;
  logger: Logger;
  devUrl: string | null;
}

const WINDOW_NAMES = new Set<WindowName>(['panel', 'settings', 'onboarding']);
const SECTIONS = new Set(['general', 'shortcuts', 'power', 'battery', 'appearance', 'privacy', 'about']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateCommand(value: unknown): Command | null {
  const input = asRecord(value);
  if (!input || typeof input.type !== 'string') return null;
  switch (input.type) {
    case 'toggle':
    case 'deactivate':
    case 'test':
    case 'reset-settings':
    case 'check-system':
    case 'recover-lid':
    case 'export-diagnostics':
      return { type: input.type } as Command;
    case 'activate': {
      if (input.durationMs === null) return { type: 'activate', durationMs: null };
      if (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs)) return null;
      return { type: 'activate', durationMs: Math.round(input.durationMs) };
    }
    case 'set-display':
      if (input.mode !== 'on' && input.mode !== 'auto') return null;
      return { type: 'set-display', mode: input.mode };
    case 'set-advanced':
      if (typeof input.enabled !== 'boolean') return null;
      return { type: 'set-advanced', enabled: input.enabled };
    case 'set-lid':
      if (typeof input.enabled !== 'boolean') return null;
      return { type: 'set-lid', enabled: input.enabled };
    case 'update-settings': {
      const patch = asRecord(input.patch);
      if (!patch) return null;
      return { type: 'update-settings', patch: patch as SettingsPatch };
    }
    case 'open-external':
      if (typeof input.url !== 'string' || input.url.length > 2048) return null;
      return { type: 'open-external', url: input.url };
    default:
      return null;
  }
}

export function registerIpc(options: IpcOptions): void {
  const { controller, windows, logger } = options;

  const trusted = (event: IpcMainInvokeEvent): boolean => {
    try {
      if (!windows.owns(event.sender)) return false;
      const url = event.senderFrame?.url ?? event.sender.getURL();
      if (options.devUrl) return url.startsWith(new URL(options.devUrl).origin);
      return url.startsWith('file://');
    } catch {
      return false;
    }
  };

  const handle = <T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => T): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) {
        logger.warn('rejected IPC from untrusted sender', { channel });
        throw new Error('Untrusted sender');
      }
      return fn(event, ...args);
    });
  };

  handle('app:bootstrap', () => controller.getBootstrap());

  handle('app:command', async (_event, raw) => {
    const command = validateCommand(raw);
    if (!command) {
      return { ok: false, error: controller.t('errIpc'), detail: 'INVALID_COMMAND', state: controller.getState() };
    }
    return controller.command(command);
  });

  handle('window:show-panel', () => {
    windows.showPanel();
  });
  handle('window:hide-panel', () => {
    windows.hidePanel();
  });
  handle('window:open-settings', (_event, raw) => {
    const section = typeof raw === 'string' && SECTIONS.has(raw) ? raw : 'general';
    windows.openSettings(section);
  });
  handle('window:show-onboarding', () => {
    windows.showOnboarding();
  });
  handle('window:close', (_event, raw) => {
    if (typeof raw === 'string' && WINDOW_NAMES.has(raw as WindowName)) {
      windows.closeWindow(raw as WindowName);
    }
  });
  handle('window:minimize', (_event, raw) => {
    if (typeof raw === 'string' && WINDOW_NAMES.has(raw as WindowName)) {
      windows.minimizeWindow(raw as WindowName);
    }
  });
  handle('app:open-data-folder', async () => {
    await shell.openPath(options.userDataDir);
  });
  handle('app:quit', () => {
    options.requestQuit();
  });
}
