import { useState } from 'react';
import type { MessageKey } from '../../shared/i18n';
import { shortcutLabel } from '../../shared/shortcut';
import { PRESET_DURATIONS, type DisplayMode } from '../../shared/types';
import { AppMark } from '../components/AppMark';
import { Banner } from '../components/Banner';
import {
  Activity,
  ChevronLeft,
  Keyboard,
  Laptop,
  Lock,
  Moon,
  ShieldCheck,
  Sun,
} from '../components/Icons';
import { RingArt } from '../components/Ring';
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

const TOTAL_STEPS = 3;

export function Onboarding() {
  const { state, run } = useRuntime();
  const t = useT();
  const api = getApi();
  const [step, setStep] = useState(1);
  const [display, setDisplay] = useState<DisplayMode>(state.settings.defaultDisplayMode);
  const [duration, setDuration] = useState<number | null>(state.settings.lastDurationMs);
  const [advanced, setAdvanced] = useState(state.settings.advancedDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaults = {
    defaultDisplayMode: display,
    lastDurationMs: duration,
    advancedDefault: advanced,
  };

  const persist = async (extra?: { onboardingComplete?: boolean }): Promise<boolean> => {
    const result = await run(
      { type: 'update-settings', patch: { ...defaults, ...extra } },
      { toast: false },
    );
    if (!result.ok) {
      setError(result.error ?? t('errGeneric'));
      return false;
    }
    setError(null);
    return true;
  };

  const closeToPanel = async (): Promise<void> => {
    await api?.closeWindow('onboarding');
    await api?.showPanel();
  };

  const next = async (): Promise<void> => {
    if (busy) return;
    if (step === 2) {
      setBusy(true);
      const saved = await persist();
      setBusy(false);
      if (!saved) return;
    }
    setStep((value) => Math.min(TOTAL_STEPS, value + 1));
  };

  const back = (): void => {
    if (busy) return;
    setError(null);
    setStep((value) => Math.max(1, value - 1));
  };

  const finish = async (enableLid: boolean): Promise<void> => {
    if (busy) return;
    setError(null);
    setBusy(true);
    if (enableLid) {
      const lid = await run({ type: 'set-lid', enabled: true }, { toast: false });
      if (!lid.ok) {
        setBusy(false);
        setError(t('obLidDenied'));
        return;
      }
    }
    const saved = await persist({ onboardingComplete: true });
    if (!saved) {
      setBusy(false);
      return;
    }
    await closeToPanel();
  };

  return (
    <div className="window-shell">
      <div className="surface onboarding-surface">
        <header className="ob-top">
          <AppMark size={24} />
          <div className="ob-brand">
            <span>InsomniaZ</span>
            <span className="muted">{t('windowsPort')}</span>
          </div>
          <span className="ob-step">{t('obStep', { current: step, total: TOTAL_STEPS })}</span>
          <button
            type="button"
            className="ghost-button ob-skip"
            onClick={() => void finish(false)}
            disabled={busy}
          >
            {t('obSkip')}
          </button>
        </header>

        <main className="ob-body">
          <div className="ob-content" key={step}>
            {error && step !== 3 && (
              <div className="ob-error ob-error-top">
                <Banner tone="error">{error}</Banner>
              </div>
            )}
            {step === 1 && (
              <>
                <div className="ob-ring">
                  <RingArt size={150} active fraction={0.76} />
                </div>
                <span className="ob-eyebrow">
                  {t('appName')} · {t('windowsPort')}
                </span>
                <h1 className="ob-title">{t('obWelcomeTitle')}</h1>
                <p className="ob-lede">{t('obWelcomeBody')}</p>
                <div className="ob-features">
                  <div className="ob-feature">
                    <span className="ob-feature-icon">
                      <Laptop size={17} />
                    </span>
                    <div>
                      <strong>{t('obFeatureLid')}</strong>
                      <span>{t('obFeatureLidBody')}</span>
                    </div>
                  </div>
                  <div className="ob-feature">
                    <span className="ob-feature-icon gold">
                      <Sun size={17} />
                    </span>
                    <div>
                      <strong>{t('obFeatureDisplay')}</strong>
                      <span>{t('obFeatureDisplayBody')}</span>
                    </div>
                  </div>
                  <div className="ob-feature">
                    <span className="ob-feature-icon">
                      <Lock size={17} />
                    </span>
                    <div>
                      <strong>{t('obFeaturePrivacy')}</strong>
                      <span>{t('obFeaturePrivacyBody')}</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <span className="ob-eyebrow">{t('obStep', { current: step, total: TOTAL_STEPS })}</span>
                <h1 className="ob-title smaller">{t('obDefaultsTitle')}</h1>
                <p className="ob-lede">{t('obDefaultsBody')}</p>

                <div className="ob-field">
                  <span className="ob-field-label">{t('obDisplayChoice')}</span>
                  <div className="ob-display-grid" role="radiogroup" aria-label={t('obDisplayChoice')}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={display === 'on'}
                      className={`ob-display-card${display === 'on' ? ' is-selected' : ''}`}
                      onClick={() => setDisplay('on')}
                    >
                      <span className="ob-display-icon">
                        <Sun size={19} />
                      </span>
                      <span className="ob-display-title">{t('displayOn')}</span>
                      <span className="ob-display-sub">{t('displayOnSub')}</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={display === 'auto'}
                      className={`ob-display-card${display === 'auto' ? ' is-selected' : ''}`}
                      onClick={() => setDisplay('auto')}
                    >
                      <span className="ob-display-icon">
                        <Moon size={19} />
                      </span>
                      <span className="ob-display-title">{t('displayAuto')}</span>
                      <span className="ob-display-sub">{t('displayAutoSub')}</span>
                    </button>
                  </div>
                </div>

                <div className="ob-field">
                  <span className="ob-field-label">{t('obDurationChoice')}</span>
                  <div className="ob-duration-row" role="radiogroup" aria-label={t('obDurationChoice')}>
                    {DURATION_LABELS.map((entry) => (
                      <button
                        key={entry.key}
                        type="button"
                        role="radio"
                        aria-checked={duration === entry.ms}
                        className={`duration-pill${duration === entry.ms ? ' is-selected' : ''}`}
                        onClick={() => setDuration(entry.ms)}
                      >
                        {t(entry.key)}
                      </button>
                    ))}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={duration === null}
                      className={`duration-pill${duration === null ? ' is-selected infinity' : ''}`}
                      onClick={() => setDuration(null)}
                      title={t('indefinitely')}
                    >
                      {t('durInf')}
                    </button>
                  </div>
                </div>

                <div className="ob-advanced">
                  <span className="ob-feature-icon gold">
                    <Activity size={17} />
                  </span>
                  <div className="ob-advanced-copy">
                    <strong>{t('activityTitle')}</strong>
                    <span>{t('activitySubtitle', { seconds: state.settings.activityIntervalSec })}</span>
                  </div>
                  <Toggle checked={advanced} onChange={setAdvanced} label={t('activityTitle')} />
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="ob-lid-icon">
                  <ShieldCheck size={34} strokeWidth={1.4} />
                </div>
                <span className="ob-eyebrow">{t('obStep', { current: step, total: TOTAL_STEPS })}</span>
                <h1 className="ob-title smaller">{t('obLidTitle')}</h1>
                <p className="ob-lede">{t('obLidBody')}</p>

                {error && (
                  <div className="ob-error">
                    <Banner tone="error">{error}</Banner>
                  </div>
                )}

                <div className="ob-lid-actions">
                  <button
                    type="button"
                    className="primary-button ob-primary"
                    onClick={() => void finish(true)}
                    disabled={busy}
                  >
                    {busy ? <span className="spinner" aria-hidden="true" /> : <ShieldCheck size={16} />}
                    {t('obLidEnable')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void finish(false)}
                    disabled={busy}
                  >
                    {t('obLidNotNow')}
                  </button>
                </div>

                <p className="ob-note">{t('obLidNote')}</p>

                <div className="ob-shortcut-tip">
                  <Keyboard size={15} />
                  <span>
                    {t('obShortcutHint', { shortcut: shortcutLabel(state.settings.shortcut) })}
                  </span>
                  <Keycaps accelerator={state.settings.shortcut} />
                </div>
              </>
            )}
          </div>
        </main>

        <footer className="ob-footer">
          <div className="ob-dots" aria-hidden="true">
            {Array.from({ length: TOTAL_STEPS }, (_, index) => (
              <span
                key={index}
                className={`ob-dot${index + 1 === step ? ' is-current' : ''}${index + 1 < step ? ' is-done' : ''}`}
              />
            ))}
          </div>
          <div className="ob-footer-actions">
            {step > 1 && (
              <button type="button" className="secondary-button" onClick={back} disabled={busy}>
                <ChevronLeft size={14} />
                {t('obBack')}
              </button>
            )}
            {step < 3 && (
              <button
                type="button"
                className="primary-button ob-primary"
                onClick={() => void next()}
                disabled={busy}
                data-testid="onboarding-next"
              >
                {busy && <span className="spinner" aria-hidden="true" />}
                {step === 1 ? t('obGetStarted') : t('obContinue')}
              </button>
            )}
          </div>
        </footer>

        <ToastViewport />
      </div>
    </div>
  );
}
