import { describe, expect, it } from 'vitest';
import { en, locales, translate, zh, type MessageKey } from '../shared/i18n';

const keys = Object.keys(en) as MessageKey[];
const placeholders = (text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) found.push(match[1]);
  return found.sort();
};

describe('translation dictionaries', () => {
  it('has a non-empty entry for every key in both languages', () => {
    for (const key of keys) {
      expect(en[key], `en.${key}`).toBeTypeOf('string');
      expect(en[key].trim(), `en.${key}`).not.toBe('');
      expect(zh[key], `zh.${key}`).toBeTypeOf('string');
      expect(zh[key].trim(), `zh.${key}`).not.toBe('');
    }
  });

  it('defines exactly the same keys in zh as in en', () => {
    expect(Object.keys(zh).sort()).toEqual([...keys].sort());
    expect(Object.keys(locales['en-US']).sort()).toEqual([...keys].sort());
    expect(Object.keys(locales['zh-CN']).sort()).toEqual([...keys].sort());
  });

  it('uses identical interpolation placeholders in both languages', () => {
    for (const key of keys) {
      expect(placeholders(zh[key]), `zh.${key} placeholders`).toEqual(placeholders(en[key]));
    }
  });

  it('actually translates the primary surfaces', () => {
    expect(zh.generalTitle).toBe('通用');
    expect(en.generalTitle).toBe('General');
    expect(zh.appName).toBe(en.appName);
    expect(zh.windowsPort).not.toBe(en.windowsPort);
    expect(zh.displayOn).not.toBe(en.displayOn);
  });
});

describe('translate', () => {
  it('returns the requested locale and substitutes every variable', () => {
    const vars = { time: '8m 38s' };
    expect(translate('en-US', 'timeRemaining', vars)).toBe('8m 38s remaining');
    expect(translate('zh-CN', 'timeRemaining', vars)).toBe('剩余 8m 38s');
    expect(translate('zh-CN', 'activitySubtitle', { seconds: 60 })).toBe('每 60 秒发送一次无害按键。');
  });

  it('leaves unknown placeholders untouched and empties none silently', () => {
    expect(translate('en-US', 'timeRemaining')).toBe('{time} remaining');
    expect(translate('en-US', 'timeRemaining', { other: 'x' })).toBe('{time} remaining');
  });

  it('falls back to English for an unknown locale', () => {
    expect(translate('fr-FR' as never, 'statusReady')).toBe(en.statusReady);
  });

  it('falls back to the key itself for an unknown message', () => {
    expect(translate('en-US', 'does.not.exist' as MessageKey)).toBe('does.not.exist');
  });

  it('never leaves a resolved variable unfilled in en or zh', () => {
    for (const key of keys) {
      const names = Array.from(new Set(en[key].match(/\{([a-zA-Z0-9_]+)\}/g) ?? [])).map((token) =>
        token.slice(1, -1),
      );
      const vars = Object.fromEntries(names.map((name) => [name, `va-${name}`]));
      for (const locale of ['en-US', 'zh-CN'] as const) {
        const text = translate(locale, key, vars);
        for (const name of names) {
          expect(text, `${locale}.${key} leaves {${name}}`).not.toContain(`{${name}}`);
        }
      }
    }
  });
});
