import { useCallback, useEffect, useRef, useState } from 'react';
import { formatRemaining, sessionRemainingMs } from '../../../shared/format';
import type { DisplayMode, Settings } from '../../../shared/types';
import { Banner } from '../../components/Banner';
import { Activity, ChevronDown, Laptop, Play, Power } from '../../components/Icons';
import { SettingRow } from '../../components/SettingRow';
import { Toggle } from '../../components/Toggle';
import {
  Card,
  ChoiceGroup,
  InlineNote,
  SectionHead,
  StatusRow,
  type StatusTone,
} from '../../components/ui';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';
import { useSettingsActions } from './context';

const INTERVALS: Array<{ value: number; key: 'interval30' | 'interval60' | 'interval120' | 'interval300' }> = [
  { value: 30, key: 'interval30' },
  { value: 60, key: 'interval60' },
  { value: 120, key: 'interval120' },
  { value: 300, key: 'interval300' },
];

export function PowerSection() {
  const { state, run, notify, busy } = useRuntime();
  const { save } = useSettingsActions();
  const t = useT();
  const { capabilities, session, settings } = state;
  const [checking, setChecking] = useState(false);
  const testWasRunning = useRef(false);

  const lidSupported = capabilities.lidPolicySupported;
  const lidChecked = session.active ? session.lid : settings.lidGuardPreferred;
  const advancedChecked = session.active ? session.advanced : settings.advancedDefault;
  const displayMode = session.active ? session.displayMode : settings.defaultDisplayMode;

  const lidTone: StatusTone =
    lidSupported === true ? 'good' : lidSupported === false ? 'bad' : '';
  const lidValue =
    lidSupported === true
      ? t('compatAvailable')
      : lidSupported === false
        ? t('compatUnsupported')
        : t('compatUnknown');

  useEffect(() => {
    const isTest = session.active && session.durationMs === 10_000;
    if (isTest) {
      testWasRunning.current = true;
      return;
    }
    if (testWasRunning.current) {
      testWasRunning.current = false;
      notify(t('testFinished'), 'success');
    }
  }, [session.active, session.durationMs, notify, t]);

  const check = useCallback(async () => {
    setChecking(true);
    const result = await run({ type: 'check-system' });
    setChecking(false);
    if (result.ok) notify(t('checkDone'), 'success');
  }, [run, notify, t]);

  const testRunning = session.active && session.durationMs === 10_000;
  const testRemaining = testRunning ? sessionRemainingMs(session, state.now) : null;

  return (
    <>
      <SectionHead title={t('powerTitle')} subtitle={t('powerSubtitle')} />
      <div className="settings-stack">
        {capabilities.recoveryPending && (
          <Banner
            tone="error"
            action={{ label: t('recoveryAction'), onClick: () => void run({ type: 'recover-lid' }) }}
          >
            {t('recoveryBanner')}
          </Banner>
        )}

        <Card title={t('compatTitle')}>
          <StatusRow label={t('compatIdle')} value={t('compatReady')} tone="good" />
          <StatusRow label={t('compatLid')} value={lidValue} tone={lidTone} />
          <StatusRow
            label={t('compatAdmin')}
            value={capabilities.elevated ? t('compatGranted') : t('compatRequired')}
            tone={capabilities.elevated ? 'good' : 'warn'}
          />
          <StatusRow
            label={t('compatHelper')}
            value={capabilities.helperConnected ? t('compatConnected') : t('compatDisconnected')}
            tone={capabilities.helperConnected ? 'good' : 'bad'}
          />
          <div className="card-foot inline-foot">
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() => void check()}
              disabled={checking || busy}
            >
              {checking ? <span className="spinner" aria-hidden="true" /> : <Power size={14} />}
              {checking ? t('checking') : t('runCheck')}
            </button>
          </div>
        </Card>

        <Card title={t('advancedLabel')}>
          <SettingRow
            icon={<Laptop size={15} />}
            title={t('lidToggle')}
            description={lidSupported === false ? t('lidUnsupported') : t('lidToggleHint')}
            badge={
              !capabilities.elevated && lidSupported !== false && !session.lid
                ? t('adminBadge')
                : undefined
            }
            control={
              <Toggle
                checked={lidChecked}
                disabled={lidSupported === false || busy}
                onChange={(next) => void run({ type: 'set-lid', enabled: next })}
                label={t('lidToggle')}
              />
            }
          />
          {capabilities.lidError && (
            <InlineNote tone="error">
              {t('lidFailed')} <code>{capabilities.lidError}</code>
            </InlineNote>
          )}
          <SettingRow
            icon={<Activity size={15} />}
            title={t('activityToggle')}
            description={t('activityToggleHint')}
            control={
              <Toggle
                checked={advancedChecked}
                disabled={busy}
                onChange={(next) => void run({ type: 'set-advanced', enabled: next })}
                label={t('activityToggle')}
              />
            }
          />
          <SettingRow
            title={t('activityInterval')}
            description={t('appliesWhenOn')}
            control={
              <div className="select-wrap">
                <select
                  className="select"
                  value={settings.activityIntervalSec}
                  disabled={!advancedChecked}
                  aria-label={t('activityInterval')}
                  onChange={(event) =>
                    void save({ activityIntervalSec: Number(event.target.value) as Settings['activityIntervalSec'] })
                  }
                >
                  {INTERVALS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {t(entry.key)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
            }
          />
        </Card>

        <Card title={t('displayLabel')}>
          <SettingRow
            title={t('defaultDisplay')}
            description={t('applyNeedsActive')}
            control={
              <ChoiceGroup<DisplayMode>
                value={displayMode}
                onChange={(next) => void run({ type: 'set-display', mode: next })}
                label={t('defaultDisplay')}
                disabled={busy}
                options={[
                  { value: 'on', label: t('displayOn') },
                  { value: 'auto', label: t('displayAuto') },
                ]}
              />
            }
          />
        </Card>

        <Card title={t('cardVerification')}>
          <SettingRow
            icon={<Play size={15} />}
            title={t('test10s')}
            description={t('testNote')}
            control={
              testRunning ? (
                <span className="test-running">
                  <span className="spinner" aria-hidden="true" />
                  {t('testRunning')}
                  {testRemaining !== null && (
                    <span className="tnum">{formatRemaining(testRemaining, state.locale)}</span>
                  )}
                </span>
              ) : (
                <button
                  type="button"
                  className="secondary-button compact-button"
                  disabled={busy}
                  onClick={() => void run({ type: 'test' })}
                >
                  {t('test10s')}
                </button>
              )
            }
          />
        </Card>
      </div>
    </>
  );
}
