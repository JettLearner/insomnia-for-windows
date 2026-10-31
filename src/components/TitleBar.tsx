import type { ReactNode } from 'react';
import { AppMark } from './AppMark';
import { Minus, X } from './Icons';

export function TitleBar({
  title,
  subtitle,
  onClose,
  onMinimize,
  closeLabel,
  minimizeLabel,
  extra,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  onMinimize?: () => void;
  closeLabel: string;
  minimizeLabel?: string;
  extra?: ReactNode;
}) {
  return (
    <div className="titlebar">
      <AppMark size={22} />
      <div className="titlebar-title">
        <span>{title}</span>
        {subtitle && <span className="muted">{subtitle}</span>}
      </div>
      <div className="titlebar-actions">
        {extra}
        {onMinimize && (
          <button
            type="button"
            className="icon-button"
            onClick={onMinimize}
            aria-label={minimizeLabel}
            title={minimizeLabel}
          >
            <Minus size={14} />
          </button>
        )}
        <button
          type="button"
          className="icon-button close"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
