import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutopilotSnapshot } from '../../shared/autopilot';
import type { InsomniazApi } from '../../shared/types';
import { getApi } from './api';

/** Fallback refresh; the main process pushes updates as soon as they happen. */
const POLL_MS = 5000;

export type AutopilotActions = InsomniazApi['autopilot'];

export interface AutopilotState {
  snapshot: AutopilotSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
  act: <T>(fn: (actions: AutopilotActions) => Promise<T>) => Promise<T | null>;
}

export function useAutopilot(): AutopilotState {
  const api = getApi();
  const [snapshot, setSnapshot] = useState<AutopilotSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.autopilot.snapshot();
      if (!mounted.current) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    void refresh();
    const unsubscribe = api.autopilot.onUpdate((next) => {
      if (mounted.current) setSnapshot(next);
    });
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [api, refresh]);

  const act = useCallback(
    async <T,>(fn: (actions: AutopilotActions) => Promise<T>): Promise<T | null> => {
      if (!api) return null;
      try {
        const result = await fn(api.autopilot);
        await refresh();
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [api, refresh],
  );

  return { snapshot, error, refresh, act };
}
