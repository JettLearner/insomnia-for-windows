import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { translate } from '../../shared/i18n';
import type {
  Bootstrap,
  Command,
  CommandResult,
  EffectiveLocale,
  RuntimeState,
  WindowName,
} from '../../shared/types';
import { getApi } from './api';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
}

interface RuntimeValue {
  bootstrap: Bootstrap;
  state: RuntimeState;
  windowName: WindowName;
  busy: boolean;
  toast: ToastMessage | null;
  notify: (text: string, kind?: ToastKind) => void;
  dismissToast: () => void;
  run: (command: Command, options?: { toast?: boolean }) => Promise<CommandResult>;
  retry: () => void;
}

const RuntimeContext = createContext<RuntimeValue | null>(null);

function guessLocale(): EffectiveLocale {
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function RuntimeBoot({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const locale = guessLocale();
  return (
    <div className="window-shell">
      <div className="boot-surface">
        <span className="app-mark large" style={{ width: 54, height: 54 }}>
          <BootMark />
        </span>
        {error ? (
          <div className="boot-error" role="alert">
            <strong>{translate(locale, 'bootErrorTitle')}</strong>
            <span>{translate(locale, 'bootErrorBody')}</span>
            <code>{error}</code>
            <div style={{ marginTop: 16 }}>
              <button type="button" className="primary-button" onClick={onRetry}>
                {translate(locale, 'reload')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>{translate(locale, 'bootLoading')}</span>
          </>
        )}
      </div>
    </div>
  );
}

function BootMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="11" fill="rgba(255,255,255,0.14)" />
      <circle cx="16" cy="16" r="7.4" fill="rgba(255,255,255,0.22)" />
      <circle cx="16" cy="16" r="4.2" fill="rgba(255,255,255,0.5)" />
      <circle cx="16" cy="16" r="1.8" fill="#F6B62E" />
    </svg>
  );
}

export function RuntimeProvider({
  windowName,
  children,
}: {
  windowName: WindowName;
  children: ReactNode;
}) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [state, setState] = useState<RuntimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(0);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastTimer = useRef<number | null>(null);
  const toastId = useRef(0);
  const stateRef = useRef<RuntimeState | null>(null);
  stateRef.current = state;

  useEffect(() => {
    document.body.dataset.app = windowName;
    const api = getApi();
    if (!api) {
      setError('window.insomniaz is undefined — the preload script did not run.');
      return;
    }
    let alive = true;
    setError(null);
    const unsubscribe = api.subscribe((next) => {
      if (alive) setState(next);
    });
    api
      .bootstrap()
      .then((boot) => {
        if (!alive) return;
        setBootstrap(boot);
        setState(boot.state);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [windowName, attempt]);

  const dismissToast = useCallback(() => {
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    setToast(null);
  }, []);

  const notify = useCallback((text: string, kind: ToastKind = 'info') => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastId.current += 1;
    setToast({ id: toastId.current, kind, text });
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, 2800);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const run = useCallback(
    async (command: Command, options: { toast?: boolean } = {}): Promise<CommandResult> => {
      const api = getApi();
      if (!api) {
        const message = 'The application bridge is unavailable.';
        if (options.toast !== false) notify(message, 'error');
        return { ok: false, error: message };
      }
      setPending((count) => count + 1);
      try {
        const result = await api.command(command);
        if (result.state) setState(result.state);
        if (!result.ok && options.toast !== false) {
          const locale = stateRef.current?.locale ?? guessLocale();
          notify(result.error ?? translate(locale, 'errGeneric'), 'error');
        }
        if (result.ok && options.toast === true) {
          const locale = stateRef.current?.locale ?? guessLocale();
          notify(translate(locale, 'saved'), 'success');
        }
        return result;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (options.toast !== false) notify(message, 'error');
        return { ok: false, error: message };
      } finally {
        setPending((count) => Math.max(0, count - 1));
      }
    },
    [notify],
  );

  const retry = useCallback(() => {
    setBootstrap(null);
    setState(null);
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  const ready = Boolean(bootstrap && state);
  const themeSetting = state?.settings.theme;

  useEffect(() => {
    if (!state) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      // The control panel keeps the brand's dark surface regardless of theme.
      const effective =
        windowName === 'panel'
          ? 'dark'
          : themeSetting === 'system'
            ? media.matches
              ? 'dark'
              : 'light'
            : themeSetting;
      document.documentElement.dataset.theme = effective;
    };
    apply();
    if (themeSetting === 'system' && windowName !== 'panel') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    return undefined;
  }, [themeSetting, windowName, ready]);

  useEffect(() => {
    if (!state) return;
    document.documentElement.lang = state.locale;
    document.body.dataset.density = state.settings.compactDensity ? 'compact' : 'comfortable';
    document.body.classList.toggle('no-anim', !state.settings.animations);
  }, [state?.locale, state?.settings.compactDensity, state?.settings.animations]);

  const value = useMemo<RuntimeValue | null>(() => {
    if (!bootstrap || !state) return null;
    return {
      bootstrap,
      state,
      windowName,
      busy: state.busy || pending > 0,
      toast,
      notify,
      dismissToast,
      run,
      retry,
    };
  }, [bootstrap, state, windowName, pending, toast, notify, dismissToast, run, retry]);

  if (!ready || !value) {
    return <RuntimeBoot error={error} onRetry={retry} />;
  }

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('useRuntime must be used inside RuntimeProvider.');
  return value;
}
