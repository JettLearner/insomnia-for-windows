import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  Bootstrap,
  Command,
  CommandResult,
  InsomniazApi,
  RuntimeState,
  WindowName,
} from '../shared/types';

const api: InsomniazApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap') as Promise<Bootstrap>,
  subscribe: (listener: (state: RuntimeState) => void) => {
    const handler = (_event: IpcRendererEvent, state: RuntimeState) => listener(state);
    ipcRenderer.on('state:update', handler);
    return () => ipcRenderer.removeListener('state:update', handler);
  },
  command: (command: Command) => ipcRenderer.invoke('app:command', command) as Promise<CommandResult>,
  showPanel: () => ipcRenderer.invoke('window:show-panel') as Promise<void>,
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
