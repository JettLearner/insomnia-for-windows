/**
 * Shortcut parsing shared by the Settings recorder, the tray menu, and the
 * main-process registrar. Electron uses the accelerators produced here.
 */

const MODIFIERS = new Set(['ctrl', 'control', 'alt', 'shift', 'super', 'win', 'meta', 'windows']);

const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Esc',
  esc: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  '-': '-',
  '=': '=',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '`': '`',
};

export interface ParsedShortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super: boolean;
  key: string;
}

export function parseAccelerator(input: string): ParsedShortcut | null {
  if (!input || typeof input !== 'string') return null;
  const parts = input.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const parsed: ParsedShortcut = { ctrl: false, alt: false, shift: false, super: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS.has(lower)) {
      if (lower === 'ctrl' || lower === 'control') parsed.ctrl = true;
      else if (lower === 'alt') parsed.alt = true;
      else if (lower === 'shift') parsed.shift = true;
      else parsed.super = true;
      continue;
    }
    if (parsed.key) return null;
    parsed.key = normalizeKey(part);
  }
  if (!parsed.key) return null;
  return parsed;
}

export function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(lower)) return lower;
  // Keep single printable characters, reject everything else.
  if (raw.length === 1) return raw;
  return raw;
}

export function isValidAccelerator(input: string): boolean {
  const parsed = parseAccelerator(input);
  if (!parsed) return false;
  if (!parsed.key) return false;
  if (!parsed.ctrl && !parsed.alt && !parsed.shift && !parsed.super) return false;
  // A modifier by itself never reaches here because key would be empty.
  return true;
}

export function buildAccelerator(parts: Omit<ParsedShortcut, 'key'> & { key: string }): string {
  const result: string[] = [];
  if (parts.ctrl) result.push('Ctrl');
  if (parts.alt) result.push('Alt');
  if (parts.shift) result.push('Shift');
  if (parts.super) result.push('Super');
  result.push(parts.key);
  return result.join('+');
}

export function canonicalize(input: string): string | null {
  const parsed = parseAccelerator(input);
  if (!parsed) return null;
  if (!isValidAccelerator(input)) return null;
  return buildAccelerator(parsed);
}

/** Human label for Windows surfaces (Super → Win). */
export function shortcutLabel(input: string): string {
  return input.replace(/\bSuper\b/g, 'Win').replace(/\bCtrl\b/g, 'Ctrl');
}

export interface RecordedKey {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Turns a keydown event into an accelerator, ignoring bare modifiers. */
export function acceleratorFromKeyEvent(event: RecordedKey): string | null {
  const rawKey = event.key;
  if (!rawKey || ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Windows'].includes(rawKey)) return null;
  const key = normalizeKey(rawKey === ' ' ? ' ' : rawKey);
  if (!key) return null;
  const accelerator = buildAccelerator({
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    super: event.metaKey,
    key,
  });
  return isValidAccelerator(accelerator) ? accelerator : null;
}
