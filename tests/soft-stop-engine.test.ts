import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiActivitySnapshot, SoftStopAdapter, SoftStopSendResult } from '../shared/soft-stop';
import { DEFAULT_SETTINGS, type PowerInfo, type SessionState, type Settings } from '../shared/types';
import type { Logger } from '../electron/core/logger';
import type { SoftStopTarget } from '../electron/core/soft-stop-sender';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  desktopCapturer: { getSources: async () => [] },
}));

import { SoftStopEngine } from '../electron/core/soft-stop-engine';

const NOW = Date.now();

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  log: () => {},
  tail: () => [],
} as unknown as Logger;

const adapter: SoftStopAdapter = {
  id: 'test-endpoint',
  label: 'Test endpoint',
  kind: 'http',
  match: {},
  http: {
    base: 'http://127.0.0.1:1234',
    send: { path: '/v1/stop', body: { prompt: '{prompt}' } },
  },
};

function activeSnapshot(ts = Date.now()): AiActivitySnapshot {
  return {
    ts,
    network: { adapters: [], throughputBps: 90_000 },
    local: [
      {
        id: 'test-endpoint',
        label: 'Test endpoint',
        process: 'test.exe',
        pid: 42,
        port: 1234,
        evidence: ['api:/v1/models', 'model:test-model'],
      },
    ],
    remote: [],
    streaming: 'likely',
    confidence: 0.9,
    evidence: [],
  };
}

function setup() {
  vi.useFakeTimers({ now: NOW });
  const dir = mkdtempSync(join(tmpdir(), 'insomniaz-engine-'));
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    softStopEnabled: true,
    softStopDryRun: false,
    softStopAutoSend: true,
    softStopGuiEnabled: false,
    softStopThreshold: 30,
    softStopSleepThreshold: 10,
  };
  const session: SessionState = {
    active: true,
    startedAt: NOW,
    endsAt: null,
    durationMs: null,
    displayMode: 'auto',
    advanced: false,
    lid: false,
  };
  const power: PowerInfo = { ac: false, batteryPercent: 29, charging: false, batteryPresent: true };
  const sleeps: number[] = [];
  const sent: Array<{ target: string; percent: number | null }> = [];
  const engine = new SoftStopEngine({
    userDataDir: dir,
    helper: {} as never,
    getSettings: () => settings,
    getSession: () => session,
    getPower: () => power,
    logger,
    performSleep: async (percent) => {
      sleeps.push(percent ?? -1);
      session.active = false;
      return { ok: true };
    },
    notifySent: (target, percent) => sent.push({ target, percent }),
    notifyFailed: () => {},
    onChange: () => {},
  });

  const detector = { snapshot: vi.fn(async () => activeSnapshot()) };
  const sender = {
    chooseTarget: vi.fn((): SoftStopTarget | null => ({
      kind: 'http' as const,
      adapter,
      label: adapter.label,
      base: 'http://127.0.0.1:1234',
      model: 'test-model',
      reason: 'test',
    })),
    send: vi.fn(async (): Promise<SoftStopSendResult> => ({
      ok: true,
      dryRun: false,
      adapterId: adapter.id,
      target: 'Test endpoint · test-model',
      model: 'test-model',
      detail: 'HTTP 200',
    })),
    listAdapters: vi.fn(() => []),
  };
  const gui = {
    sendPrompt: vi.fn(),
    scan: vi.fn(),
    recordStart: vi.fn(),
    recordStop: vi.fn(),
    recordStatus: vi.fn(),
    suspend: vi.fn(),
  };
  const internals = engine as unknown as {
    detector: typeof detector;
    sender: typeof sender;
    gui: typeof gui;
  };
  internals.detector = detector;
  internals.sender = sender;
  internals.gui = gui;

  engine.onSessionStart(NOW);
  const at = async (delta: number): Promise<void> => {
    vi.setSystemTime(NOW + delta);
    await engine.tick();
  };
  return { dir, engine, settings, session, power, sleeps, sent, detector, sender, gui, at };
}

