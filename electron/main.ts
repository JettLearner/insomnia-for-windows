import { app, Menu, dialog, Notification, powerMonitor, screen } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AutopilotService } from './core/autopilot-service';
import { Controller } from './core/controller';
import { WindowManager } from './core/windows';
import { TrayController } from './core/tray';
import { ShortcutManager } from './core/shortcuts';
import { Logger } from './core/logger';
import { installNetGuard } from './core/net-guard';
import { registerIpc } from './core/ipc';
import type { WindowName } from '../shared/types';

const captureMode = process.argv.includes('--capture');
const smokeMode = process.argv.includes('--smoke');
const freshMode = process.argv.includes('--smoke-fresh');
const devUrl = process.env.VITE_DEV_SERVER_URL ?? null;

const appRoot = app.getAppPath();
if (captureMode) app.setPath('userData', join(appRoot, 'docs', '.capture-profile'));
if (smokeMode) app.setPath('userData', join(appRoot, 'docs', '.smoke-profile'));
let freshProfile: string | null = null;
if (freshMode) {
  freshProfile = mkdtempSync(join(tmpdir(), 'insomniaz-fresh-'));
  app.setPath('userData', freshProfile);
}

if (captureMode || smokeMode || freshMode || process.env.INSOMNIAZ_SOFTWARE === '1') {
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch('disable-breakpad');

let controller: Controller | null = null;
let windows: WindowManager | null = null;
let tray: TrayController | null = null;
let shortcuts: ShortcutManager | null = null;
let logger: Logger | null = null;
let autopilot: AutopilotService | null = null;
let quitting = false;

function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : join(appRoot, 'resources');
  return join(base, ...parts);
}

function requestQuit(): void {
  void (async () => {
    if (!controller) {
      app.quit();
      return;
    }
    const confirmed = await controller.confirmQuit();
    if (confirmed) app.quit();
  })();
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.insomniaz.windows');

  const userDataDir = app.getPath('userData');
  mkdirSync(userDataDir, { recursive: true });
  logger = new Logger(userDataDir);
  logger.info('InsomniaZ starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    capture: captureMode,
  });

  const helperExe = resourcePath('helper', 'InsomniaZHelper.exe');
  if (!existsSync(helperExe)) {
    logger.error(`power helper missing at ${helperExe}`);
  }

  installNetGuard(devUrl, logger);

  controller = new Controller({
    userDataDir,
    helperExe,
    recoveryPath: join(userDataDir, 'lid-recovery.json'),
    helperLog: join(userDataDir, 'helper.log'),
    logger,
  });

  shortcuts = new ShortcutManager(() => {
    void controller?.toggle().then((result) => {
      if (!result.ok && result.error) logger?.warn('shortcut action failed', { message: result.error });
    });
  }, logger);
  controller.setShortcutBinder(shortcuts);

  windows = new WindowManager({
    preloadPath: join(__dirname, 'preload.cjs'),
    rendererFile: join(appRoot, 'dist', 'renderer', 'index.html'),
    devUrl,
    appIcon: resourcePath('icon.png'),
    controller,
    logger,
  });

  const autoHelperExe = resourcePath('helper', 'InsomniaZAuto.exe');
  if (!existsSync(autoHelperExe)) {
    logger.warn('automation helper missing; scheduled deliveries will fail', { autoHelperExe });
  }
  autopilot = new AutopilotService({
    userDataDir,
    log: logger,
    autoHelperExe,
    tempDir: () => join(userDataDir, 'autopilot-tmp'),
    softStopActive: () => {
      const phase = controller?.getState().softStop.phase ?? 'off';
      return phase === 'detected' || phase === 'sending' || phase === 'sent' || phase === 'sleeping';
    },
    onGuardBusy: () => windows?.hideAutopilot(),
    notify: (title, body) => {
      if (Notification.isSupported()) {
        new Notification({ title: 'InsomniaZ 定时投递', body: `${title} · ${body}`, silent: true }).show();
      }
    },
  });
  autopilot.onChange((snapshot) => windows?.broadcastAutopilot(snapshot));

  tray = new TrayController({
    controller,
    windows,
    activeIcon: resourcePath('tray-active.png'),
    idleIcon: resourcePath('tray-idle.png'),
    requestQuit,
    logger,
  });

  controller.on('state', (state) => {
    tray?.update(state);
    windows?.broadcast(state);
  });
  controller.on('show-panel', () => windows?.showPanel());

  registerIpc({
    controller,
    windows,
    autopilot,
    requestQuit,
    userDataDir,
    logger,
    devUrl,
  });

  await controller.init();

  const settings = controller.getSettings();
  if (!shortcuts.apply(settings.shortcut)) {
    logger.warn('configured shortcut is unavailable', { shortcut: settings.shortcut });
    if (settings.shortcut !== 'Ctrl+Alt+I' && shortcuts.apply('Ctrl+Alt+I')) {
      await controller.updateSettings({ shortcut: 'Ctrl+Alt+I' });
    }
  }

  tray.create();
  tray.update(controller.getState());

  // UI acceptance runs must never trigger real deliveries on a live desktop.
  if (!captureMode && !smokeMode && !freshMode) {
    autopilot.start();
    powerMonitor.on('suspend', () => autopilot?.flush());
    powerMonitor.on('shutdown', () => autopilot?.flush());
  }

  if (!settings.onboardingComplete) {
    windows.showOnboarding();
  }
  if (captureMode) {
    await runCapture();
    return;
  }
  if (smokeMode) {
    await runSmoke();
    return;
  }
  if (freshMode) {
    await runFreshSmoke();
    return;
  }
}

