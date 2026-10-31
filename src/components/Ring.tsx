import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Power } from './Icons';

/**
 * The concentric-ring mark. Four layered discs, a faint outer track and a
 * gold arc that counts down. Intentionally drawn with plain SVG so the
 * artwork stays crisp at any DPI and never depends on external assets.
 */
export function RingArt({
  size = 200,
  active,
  fraction = 1,
  indefinite = false,
}: {
  size?: number;
  active: boolean;
  fraction?: number;
  indefinite?: boolean;
}) {
  const raw = useId();
  const uid = `ring-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const progress = indefinite ? 1 : Math.min(1, Math.max(0, fraction));
  const dashOffset = 100 - progress * 100;
  return (
    <svg
      className={`ring-art${active ? ' is-active' : ' is-idle'}`}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`${uid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0.55" stopColor="#8E63EC" stopOpacity="0" />
          <stop offset="0.82" stopColor="#8E63EC" stopOpacity="0.26" />
          <stop offset="1" stopColor="#8E63EC" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}-disc1`} cx="44%" cy="38%" r="74%">
          <stop offset="0" stopColor="#9B7BEC" stopOpacity="0.55" />
          <stop offset="1" stopColor="#6445B8" stopOpacity="0.42" />
        </radialGradient>
        <radialGradient id={`${uid}-disc2`} cx="44%" cy="38%" r="72%">
          <stop offset="0" stopColor="#B295F4" stopOpacity="0.72" />
          <stop offset="1" stopColor="#8560E1" stopOpacity="0.62" />
        </radialGradient>
        <radialGradient id={`${uid}-disc3`} cx="44%" cy="38%" r="70%">
          <stop offset="0" stopColor="#D3BFFB" stopOpacity="0.92" />
          <stop offset="1" stopColor="#A888EF" stopOpacity="0.88" />
        </radialGradient>
        <radialGradient id={`${uid}-disc4`} cx="44%" cy="36%" r="70%">
          <stop offset="0" stopColor="#E8DDFF" />
          <stop offset="1" stopColor="#BDA6F7" />
        </radialGradient>
        <linearGradient id={`${uid}-arc`} x1="22%" y1="6%" x2="80%" y2="94%">
          <stop offset="0" stopColor="#FFD57E" />
          <stop offset="0.55" stopColor="#F6B62E" />
          <stop offset="1" stopColor="#F2A71B" />
        </linearGradient>
      </defs>

      <circle cx="100" cy="100" r="96" fill={`url(#${uid}-glow)`} />
      <circle cx="100" cy="100" r="78.5" fill={`url(#${uid}-disc1)`} />
      <circle cx="100" cy="100" r="59" fill={`url(#${uid}-disc2)`} />
      <circle cx="100" cy="100" r="40.5" fill={`url(#${uid}-disc3)`} />
      <circle cx="100" cy="100" r="22.5" fill={`url(#${uid}-disc4)`} />

      <circle cx="100" cy="100" r="92" stroke="rgba(255,255,255,0.07)" strokeWidth="1.4" />
      {active && (
        <circle
          cx="100"
          cy="100"
          r="92"
          stroke={`url(#${uid}-arc)`}
          strokeWidth="3.2"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={dashOffset}
          transform="rotate(-90 100 100)"
          className="ring-arc"
        />
      )}
    </svg>
  );
}

export interface RingProps {
  size?: number;
  active: boolean;
  fraction?: number;
  indefinite?: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
  onToggle?: () => void;
  onOpenSettings?: () => void;
}

export function Ring({
  size = 200,
  active,
  fraction = 1,
  indefinite = false,
  disabled = false,
  label,
  title,
  onToggle,
  onOpenSettings,
}: RingProps) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const origin = useRef({ x: 0, y: 0 });

  const clearTimer = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled || event.button !== 0) return;
    longPressed.current = false;
    origin.current = { x: event.clientX, y: event.clientY };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      longPressed.current = true;
      onOpenSettings?.();
    }, 550);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (timer.current === null) return;
    const dx = event.clientX - origin.current.x;
    const dy = event.clientY - origin.current.y;
    if (dx * dx + dy * dy > 144) clearTimer();
  };

  const pointerUp = (): void => {
    const wasLong = longPressed.current;
    longPressed.current = false;
    clearTimer();
    if (!disabled && !wasLong) onToggle?.();
  };

  const pointerCancel = (): void => {
    longPressed.current = false;
    clearTimer();
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle?.();
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      onOpenSettings?.();
    }
  };

  return (
    <button
      type="button"
      className={`ring-button${active ? ' is-active' : ''}`}
      role="switch"
      aria-checked={active}
      aria-label={label}
      aria-disabled={disabled}
      title={title}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onPointerLeave={pointerCancel}
      onKeyDown={keyDown}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenSettings?.();
      }}
    >
      <RingArt size={size} active={active} fraction={fraction} indefinite={indefinite} />
      <span className="ring-center-icon">
        <Power size={26} strokeWidth={1.5} />
      </span>
    </button>
  );
}
