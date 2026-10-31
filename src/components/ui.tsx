import type { ReactNode } from 'react';
import { shortcutLabel } from '../../shared/shortcut';

export function Keycaps({ accelerator, className = '' }: { accelerator: string; className?: string }) {
  const parts = accelerator.split('+').filter(Boolean);
  return (
    <span className={`keycaps ${className}`.trim()}>
      {parts.map((part, index) => (
        <kbd className="kbd" key={`${part}-${index}`}>
          {shortcutLabel(part)}
        </kbd>
      ))}
    </span>
  );
}

export function SectionHead({ title, subtitle, aside }: { title: string; subtitle: string; aside?: ReactNode }) {
  return (
    <header className="section-head">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {aside && <div className="section-head-aside">{aside}</div>}
    </header>
  );
}

export function Card({
  title,
  children,
  footer,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {title && <header className="card-head">{title}</header>}
      {children}
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export function ChoiceGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T;
  options: Array<ChoiceOption<T>>;
  onChange: (next: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="choice-group" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`choice${value === option.value ? ' is-selected' : ''}`}
          onClick={() => onChange(option.value)}
          disabled={disabled}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export type StatusTone = 'good' | 'warn' | 'bad' | '';

export function StatusRow({ label, value, tone = '' }: { label: string; value: string; tone?: StatusTone }) {
  return (
    <div className="compat-row">
      <span className={`status-dot ${tone}`.trim()} aria-hidden="true" />
      <span className="compat-label">{label}</span>
      <span className={`compat-value ${tone === 'bad' ? 'is-bad' : tone === 'warn' ? 'is-warn' : ''}`.trim()}>
        {value}
      </span>
    </div>
  );
}

export function InlineNote({ children, tone = '' }: { children: ReactNode; tone?: 'error' | 'warn' | '' }) {
  return <p className={`inline-note ${tone}`.trim()}>{children}</p>;
}
