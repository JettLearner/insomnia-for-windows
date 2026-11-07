import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { AutopilotAction, AutopilotTarget } from '../../shared/autopilot';
import type { Command, SettingsPatch, WindowName } from '../../shared/types';
import type { AutopilotService } from './autopilot-service';
import type { Controller } from './controller';
import type { WindowManager } from './windows';
import type { Logger } from './logger';

interface IpcOptions {
  controller: Controller;
  windows: WindowManager;
  autopilot: AutopilotService;
  requestQuit: () => void;
  userDataDir: string;
  logger: Logger;
  devUrl: string | null;
}

const WINDOW_NAMES = new Set<WindowName>(['panel', 'settings', 'onboarding', 'autopilot']);
const AUTOPILOT_TARGETS = new Set(['zcode', 'workbuddy', 'workbuddy-ai', 'generic', 'fallback-only']);
const ATTACHMENT_ACTIONS = new Set(['delete', 'restore', 'backup']);
const SECTIONS = new Set([
  'general',
  'shortcuts',
  'power',
  'battery',
  'softstop',
  'appearance',
  'privacy',
  'about',
]);

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
  handle('window:show-autopilot', () => {
    windows.showAutopilot();
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

  const { autopilot } = options;
  handle('autopilot:snapshot', () => autopilot.snapshot());
  handle('autopilot:save-job', (_event, raw) => autopilot.saveJob(raw));
  handle('autopilot:delete-job', (_event, raw) =>
    typeof raw === 'string' && raw.length <= 64 ? autopilot.deleteJob(raw) : { ok: false },
  );
  handle('autopilot:set-enabled', (_event, raw) => {
    const input = asRecord(raw);
    if (!input || typeof input.id !== 'string' || typeof input.enabled !== 'boolean') return { ok: false };
    return autopilot.setEnabled(input.id, input.enabled);
  });
  handle('autopilot:run-now', (_event, raw) =>
    typeof raw === 'string' && raw.length <= 64 ? autopilot.runNow(raw) : { ok: false, error: 'INVALID_JOB' },
  );
  handle('autopilot:cancel-run', (_event, raw) =>
    typeof raw === 'string' && raw.length <= 64 ? autopilot.cancelRun(raw) : { ok: false },
  );
  handle('autopilot:update-settings', (_event, raw) =>
    autopilot.updateSettings(asRecord(raw) ?? {}),
  );
  handle('autopilot:set-paused', (_event, raw) =>
    typeof raw === 'boolean' ? autopilot.setPaused(raw) : { ok: false },
  );
  handle('autopilot:windows', () => autopilot.windows());
  handle('autopilot:clear-runs', () => autopilot.clearRuns());
  handle('autopilot:set-api-key', (_event, raw) =>
    autopilot.setApiKey(typeof raw === 'string' ? raw : raw === null ? null : undefined),
  );
  handle('autopilot:has-api-key', () => autopilot.hasApiKey());
  handle('autopilot:pick-files', async (event) => {
    const owner =
      windows.getWindow('autopilot') ?? BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(owner!, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths.slice(0, 20);
  });
  handle('autopilot:sync', async (_event, raw) => {
    const target: AutopilotTarget =
      typeof raw === 'string' && AUTOPILOT_TARGETS.has(raw as AutopilotTarget)
        ? (raw as AutopilotTarget)
        : 'zcode';
    return autopilot.sync(target);
  });
  handle('autopilot:attachment-action', (_event, raw) => {
    const input = asRecord(raw);
    if (
      !input ||
      typeof input.attachmentId !== 'string' ||
      typeof input.jobId !== 'string' ||
      typeof input.type !== 'string' ||
      !ATTACHMENT_ACTIONS.has(input.type)
    ) {
      return { ok: false, error: 'INVALID_ACTION' };
    }
    return autopilot.attachmentAction(input as unknown as AutopilotAction);
  });

  handle('soft-stop:detect', () => controller.softStopDetect());
  handle('soft-stop:test-send', () => controller.softStopTestSend());
  handle('soft-stop:audit', (_event, raw) =>
    controller.softStopAudit(typeof raw === 'number' ? raw : undefined),
  );
  handle('soft-stop:scan', (_event, raw) => {
    const input = asRecord(raw);
    return controller.softStopScan({ capture: input?.capture === true });
  });
  handle('soft-stop:record-start', () => controller.softStopRecordStart());
  handle('soft-stop:record-stop', () => controller.softStopRecordStop());
  handle('soft-stop:record-status', () => controller.softStopRecordStatus());
  handle('soft-stop:profiles', () => controller.softStopProfiles());
  handle('soft-stop:save-profile', (_event, raw) => controller.softStopSaveProfile(raw));
  handle('soft-stop:delete-profile', (_event, raw) => controller.softStopDeleteProfile(raw));
  handle('soft-stop:adapters', () => controller.softStopAdapters());
  handle('soft-stop:set-key', (_event, raw) => controller.softStopSetKey(raw));
  handle('soft-stop:suspend', () => controller.softStopSuspendNow());
}
