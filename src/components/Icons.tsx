import type { ReactNode } from 'react';

export interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

function Icon({
  children,
  size = 16,
  strokeWidth = 1.7,
  className,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function Sun(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2.5 12h2M19.5 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </Icon>
  );
}

export function Moon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.4 14.2A8.6 8.6 0 1 1 9.8 3.6a6.9 6.9 0 0 0 10.6 10.6Z" />
    </Icon>
  );
}

export function Clock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.3" />
      <path d="M12 7.4V12l3 1.8" />
    </Icon>
  );
}

export function Laptop(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.4 15.6V7.2A1.8 1.8 0 0 1 6.2 5.4h11.6a1.8 1.8 0 0 1 1.8 1.8v8.4" />
      <path d="M2.4 15.6h19.2" />
      <path d="M3.4 19.2h17.2" />
      <path d="M8.6 19.2v-3.6M15.4 19.2v-3.6" />
    </Icon>
  );
}

export function Activity(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.8 12h3.1l2.2-6.3 3.8 12.6 2.3-6.3h7" />
    </Icon>
  );
}

export function Sliders(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.2h16M4 12h16M4 17.8h16" />
      <circle cx="9" cy="6.2" r="1.9" fill="var(--surface)" />
      <circle cx="15.4" cy="12" r="1.9" fill="var(--surface)" />
      <circle cx="7.6" cy="17.8" r="1.9" fill="var(--surface)" />
    </Icon>
  );
}

export function Power(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2v8.4" />
      <path d="M7.3 5.9a7.6 7.6 0 1 0 9.4 0" />
    </Icon>
  );
}

export function X(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />
    </Icon>
  );
}

export function Minus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 12h13" />
    </Icon>
  );
}

export function ChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9.2 5.8 6.2 6.2-6.2 6.2" />
    </Icon>
  );
}

export function ChevronLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.8 5.8 8.6 12l6.2 6.2" />
    </Icon>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5.8 9.2 6.2 6.2 6.2-6.2" />
    </Icon>
  );
}

export function Check(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.6 12.4 4.7 4.7L19.6 6.8" />
    </Icon>
  );
}

export function Shield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.1 19 6v5.7c0 4.4-3 7.4-7 9.2-4-1.8-7-4.8-7-9.2V6l7-2.9Z" />
    </Icon>
  );
}

export function ShieldCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.1 19 6v5.7c0 4.4-3 7.4-7 9.2-4-1.8-7-4.8-7-9.2V6l7-2.9Z" />
      <path d="m9 11.8 2.1 2.1 4-4.2" />
    </Icon>
  );
}

export function ExternalLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.8 4.2h6v6" />
      <path d="m19.8 4.2-8.4 8.4" />
      <path d="M18.2 13.6v5.2a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1V6.4a1 1 0 0 1 1-1h5.2" />
    </Icon>
  );
}

export function Folder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.4 7.5A1.7 1.7 0 0 1 5.1 5.8h3.8l2.1 2.6h8A1.7 1.7 0 0 1 20.6 10v7.3a1.7 1.7 0 0 1-1.7 1.7H5.1a1.7 1.7 0 0 1-1.7-1.7V7.5Z" />
    </Icon>
  );
}

export function Download(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.4v11.2" />
      <path d="m7.5 10.1 4.5 4.5 4.5-4.5" />
      <path d="M4.2 17.4v2.2h15.6v-2.2" />
    </Icon>
  );
}

export function Restore(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.6 12a8.4 8.4 0 1 0 2.5-6" />
      <path d="M3.4 4.4v5.4h5.4" />
      <path d="M12 8.3v4l2.6 1.7" />
    </Icon>
  );
}

export function AlertTriangle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.2 21 19.6H3L12 4.2Z" />
      <path d="M12 9.6v4.6" />
      <path d="M12 17.2v.1" />
    </Icon>
  );
}

export function Info(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5" />
      <path d="M12 7.8v.1" />
    </Icon>
  );
}

export function Keyboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.4" y="6" width="19.2" height="12" rx="2.2" />
      <path d="M6 9.6h.1M9.3 9.6h.1M12.6 9.6h.1M15.9 9.6h.1M18.3 9.6h.1M6 12.6h.1M9.3 12.6h.1M12.6 12.6h.1M15.9 12.6h.1M18.3 12.6h.1M7.4 15.4h9.2" />
    </Icon>
  );
}

export function Battery(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.6" y="7.4" width="17" height="9.2" rx="2" />
      <path d="M22 10.5v3" />
      <path d="M5.6 10.2v3.6M8.8 10.2v3.6M12 10.2v3.6" />
    </Icon>
  );
}

export function Palette(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2a8.8 8.8 0 1 0 0 17.6h1.4a2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.3h1.9a2.8 2.8 0 0 0 2.8-2.8A8.8 8.8 0 0 0 12 3.2Z" />
      <circle cx="7.8" cy="11.4" r="1" />
      <circle cx="10.2" cy="7.6" r="1" />
      <circle cx="14.4" cy="7.3" r="1" />
    </Icon>
  );
}

export function Lock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.8" y="10.4" width="14.4" height="10" rx="2.1" />
      <path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" />
      <path d="M12 14.2v2.4" />
    </Icon>
  );
}

export function Globe(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M3.3 12h17.4" />
      <path d="M12 3.3c2.6 2.7 3.9 5.6 3.9 8.7s-1.3 6-3.9 8.7c-2.6-2.7-3.9-5.6-3.9-8.7s1.3-6 3.9-8.7Z" />
    </Icon>
  );
}

export function Monitor(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.8" y="4.2" width="18.4" height="12.2" rx="2" />
      <path d="M8.4 20.2h7.2M12 16.4v3.8" />
    </Icon>
  );
}

export function Cpu(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6.8" y="6.8" width="10.4" height="10.4" rx="2" />
      <path d="M10 3.4v3.4M14 3.4v3.4M10 17.2v3.4M14 17.2v3.4M3.4 10h3.4M3.4 14h3.4M17.2 10h3.4M17.2 14h3.4" />
    </Icon>
  );
}

export function Sparkles(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2 13.7 8l4.8 1.7-4.8 1.7L12 16.2l-1.7-4.8L5.5 9.7 10.3 8 12 3.2Z" />
      <path d="M18.4 15.2l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </Icon>
  );
}

export function Bell(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 9.4a6 6 0 0 0-12 0c0 4.6-1.8 5.7-1.8 5.7h15.6S18 14 18 9.4Z" />
      <path d="M9.9 18.2a2.4 2.4 0 0 0 4.2 0" />
    </Icon>
  );
}

export function Play(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.2 5.2 19 12 8.2 18.8V5.2Z" />
    </Icon>
  );
}

export function RotateCcw(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.6 12a8.4 8.4 0 1 1 2.5 6" />
      <path d="M3.4 19.6v-5.4h5.4" />
    </Icon>
  );
}

export function CircleDot(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function Display(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4.5" width="18" height="11.6" rx="1.8" />
      <path d="M3 16.1h18M7.6 20.4h8.8" />
      <path d="M12 16.1v4.3" />
    </Icon>
  );
}