async function runCapture(): Promise<void> {
  if (!controller || !windows || !logger) return;
  const outDir = join(appRoot, 'docs', 'captures');
  mkdirSync(outDir, { recursive: true });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const capture = async (name: string, windowName: WindowName, margin = 12): Promise<void> => {
    const win = windows?.getWindow(windowName);
    if (!win) return;
    if (win.webContents.isLoadingMainFrame()) {
      await new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve());
        setTimeout(resolve, 5000);
      });
    }
    await wait(700);
    const [width, height] = win.getContentSize();
    const image = await win.webContents.capturePage({
      x: margin,
      y: margin,
      width: Math.max(1, width - margin * 2),
      height: Math.max(1, height - margin * 2),
    });
    writeFileSync(join(outDir, `${name}.png`), image.toPNG());
    logger?.info('capture saved', { name });
  };

  await controller.updateSettings({ language: 'en-US', showNotifications: false, animations: false });
  windows.showPanel();
  await capture('panel-idle-en', 'panel');

  await controller.updateSettings({ language: 'zh-CN' });
  await capture('panel-idle-zh', 'panel');
  await controller.updateSettings({ language: 'en-US' });

  await controller.activate(30 * 60_000, { interactive: false, silent: true });
  await capture('panel-active-auto-en', 'panel');

  await controller.setDisplayMode('on');
  await capture('panel-active-on-en', 'panel');

  await controller.updateSettings({ language: 'zh-CN' });
  await capture('panel-active-on-zh', 'panel');

  await controller.deactivate('manual');
  await controller.setDisplayMode('auto');
  await controller.updateSettings({ language: 'en-US' });

  windows.openSettings('general');
  await capture('settings-general-en', 'settings');

  for (const section of ['shortcuts', 'power', 'battery', 'softstop', 'appearance', 'privacy', 'about']) {
    windows.openSettings(section);
    await wait(350);
    await capture(`settings-${section}-en`, 'settings');
  }

  // The soft stop page is taller than one window; document its lower cards too.
  windows.openSettings('softstop');
  for (const [name, title] of [
    ['settings-softstop-target-en', 'Delivery target'],
    ['settings-softstop-teaching-en', 'Teaching mode'],
  ] as const) {
    await windows.getWindow('settings')?.webContents.executeJavaScript(`(() => {
      const main = document.querySelector('.settings-main');
      if (!main) return false;
      const card = [...main.querySelectorAll('.card')].find(
        (el) => el.querySelector('.card-head')?.textContent?.trim() === ${JSON.stringify(title)},
      );
      if (!card) return false;
      main.scrollTop += card.getBoundingClientRect().top - main.getBoundingClientRect().top - 18;
      return true;
    })()`);
    await wait(320);
    await capture(name, 'settings');
  }

  // The autopilot window is a separate native-shell window; capture its two
  // primary states without persisting anything.
  windows.showAutopilot();
  await wait(900);
  await capture('autopilot-jobs-en', 'autopilot', 0);
  await windows.getWindow('autopilot')?.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.ap-btn')].find((el) => el.textContent === 'New task');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await wait(450);
  await capture('autopilot-editor-en', 'autopilot', 0);

  await controller.updateSettings({ theme: 'light' });
  windows.openSettings('general');
  await wait(450);
  await capture('settings-general-light-en', 'settings');
  await controller.updateSettings({ theme: 'system' });

  windows.showOnboarding();
  await wait(900);
  await capture('onboarding-1-en', 'onboarding');
  const clickNext = async (): Promise<void> => {
    const win = windows?.getWindow('onboarding');
    if (!win) return;
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="onboarding-next"]')?.click()`,
    );
    await wait(500);
  };
  await clickNext();
  await capture('onboarding-2-en', 'onboarding');
  await clickNext();
  await capture('onboarding-3-en', 'onboarding');

  await controller.updateSettings({ language: 'zh-CN' });
  windows.getWindow('onboarding')?.webContents.reload();
  await wait(900);
  await capture('onboarding-1-zh', 'onboarding');
  await controller.updateSettings({ language: 'en-US' });

  logger.info('capture run complete');
  await controller.shutdown();
  tray?.destroy();
  windows.destroyAll();
  app.exit(0);
}

