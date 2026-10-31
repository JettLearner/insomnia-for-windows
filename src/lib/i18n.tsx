import { useCallback } from 'react';
import { translate, type MessageKey } from '../../shared/i18n';
import { useRuntime } from './runtime';

export function useT() {
  const { state } = useRuntime();
  const locale = state.locale;
  return useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );
}
