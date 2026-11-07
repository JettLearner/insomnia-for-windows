import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoBridge, AutoBridgeError } from '../electron/core/auto-bridge';
import type { Logger } from '../electron/core/logger';

const stub = resolve(process.cwd(), 'tests', 'fixtures', 'auto-helper-stub.cjs');

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const bridges: AutoBridge[] = [];

function bridge(options: { timeout?: number } = {}): AutoBridge {
  const instance = new AutoBridge({
    executable: process.execPath,
    extraArgs: [stub],
    logPath: 'unused.log',
    parentPid: process.pid,
    defaultTimeoutMs: options.timeout ?? 5_000,
    log,
  });
  bridges.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of bridges.splice(0)) instance.dispose();
});

describe('AutoBridge', () => {
  it('spawns lazily and routes responses by request id', async () => {
    const auto = bridge();
    expect(auto.alive).toBe(false);
    const first = await auto.request<{ version: string }>('hello');
    expect(first.version).toBe('stub');
    expect(auto.alive).toBe(true);
    const second = await auto.request<{ echo: { value: number } }>('echo', { value: 7 });
    expect(second.echo.value).toBe(7);
  });

  it('handles concurrent requests without mixing them up', async () => {
    const auto = bridge();
    const results = await Promise.all([
      auto.request<{ slept: number }>('sleep', { ms: 120 }),
      auto.request<{ echo: string }>('echo', { marker: 'fast' }),
      auto.request<{ slept: number }>('sleep', { ms: 40 }),
    ]);
    expect(results[1]).toEqual({ echo: { marker: 'fast' } });
    expect((results[0] as { slept: number }).slept).toBe(120);
    expect((results[2] as { slept: number }).slept).toBe(40);
  });

  it('turns helper error payloads into AutoBridgeError', async () => {
    const auto = bridge();
    const error = await auto.request('fail', { code: 'CLIPBOARD_OCCUPIED', retryable: true }).catch((err) => err);
    expect(error).toBeInstanceOf(AutoBridgeError);
    expect((error as AutoBridgeError).code).toBe('CLIPBOARD_OCCUPIED');
    expect((error as AutoBridgeError).retryable).toBe(true);

    const fatal = await auto.request('fail', { code: 'SEND_DISABLED', retryable: false }).catch((err) => err);
    expect((fatal as AutoBridgeError).retryable).toBe(false);
  });

  it('times out a stuck request without killing the helper', async () => {
    const auto = bridge({ timeout: 150 });
    const error = await auto.request('sleep', { ms: 600 }).catch((err) => err);
    expect((error as AutoBridgeError).code).toBe('TIMEOUT');
    const hello = await auto.request<{ version: string }>('hello', {}, 2_000);
    expect(hello.version).toBe('stub');
  });

  it('rejects pending work when the helper dies and spawns a new one later', async () => {
    const auto = bridge();
    await auto.request('hello');
    const pending = auto.request('sleep', { ms: 5_000 }).catch((err) => err);
    await auto.request('echo', { ready: true });
    const error = await Promise.race([pending, auto.request('die').catch((err) => err)]);
    expect((error as AutoBridgeError).code).toBe('AUTO_HELPER_DEAD');
    expect(auto.alive).toBe(false);
    const hello = await auto.request<{ version: string }>('hello');
    expect(hello.version).toBe('stub');
    expect(auto.alive).toBe(true);
  });

  it('ignores non-JSON noise on stdout', async () => {
    const auto = bridge();
    const result = await auto.request<{ noisy: boolean }>('noise');
    expect(result.noisy).toBe(true);
  });

  it('rejects new requests after dispose', async () => {
    const auto = bridge();
    await auto.request('hello');
    auto.dispose();
    await expect(auto.request('hello')).rejects.toMatchObject({ code: 'AUTO_HELPER_DEAD' });
    expect(auto.alive).toBe(false);
  });
});
