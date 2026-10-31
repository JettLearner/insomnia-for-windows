import { useEffect, useState, type CSSProperties } from 'react';
import {
  Battery,
  ShieldCheck,
  Power,
} from '../../components/Icons';
import { SettingRow } from '../../components/SettingRow';
import { Toggle } from '../../components/Toggle';
import { Card, SectionHead } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';
import { useSettingsActions } from './context';

export function BatterySection() {
  const { state } = useRuntime();
  const { save } = useSettingsActions();
  const t = useT();
  const { settings, power, capabilities } = state;
  const [threshold, setThreshold] = useState(settings.batteryThreshold);

  useEffect(() => {
    setThreshold(settings.batteryThreshold);
  }, [settings.batteryThreshold]);

  const commitThreshold = (): void => {
    if (threshold !== settings.batteryThreshold) void save({ batteryThreshold: threshold });
  };

  const percent = power.batteryPercent;
  const status = !power.batteryPresent && capabilities.helperConnected
    ? t('batteryNone')
    : percent === null
      ? t('compatUnknown')
      : power.charging
        ? t('batteryCharging')
        : power.ac
          ? t('batteryOnAc')
          : t('batteryDischarging');

  return (
    <>
      <SectionHead title={t('batteryTitle')} subtitle={t('batterySubtitle')} />

      <div className="settings-stack">
        <Card>
          <SettingRow
            icon={<ShieldCheck size={15} />}
            title={t('batteryGuard')}
            description={t('batteryGuardHint')}
            control={
              <Toggle
                checked={settings.batteryGuardEnabled}
                onChange={(next) => void save({ batteryGuardEnabled: next })}
                label={t('batteryGuard')}
              />
            }
          />
          <div className={`threshold-block${settings.batteryGuardEnabled ? '' : ' is-disabled'}`}>
            <div className="threshold-head">
              <span>{t('batteryThreshold')}</span>
              <output className="threshold-value tnum">
                {t('batteryThresholdValue', { percent: threshold })}
              </output>
            </div>
            <div className="threshold-range">
              <span className="range-edge">5%</span>
              <input
                type="range"
                min={5}
                max={50}
                step={5}
                value={threshold}
                disabled={!settings.batteryGuardEnabled}
                aria-label={t('batteryThreshold')}
                style={{ '--fill': `${((threshold - 5) / 45) * 100}%` } as CSSProperties}
                onChange={(event) => setThreshold(Number(event.target.value))}
                onPointerUp={commitThreshold}
                onKeyUp={commitThreshold}
                onBlur={commitThreshold}
              />
              <span className="range-edge">50%</span>
            </div>
            <span className="threshold-note">{t('batteryRangeHint')}</span>
          </div>
          <SettingRow
            icon={<Power size={15} />}
            title={t('stopOnBattery')}
            description={t('stopOnBatteryHint')}
            control={
              <Toggle
                checked={settings.stopOnBattery}
                onChange={(next) => void save({ stopOnBattery: next })}
                label={t('stopOnBattery')}
              />
            }
          />
        </Card>

        <Card title={t('cardCurrentPower')}>
          <div className="power-card">
            <div className="power-visual" data-charging={power.charging}>
              <Battery size={30} strokeWidth={1.4} />
              {percent !== null && (
                <span className="power-visual-fill" style={{ height: `${Math.max(0, Math.min(100, percent))}%` }} />
              )}
            </div>
            <div className="power-copy">
              <span className="power-state">{status}</span>
              <span className="power-percent tnum">
                {percent === null ? '—' : `${Math.round(percent)}%`}
              </span>
              <div className="power-bar" aria-hidden="true">
                <span style={{ width: `${percent === null ? 0 : Math.max(0, Math.min(100, percent))}%` }} />
              </div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
