import type { ThemeMode } from '../../../shared/types';
import { Globe, Monitor, Moon, Palette, Sliders, Sparkles, Sun } from '../../components/Icons';
import { SettingRow } from '../../components/SettingRow';
import { Toggle } from '../../components/Toggle';
import { Card, ChoiceGroup, SectionHead } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';
import { useSettingsActions } from './context';

export function AppearanceSection() {
  const { state } = useRuntime();
  const { save, goTo } = useSettingsActions();
  const t = useT();
  const { settings } = state;
  const languageLabel =
    settings.language === 'system'
      ? t('languageSystem')
      : settings.language === 'zh-CN'
        ? t('languageChinese')
        : t('languageEnglish');

  return (
    <>
      <SectionHead title={t('appearanceTitle')} subtitle={t('appearanceSubtitle')} />

      <div className="settings-stack">
        <Card title={t('theme')}>
          <div className="appearance-choice">
            <ChoiceGroup<ThemeMode>
              value={settings.theme}
              onChange={(next) => void save({ theme: next })}
              label={t('theme')}
              options={[
                { value: 'dark', label: t('themeDark'), icon: <Moon size={14} /> },
                { value: 'light', label: t('themeLight'), icon: <Sun size={14} /> },
                { value: 'system', label: t('themeSystem'), icon: <Monitor size={14} /> },
              ]}
            />
            <p className="card-note">{t('autosaveHint')}</p>
          </div>
        </Card>

        <Card title={t('density')}>
          <div className="appearance-choice">
            <ChoiceGroup<'comfortable' | 'compact'>
              value={settings.compactDensity ? 'compact' : 'comfortable'}
              onChange={(next) => void save({ compactDensity: next === 'compact' })}
              label={t('density')}
              options={[
                { value: 'comfortable', label: t('densityComfortable'), icon: <Sliders size={14} /> },
                { value: 'compact', label: t('densityCompact'), icon: <Sliders size={14} /> },
              ]}
            />
          </div>
        </Card>

        <Card>
          <SettingRow
            icon={<Palette size={15} />}
            title={t('accentFixed')}
            description={t('accentFixedHint')}
            control={<span className="accent-swatch" aria-hidden="true" />}
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
          <SettingRow
            icon={<Globe size={15} />}
            title={t('language')}
            description={t('languageShortcutHint')}
            control={
              <button type="button" className="ghost-button compact-button" onClick={() => goTo('general')}>
                {languageLabel}
              </button>
            }
          />
        </Card>
      </div>
    </>
  );
}
