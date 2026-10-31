import { useCallback, useEffect, useState } from 'react';
import { acceleratorFromKeyEvent } from '../../../shared/shortcut';
import { Keyboard } from '../../components/Icons';
import { Card, InlineNote, Keycaps, SectionHead } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';

export function ShortcutsSection() {
  const { state, run, notify } = useRuntime();
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { settings } = state;

  const commit = useCallback(
    async (accelerator: string) => {
      const result = await run(
        { type: 'update-settings', patch: { shortcut: accelerator } },
        { toast: false },
      );
      if (result.ok) {
        setRecording(false);
        setError(null);
        notify(t('shortcutSaved'), 'success');
      } else {
        setError(result.error ?? t('shortcutInvalid'));
      }
    },
    [run, notify, t],
  );

  const reset = useCallback(async () => {
    const result = await run(
      { type: 'update-settings', patch: { shortcut: 'Ctrl+Alt+I' } },
      { toast: false },
    );
    if (result.ok) {
      setRecording(false);
      setError(null);
      notify(t('shortcutResetDone'), 'success');
    } else {
      setError(result.error ?? t('shortcutInvalid'));
    }
  }, [run, notify, t]);

  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        setError(null);
        return;
      }
      if (
        event.key === 'Backspace' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        void reset();
        return;
      }
      if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Windows'].includes(event.key)) return;
      const accelerator = acceleratorFromKeyEvent(event);
      if (!accelerator) {
        setError(t('shortcutInvalid'));
        return;
      }
      void commit(accelerator);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, commit, reset, t]);

  return (
    <>
      <SectionHead title={t('shortcutsTitle')} subtitle={t('shortcutsSubtitle')} />
      <div className="settings-stack">
        <Card>
          <div className="shortcut-hero">
            <span className="setting-icon shortcut-hero-icon">
              <Keyboard size={19} />
            </span>
            <div className="shortcut-hero-main">
              <span className="shortcut-hero-label">{t('globalShortcut')}</span>
              <Keycaps accelerator={settings.shortcut} className="keycaps-lg" />
              <p className="shortcut-hero-hint">{t('globalShortcutHint')}</p>
            </div>
            <div className="shortcut-hero-actions">
              {recording ? (
                <button type="button" className="secondary-button" onClick={() => setRecording(false)}>
                  {t('cancel')}
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setError(null);
                    setRecording(true);
                  }}
                >
                  {t('recordShortcut')}
                </button>
              )}
              <button type="button" className="ghost-button" onClick={() => void reset()}>
                {t('resetShortcut')}
              </button>
            </div>
          </div>

          {recording && (
            <div className="recorder" role="status">
              <span className="recording-dot" aria-hidden="true" />
              <span className="recorder-title">{t('recording')}</span>
              <span className="recorder-hint">{t('pressKeys')}</span>
              <span className="recorder-esc">Esc</span>
            </div>
          )}

          {error && <InlineNote tone="error">{error}</InlineNote>}

          <p className="card-note">{t('shortcutModifierHint')}</p>
        </Card>
      </div>
    </>
  );
}
