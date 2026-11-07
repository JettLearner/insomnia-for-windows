import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, readJson, writeAtomic } from '../electron/core/store';
import type { Logger } from '../electron/core/logger';

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
}

/** Burns CPU so the burst below runs against a busy machine, like the load run does. */
function burnCpu(milliseconds: number): void {
  const end = Date.now() + milliseconds;
  let sink = 0;
  while (Date.now() < end) sink += Math.sqrt(Math.random());
  if (sink < 0) throw new Error('unreachable');
}

describe('persistence under load', () => {
  let root = '';
  let file = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'insomniaz-stress-'));
    file = join(root, 'settings.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the settings file parseable through a burst of writes on a busy machine', () => {
    const store = new SettingsStore(file, silentLogger());
    store.load();

    for (let index = 0; index < 250; index += 1) {
      store.update({ lastDurationMs: (index % 2 === 0 ? 15 : 30) * 60_000 });
      expect(() => readJson(file)).not.toThrow();
      const parsed = readJson(file) as { lastDurationMs?: number } | undefined;
      expect(parsed).toBeTypeOf('object');
      if (index % 50 === 0) burnCpu(15);
    }

    const final = readJson(file) as { lastDurationMs?: number };
    expect(final.lastDurationMs).toBe(30 * 60_000);
  });

  it('leaves no temporary files behind after an atomic write', () => {
    writeAtomic(file, JSON.stringify({ a: 1 }));
    const leftovers = readdirSync(root).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 1 }));
  });

  it('replaces a corrupt file instead of appending to it', () => {
    writeFileSync(file, '{ this is not json', 'utf8');
    expect(readJson(file)).toBeUndefined();

    const store = new SettingsStore(file, silentLogger());
    store.load();
    store.update({ theme: 'light' });

    expect(existsSync(file)).toBe(true);
    expect(readJson(file)).toBeTypeOf('object');
  });
});
