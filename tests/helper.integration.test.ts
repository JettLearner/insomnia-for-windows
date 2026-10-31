import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HelperClient, HelperError, type HelperStatus } from '../electron/core/helper-client';
import { Logger } from '../electron/core/logger';

const exePath = resolve(process.cwd(), 'resources', 'helper', 'InsomniaZHelper.exe');

let workDir = '';
let client: HelperClient;
let hello: HelperStatus;

describe('InsomniaZHelper integration', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'insomniaz-helper-test-'));
    client = new HelperClient({
      exePath,
      recoveryPath: join(workDir, 'lid-recovery.json'),
      logPath: join(workDir, 'helper.log'),
      logger: new Logger(workDir, 'test.log'),
    });
    hello = await client.start(false, 20_000);
  }, 40_000);

  afterAll(async () => {
    if (client) await client.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }, 20_000);

  it('ships a real helper binary', () => {
    expect(existsSync(exePath)).toBe(true);
  });

  it('completes the hello handshake over the private pipe', () => {
    expect(hello.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(hello.parentPid).toBe(process.pid);
    expect(hello.helperPid).toBeGreaterThan(0);
    expect(hello.helperPid).not.toBe(process.pid);
    expect(typeof hello.elevated).toBe('boolean');
    expect(client.connected).toBe(true);
    expect(client.lastStatus).toBe(hello);
    expect(hello.lidSupported).toBeTypeOf('boolean');
    expect(hello.scheme === null || hello.scheme === undefined || typeof hello.scheme === 'string').toBe(true);
  });

  it('reports execution state back through status', async () => {
    await client.setExecution(true, true);
    let status = await client.refreshStatus();
    expect(status.execution).toMatchObject({ active: true, system: true, display: true });

    await client.setExecution(false, true);
    status = await client.refreshStatus();
    expect(status.execution?.system).toBe(true);
    expect(status.execution?.display).toBe(false);

    await client.setExecution(false, false);
    status = await client.refreshStatus();
    expect(status.execution).toMatchObject({ active: false, system: false, display: false });
  });

  it('sends a harmless activity key on demand', async () => {
    const result = await client.jiggle();
    expect(result.sent).toBe(true);
    expect(Number.isFinite(result.idleBefore)).toBe(true);
    expect(Number.isFinite(result.idleAfter)).toBe(true);
  });

  it('refuses to touch the lid policy without elevation', async () => {
    if (client.elevated) {
      // Running the suite from an elevated shell would let the helper write the
      // real power policy; never do that from an automated test.
      const status = await client.refreshStatus();
      expect(status.elevated).toBe(true);
      return;
    }
    await expect(client.applyLid()).rejects.toBeInstanceOf(HelperError);
    try {
      await client.applyLid();
    } catch (error) {
      expect((error as HelperError).code).toBe('ELEVATION_REQUIRED');
    }
  });

  it('reports no backup instead of guessing when none exists', async () => {
    if (client.elevated) return;
    await expect(client.recoverLid()).rejects.toBeInstanceOf(HelperError);
    try {
      await client.recoverLid();
    } catch (error) {
      expect((error as HelperError).code).toBe('RECOVERY_NONE');
    }
  });

  it('restores cleanly and reconnects afterwards', async () => {
    await client.shutdownHelper();
    expect(client.connected).toBe(false);

    const again = await client.start(false, 20_000);
    expect(again.parentPid).toBe(process.pid);
    expect(client.connected).toBe(true);

    await client.shutdownHelper();
    expect(client.connected).toBe(false);
    expect(existsSync(join(workDir, 'helper.log'))).toBe(true);
    expect(readFileSync(join(workDir, 'helper.log'), 'utf8').length).toBeGreaterThan(0);
  }, 40_000);
});
