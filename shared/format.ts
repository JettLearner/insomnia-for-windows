import type { EffectiveLocale, SessionState } from './types';

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * Compact duration used on the ring, in the tray menu, and in notifications.
 * English: 8m 38s / 1h 02m / ∞. Chinese: 8分38秒 / 1小时02分 / ∞.
 */
export function formatRemaining(ms: number, locale: EffectiveLocale): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (locale === 'zh-CN') {
    if (hours > 0) return `${hours}小时${pad2(minutes)}分`;
    if (minutes > 0) return `${minutes}分${pad2(seconds)}秒`;
    return `${seconds}秒`;
  }
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
  return `${seconds}s`;
}

/** Longer, human-readable duration for tooltips and menus. */
export function formatDurationLong(ms: number | null, locale: EffectiveLocale): string {
  if (ms === null) return locale === 'zh-CN' ? '无限期' : 'Indefinitely';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes % 60 === 0) {
    const hours = totalMinutes / 60;
    return locale === 'zh-CN' ? `${hours} 小时` : `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return locale === 'zh-CN' ? `${totalMinutes} 分钟` : `${totalMinutes} minutes`;
}

export function sessionRemainingMs(session: SessionState, now: number): number | null {
  if (!session.active) return null;
  if (session.endsAt === null) return null;
  return Math.max(0, session.endsAt - now);
}

export function isSessionExpired(session: SessionState, now: number): boolean {
  return session.active && session.endsAt !== null && session.endsAt <= now;
}

/** Progress from 0 (just started) to 1 (finished); indefinite sessions are 1. */
export function sessionProgress(session: SessionState, now: number): number {
  if (!session.active) return 0;
  if (session.startedAt === null || session.endsAt === null || session.durationMs === null) return 1;
  const total = session.endsAt - session.startedAt;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - session.startedAt) / total));
}

export function formatPercent(value: number | null, locale: EffectiveLocale): string {
  if (value === null) return locale === 'zh-CN' ? '未知' : 'Unknown';
  return `${Math.round(value)}%`;
}
