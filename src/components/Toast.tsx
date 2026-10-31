import { useT } from '../lib/i18n';
import { useRuntime } from '../lib/runtime';
import { X } from './Icons';

export function ToastViewport() {
  const { toast, dismissToast } = useRuntime();
  const t = useT();
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role="status" aria-live="polite">
      <span className="toast-dot" aria-hidden="true" />
      <span>{toast.text}</span>
      <button
        type="button"
        className="icon-button"
        onClick={dismissToast}
        aria-label={t('dismiss')}
        style={{ width: 20, height: 20, marginRight: -4 }}
      >
        <X size={11} />
      </button>
    </div>
  );
}
