import { describe, expect, it } from 'vitest';
import {
  acceleratorFromKeyEvent,
  buildAccelerator,
  canonicalize,
  isValidAccelerator,
  normalizeKey,
  parseAccelerator,
  shortcutLabel,
} from '../shared/shortcut';

describe('parseAccelerator', () => {
  it('parses modifiers case-insensitively and keeps one key', () => {
    expect(parseAccelerator('ctrl+alt+i')).toEqual({
      ctrl: true,
      alt: true,
      shift: false,
      super: false,
      key: 'I',
    });
    expect(parseAccelerator('Shift + F12')).toMatchObject({ shift: true, key: 'F12' });
    expect(parseAccelerator('Super+ArrowUp')).toMatchObject({ super: true, key: 'Up' });
  });

  it('rejects empty input, missing keys, and multiple keys', () => {
    expect(parseAccelerator('')).toBeNull();
    expect(parseAccelerator('Ctrl')).toBeNull();
    expect(parseAccelerator('Ctrl+Alt')).toBeNull();
    expect(parseAccelerator('Ctrl+A+B')).toBeNull();
    expect(parseAccelerator('Ctrl++')).toBeNull();
  });
});

describe('normalizeKey', () => {
  it('maps aliases and function keys', () => {
    expect(normalizeKey(' ')).toBe('Space');
    expect(normalizeKey('escape')).toBe('Esc');
    expect(normalizeKey('arrowleft')).toBe('Left');
    expect(normalizeKey('f9')).toBe('F9');
    expect(normalizeKey('f24')).toBe('F24');
    expect(normalizeKey('a')).toBe('A');
    expect(normalizeKey('7')).toBe('7');
    expect(normalizeKey('-')).toBe('-');
  });
});

describe('canonicalize', () => {
  it('normalizes ordering, casing, and aliases', () => {
    expect(canonicalize('ctrl+alt+i')).toBe('Ctrl+Alt+I');
    expect(canonicalize('shift + f12')).toBe('Shift+F12');
    expect(canonicalize('super+arrowup')).toBe('Super+Up');
    expect(canonicalize('alt+ctrl+space')).toBe('Ctrl+Alt+Space');
  });

  it('rejects shortcuts without a modifier or without a key', () => {
    expect(canonicalize('A')).toBeNull();
    expect(canonicalize('Ctrl')).toBeNull();
    expect(canonicalize('Ctrl+Alt')).toBeNull();
    expect(canonicalize('')).toBeNull();
  });
});

describe('isValidAccelerator', () => {
  it('requires at least one modifier and one key', () => {
    expect(isValidAccelerator('Ctrl+Alt+I')).toBe(true);
    expect(isValidAccelerator('Shift+F1')).toBe(true);
    expect(isValidAccelerator('I')).toBe(false);
    expect(isValidAccelerator('Ctrl')).toBe(false);
  });
});

describe('buildAccelerator', () => {
  it('emits a stable modifier order', () => {
    expect(
      buildAccelerator({ ctrl: true, alt: true, shift: true, super: true, key: 'K' }),
    ).toBe('Ctrl+Alt+Shift+Super+K');
    expect(buildAccelerator({ ctrl: false, alt: false, shift: false, super: false, key: 'F15' })).toBe(
      'F15',
    );
  });
});

describe('acceleratorFromKeyEvent', () => {
  it('ignores bare modifiers and unmodified keys', () => {
    expect(
      acceleratorFromKeyEvent({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }),
    ).toBeNull();
    expect(
      acceleratorFromKeyEvent({ key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
    ).toBeNull();
  });

  it('builds accelerators from real keydown shapes', () => {
    expect(
      acceleratorFromKeyEvent({ key: 'k', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe('Ctrl+Shift+K');
    expect(
      acceleratorFromKeyEvent({ key: ' ', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }),
    ).toBe('Alt+Space');
    expect(
      acceleratorFromKeyEvent({ key: 'ArrowUp', ctrlKey: true, altKey: false, shiftKey: false, metaKey: true }),
    ).toBe('Ctrl+Super+Up');
  });
});

describe('shortcutLabel', () => {
  it('shows Win instead of Super', () => {
    expect(shortcutLabel('Ctrl+Alt+I')).toBe('Ctrl+Alt+I');
    expect(shortcutLabel('Super+Shift+F2')).toBe('Win+Shift+F2');
  });
});
