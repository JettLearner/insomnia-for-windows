import { describe, expect, it } from 'vitest';
import {
  formatDurationLong,
  formatPercent,
  formatRemaining,
  isSessionExpired,
  sessionProgress,
  sessionRemainingMs,
} from '../shared/format';
import type { SessionState } from '../shared/types';

const NOW = 1_700_000_000_000;

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    active: true,
    startedAt: NOW - 15 * 60_000,
    endsAt: NOW + 15 * 60_000,
    durationMs: 30 * 60_000,
    displayMode: 'auto',
    advanced: false,
    lid: false,
    ...overrides,
  };
}

describe('formatRemaining', () => {
  it('pads minutes and seconds in English', () => {
    expect(formatRemaining(8 * 60_000 + 38_000, 'en-US')).toBe('8m 38s');
    expect(formatRemaining(62 * 60_000 + 5_000, 'en-US')).toBe('1h 02m');
    expect(formatRemaining(59_000, 'en-US')).toBe('59s');
  });

  it('rounds partial seconds up so a countdown never shows zero early', () => {
    expect(formatRemaining(1, 'en-US')).toBe('1s');
    expect(formatRemaining(59_001, 'en-US')).toBe('1m 00s');
  });

  it('formats Chinese units', () => {
    expect(formatRemaining(8 * 60_000 + 38_000, 'zh-CN')).toBe('8分38秒');
    expect(formatRemaining(62 * 60_000 + 5_000, 'zh-CN')).toBe('1小时02分');
    expect(formatRemaining(8_000, 'zh-CN')).toBe('8秒');
  });

  it('clamps negative values to zero', () => {
    expect(formatRemaining(-5_000, 'en-US')).toBe('0s');
    expect(formatRemaining(-5_000, 'zh-CN')).toBe('0秒');
  });
});

describe('formatDurationLong', () => {
  it('uses singular and plural hours', () => {
    expect(formatDurationLong(60 * 60_000, 'en-US')).toBe('1 hour');
    expect(formatDurationLong(2 * 60 * 60_000, 'en-US')).toBe('2 hours');
  });

  it('falls back to minutes for non-whole hours', () => {
    expect(formatDurationLong(90 * 60_000, 'en-US')).toBe('90 minutes');
    expect(formatDurationLong(90 * 60_000, 'zh-CN')).toBe('90 分钟');
  });

  it('renders indefinite durations', () => {
    expect(formatDurationLong(null, 'en-US')).toBe('Indefinitely');
    expect(formatDurationLong(null, 'zh-CN')).toBe('无限期');
  });
});

describe('session helpers', () => {
  it('returns null for inactive and indefinite sessions', () => {
    expect(sessionRemainingMs(session({ active: false }), NOW)).toBeNull();
    expect(sessionRemainingMs(session({ endsAt: null }), NOW)).toBeNull();
  });

  it('clamps remaining time at zero', () => {
    expect(sessionRemainingMs(session({ endsAt: NOW - 1 }), NOW)).toBe(0);
    expect(sessionRemainingMs(session(), NOW)).toBe(15 * 60_000);
  });

  it('detects expiry only for active, timed sessions', () => {
    expect(isSessionExpired(session({ endsAt: NOW - 1 }), NOW)).toBe(true);
    expect(isSessionExpired(session({ endsAt: NOW + 1 }), NOW)).toBe(false);
    expect(isSessionExpired(session({ active: false, endsAt: NOW - 1 }), NOW)).toBe(false);
    expect(isSessionExpired(session({ endsAt: null }), NOW)).toBe(false);
  });

  it('computes clamped progress', () => {
    expect(sessionProgress(session(), NOW)).toBe(0.5);
    expect(sessionProgress(session(), NOW - 60 * 60_000)).toBe(0);
    expect(sessionProgress(session(), NOW + 60 * 60_000)).toBe(1);
    expect(sessionProgress(session({ endsAt: null }), NOW)).toBe(1);
    expect(sessionProgress(session({ active: false }), NOW)).toBe(0);
    expect(
      sessionProgress(session({ startedAt: NOW, endsAt: NOW, durationMs: 0 }), NOW),
    ).toBe(1);
  });

  it('formats percentages', () => {
    expect(formatPercent(42.6, 'en-US')).toBe('43%');
    expect(formatPercent(null, 'en-US')).toBe('Unknown');
    expect(formatPercent(null, 'zh-CN')).toBe('未知');
  });
});