describe('SoftStopEngine two-stage state machine', () => {
  let dir = '';
  afterEach(() => {
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing above threshold A', async () => {
    const context = setup();
    dir = context.dir;
    context.power.batteryPercent = 55;
    await context.at(0);
    expect(context.detector.snapshot).not.toHaveBeenCalled();
    expect(context.sender.send).not.toHaveBeenCalled();
    expect(context.engine.getStatus().phase).toBe('monitoring');
  });

  it('detects activity between A and B and sends exactly once', async () => {
    const context = setup();
    dir = context.dir;
    await context.at(0);
    expect(context.detector.snapshot).toHaveBeenCalledTimes(1);
    expect(context.sender.send).toHaveBeenCalledTimes(1);
    expect(context.sender.send).toHaveBeenCalledWith(expect.anything(), 29, false);
    const status = context.engine.getStatus();
    expect(status.phase).toBe('sent');
    expect(status.triggeredThisCycle).toBe(true);
    expect(status.attempts).toBe(1);
    expect(context.sent).toEqual([{ target: 'Test endpoint · test-model', percent: 29 }]);

    await context.at(5_000);
    expect(context.sender.send).toHaveBeenCalledTimes(1);
    expect(context.sleeps).toHaveLength(0);
  });

  it('waits without activity, then sleeps at threshold B', async () => {
    const context = setup();
    dir = context.dir;
    context.detector.snapshot.mockResolvedValueOnce({
      ...activeSnapshot(),
      local: [],
      streaming: 'none',
      confidence: 0,
      network: { adapters: [], throughputBps: 0 },
    });
    await context.at(0);
    expect(context.sender.send).not.toHaveBeenCalled();
    expect(context.engine.getStatus().phase).toBe('monitoring');

    context.power.batteryPercent = 10;
    await context.at(5_000);
    expect(context.sleeps).toEqual([10]);
    expect(context.engine.getStatus().phase).toBe('sleeping');
    expect(context.engine.getStatus().lastAction).toBe('sleep');

    await context.at(10_000);
    expect(context.sleeps).toHaveLength(1);
  });

  it('re-arms after AC power returns', async () => {
    const context = setup();
    dir = context.dir;
    await context.at(0);
    expect(context.engine.getStatus().triggeredThisCycle).toBe(true);

    context.power.ac = true;
    await context.at(5_000);
    expect(context.engine.getStatus().triggeredThisCycle).toBe(false);

    context.power.ac = false;
    context.power.batteryPercent = 28;
    await context.at(10_000);
    expect(context.sender.send).toHaveBeenCalledTimes(2);
  });

  it('holds a failed send for the retry cooldown and stops after two attempts', async () => {
    const context = setup();
    dir = context.dir;
    context.sender.send.mockResolvedValue({
      ok: false,
      dryRun: false,
      adapterId: adapter.id,
      target: 'Test endpoint',
      model: null,
      detail: 'HTTP 500',
      error: 'HTTP_500',
    });
    await context.at(0);
    expect(context.sender.send).toHaveBeenCalledTimes(1);
    expect(context.engine.getStatus().phase).toBe('error');
    expect(context.engine.getStatus().attempts).toBe(1);

    context.detector.snapshot.mockClear();
    await context.at(60_000);
    expect(context.sender.send).toHaveBeenCalledTimes(1);
    expect(context.detector.snapshot).not.toHaveBeenCalled();
    expect(context.engine.getStatus().phase).toBe('cooldown');

    await context.at(5 * 60_000 + 200);
    expect(context.sender.send).toHaveBeenCalledTimes(2);
    expect(context.engine.getStatus().attempts).toBe(2);

    await context.at(10 * 60_000);
    expect(context.sender.send).toHaveBeenCalledTimes(2);
    expect(context.engine.getStatus().phase).toBe('error');
  });

  it('treats a missing target as a configuration block and keeps retrying on cooldown', async () => {
    const context = setup();
    dir = context.dir;
    context.sender.chooseTarget.mockReturnValue(null);
    await context.at(0);
    expect(context.engine.getStatus().lastError).toBe('NO_TARGET');
    expect(context.engine.getStatus().attempts).toBe(0);

    context.detector.snapshot.mockClear();
    await context.at(5 * 60_000 + 200);
    expect(context.detector.snapshot).toHaveBeenCalled();
    expect(context.engine.getStatus().attempts).toBe(0);
  });
});
