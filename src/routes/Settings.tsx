import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MessageKey } from '../../shared/i18n';
import type { SettingsPatch } from '../../shared/types';
import {
  Activity,
  Battery,
  Info,
  Keyboard,
  Palette,
  Power,
  Sliders,
  Lock,
} from '../components/Icons';
import { ToastViewport } from '../components/Toast';
import { TitleBar } from '../components/TitleBar';
import { getApi, readSection, replaceSection } from '../lib/api';
import { useT } from '../lib/i18n';
import { useRuntime } from '../lib/runtime';
import { SettingsActionsContext, type SettingsActions } from './settings/context';
import { GeneralSection } from './settings/GeneralSection';
import { ShortcutsSection } from './settings/ShortcutsSection';
import { PowerSection } from './settings/PowerSection';
import { BatterySection } from './settings/BatterySection';
import { SoftStopSection } from './settings/SoftStopSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { PrivacySection } from './settings/PrivacySection';
import { AboutSection } from './settings/AboutSection';

type SectionId =
  | 'general'
  | 'shortcuts'
  | 'power'
  | 'battery'
  | 'softstop'
  | 'appearance'
  | 'privacy'
  | 'about';

interface NavEntry {
  id: SectionId;
  label: MessageKey;
  icon: ReactNode;
}

const NAV: NavEntry[] = [
  { id: 'general', label: 'navGeneral', icon: <Sliders size={15} /> },
  { id: 'shortcuts', label: 'navShortcuts', icon: <Keyboard size={15} /> },
  { id: 'power', label: 'navPower', icon: <Power size={15} /> },
  { id: 'battery', label: 'navBattery', icon: <Battery size={15} /> },
  { id: 'softstop', label: 'navSoftStop', icon: <Activity size={15} /> },
  { id: 'appearance', label: 'navAppearance', icon: <Palette size={15} /> },
  { id: 'privacy', label: 'navPrivacy', icon: <Lock size={15} /> },
  { id: 'about', label: 'navAbout', icon: <Info size={15} /> },
];

const SECTION_IDS = new Set<string>(NAV.map((entry) => entry.id));

function normalizeSection(raw: string): SectionId {
  return SECTION_IDS.has(raw) ? (raw as SectionId) : 'general';
}

export function Settings() {
  const { state, run } = useRuntime();
  const t = useT();
  const api = getApi();
  const [section, setSection] = useState<SectionId>(normalizeSection(readSection()));
  const [savedVisible, setSavedVisible] = useState(false);
  const savedTimer = useRef<number | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!api) return undefined;
    return api.onNavigateSection((next) => {
      if (SECTION_IDS.has(next)) {
        setSection(next as SectionId);
        replaceSection(next);
      }
    });
  }, [api]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [section]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const flashSaved = useCallback(() => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setSavedVisible(true);
    savedTimer.current = window.setTimeout(() => {
      savedTimer.current = null;
      setSavedVisible(false);
    }, 1500);
  }, []);

  const save = useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      const result = await run({ type: 'update-settings', patch });
      if (result.ok) flashSaved();
      return result.ok;
    },
    [run, flashSaved],
  );

  const goTo = useCallback((next: string) => {
    const id = normalizeSection(next);
    setSection(id);
    replaceSection(id);
  }, []);

  const actions: SettingsActions = { save, goTo };

  const body = (() => {
    switch (section) {
      case 'shortcuts':
        return <ShortcutsSection />;
      case 'power':
        return <PowerSection />;
      case 'battery':
        return <BatterySection />;
      case 'softstop':
        return <SoftStopSection />;
      case 'appearance':
        return <AppearanceSection />;
      case 'privacy':
        return <PrivacySection />;
      case 'about':
        return <AboutSection />;
      default:
        return <GeneralSection />;
    }
  })();

  return (
    <div className="window-shell">
      <div className="surface settings-surface">
        <TitleBar
          title="InsomniaZ"
          subtitle={t('settingsTitle')}
          closeLabel={t('closeWindowAria')}
          minimizeLabel={t('minimizeWindowAria')}
          onClose={() => void api?.closeWindow('settings')}
          onMinimize={() => void api?.minimizeWindow('settings')}
          extra={
            <span
              className={`saved-chip${savedVisible ? ' is-visible' : ''}`}
              aria-live="polite"
              aria-atomic="true"
            >
              {t('saved')}
            </span>
          }
        />

        <div className="settings-body">
          <nav className="settings-nav" aria-label={t('settingsSectionsAria')}>
            <div className="nav-caption">{t('settingsTitle')}</div>
            {NAV.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`nav-item${section === entry.id ? ' is-active' : ''}`}
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => goTo(entry.id)}
              >
                <span className="nav-icon">{entry.icon}</span>
                <span>{t(entry.label)}</span>
                <span className="nav-indicator" aria-hidden="true" />
              </button>
            ))}
            <div className="nav-footer">
              <span>{t('windowsPort')}</span>
              <span className="tnum">v{state.version}</span>
            </div>
          </nav>

          <main className="settings-main" ref={mainRef}>
            <div className="settings-content">
              <SettingsActionsContext.Provider value={actions}>{body}</SettingsActionsContext.Provider>
            </div>
          </main>
        </div>

        <ToastViewport />
      </div>
    </div>
  );
}
