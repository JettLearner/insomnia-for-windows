import { BrowserWindow, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { RuntimeState, WindowName } from '../../shared/types';
import type { Controller } from './controller';
import type { Logger } from './logger';

interface WindowManagerOptions {
  preloadPath: string;
  rendererFile: string;
  devUrl: string | null;
  appIcon: string;
  controller: Controller;
  logger: Logger;
}

const SHADOW = 12;

const PANEL = { width: 392, height: 700 };
const SETTINGS = { width: 860, height: 660 };
const ONBOARDING = { width: 560, height: 680 };

export class WindowManager {
  private panel: BrowserWindow | null = null;
  private settingsWindow: BrowserWindow | null = null;
  private onboardingWindow: BrowserWindow | null = null;
  private lastPanelBlur = 0;
  private closing = false;
  private section = 'general';
  private trayBounds: Rectangle | null = null;

  constructor(private readonly options: WindowManagerOptions) {}

  setTrayBounds(bounds: Rectangle | null): void {
    this.trayBounds = bounds;
  }

  owns(contents: Electron.WebContents): boolean {
    return [this.panel, this.settingsWindow, this.onboardingWindow].some(
      (win) => win !== null && !win.isDestroyed() && win.webContents === contents,
    );
  }

  getWindow(name: WindowName): BrowserWindow | null {
    if (name === 'panel') return this.panel;
    if (name === 'settings') return this.settingsWindow;
    return this.onboardingWindow;
  }

  isPanelVisible(): boolean {
    return this.panel?.isVisible() ?? false;
  }

  private get isDev(): boolean {
    return this.options.devUrl !== null;
  }

  private baseWindowOptions() {
    return {
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      title: 'InsomniaZ',
      icon: this.options.appIcon,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
        devTools: this.isDev,
      },
    } satisfies Electron.BrowserWindowConstructorOptions;
  }

  private attachSecurity(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      this.options.logger.warn('renderer failed to load', { code, description, url });
    });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) this.options.logger.warn('renderer console', { message });
      else this.options.logger.debug('renderer console', { message });
    });
    if (this.isDev) {
      win.webContents.on('before-input-event', (event, input) => {
        const devtools =
          input.key === 'F12' ||
          (input.control && input.shift && input.key.toLowerCase() === 'i');
        if (devtools) {
          event.preventDefault();
          win.webContents.toggleDevTools();
        }
      });
    }
  }

  private load(win: BrowserWindow, name: WindowName, extra?: Record<string, string>): void {
    const query = { window: name, ...(extra ?? {}) };
    const devUrl = this.options.devUrl;
    if (devUrl) {
      const url = new URL(devUrl);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      void win.loadURL(url.toString());
    } else {
      void win.loadFile(this.options.rendererFile, { query });
    }
  }

  /**
   * Returns the tallest panel that still fits above the taskbar on the display
   * under the cursor. Windows silently clamps an oversized window, which would
   * cut into the transparent shadow margin; doing the math up front keeps the
   * surface whole even on 768px-tall laptops.
   */
  private panelSurfaceHeight(): number {
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      return Math.max(620, Math.min(PANEL.height, display.workAreaSize.height - 32));
    } catch {
      return PANEL.height;
    }
  }

  createPanel(): BrowserWindow {
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    const win = new BrowserWindow({
      ...this.baseWindowOptions(),
      width: PANEL.width + SHADOW * 2,
      height: this.panelSurfaceHeight() + SHADOW * 2,
      movable: false,
      alwaysOnTop: true,
      type: 'toolbar',
      minimizable: false,
      maximizable: false,
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    this.panel = win;
    this.attachSecurity(win);
    this.load(win, 'panel');
    win.on('blur', () => this.onPanelBlur(win));
    win.on('close', (event) => this.interceptClose(win, event));
    win.on('hide', () => {
      if (this.isDev) win.webContents.closeDevTools();
    });
    return win;
  }

  private onPanelBlur(win: BrowserWindow): void {
    this.lastPanelBlur = Date.now();
    if (!this.options.controller.getSettings().closePanelOnBlur) return;
    setTimeout(() => {
      if (this.closing || win.isDestroyed()) return;
      if (win.webContents.isDevToolsOpened()) return;
      if (win.isVisible() && !win.isFocused()) win.hide();
    }, 140);
  }

  createSettings(): BrowserWindow {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) return this.settingsWindow;
    const win = new BrowserWindow({
      ...this.baseWindowOptions(),
      width: SETTINGS.width + SHADOW * 2,
      height: SETTINGS.height + SHADOW * 2,
      resizable: false,
      movable: true,
      type: 'normal',
    });
    win.setMenuBarVisibility(false);
    this.settingsWindow = win;
    this.attachSecurity(win);
    this.load(win, 'settings', { section: this.section });
    win.on('close', (event) => this.interceptClose(win, event));
    return win;
  }

  createOnboarding(): BrowserWindow {
    if (this.onboardingWindow && !this.onboardingWindow.isDestroyed()) return this.onboardingWindow;
    const win = new BrowserWindow({
      ...this.baseWindowOptions(),
      width: ONBOARDING.width + SHADOW * 2,
      height: ONBOARDING.height + SHADOW * 2,
      resizable: false,
      movable: true,
      type: 'normal',
    });
    this.onboardingWindow = win;
    this.attachSecurity(win);
    this.load(win, 'onboarding');
    win.on('close', (event) => this.interceptClose(win, event));
    return win;
  }

  private interceptClose(win: BrowserWindow, event: Electron.Event): void {
    if (this.closing) return;
    event.preventDefault();
    win.hide();
  }

  private placePanel(): void {
    const win = this.panel;
    if (!win) return;
    const [width, height] = win.getSize();
    let anchor = this.trayBounds;
    if (!anchor || anchor.width === 0) {
      const primary = screen.getPrimaryDisplay();
      anchor = {
        x: primary.workArea.x + primary.workArea.width - 36,
        y: primary.workArea.y + primary.workArea.height - 48,
        width: 24,
        height: 24,
      };
    }
    const display = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2),
    });
    const area = display.workArea;
    const targetCenter = anchor.x + anchor.width / 2;
    let x = Math.round(targetCenter - width / 2);
    x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
    let y = area.y + area.height - height - 8;
    if (anchor.y < area.y + area.height / 2) {
      y = area.y + 8;
    }
    win.setPosition(x, y, false);
  }

  showPanel(): void {
    const win = this.createPanel();
    this.placePanel();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.sendState(win);
  }

  hidePanel(): void {
    this.panel?.hide();
  }

  togglePanel(): void {
    const win = this.createPanel();
    if (win.isVisible() && win.isFocused()) {
      win.hide();
      return;
    }
    if (win.isVisible()) {
      // A pending blur handler is about to hide the panel; treat this as the
      // user asking for it to close.
      win.hide();
      return;
    }
    if (Date.now() - this.lastPanelBlur < 450) {
      // The panel just auto-hid because the tray was clicked; keep it closed.
      return;
    }
    this.showPanel();
  }

  openSettings(section?: string): void {
    const nextSection = section ?? 'general';
    this.section = nextSection;
    const exists = this.settingsWindow && !this.settingsWindow.isDestroyed();
    const win = this.createSettings();
    if (exists) {
      if (win.webContents.isLoadingMainFrame()) {
        win.webContents.once('did-finish-load', () => win.webContents.send('settings:section', nextSection));
      } else {
        win.webContents.send('settings:section', nextSection);
      }
    }
    this.centerOnCursor(win);
    win.show();
    win.focus();
    this.sendState(win);
  }

  showOnboarding(): void {
    const existed = this.onboardingWindow && !this.onboardingWindow.isDestroyed();
    const win = this.createOnboarding();
    if (existed) {
      this.load(win, 'onboarding', { restart: String(Date.now()) });
    }
    this.centerOnCursor(win);
    const show = () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        this.sendState(win);
      }
    };
    if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', show);
    else show();
  }

  private centerOnCursor(win: BrowserWindow): void {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const [width, height] = win.getSize();
    const area = display.workArea;
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(area.y + (area.height - height) / 2);
    win.setPosition(x, y, false);
  }

  closeWindow(name: WindowName): void {
    if (name === 'panel') this.panel?.hide();
    else if (name === 'settings') this.settingsWindow?.hide();
    else this.onboardingWindow?.hide();
  }

  minimizeWindow(name: WindowName): void {
    this.closeWindow(name);
  }

  sendState(win: BrowserWindow): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('state:update', this.options.controller.getState());
  }

  broadcast(state: RuntimeState): void {
    for (const win of [this.panel, this.settingsWindow, this.onboardingWindow]) {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (!win.isVisible()) continue;
      win.webContents.send('state:update', state);
    }
  }

  prepareForQuit(): void {
    this.closing = true;
  }

  destroyAll(): void {
    this.closing = true;
    for (const win of [this.panel, this.settingsWindow, this.onboardingWindow]) {
      if (win && !win.isDestroyed()) win.destroy();
    }
    this.panel = null;
    this.settingsWindow = null;
    this.onboardingWindow = null;
  }

  get preloadPath(): string {
    return join(__dirname, 'preload.cjs');
  }
}
