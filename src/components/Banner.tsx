import type { ReactNode } from 'react';
import { AlertTriangle } from './Icons';

export type BannerTone = 'warning' | 'info' | 'error';

export function Banner({
  tone = 'warning',
  children,
  action,
  icon,
}: {
  tone?: BannerTone;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  icon?: ReactNode;
}) {
  const className = tone === 'warning' ? 'banner' : `banner ${tone}`;
  return (
    <div className={className} role="status">
      <span className="banner-icon">{icon ?? <AlertTriangle size={14} />}</span>
      <div className="banner-copy">{children}</div>
      {action && (
        <button type="button" className="banner-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
