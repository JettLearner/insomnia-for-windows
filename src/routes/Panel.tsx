import { useEffect, useMemo } from 'react';
import {
  formatRemaining,
  sessionRemainingMs,
} from '../../shared/format';
import type { MessageKey } from '../../shared/i18n';
import { PRESET_DURATIONS, type DisplayMode } from '../../shared/types';
import { Banner } from '../components/Banner';
import { Clock, Laptop, Moon, Power, Sliders, Sun, X, Activity } from '../components/Icons';
import { Ring } from '../components/Ring';
import { ToastViewport } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { Keycaps } from '../components/ui';
import { getApi } from '../lib/api';
import { useT } from '../lib/i18n';
import { useRuntime } from '../lib/runtime';

const DURATION_LABELS: Array<{ ms: number; key: MessageKey }> = [
  { ms: PRESET_DURATIONS[0], key: 'dur15' },
  { ms: PRESET_DURATIONS[1], key: 'dur30' },
  { ms: PRESET_DURATIONS[2], key: 'dur1h' },
  { ms: PRESET_DURATIONS[3], key: 'dur2h' },
  { ms: PRESET_DURATIONS[4], key: 'dur4h' },
  { ms: PRESET_DURATIONS[5], key: 'dur8h' },
];

export function Panel() {
  const { state, run, busy } = useRuntime();
  const t = useT();
  const api = getApi();
  const { session, settings, capabilities, power } = state;
  const active = session.active;
  const indefinite = active && session.endsAt === null;
  const remaining = sessionRemainingMs(session, state.now);
  const fraction =
    active && session.durationMs !== null && remaining !== null
      ? Math.max(0, Math.min(1, remaining / session.durationMs))
      : active
        ? 1
        : 0;

  const display = active ? session.displayMode : settings.defaultDisplayMode;
  const advanced = active ? session.advanced : settings.advancedDefault;
  const lidChecked = active ? session.lid : settings.lidGuardPreferred;
  const selectedDuration = active ? session.durationMs : settings.lastDurationMs;
  const lidUnsupported = capabilities.lidPolicySupported === false;
  const showAdmin = !capabilities.elevated && !lidUnsupported && !session.lid;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void api?.hidePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api]);

  const liveBucket = remaining === null ? 0 : Math.ceil(remaining / 30_000);
  const liveText = useMemo(() => {
    if (!active) return t('readyHint');
    if (indefinite) return t('timeIndefinite');
    const ms = liveBucket * 30_000;
    return t('timeRemaining', { time: formatRemaining(ms, state.locale) });
  }, [active, indefinite, liveBucket, state.locale, t]);

  const toggle = (): void => {
    if (busy) return;
    void run({ type: 'toggle' });
  };

  const chooseDuration = (ms: number | null): void => {
    if (busy) return;
    if (active) {
      if (session.durationMs === ms) return;
      void run({ type: 'activate', durationMs: ms });
      return;
    }
    if (settings.lastDurationMs === ms) return;
    void run({ type: 'update-settings', patch: { lastDurationMs: ms } });
  };

  const chooseDisplay = (mode: DisplayMode): void => {
    if (busy || display === mode) return;
    void run({ type: 'set-display', mode });
  };

  const toggleLid = (next: boolean): void => {
    if (busy) return;
    void run({ type: 'set-lid', enabled: next });
  };

  const toggleAdvanced = (next: boolean): void => {
    if (busy) return;
    void run({ type: 'set-advanced', enabled: next });
  };

  const lowBattery =
    power.batteryPresent &&
    !power.ac &&
    settings.batteryGuardEnabled &&
    power.batteryPercent !== null &&
    power.batteryPercent <= settings.batteryThreshold + 10;

  const showLidAdmin = settings.lidGuardPreferred && active && !session.lid && !lidUnsupported;
  const showLidUnsupported = settings.lidGuardPreferred && lidUnsupported;

  return (
    <div className="window-shell">
      <div className="surface panel" role="dialog" aria-label={t('panelAria')}>
        <header className="panel-header">
          <div className="brand-block">
            <span className="brand-name">InsomniaZ</span>
            <span className={`brand-kicker${active ? ' is-active' : ''}`}>
              {active ? t('statusActive') : t('statusReady')}
            </span>
          </div>
          <div className="panel-header-actions">
            <button
              type="button"
              className={`status-pill${active ? ' is-on' : ''}`}
              onClick={toggle}
              disabled={busy}
              aria-label={active ? t('toggleOnAria') : t('toggleOffAria')}
            >
              <span className="pill-dot" aria-hidden="true" />
              {active ? t('statusOn') : t('statusOff')}
            </button>
            <button
              type="button"
              className="icon-button panel-close"
              onClick={() => void api?.hidePanel()}
              aria-label={t('closePanelAria')}
              title={t('closePanelAria')}
            >
              <X size={13} />
            </button>
          </div>
        </header>

        <main className="panel-main">
          <div className="panel-banners">
            {capabilities.recoveryPending && (
              <Banner
                tone="error"
                action={{ label: t('recoveryAction'), onClick: () => void run({ type: 'recover-lid' }) }}
              >
                {t('recoveryBanner')}
              </Banner>
            )}
            {lowBattery && power.batteryPercent !== null && (
              <Banner tone="warning">
                {t('lowBatteryBanner', {
                  percent: Math.round(power.batteryPercent),
                  threshold: settings.batteryThreshold,
                })}
              </Banner>
            )}
            {active && !capabilities.helperConnected && (
              <Banner tone="info">{t('helperOfflineBanner')}</Banner>
            )}
            {showLidUnsupported && <Banner tone="warning">{t('lidUnavailableBanner')}</Banner>}
            {showLidAdmin && (
              <Banner
                tone="warning"
                action={{ label: t('retry'), onClick: () => void run({ type: 'set-lid', enabled: true }) }}
              >
                {t('lidNeedsAdminBanner')}
              </Banner>
            )}
          </div>

          <section className="ring-section" aria-label={t('panelAria')}>
            <Ring
              active={active}
              fraction={fraction}
              indefinite={indefinite}
              disabled={busy}
              label={active ? t('toggleOnAria') : t('toggleOffAria')}
              title={t('ringHint')}
              onToggle={toggle}
              onOpenSettings={() => void api?.openSettings('general')}
            />
            <div className="ring-readout">
              <div className="ring-time-line">
                {active && !indefinite && (
                  <>
                    <Clock size={13} className="ring-time-icon" />
                    <span className="ring-time tnum">
                      {formatRemaining(remaining ?? 0, state.locale)}
                    </span>
                    <span className="ring-time-label">{t('remainingLabel')}</span>
                  </>
                )}
                {indefinite && (
                  <>
                    <span className="ring-time infinity">∞</span>
                    <span className="ring-time-label">{t('indefiniteLabel')}</span>
                  </>
                )}
                {!active && <span className="ring-time is-idle">{t('statusReady')}</span>}
              </div>
              <div className="ring-substate">
                {active ? (
                  <>
                    <span className="mini-dot" aria-hidden="true" />
                    {session.lid ? t('lidActiveHint') : t('activeHint')}
                  </>
                ) : (
                  t('readyHint')
                )}
              </div>
            </div>
            <span className="sr-only" aria-live="polite">
              {liveText}
            </span>
          </section>

          <section className="control-group">
            <div className="group-head">
              <span className="group-label">{t('displayLabel')}</span>
              <span className="badge">{t('newBadge')}</span>
              <span className="group-note">{t('pcKeepsRunning')}</span>
            </div>
            <div className="display-segmented" role="radiogroup" aria-label={t('displayLabel')}>
              <button
                type="button"
                role="radio"
                aria-checked={display === 'on'}
                className={`seg-option${display === 'on' ? ' is-selected' : ''}`}
                onClick={() => chooseDisplay('on')}
                disabled={busy}
              >
                <Sun size={16} />
                <span className="seg-title">{t('displayOn')}</span>
                <span className="seg-sub">{t('displayOnSub')}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={display === 'auto'}
                className={`seg-option${display === 'auto' ? ' is-selected' : ''}`}
                onClick={() => chooseDisplay('auto')}
                disabled={busy}
              >
                <Moon size={16} />
                <span className="seg-title">{t('displayAuto')}</span>
                <span className="seg-sub">{t('displayAutoSub')}</span>
              </button>
            </div>
          </section>

          <section className="control-group">
            <div className="group-head">
              <span className="group-label">{t('durationLabel')}</span>
            </div>
            <div className="duration-row" role="radiogroup" aria-label={t('durationLabel')}>
              {DURATION_LABELS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="radio"
                  aria-checked={selectedDuration === entry.ms}
                  className={`duration-pill${selectedDuration === entry.ms ? ' is-selected' : ''}`}
                  onClick={() => chooseDuration(entry.ms)}
                  disabled={busy}
                >
                  {t(entry.key)}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={selectedDuration === null}
                className={`duration-pill${selectedDuration === null ? ' is-selected infinity' : ''}`}
                onClick={() => chooseDuration(null)}
                disabled={busy}
                title={t('indefinitely')}
              >
                {t('durInf')}
              </button>
            </div>
          </section>

          <section className="control-group">
            <div className="group-head">
              <span className="group-label">{t('advancedLabel')}</span>
              <span className="group-note">{t('appliesWhenOn')}</span>
            </div>
            <div className="advanced-card">
              <div className="feature-row">
                <span className="feature-icon">
                  <Laptop size={15} />
                </span>
                <div className="feature-copy">
                  <div className="feature-title-row">
                    <span className="feature-title">{t('lidTitle')}</span>
                    {showAdmin && <span className="badge admin">{t('adminBadge')}</span>}
                  </div>
                  <span className="feature-sub">{lidUnsupported ? t('lidUnsupported') : t('lidSubtitle')}</span>
                </div>
                <Toggle
                  checked={lidChecked}
                  disabled={busy || lidUnsupported}
                  onChange={toggleLid}
                  label={t('lidTitle')}
                />
              </div>
              <div className="feature-row">
                <span className="feature-icon gold">
                  <Activity size={15} />
                </span>
                <div className="feature-copy">
                  <div className="feature-title-row">
                    <span className="feature-title">{t('activityTitle')}</span>
                  </div>
                  <span className="feature-sub">
                    {t('activitySubtitle', { seconds: settings.activityIntervalSec })}
                  </span>
                </div>
                <Toggle
                  checked={advanced}
                  disabled={busy}
                  onChange={toggleAdvanced}
                  label={t('activityTitle')}
                />
              </div>
            </div>
          </section>
        </main>

        <footer className="panel-footer">
          <button
            type="button"
            className="footer-action"
            onClick={() => void api?.openSettings('general')}
          >
            <Sliders size={14} />
            {t('openSettings')}
          </button>
          <div className="shortcut-chip">
            <span>{t('shortcutHint')}</span>
            <Keycaps accelerator={settings.shortcut} />
          </div>
          <button type="button" className="footer-action quit" onClick={() => void api?.quit()}>
            <Power size={14} />
            {t('quit')}
          </button>
        </footer>

        <ToastViewport />
      </div>
    </div>
  );
}
