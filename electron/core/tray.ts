import { Menu, Notification, Tray, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { RuntimeState } from '../../shared/types';
import { PRESET_DURATIONS } from '../../shared/types';
import { formatDurationLong, formatRemaining } from '../../shared/format';
import { shortcutLabel } from '../../shared/shortcut';
import type { Controller } from './controller';
import type { WindowManager } from './windows';
import type { Logger } from './logger';

function flattenMenuLabels(menu: Menu): string[] {
  const labels: string[] = [];
  for (const item of menu.items) {
    if (typeof item.label === 'string' && item.label.length > 0) labels.push(item.label);
    if (item.submenu) labels.push(...flattenMenuLabels(item.submenu));
  }
  return labels;
}

interface TrayControllerOptions {
  controller: Controller;
  windows: WindowManager;
  activeIcon: string;
  idleIcon: string;
  requestQuit: () => void;
  logger: Logger;
}

export class TrayController {
  private tray: Tray | null = null;
  private lastSignature = '';
  private lastActive: boolean | null = null;
  private lastState: RuntimeState | null = null;
  private lastTooltip = 'InsomniaZ';
  private lastMenuLabels: string[] = [];

  constructor(private readonly options: TrayControllerOptions) {}

  create(): void {
    const image = nativeImage.createFromPath(this.options.idleIcon);
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip('InsomniaZ');
    this.options.windows.setTrayBounds(this.tray.getBounds());
    this.tray.on('click', () => {
      if (this.options.controller.getSettings().leftClickOpensPanel) {
        this.options.windows.togglePanel();
      }
    });
    this.tray.on('double-click', () => this.options.windows.showPanel());
    this.tray.on('right-click', () => {
      this.options.windows.setTrayBounds(this.tray?.getBounds() ?? null);
    });
    if (this.lastState) this.update(this.lastState);
  }

  update(state: RuntimeState): void {
    if (!this.tray) {
      this.lastState = state;
      return;
    }
    this.lastState = state;
    this.lastTooltip = this.tooltip(state);
    this.tray.setToolTip(this.lastTooltip);
    const activeChanged = this.lastActive !== state.session.active;
    this.lastActive = state.session.active;
    if (activeChanged) {
      const path = state.session.active ? this.options.activeIcon : this.options.idleIcon;
      const image = nativeImage.createFromPath(path);
      if (!image.isEmpty()) this.tray.setImage(image);
    }
    const signature = this.signature(state);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      const menu = this.menu(state);
      this.lastMenuLabels = flattenMenuLabels(menu);
      this.tray.setContextMenu(menu);
    }
  }

  private signature(state: RuntimeState): string {
    const secondsBucket = state.session.active ? Math.floor(state.now / 5000) : 0;
    return JSON.stringify({
      active: state.session.active,
      endsAt: state.session.endsAt,
      duration: state.session.durationMs,
      display: state.session.displayMode,
      advanced: state.session.advanced,
      lid: state.session.lid,
      settingsDisplay: state.settings.defaultDisplayMode,
      settingsDuration: state.settings.lastDurationMs,
      settingsAdvanced: state.settings.advancedDefault,
      settingsLid: state.settings.lidGuardPreferred,
      shortcut: state.settings.shortcut,
      locale: state.locale,
      busy: state.busy,
      helper: state.capabilities.helperConnected,
      elevated: state.capabilities.elevated,
      lidSupported: state.capabilities.lidPolicySupported,
      recovery: state.capabilities.recoveryPending,
      secondsBucket,
    });
  }

  private tooltip(state: RuntimeState): string {
    const status = state.session.active ? this.t('statusActive') : this.t('statusReady');
    const time =
      state.session.active && state.session.endsAt !== null
        ? formatRemaining(Math.max(0, state.session.endsAt - state.now), state.locale)
        : this.t('indefiniteLabel');
    return this.t('trayTooltip', { status, time }).slice(0, 126);
  }

  private t(key: Parameters<Controller['t']>[0], vars?: Record<string, string | number>): string {
    return this.options.controller.t(key, vars);
  }

  private durationLabel(ms: number | null, state: RuntimeState): string {
    if (ms === null) return this.t('indefinitely');
    if (ms === 15 * 60_000) return this.t('dur15');
    if (ms === 30 * 60_000) return this.t('dur30');
    if (ms === 60 * 60_000) return this.t('dur1h');
    if (ms === 2 * 60 * 60_000) return this.t('dur2h');
    if (ms === 4 * 60 * 60_000) return this.t('dur4h');
    if (ms === 8 * 60 * 60_000) return this.t('dur8h');
    return formatDurationLong(ms, state.locale);
  }

  private menu(state: RuntimeState): Menu {
    const { controller, windows } = this.options;
    const active = state.session.active;
    const busy = state.busy;
    const selectedDuration = active ? state.session.durationMs : state.settings.lastDurationMs;
    const selectedDisplay = active ? state.session.displayMode : state.settings.defaultDisplayMode;
    const selectedAdvanced = active ? state.session.advanced : state.settings.advancedDefault;
    const selectedLid = active ? state.session.lid : state.settings.lidGuardPreferred;
    const lidSupported = state.capabilities.lidPolicySupported;
    const lidSuffix =
      lidSupported === false
        ? ` — ${this.t('trayUnsupported')}`
        : active && !state.capabilities.elevated
          ? ` — ${this.t('trayAdminRequired')}`
          : '';

    const title = active
      ? [
          this.t('trayActive'),
          state.session.endsAt === null
            ? this.t('indefiniteLabel')
            : formatRemaining(Math.max(0, state.session.endsAt - state.now), state.locale),
        ].join(' · ')
      : this.t('trayReady');

    const durationItems: MenuItemConstructorOptions[] = PRESET_DURATIONS.map((duration) => ({
      label: this.durationLabel(duration, state),
      type: 'radio',
      checked: selectedDuration === duration,
      enabled: !busy,
      click: () => this.run(controller.activate(duration)),
    }));
    durationItems.push({ type: 'separator' });
    durationItems.push({
      label: this.t('indefinitely'),
      type: 'radio',
      checked: selectedDuration === null,
      enabled: !busy,
      click: () => this.run(controller.activate(null)),
    });

    const items: MenuItemConstructorOptions[] = [
      { label: title, enabled: false },
      { type: 'separator' },
      {
        label: active ? this.t('trayTurnOff') : this.t('trayTurnOn'),
        enabled: !busy,
        click: () => this.run(controller.toggle()),
      },
      {
        label: this.t('trayDuration'),
        enabled: !busy,
        submenu: durationItems,
      },
      {
        label: this.t('trayDisplay'),
        enabled: !busy,
        submenu: [
          {
            label: this.t('trayDisplayOn'),
            type: 'radio',
            checked: selectedDisplay === 'on',
            click: () => this.run(controller.setDisplayMode('on')),
          },
          {
            label: this.t('trayDisplayAuto'),
            type: 'radio',
            checked: selectedDisplay === 'auto',
            click: () => this.run(controller.setDisplayMode('auto')),
          },
        ],
      },
      { type: 'separator' },
      {
        label: `${this.t('trayLid')}${lidSuffix}`,
        type: 'checkbox',
        checked: selectedLid,
        enabled: !busy && lidSupported !== false,
        click: (item) => this.run(controller.setLid(item.checked)),
      },
      {
        label: this.t('trayActivity'),
        type: 'checkbox',
        checked: selectedAdvanced,
        enabled: !busy,
        click: (item) => this.run(controller.setAdvanced(item.checked)),
      },
      { type: 'separator' },
      {
        label: this.t('trayPanel'),
        click: () => windows.showPanel(),
      },
      ...(this.options.controller.isAutopilotEnabled()
        ? [
            {
              label: this.t('autopilotOpen'),
              click: () => windows.showAutopilot(),
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      {
        label: this.t('traySettings'),
        click: () => windows.openSettings(),
      },
      {
        label: this.t('trayAbout'),
        click: () => windows.openSettings('about'),
      },
      { type: 'separator' },
      {
        label: `${this.t('shortcutHint')}: ${shortcutLabel(state.settings.shortcut)}`,
        enabled: false,
      },
      {
        label: this.t('runCheck'),
        enabled: !busy,
        click: () => this.run(controller.checkSystem()),
      },
    ];

    if (state.capabilities.recoveryPending) {
      items.push({
        label: this.t('trayRecovery'),
        enabled: !busy,
        click: () => this.run(controller.recoverLid()),
      });
    }

    items.push({ type: 'separator' });
    items.push({
      label: this.t('trayQuit'),
      click: () => this.options.requestQuit(),
    });

    return Menu.buildFromTemplate(items);
  }

  private run(promise: Promise<{ ok: boolean; error?: string }>): void {
    void promise.then((result) => {
      if (result.ok || !result.error) return;
      this.showError(result.error);
    });
  }

  private showError(message: string): void {
    if (Notification.isSupported()) {
      new Notification({ title: 'InsomniaZ', body: message, silent: true }).show();
    } else {
      this.options.logger.warn('tray action failed', { message });
    }
  }

  /** Read-only snapshot of the live tray for diagnostics and acceptance tests. */
  describe(): { ready: boolean; tooltip: string; labels: string[] } {
    return {
      ready: this.tray !== null && !this.tray.isDestroyed(),
      tooltip: this.lastTooltip,
      labels: [...this.lastMenuLabels],
    };
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
