import type { ReactNode } from 'react';

export function SettingRow({
  icon,
  title,
  description,
  badge,
  control,
  stacked = false,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badge?: string;
  control?: ReactNode;
  stacked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`setting-row${stacked ? ' is-stacked' : ''}`}>
      <div className="setting-row-main">
        {icon && <span className="setting-icon">{icon}</span>}
        <div className="setting-copy">
          <div className="setting-title-row">
            <span className="setting-title">{title}</span>
            {badge && <span className="badge admin">{badge}</span>}
          </div>
          {description && <span className="setting-desc">{description}</span>}
        </div>
        {control && <div className="setting-control">{control}</div>}
      </div>
      {children && <div className="setting-extra">{children}</div>}
    </div>
  );
}
