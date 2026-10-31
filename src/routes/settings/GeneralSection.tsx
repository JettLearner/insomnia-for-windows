import type { Settings } from '../../../shared/types';
import {
  Bell,
  ChevronDown,
  Globe,
  Laptop,
  Monitor,
  Play,
  Restore,
  Sliders,
  Sparkles,
} from '../../components/Icons';
import { SettingRow } from '../../components/SettingRow';
import { Toggle } from '../../components/Toggle';
import { Card, SectionHead } from '../../components/ui';
import { getApi } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';
import { useSettingsActions } from './context';

export function GeneralSection() {
  const { state, bootstrap } = useRuntime();
  const { save } = useSettingsActions();
  const t = useT();
  const { settings } = state;

  return (
    <>
      <SectionHead title={t('generalTitle')} subtitle={t('generalSubtitle')} />

      <div className="settings-stack">
        <Card title={t('cardStartup')}>
          <SettingRow
            icon={<Laptop size={15} />}
            title={t('launchAtLogin')}
            description={t('launchAtLoginHint')}
            control={
              <Toggle
                checked={settings.launchAtLogin}
                disabled={!bootstrap.loginItemSupported}
                onChange={(next) => void save({ launchAtLogin: next })}
                label={t('launchAtLogin')}
              />
            }
          />
          <SettingRow
            icon={<Play size={15} />}
            title={t('startActive')}
            description={t('startActiveHint')}
            control={
              <Toggle
                checked={settings.startActiveOnLaunch}
                onChange={(next) => void save({ startActiveOnLaunch: next })}
                label={t('startActive')}
              />
            }
          />
          <SettingRow
            icon={<Restore size={15} />}
            title={t('restoreSession')}
            description={t('restoreSessionHint')}
            control={
              <Toggle
                checked={settings.restoreSession}
                onChange={(next) => void save({ restoreSession: next })}
                label={t('restoreSession')}
              />
            }
          />
        </Card>

        <Card title={t('cardInterface')}>
          <SettingRow
            icon={<Globe size={15} />}
            title={t('language')}
            description={t('autosaveHint')}
            control={
              <div className="select-wrap">
                <select
                  className="select"
                  value={settings.language}
                  onChange={(event) =>
                    void save({ language: event.target.value as Settings['language'] })
                  }
                  aria-label={t('language')}
                >
                  <option value="system">{t('languageSystem')}</option>
                  <option value="zh-CN">{t('languageChinese')}</option>
                  <option value="en-US">{t('languageEnglish')}</option>
                </select>
                <ChevronDown size={13} />
              </div>
            }
          />
          <SettingRow
            icon={<Monitor size={15} />}
            title={t('leftClickPanel')}
            description={t('leftClickPanelHint')}
            control={
              <Toggle
                checked={settings.leftClickOpensPanel}
                onChange={(next) => void save({ leftClickOpensPanel: next })}
                label={t('leftClickPanel')}
              />
            }
          />
          <SettingRow
            icon={<Monitor size={15} />}
            title={t('closeOnBlur')}
            description={t('closeOnBlurHint')}
            control={
              <Toggle
                checked={settings.closePanelOnBlur}
                onChange={(next) => void save({ closePanelOnBlur: next })}
                label={t('closeOnBlur')}
              />
            }
          />
          <SettingRow
            icon={<Bell size={15} />}
            title={t('notifications')}
            description={t('notificationsHint')}
            control={
              <Toggle
                checked={settings.showNotifications}
                disabled={!bootstrap.notificationSupported}
                onChange={(next) => void save({ showNotifications: next })}
                label={t('notifications')}
              />
            }
          />
        </Card>

        <Card title={t('cardLayout')}>
          <SettingRow
            icon={<Sliders size={15} />}
            title={t('compactDensity')}
            description={t('compactDensityHint')}
            control={
              <Toggle
                checked={settings.compactDensity}
                onChange={(next) => void save({ compactDensity: next })}
                label={t('compactDensity')}
              />
            }
          />
          <SettingRow
            icon={<Sparkles size={15} />}
            title={t('animations')}
            description={t('animationsHint')}
            control={
              <Toggle
                checked={settings.animations}
                onChange={(next) => void save({ animations: next })}
                label={t('animations')}
              />
            }
          />
        </Card>

        <Card title={t('cardOnboarding')}>
          <SettingRow
            icon={<Sparkles size={15} />}
            title={t('reopenOnboarding')}
            description={t('reopenOnboardingHint')}
            control={
              <button
                type="button"
                className="secondary-button compact-button"
                onClick={() => void getApi()?.showOnboarding()}
              >
                {t('openOnboarding')}
              </button>
            }
          />
        </Card>
      </div>
    </>
  );
}
