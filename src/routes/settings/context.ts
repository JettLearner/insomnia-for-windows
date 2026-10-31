import { createContext, useContext } from 'react';
import type { SettingsPatch } from '../../../shared/types';

export interface SettingsActions {
  save: (patch: SettingsPatch) => Promise<boolean>;
  goTo: (section: string) => void;
}

export const SettingsActionsContext = createContext<SettingsActions | null>(null);

export function useSettingsActions(): SettingsActions {
  const value = useContext(SettingsActionsContext);
  if (!value) throw new Error('useSettingsActions must be used inside Settings.');
  return value;
}
