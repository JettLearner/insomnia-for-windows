import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PRESET_DURATIONS } from '../shared/types';
import {
  nextPreset,
  sanitizeSession,
  sanitizeSettings,
  sanitizeTimerDuration,
} from '../shared/settings';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('sanitizeSettings', () => {
  it('returns the documented defaults for junk input', () => {
    for (const raw of [null, undefined, 42, 'nope', [], true]) {
      expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps valid values and normalises the persisted shape', () => {
    const parsed = sanitizeSettings({
      schemaVersion: 99,
      language: 'zh-CN',
      theme: 'light',
      launchAtLogin: true,
      startActiveOnLaunch: true,
      restoreSession: false,
      shortcut: 'ctrl+shift+alt+k',
      defaultDisplayMode: 'on',
      lastDurationMs: 2 * HOUR,
      lidGuardPreferred: true,
      advancedDefault: true,
      batteryGuardEnabled: false,
      batteryThreshold: 35,
      stopOnBattery: true,
      activityIntervalSec: 120,
      showNotifications: false,
      closePanelOnBlur: false,
      leftClickOpensPanel: false,
      animations: false,
      onboardingComplete: true,
      compactDensity: true,
    });
    expect(parsed).toEqual({
      schemaVersion: 1,
      language: 'zh-CN',
      theme: 'light',
      launchAtLogin: true,
      startActiveOnLaunch: true,
      restoreSession: false,
      shortcut: 'Ctrl+Alt+Shift+K',
      defaultDisplayMode: 'on',
      lastDurationMs: 2 * HOUR,
      lidGuardPreferred: true,
      advancedDefault: true,
      batteryGuardEnabled: false,
      batteryThreshold: 35,
      stopOnBattery: true,
      activityIntervalSec: 120,
      showNotifications: false,
      closePanelOnBlur: false,
      leftClickOpensPanel: false,
      animations: false,
      onboardingComplete: true,
      compactDensity: true,
    });
  });

  it('drops unknown enum values and non-boolean flags', () => {
    const parsed = sanitizeSettings({
      language: 'fr-FR',
      theme: 'midnight',
      defaultDisplayMode: 'always',
      launchAtLogin: 'yes',
      restoreSession: 1,
      onboardingComplete: {},
    });
    expect(parsed.language).toBe(DEFAULT_SETTINGS.language);
    expect(parsed.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(parsed.defaultDisplayMode).toBe(DEFAULT_SETTINGS.defaultDisplayMode);
    expect(parsed.launchAtLogin).toBe(DEFAULT_SETTINGS.launchAtLogin);
    expect(parsed.restoreSession).toBe(DEFAULT_SETTINGS.restoreSession);
    expect(parsed.onboardingComplete).toBe(DEFAULT_SETTINGS.onboardingComplete);
  });

  it('rejects invalid shortcuts in favour of the default', () => {
    for (const shortcut of ['', 'nonsense', 'Ctrl+', 'Ctrl+Alt', 'Alt+Shift+F1+F2', 42]) {
      expect(sanitizeSettings({ shortcut }).shortcut).toBe(DEFAULT_SETTINGS.shortcut);
    }
    expect(sanitizeSettings({ shortcut: 'win+alt+s' }).shortcut).toBe('Alt+Super+S');
  });

  it('treats lastDurationMs as a strict 1 minute .. 24 hour range', () => {
    expect(sanitizeSettings({ lastDurationMs: null }).lastDurationMs).toBeNull();
    expect(sanitizeSettings({ lastDurationMs: MINUTE }).lastDurationMs).toBe(MINUTE);
    expect(sanitizeSettings({ lastDurationMs: 24 * HOUR }).lastDurationMs).toBe(24 * HOUR);
    expect(sanitizeSettings({ lastDurationMs: 59_999 }).lastDurationMs).toBe(
      DEFAULT_SETTINGS.lastDurationMs,
    );
    expect(sanitizeSettings({ lastDurationMs: 24 * HOUR + 1 }).lastDurationMs).toBe(
      DEFAULT_SETTINGS.lastDurationMs,
    );
    expect(sanitizeSettings({ lastDurationMs: Number.NaN }).lastDurationMs).toBe(
      DEFAULT_SETTINGS.lastDurationMs,
    );
    expect(sanitizeSettings({ lastDurationMs: '900000' }).lastDurationMs).toBe(
      DEFAULT_SETTINGS.lastDurationMs,
    );
    // fractional values are rounded, not truncated arbitrarily
    expect(sanitizeSettings({ lastDurationMs: 90_000.6 }).lastDurationMs).toBe(90_001);
  });

  it('rounds and clamps the battery threshold to 5..95', () => {
    expect(sanitizeSettings({ batteryThreshold: 5 }).batteryThreshold).toBe(5);
    expect(sanitizeSettings({ batteryThreshold: 95 }).batteryThreshold).toBe(95);
    expect(sanitizeSettings({ batteryThreshold: 0 }).batteryThreshold).toBe(5);
    expect(sanitizeSettings({ batteryThreshold: 200 }).batteryThreshold).toBe(95);
    expect(sanitizeSettings({ batteryThreshold: 20.7 }).batteryThreshold).toBe(21);
    expect(sanitizeSettings({ batteryThreshold: Number.POSITIVE_INFINITY }).batteryThreshold).toBe(
      DEFAULT_SETTINGS.batteryThreshold,
    );
  });

  it('only accepts the application-supported activity intervals', () => {
    for (const seconds of [30, 60, 120, 300]) {
      expect(sanitizeSettings({ activityIntervalSec: seconds }).activityIntervalSec).toBe(seconds);
    }
    // Values are clamped first, then snapped onto a supported interval.
    expect(sanitizeSettings({ activityIntervalSec: 0 }).activityIntervalSec).toBe(30);
    expect(sanitizeSettings({ activityIntervalSec: -5 }).activityIntervalSec).toBe(30);
    expect(sanitizeSettings({ activityIntervalSec: 999 }).activityIntervalSec).toBe(300);
    expect(sanitizeSettings({ activityIntervalSec: 45 }).activityIntervalSec).toBe(
      DEFAULT_SETTINGS.activityIntervalSec,
    );
    expect(sanitizeSettings({ activityIntervalSec: '60' }).activityIntervalSec).toBe(
      DEFAULT_SETTINGS.activityIntervalSec,
    );
    expect(sanitizeSettings({ activityIntervalSec: Number.NaN }).activityIntervalSec).toBe(
      DEFAULT_SETTINGS.activityIntervalSec,
    );
  });

  it('ignores unknown keys instead of leaking them into state', () => {
    const parsed = sanitizeSettings({ __proto__: { poisoned: true }, extra: 'x' });
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.hasOwn(parsed, 'extra')).toBe(false);
    expect(Object.hasOwn(parsed, 'poisoned')).toBe(false);
  });
});

describe('nextPreset', () => {
  const order: Array<number | null> = [...PRESET_DURATIONS, null];

  it('cycles forward through every preset and the indefinite slot', () => {
    let current = order[0];
    for (let index = 1; index <= order.length; index += 1) {
      current = nextPreset(current, 1);
      expect(current).toBe(order[index % order.length]);
    }
  });

  it('cycles backward and wraps to the indefinite slot', () => {
    expect(nextPreset(15 * MINUTE, -1)).toBeNull();
    expect(nextPreset(null, -1)).toBe(8 * HOUR);
  });

  it('starts from the first preset when the current value is not a preset', () => {
    expect(nextPreset(42 * MINUTE, 1)).toBe(30 * MINUTE);
    expect(nextPreset(42 * MINUTE, -1)).toBeNull();
  });
});

describe('sanitizeSession', () => {
  const valid = {
    active: true as const,
    startedAt: 1_700_000_000_000,
    endsAt: 1_700_000_900_000,
    durationMs: 900_000,
    displayMode: 'on' as const,
    advanced: true,
    lid: true,
  };

  it('rejects anything that is not an active session', () => {
    expect(sanitizeSession(null)).toBeNull();
    expect(sanitizeSession('active')).toBeNull();
    expect(sanitizeSession({ ...valid, active: false })).toBeNull();
    expect(sanitizeSession({ ...valid, active: 'true' })).toBeNull();
    expect(sanitizeSession({ ...valid, startedAt: null })).toBeNull();
    expect(sanitizeSession({ ...valid, startedAt: Number.NaN })).toBeNull();
  });

  it('preserves an indefinite session with null ends', () => {
    expect(sanitizeSession({ ...valid, endsAt: null, durationMs: null })).toEqual({
      active: true,
      startedAt: valid.startedAt,
      endsAt: null,
      durationMs: null,
      displayMode: 'on',
      advanced: true,
      lid: false,
    });
  });

  it('never restores lid protection implicitly', () => {
    expect(sanitizeSession(valid)?.lid).toBe(false);
  });

  it('refuses a duration without a matching end time', () => {
    expect(sanitizeSession({ ...valid, endsAt: null })).toBeNull();
    expect(sanitizeSession({ ...valid, endsAt: Number.NaN })).toBeNull();
  });

  it('keeps a timed session alive when only the duration field is corrupt', () => {
    for (const durationMs of [-5, '900000', Number.NaN]) {
      const parsed = sanitizeSession({ ...valid, durationMs });
      expect(parsed).not.toBeNull();
      expect(parsed?.endsAt).toBe(valid.endsAt);
      expect(parsed?.durationMs).toBeNull();
    }
  });

  it('coerces display mode and advanced flags defensively', () => {
    const parsed = sanitizeSession({ ...valid, displayMode: 'turbo', advanced: 'yes' });
    expect(parsed?.displayMode).toBe('auto');
    expect(parsed?.advanced).toBe(false);
  });
});

describe('sanitizeTimerDuration', () => {
  it('accepts null as the indefinite duration', () => {
    expect(sanitizeTimerDuration(null)).toBeNull();
  });

  it('accepts 1 second .. 24 hours and rounds to whole milliseconds', () => {
    expect(sanitizeTimerDuration(1000)).toBe(1000);
    expect(sanitizeTimerDuration(15 * MINUTE)).toBe(15 * MINUTE);
    expect(sanitizeTimerDuration(90_000.4)).toBe(90_000);
    expect(sanitizeTimerDuration(24 * HOUR)).toBe(24 * HOUR);
  });

  it('returns undefined for values the UI must ignore', () => {
    expect(sanitizeTimerDuration(999)).toBeUndefined();
    expect(sanitizeTimerDuration(24 * HOUR + 1)).toBeUndefined();
    expect(sanitizeTimerDuration('900000')).toBeUndefined();
    expect(sanitizeTimerDuration(Number.NaN)).toBeUndefined();
    expect(sanitizeTimerDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeTimerDuration(undefined)).toBeUndefined();
  });
});