/**
 * Reads GWL_EXSTYLE from a live BrowserWindow. This is the only direct proof
 * that skipTaskbar reached the Win32 window rather than just the JS options.
 */
function windowExStyle(win: Electron.BrowserWindow): number | null {
  try {
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    const script = [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class InsomniazNative { [DllImport(\"user32.dll\")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex); }'",
      `[InsomniazNative]::GetWindowLongPtr([IntPtr]${hwnd.toString()}, -20).ToInt64()`,
    ].join('; ');
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (out.status !== 0) return null;
    const parsed = Number.parseInt((out.stdout || '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const WS_EX_TOOLWINDOW = 0x00000080;

function hasSkipTaskbarStyle(win: Electron.BrowserWindow): boolean {
  const style = windowExStyle(win);
  return style !== null && (style & WS_EX_TOOLWINDOW) !== 0;
}

function insideWorkArea(win: Electron.BrowserWindow): boolean {
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  return (
    bounds.x >= area.x &&
    bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  );
}

async function runFreshSmoke(): Promise<void> {
  if (!controller || !windows || !logger) return;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const record = (name: string, ok: boolean, detail?: string): void => {
    results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };

  try {
    const onboarding = windows.getWindow('onboarding');
    if (onboarding) {
      if (onboarding.webContents.isLoadingMainFrame()) {
        await new Promise<void>((resolve) => onboarding.webContents.once('did-finish-load', () => resolve()));
      }
      await wait(700);
    }
    record(
      'fresh.onboarding-auto-open',
      onboarding !== null && onboarding.isVisible(),
      onboarding ? `visible=${onboarding.isVisible()}` : 'window missing',
    );
    if (onboarding) {
      const probe = (await onboarding.webContents.executeJavaScript(
        `({ app: document.body.dataset.app, bootError: window.__insomniazBootError || null, textLength: document.body.innerText.length, hasNext: !!document.querySelector('[data-testid="onboarding-next"]'), step: (document.body.innerText.match(/(STEP \\d OF 3|第 \\d 步)/i) || [''])[0] })`,
        true,
      )) as { app?: string; bootError?: string | null; textLength: number; hasNext: boolean; step: string };
      record(
        'fresh.onboarding-render',
        probe.app === 'onboarding' && !probe.bootError && probe.textLength > 200 && probe.hasNext && probe.step.length > 0,
        JSON.stringify(probe),
      );
      record('fresh.onboarding-onscreen', insideWorkArea(onboarding));
    }

    const settings = controller.getSettings();
    record(
      'fresh.default-settings',
      settings.onboardingComplete === false &&
        settings.shortcut === 'Ctrl+Alt+I' &&
        settings.startActiveOnLaunch === false &&
        controller.getState().session.active === false,
      `onboarding=${settings.onboardingComplete} shortcut=${settings.shortcut}`,
    );
    record('fresh.panel-hidden', windows.isPanelVisible() === false);
    record('fresh.tray-ready', tray?.describe().ready === true, JSON.stringify(tray?.describe()));
    const shortcut = shortcuts?.describe();
    record(
      'fresh.shortcut-registered',
      shortcut?.registered === true && shortcut.accelerator === settings.shortcut,
      JSON.stringify(shortcut),
    );
    record(
      'fresh.helper-connected',
      controller.getState().capabilities.helperConnected === true,
      JSON.stringify(controller.getState().capabilities),
    );
  } catch (error) {
    record('fresh.error', false, (error as Error).stack ?? (error as Error).message);
  }

  const ok = results.every((result) => result.ok);
  logger.info('fresh profile smoke result', { ok, results });
  writeFileSync(
    join(appRoot, 'docs', 'smoke-fresh.json'),
    `${JSON.stringify({ ok, ranAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
  console.log(JSON.stringify(results, null, 2));
  await controller.shutdown();
  tray?.destroy();
  windows.destroyAll();
  if (freshProfile) {
    try {
      rmSync(freshProfile, { recursive: true, force: true });
    } catch {
      /* Chromium may still hold cache files; the OS temp cleaner will get them. */
    }
  }
  app.exit(ok ? 0 : 1);
}

async function runSmoke(): Promise<void> {
  if (!controller || !windows || !logger) return;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const record = (name: string, ok: boolean, detail?: string): void => {
    results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };
  const evalIn = async <T,>(win: Electron.BrowserWindow, script: string): Promise<T> =>
    (await win.webContents.executeJavaScript(script, true)) as T;
  const ready = async (win: Electron.BrowserWindow): Promise<void> => {
    if (win.webContents.isLoadingMainFrame()) {
      await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
    }
    await wait(700);
  };
  type Probe = { app?: string; bootError?: string | null; textLength: number };

  try {
    await controller.updateSettings({
      language: 'en-US',
      theme: 'system',
      showNotifications: false,
      animations: false,
      compactDensity: false,
    });
    if (controller.getState().session.active) await controller.deactivate('manual');

    // --- Panel -------------------------------------------------------------
    windows.showPanel();
    const panel = windows.getWindow('panel');
    if (!panel) throw new Error('panel window missing');
    await ready(panel);
    const panelProbe = await evalIn<Probe>(
      panel,
      `({ app: document.body.dataset.app, bootError: window.__insomniazBootError || null, textLength: document.body.innerText.length })`,
    );
    record(
      'panel.render',
      panelProbe.app === 'panel' && !panelProbe.bootError && panelProbe.textLength > 40,
      JSON.stringify(panelProbe),
    );
    const panelBounds = panel.getBounds();
    record(
      'panel.bounds',
      panelBounds.width === 416 && panelBounds.height === 724,
      `${panelBounds.width}x${panelBounds.height}`,
    );
    record('panel.skip-taskbar', hasSkipTaskbarStyle(panel), `exStyle=${windowExStyle(panel) ?? 'null'}`);
    record(
      'panel.placement',
      insideWorkArea(panel),
      JSON.stringify({ bounds: panelBounds, workArea: screen.getDisplayMatching(panelBounds).workArea }),
    );

    await evalIn(panel, `document.querySelector('.status-pill').click()`);
    await wait(500);
    let state = controller.getState();
    record('panel.toggle-on', state.session.active === true, `active=${state.session.active}`);
    const ringChecked = await evalIn<string>(
      panel,
      `document.querySelector('.ring-button').getAttribute('aria-checked')`,
    );
    record('panel.ring-reflects-state', ringChecked === 'true', `aria-checked=${ringChecked}`);

    await evalIn(
      panel,
      `[...document.querySelectorAll('.duration-pill')].find((b) => b.textContent.trim() === '1h')?.click()`,
    );
    await wait(500);
    state = controller.getState();
    record(
      'panel.duration-1h',
      state.session.durationMs === 60 * 60_000,
      `durationMs=${state.session.durationMs}`,
    );
    const presets: Array<[string, number | null]> = [
      ['15m', 15 * 60_000],
      ['30m', 30 * 60_000],
      ['1h', 60 * 60_000],
      ['2h', 2 * 60 * 60_000],
      ['4h', 4 * 60 * 60_000],
      ['8h', 8 * 60 * 60_000],
      ['∞', null],
    ];
    const presetSeen: Array<{ pill: string; durationMs: number | null }> = [];
    let presetsOk = true;
    for (const [label, expected] of presets) {
      await evalIn(
        panel,
        `[...document.querySelectorAll('.duration-pill')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`,
      );
      await wait(320);
      const duration = controller.getState().session.durationMs;
      presetSeen.push({ pill: label, durationMs: duration });
      if (duration !== expected) presetsOk = false;
    }
    record('panel.duration-presets', presetsOk, JSON.stringify(presetSeen));

    await evalIn(panel, `document.querySelectorAll('.seg-option')[0].click()`);
    await wait(450);
    state = controller.getState();
    record('panel.display-on', state.session.displayMode === 'on', `display=${state.session.displayMode}`);

    await evalIn(
      panel,
      `(() => { const el = document.querySelector('.ring-button'); const o = { bubbles: true, button: 0, pointerId: 11, isPrimary: true }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); return true; })()`,
    );
    await wait(500);
    record('panel.ring-toggle-off', controller.getState().session.active === false);

    // A real one-second timer must expire through the normal tick path.
    const shortTimer = await controller.activate(1200, { interactive: false, silent: true });
    const activeBefore = controller.getState().session.active;
    await wait(2600);
    const activeAfter = controller.getState().session.active;
    record(
      'session.auto-expire',
      shortTimer.ok && activeBefore === true && activeAfter === false,
      `ok=${shortTimer.ok} before=${activeBefore} after=${activeAfter}`,
    );

    await evalIn(
      panel,
      `(() => { const el = document.querySelector('.ring-button'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 12, isPrimary: true })); return true; })()`,
    );
    await wait(750);
    const settingsWin = windows.getWindow('settings');
    record('panel.long-press-settings', settingsWin !== null && settingsWin.isVisible());
    await evalIn(
      panel,
      `(() => { const el = document.querySelector('.ring-button'); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 12, isPrimary: true })); return true; })()`,
    );

    // --- Settings ----------------------------------------------------------
    if (!settingsWin) throw new Error('settings window missing');
    await ready(settingsWin);
    const settingsProbe = await evalIn<Probe>(
      settingsWin,
      `({ app: document.body.dataset.app, bootError: window.__insomniazBootError || null, textLength: document.body.innerText.length })`,
    );
    record(
      'settings.render',
      settingsProbe.app === 'settings' && !settingsProbe.bootError && settingsProbe.textLength > 200,
      JSON.stringify(settingsProbe),
    );
    const navCount = await evalIn<number>(settingsWin, `document.querySelectorAll('.nav-item').length`);
    record('settings.nav-count', navCount === 8, `nav=${navCount}`);

    const headingByIndex = [
      'General',
      'Shortcuts',
      'Power',
      'Battery',
      'Soft Stop',
      'Appearance',
      'Privacy',
      'About InsomniaZ',
    ];
    for (let index = 0; index < headingByIndex.length; index += 1) {
      await evalIn(settingsWin, `document.querySelectorAll('.nav-item')[${index}].click()`);
      await wait(320);
      const heading = await evalIn<string>(
        settingsWin,
        `(document.querySelector('.settings-main h1')?.textContent || '').trim()`,
      );
      record(`settings.section-${index}`, heading === headingByIndex[index], heading);
    }

    // --- Soft stop ---------------------------------------------------------
    await evalIn(settingsWin, `document.querySelectorAll('.nav-item')[4].click()`);
    await wait(400);
    type SoftProbe = { phase: string; prompt: number; sliders: number[]; cards: string[] };
    const softProbe = await evalIn<SoftProbe>(
      settingsWin,
      `(() => {
        const main = document.querySelector('.settings-main');
        return {
          phase: (main?.querySelector('.softstop-phase')?.textContent || '').trim(),
          prompt: (main?.querySelector('.softstop-textarea')?.value || '').length,
          sliders: [...(main?.querySelectorAll('input[type=range]') || [])].map((el) => Number(el.value)),
          cards: [...(main?.querySelectorAll('.card') || [])].map((el) => (el.querySelector('.card-head')?.textContent || '').trim()),
        };
      })()`,
    );
    const softSettings = controller.getSettings();
    record(
      'softstop.render',
      softProbe.phase === 'Off' && softProbe.prompt >= 20 && softProbe.cards.length === 5,
      JSON.stringify(softProbe),
    );
    record(
      'softstop.thresholds',
      softProbe.sliders.length === 2 &&
        softProbe.sliders[0] === softSettings.softStopThreshold &&
        softProbe.sliders[1] === softSettings.softStopSleepThreshold,
      JSON.stringify(softProbe.sliders),
    );

    if (softSettings.softStopEnabled) {
      await evalIn(settingsWin, `document.querySelector('.settings-main .toggle').click()`);
      await wait(600);
    }
    await evalIn(settingsWin, `document.querySelector('.settings-main .toggle').click()`);
    await wait(800);
    record(
      'softstop.enable-ui',
      controller.getSettings().softStopEnabled === true &&
        controller.getState().softStop.phase === 'idle',
      `enabled=${controller.getSettings().softStopEnabled} phase=${controller.getState().softStop.phase}`,
    );
    const phaseChip = await evalIn<string>(
      settingsWin,
      `(document.querySelector('.softstop-phase')?.textContent || '').trim()`,
    );
    record('softstop.phase-chip', phaseChip === 'Idle', phaseChip);

    await evalIn(settingsWin, `document.querySelector('.settings-main .toggle').click()`);
    await wait(600);
    record(
      'softstop.disable-ui',
      controller.getSettings().softStopEnabled === false &&
        controller.getState().softStop.phase === 'off',
      `enabled=${controller.getSettings().softStopEnabled} phase=${controller.getState().softStop.phase}`,
    );

    // Detection reads processes/adapters only; no AI runtime is required for the probe.
    await evalIn(
      settingsWin,
      `[...document.querySelectorAll('.settings-main .secondary-button')].at(-1)?.click()`,
    );
    let detection: string | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(800);
      detection = await evalIn<string | null>(
        settingsWin,
        `(() => {
          const el = document.querySelector('.softstop-sample') || document.querySelector('.softstop-fold .inline-note');
          return el ? el.textContent.trim() : null;
        })()`,
      );
      if (detection) break;
    }
    record('softstop.detect-ui', detection !== null && detection.length > 10, String(detection));

    // Toggle styling across themes (also verifies the theme update path).
    await evalIn(settingsWin, `document.querySelectorAll('.nav-item')[0].click()`);
    await wait(320);
    type ToggleProbe = {
      theme: string | null;
      checked: Array<{ state: string | null; bg: string; knob: string }>;
      unchecked: Array<{ state: string | null; bg: string; knob: string }>;
    };
    const toggleScript = `(() => {
      const all = [...document.querySelectorAll('.toggle')];
      const pick = (el) => ({ state: el.getAttribute('data-checked'), bg: getComputedStyle(el).backgroundColor, knob: getComputedStyle(el, '::after').transform });
      return { theme: document.documentElement.dataset.theme || null, checked: all.filter((el) => el.getAttribute('data-checked') === 'true').map(pick), unchecked: all.filter((el) => el.getAttribute('data-checked') === 'false').map(pick) };
    })()`;
    await controller.updateSettings({ theme: 'dark' });
    await wait(400);
    const darkToggles = await evalIn<ToggleProbe>(settingsWin, toggleScript);
    record(
      'settings.toggles-dark',
      darkToggles.theme === 'dark' &&
        darkToggles.checked.length > 0 &&
        darkToggles.checked[0].bg === 'rgb(142, 99, 236)',
      JSON.stringify(darkToggles),
    );

    await controller.updateSettings({ theme: 'light' });
    await wait(450);
    const lightToggles = await evalIn<ToggleProbe>(settingsWin, toggleScript);
    record(
      'settings.toggles-light',
      lightToggles.theme === 'light' &&
        lightToggles.checked.length > 0 &&
        lightToggles.checked[0].bg === 'rgb(122, 79, 224)',
      JSON.stringify(lightToggles),
    );
    await controller.updateSettings({ theme: 'system' });
    await wait(350);

    // Appearance controls through the UI.
    await evalIn(settingsWin, `document.querySelectorAll('.nav-item')[5].click()`);
    await wait(350);
    await evalIn(
      settingsWin,
      `[...document.querySelectorAll('.choice')].find((b) => b.textContent.trim() === 'Light')?.click()`,
    );
    await wait(450);
    let theme = await evalIn<string | null>(settingsWin, `document.documentElement.dataset.theme || null`);
    record('settings.theme-ui-light', theme === 'light', String(theme));
    await evalIn(
      settingsWin,
      `[...document.querySelectorAll('.choice')].find((b) => b.textContent.trim() === 'Follow system')?.click()`,
    );
    await wait(450);
    theme = await evalIn<string | null>(settingsWin, `document.documentElement.dataset.theme || null`);
    record('settings.theme-ui-system', theme === 'dark' || theme === 'light', String(theme));

    await evalIn(
      settingsWin,
      `[...document.querySelectorAll('.choice')].find((b) => b.textContent.trim() === 'Compact')?.click()`,
    );
    await wait(350);
    const density = await evalIn<string | null>(settingsWin, `document.body.dataset.density || null`);
    record('settings.density-compact', density === 'compact', String(density));
    await evalIn(
      settingsWin,
      `[...document.querySelectorAll('.choice')].find((b) => b.textContent.trim() === 'Comfortable')?.click()`,
    );
    await wait(300);

    // Language switch updates the live UI.
    await evalIn(settingsWin, `document.querySelectorAll('.nav-item')[0].click()`);
    await wait(320);
    await evalIn(
      settingsWin,
      `(() => { const s = document.querySelector('.select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(s, 'zh-CN'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    );
    await wait(500);
    const zhHeading = await evalIn<string>(
      settingsWin,
      `(document.querySelector('.settings-main h1')?.textContent || '').trim()`,
    );
    record('settings.language-zh', zhHeading === '通用', zhHeading);
    await evalIn(
      settingsWin,
      `(() => { const s = document.querySelector('.select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(s, 'en-US'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    );
    await wait(500);

    settingsWin.close();
    await wait(300);
    record(
      'settings.close-hides',
      !settingsWin.isDestroyed() && !settingsWin.isVisible(),
      `destroyed=${settingsWin.isDestroyed()} visible=${settingsWin.isVisible()}`,
    );

    // --- Onboarding --------------------------------------------------------
    windows.showOnboarding();
    const onboarding = windows.getWindow('onboarding');
    if (!onboarding) throw new Error('onboarding window missing');
    await ready(onboarding);
    const obProbe = await evalIn<Probe>(
      onboarding,
      `({ app: document.body.dataset.app, bootError: window.__insomniazBootError || null, textLength: document.body.innerText.length })`,
    );
    record(
      'onboarding.render',
      obProbe.app === 'onboarding' && !obProbe.bootError && obProbe.textLength > 200,
      JSON.stringify(obProbe),
    );
    const step1 = await evalIn<string>(onboarding, `(document.body.innerText.match(/STEP \\d OF 3/i) || [''])[0]`);
    record('onboarding.step1', /STEP 1 OF 3/i.test(step1), step1);
    const clickNext = async (): Promise<void> => {
      await evalIn(onboarding, `document.querySelector('[data-testid="onboarding-next"]')?.click()`);
      await wait(500);
    };
    await clickNext();
    const step2 = await evalIn<string>(onboarding, `(document.body.innerText.match(/STEP \\d OF 3/i) || [''])[0]`);
    record('onboarding.step2', /STEP 2 OF 3/i.test(step2), step2);
    await clickNext();
    const step3 = await evalIn<string>(onboarding, `(document.body.innerText.match(/STEP \\d OF 3/i) || [''])[0]`);
    record('onboarding.step3', /STEP 3 OF 3/i.test(step3), step3);
    await evalIn(
      onboarding,
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Not now')?.click()`,
    );
    await wait(900);
    record(
      'onboarding.finish',
      !onboarding.isVisible() && controller.getSettings().onboardingComplete === true,
      `visible=${onboarding.isVisible()} complete=${controller.getSettings().onboardingComplete}`,
    );
    record('onboarding.panel-after', windows.isPanelVisible() === true);

    // --- Tray --------------------------------------------------------------
    const trayInfo = tray?.describe();
    const requiredLabels = [
      'Duration',
      'Display',
      'Keep awake with lid closed',
      'Prevent apps from seeing you idle',
      'Open Control Panel',
      'Settings…',
      'Quit InsomniaZ',
    ];
    const missing = requiredLabels.filter((label) => !(trayInfo?.labels ?? []).some((item) => item.startsWith(label)));
    record(
      'tray.menu',
      trayInfo?.ready === true && missing.length === 0,
      `labels=${trayInfo?.labels.length ?? 0} missing=${missing.join(',') || 'none'}`,
    );
    record(
      'tray.tooltip',
      typeof trayInfo?.tooltip === 'string' && trayInfo.tooltip.length > 0,
      trayInfo?.tooltip,
    );
    const shortcutInfo = shortcuts?.describe();
    record(
      'shortcut.registered',
      shortcutInfo?.registered === true && shortcutInfo.accelerator === controller.getSettings().shortcut,
      JSON.stringify(shortcutInfo),
    );
  } catch (error) {
    record('smoke.error', false, (error as Error).stack ?? (error as Error).message);
  } finally {
    try {
      if (controller.getState().session.active) await controller.deactivate('manual');
      await controller.updateSettings({ language: 'en-US', theme: 'system', compactDensity: false, lastDurationMs: 30 * 60_000, softStopEnabled: false });
    } catch {
      /* cleanup is best-effort */
    }
  }

  const ok = results.every((result) => result.ok);
  logger.info('smoke result', { ok, results });
  writeFileSync(
    join(appRoot, 'docs', 'smoke.json'),
    `${JSON.stringify({ ok, ranAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
  console.log(JSON.stringify(results, null, 2));
  await controller.shutdown();
  tray?.destroy();
  windows.destroyAll();
  app.exit(ok ? 0 : 1);
}


if (captureMode || smokeMode || freshMode) {
  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error);
    app.exit(1);
  });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => windows?.showPanel());
    app.whenReady().then(bootstrap).catch((error) => {
      logger?.error('startup failed', error);
      dialog.showErrorBox('InsomniaZ', error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
  }
}

app.on('window-all-closed', () => {
  // Tray application: closing a window must not quit.
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  windows?.prepareForQuit();
  void (async () => {
    try {
      await controller?.shutdown();
    } catch (error) {
      logger?.warn('shutdown failed', { message: (error as Error).message });
    }
    autopilot?.dispose();
    shortcuts?.dispose();
    tray?.destroy();
    windows?.destroyAll();
    app.quit();
  })();
});

app.on('will-quit', () => {
  shortcuts?.dispose();
});

process.on('uncaughtException', (error) => {
  logger?.error('uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  logger?.warn('unhandled rejection', { message: String(reason) });
});
