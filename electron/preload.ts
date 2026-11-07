import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  Bootstrap,
  Command,
  CommandResult,
  InsomniazApi,
  RuntimeState,
  WindowName,
} from '../shared/types';
import type {
  AutopilotAction,
  AutopilotJobSaveResult,
  AutopilotRunActionResult,
  AutopilotSettings,
  AutopilotSnapshot,
  AutopilotSyncResult,
  AutopilotTarget,
  AutopilotWindowInfo,
} from '../shared/autopilot';
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
} from '../shared/soft-stop';

const api: InsomniazApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap') as Promise<Bootstrap>,
  subscribe: (listener: (state: RuntimeState) => void) => {
    const handler = (_event: IpcRendererEvent, state: RuntimeState) => listener(state);
    ipcRenderer.on('state:update', handler);
    return () => ipcRenderer.removeListener('state:update', handler);
  },
  command: (command: Command) => ipcRenderer.invoke('app:command', command) as Promise<CommandResult>,
  softStop: {
    detect: () => ipcRenderer.invoke('soft-stop:detect') as Promise<AiActivitySnapshot>,
    testSend: () => ipcRenderer.invoke('soft-stop:test-send') as Promise<SoftStopSendResult>,
    getAudit: () => ipcRenderer.invoke('soft-stop:audit') as Promise<SoftStopAuditEntry[]>,
    scan: (options?: { capture?: boolean }) =>
      ipcRenderer.invoke('soft-stop:scan', options ?? {}) as Promise<GuiPreview>,
    recordStart: () => ipcRenderer.invoke('soft-stop:record-start') as Promise<GuiRecordStartResult>,
    recordStop: () => ipcRenderer.invoke('soft-stop:record-stop') as Promise<GuiRecordResult>,
    recordStatus: () => ipcRenderer.invoke('soft-stop:record-status') as Promise<GuiRecordStatus>,
    listProfiles: () => ipcRenderer.invoke('soft-stop:profiles') as Promise<GuiProfile[]>,
    saveProfile: (profile: GuiProfile) =>
      ipcRenderer.invoke('soft-stop:save-profile', profile) as Promise<CommandResult>,
    deleteProfile: (id: string) =>
      ipcRenderer.invoke('soft-stop:delete-profile', id) as Promise<CommandResult>,
    adapters: () => ipcRenderer.invoke('soft-stop:adapters') as Promise<SoftStopAdapterInfo[]>,
    setHttpKey: (key: string | null) =>
      ipcRenderer.invoke('soft-stop:set-key', key) as Promise<CommandResult>,
    suspendNow: () => ipcRenderer.invoke('soft-stop:suspend') as Promise<CommandResult>,
  },
  autopilot: {
    snapshot: () => ipcRenderer.invoke('autopilot:snapshot') as Promise<AutopilotSnapshot>,
    saveJob: (raw: unknown) => ipcRenderer.invoke('autopilot:save-job', raw) as Promise<AutopilotJobSaveResult>,
    deleteJob: (id: string) => ipcRenderer.invoke('autopilot:delete-job', id) as Promise<{ ok: boolean }>,
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('autopilot:set-enabled', { id, enabled }) as Promise<{ ok: boolean }>,
    runNow: (id: string) => ipcRenderer.invoke('autopilot:run-now', id) as Promise<AutopilotRunActionResult>,
    cancelRun: (runId: string) =>
      ipcRenderer.invoke('autopilot:cancel-run', runId) as Promise<{ ok: boolean }>,
    updateSettings: (patch: Partial<AutopilotSettings>) =>
      ipcRenderer.invoke('autopilot:update-settings', patch) as Promise<AutopilotSettings>,
    setPaused: (paused: boolean) => ipcRenderer.invoke('autopilot:set-paused', paused) as Promise<{ ok: boolean }>,
    windows: () => ipcRenderer.invoke('autopilot:windows') as Promise<AutopilotWindowInfo[]>,
    sync: (target: AutopilotTarget) => ipcRenderer.invoke('autopilot:sync', target) as Promise<AutopilotSyncResult>,
    clearRuns: () => ipcRenderer.invoke('autopilot:clear-runs') as Promise<{ ok: boolean }>,
    attachmentAction: (action: AutopilotAction) =>
      ipcRenderer.invoke('autopilot:attachment-action', action) as Promise<{ ok: boolean; error?: string }>,
    pickFiles: () => ipcRenderer.invoke('autopilot:pick-files') as Promise<string[]>,
    setApiKey: (key: string | null) =>
      ipcRenderer.invoke('autopilot:set-api-key', key) as Promise<{ ok: boolean; error?: string }>,
    hasApiKey: () => ipcRenderer.invoke('autopilot:has-api-key') as Promise<boolean>,
    onUpdate: (listener: (snapshot: AutopilotSnapshot) => void) => {
      const handler = (_event: IpcRendererEvent, snapshot: AutopilotSnapshot) => listener(snapshot);
      ipcRenderer.on('autopilot:update', handler);
      return () => ipcRenderer.removeListener('autopilot:update', handler);
    },
  },
  showPanel: () => ipcRenderer.invoke('window:show-panel') as Promise<void>,
  showAutopilot: () => ipcRenderer.invoke('window:show-autopilot') as Promise<void>,
  hidePanel: () => ipcRenderer.invoke('window:hide-panel') as Promise<void>,
  openSettings: (section?: string) => ipcRenderer.invoke('window:open-settings', section) as Promise<void>,
  showOnboarding: () => ipcRenderer.invoke('window:show-onboarding') as Promise<void>,
  closeWindow: (name: WindowName) => ipcRenderer.invoke('window:close', name) as Promise<void>,
  minimizeWindow: (name: WindowName) => ipcRenderer.invoke('window:minimize', name) as Promise<void>,
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder') as Promise<void>,
  onNavigateSection: (listener: (section: string) => void) => {
    const handler = (_event: IpcRendererEvent, section: string) => listener(section);
    ipcRenderer.on('settings:section', handler);
    return () => ipcRenderer.removeListener('settings:section', handler);
  },
  quit: () => ipcRenderer.invoke('app:quit') as Promise<void>,
};

try {
  contextBridge.exposeInMainWorld('insomniaz', api);
} catch {
  // Expose only for the one-argument contextBridge path used by tests.
  (globalThis as unknown as { insomniaz: InsomniazApi }).insomniaz = api;
}
