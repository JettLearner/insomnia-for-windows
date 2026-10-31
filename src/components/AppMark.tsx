import type { CSSProperties } from 'react';

export function AppMark({
  size = 22,
  className = '',
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`app-mark ${className}`.trim()}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
    >
      <svg width={size * 0.64} height={size * 0.64} viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="12.5" fill="rgba(255,255,255,0.13)" />
        <circle cx="16" cy="16" r="9" fill="rgba(255,255,255,0.18)" />
        <circle cx="16" cy="16" r="6" fill="rgba(255,255,255,0.3)" />
        <circle cx="16" cy="16" r="3.1" fill="rgba(255,255,255,0.62)" />
        <circle cx="16" cy="16" r="1.25" fill="#F6B62E" />
      </svg>
    </span>
  );
}
