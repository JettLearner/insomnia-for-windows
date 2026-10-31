import {
  DEFAULT_SETTINGS,
  PRESET_DURATIONS,
  type Settings,
  type SessionState,
} from './types';
import { canonicalize } from './shortcut';

const LANGUAGES = new Set(['system', 'en-US', 'zh-CN']);
const THEMES = new Set(['dark', 'light', 'system']);
const DISPLAY_MODES = new Set(['on', 'auto']);
const ACTIVITY_INTERVALS = new Set([30, 60, 120, 300]);

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function sanitizeSettings(raw: unknown): Settings {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;

  const language =
    typeof input.language === 'string' && LANGUAGES.has(input.language)
      ? (input.language as Settings['language'])
      : d.language;
  const theme =
    typeof input.theme === 'string' && THEMES.has(input.theme)
      ? (input.theme as Settings['theme'])
      : d.theme;
  const display =
    typeof input.defaultDisplayMode === 'string' && DISPLAY_MODES.has(input.defaultDisplayMode)
      ? (input.defaultDisplayMode as Settings['defaultDisplayMode'])
      : d.defaultDisplayMode;

  const shortcutInput = typeof input.shortcut === 'string' ? input.shortcut : d.shortcut;
  const shortcut = canonicalize(shortcutInput) ?? d.shortcut;

  let lastDurationMs: number | null = d.lastDurationMs;
  if (input.lastDurationMs === null) lastDurationMs = null;
  else if (typeof input.lastDurationMs === 'number' && Number.isFinite(input.lastDurationMs)) {
    const value = Math.round(input.lastDurationMs);
    if (value >= 60_000 && value <= 24 * 60 * 60_000) lastDurationMs = value;
  }

  const interval = boundedInt(input.activityIntervalSec, d.activityIntervalSec, 30, 300);

  return {
    schemaVersion: 1,
    language,
    theme,
    launchAtLogin: bool(input.launchAtLogin, d.launchAtLogin),
    startActiveOnLaunch: bool(input.startActiveOnLaunch, d.startActiveOnLaunch),
    restoreSession: bool(input.restoreSession, d.restoreSession),
    shortcut,
    defaultDisplayMode: display,
    lastDurationMs,
    lidGuardPreferred: bool(input.lidGuardPreferred, d.lidGuardPreferred),
    advancedDefault: bool(input.advancedDefault, d.advancedDefault),
    batteryGuardEnabled: bool(input.batteryGuardEnabled, d.batteryGuardEnabled),
    batteryThreshold: boundedInt(input.batteryThreshold, d.batteryThreshold, 5, 95),
    stopOnBattery: bool(input.stopOnBattery, d.stopOnBattery),
    activityIntervalSec: ACTIVITY_INTERVALS.has(interval) ? interval : d.activityIntervalSec,
    showNotifications: bool(input.showNotifications, d.showNotifications),
    closePanelOnBlur: bool(input.closePanelOnBlur, d.closePanelOnBlur),
    leftClickOpensPanel: bool(input.leftClickOpensPanel, d.leftClickOpensPanel),
    animations: bool(input.animations, d.animations),
    onboardingComplete: bool(input.onboardingComplete, d.onboardingComplete),
    compactDensity: bool(input.compactDensity, d.compactDensity),
  };
}

export function nextPreset(current: number | null, direction: 1 | -1): number | null {
  const options: Array<number | null> = [...PRESET_DURATIONS, null];
  const index = options.findIndex((value) => value === current);
  const start = index === -1 ? 0 : index;
  const nextIndex = (start + direction + options.length) % options.length;
  return options[nextIndex];
}

export function sanitizeSession(raw: unknown): SessionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (input.active !== true) return null;
  const startedAt = typeof input.startedAt === 'number' && Number.isFinite(input.startedAt) ? input.startedAt : null;
  if (startedAt === null) return null;
  const endsAt =
    input.endsAt === null
      ? null
      : typeof input.endsAt === 'number' && Number.isFinite(input.endsAt)
        ? input.endsAt
        : null;
  const durationMs =
    input.durationMs === null
      ? null
      : typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs > 0
        ? input.durationMs
        : null;
  if (durationMs !== null && endsAt === null) return null;

  return {
    active: true,
    startedAt,
    endsAt,
    durationMs,
    displayMode: input.displayMode === 'on' ? 'on' : 'auto',
    advanced: input.advanced === true,
    // Lid is never restored implicitly; it requires a fresh elevation check.
    lid: false,
  };
}

export function sanitizeTimerDuration(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const rounded = Math.round(raw);
  if (rounded < 1000 || rounded > 24 * 60 * 60_000) return undefined;
  return rounded;
}
