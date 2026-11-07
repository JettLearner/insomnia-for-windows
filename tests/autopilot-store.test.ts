import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../electron/core/logger';
import { AutosaveController } from '../electron/core/autosave';
import { AutopilotStore } from '../electron/core/autopilot-store';
import { AutopilotScheduler, delayFor, type TimerHandle } from '../electron/core/autopilot-scheduler';
import { sanitizeJob, type AutopilotJob, type AutopilotRun } from '../shared/autopilot';

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
  tail: () => '',
  path: '',
} as unknown as Logger;

const job = (patch: Partial<AutopilotJob> = {}): AutopilotJob => ({
  ...sanitizeJob({ id: 'job-1', title: 'Test', prompt: 'hello' }, 'x')!,
  ...patch,
});

const run = (patch: Partial<AutopilotRun> = {}): AutopilotRun => ({
  id: 'run-1',
  jobId: 'job-1',
  startedAt: new Date(0).toISOString(),
  scheduledAt: new Date(0).toISOString(),
  state: 'running',
  route: 'gui-zcode',
  attempts: 0,
  steps: [],
  promptDigest: 'abcdef',
  ...patch,
});

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insomniaz-autopilot-'));
});

afterEach(() => {
  vi.useRealTimers();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('AutopilotStore', () => {
  it('creates a working store for an empty directory', () => {
    const store = new AutopilotStore({ dir, log: silentLog });
    store.load();
    expect(store.listJobs()).toEqual([]);
    expect(store.listRuns()).toEqual([]);
    expect(store.getSettings().fallback.remoteEnabled).toBe(false);
    store.dispose();
  });

  it('persists jobs immediately and reloads them', () => {
    const store = new AutopilotStore({ dir, log: silentLog });
    store.load();
    store.upsertJob(job({ prompt: '第一行\n第二行' }));
    const onDisk = JSON.parse(readFileSync(join(dir, 'autopilot-jobs.json'), 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.jobs).toHaveLength(1);
    expect(onDisk.jobs[0].prompt).toContain('第二行');

    const reloaded = new AutopilotStore({ dir, log: silentLog });
    reloaded.load();
    expect(reloaded.getJob('job-1')?.prompt).toBe('第一行\n第二行');
    store.dispose();
    reloaded.dispose();
  });

  it('updates, patches and deletes jobs', () => {
    const store = new AutopilotStore({ dir, log: silentLog });
    store.load();
    store.upsertJob(job());
    expect(store.patchJob('job-1', { enabled: false })?.enabled).toBe(false);
    expect(store.patchJob('missing', { enabled: false })).toBeNull();
    expect(store.deleteJob('job-1')).toBe(true);
    expect(store.deleteJob('job-1')).toBe(false);
    expect(store.listJobs()).toEqual([]);
    store.dispose();
  });

  it('preserves a corrupt jobs file instead of dropping data', () => {
    writeFileSync(join(dir, 'autopilot-jobs.json'), '{not json', 'utf8');
    const store = new AutopilotStore({ dir, log: silentLog });
    store.load();
    expect(store.listJobs()).toEqual([]);
    const preserved = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(preserved).toHaveLength(1);
    store.dispose();
  });

  it('caps the run history and rewrites running runs as interrupted', () => {
    const store = new AutopilotStore({ dir, log: silentLog, maxRuns: 50 });
    store.load();
    for (let i = 0; i < 60; i += 1) {
      store.recordRun(run({ id: `run-${i}`, state: 'sent' }));
    }
    store.flush();
    store.dispose();

    const reloaded = new AutopilotStore({ dir, log: silentLog, maxRuns: 50 });
    reloaded.load();
    expect(reloaded.listRuns(1000)).toHaveLength(50);
    expect(reloaded.getRun('run-0')).toBeNull();
    reloaded.dispose();
  });

  it('marks stale running runs as interrupted on load', () => {
    const first = new AutopilotStore({ dir, log: silentLog });
    first.load();
    first.recordRun(run({ id: 'run-live', state: 'running' }));
    first.flush();
    first.dispose();

    const second = new AutopilotStore({ dir, log: silentLog });
    second.load();
    const recovered = second.getRun('run-live');
    expect(recovered?.state).toBe('interrupted');
    expect(recovered?.endedAt).toBeTruthy();
    second.dispose();
  });

  it('flushes run patches on request', () => {
    const store = new AutopilotStore({ dir, log: silentLog });
    store.load();
    store.recordRun(run());
    store.patchRun('run-1', { attempts: 3 }, { flush: true });
    const onDisk = JSON.parse(readFileSync(join(dir, 'autopilot-runs.json'), 'utf8'));
    expect(onDisk.runs[0].attempts).toBe(3);
    store.dispose();
  });

  it('sanitizes settings on write', () => {
    const store = new AutopilotStore({ dir, log: silentLog });
    store.load();
    const next = store.updateSettings({ attemptsBudget: 10_000, fallback: { ...store.getSettings().fallback, baseUrl: 'javascript:alert(1)' } });
    expect(next.attemptsBudget).toBe(60);
    expect(next.fallback.baseUrl).toContain('http');
    store.dispose();
  });
});

describe('AutosaveController', () => {
  it('stretches the interval with load and respects the cap', () => {
    const controller = new AutosaveController({
      baseIntervalMs: 500,
      maxIntervalMs: 15_000,
      load: () => 0,
      write: () => undefined,
    });
    expect(controller.intervalFor(0)).toBe(500);
    expect(controller.intervalFor(0.25)).toBe(1000);
    expect(controller.intervalFor(1)).toBe(2500);
    expect(controller.intervalFor(5)).toBe(2500);
  });

  it('coalesces writes until the timer fires', () => {
    vi.useFakeTimers();
    let writes = 0;
    const load = { value: 0 };
    const controller = new AutosaveController({
      baseIntervalMs: 500,
      maxIntervalMs: 15_000,
      load: () => load.value,
      write: () => {
        writes += 1;
      },
    });
    controller.start();
    controller.markDirty();
    controller.markDirty();
    expect(writes).toBe(0);
    vi.advanceTimersByTime(499);
    expect(writes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(writes).toBe(1);

    load.value = 1;
    controller.markDirty();
    vi.advanceTimersByTime(2499);
    expect(writes).toBe(1);
    vi.advanceTimersByTime(1);
    expect(writes).toBe(2);
    controller.stop();
  });

  it('flushes immediately on demand and keeps failures dirty', () => {
    let writes = 0;
    let fail = false;
    const controller = new AutosaveController({
      load: () => 0,
      write: () => {
        writes += 1;
        if (fail) throw new Error('disk full');
      },
    });
    controller.markDirty();
    controller.flushNow();
    expect(writes).toBe(1);
    expect(controller.pending).toBe(false);

    fail = true;
    controller.markDirty();
    controller.flushNow();
    expect(controller.pending).toBe(true);
    controller.stop();
  });
});

describe('AutopilotScheduler', () => {
  interface FakeTimer {
    id: number;
    fn: () => void;
    ms: number;
    cleared: boolean;
  }

  function harness(initialJobs: AutopilotJob[], options: { graceMs?: number; maxWaitMs?: number } = {}) {
    let clock = 1_000_000;
    let nextId = 1;
    const timers: FakeTimer[] = [];
    const fired: Array<{ jobId: string; due: number; decision: string }> = [];
    const jobs = [...initialJobs];
    const scheduler = new AutopilotScheduler({
      listJobs: () => jobs,
      onDue: (job, due, decision) => fired.push({ jobId: job.id, due, decision }),
      graceMs: () => options.graceMs ?? 0,
      now: () => clock,
      setTimer: (fn, ms) => {
        const timer: FakeTimer = { id: nextId++, fn, ms, cleared: false };
        timers.push(timer);
        return timer as unknown as TimerHandle;
      },
      clearTimer: (handle) => {
        (handle as unknown as FakeTimer).cleared = true;
      },
      maxWaitMs: options.maxWaitMs ?? 60_000,
    });
    return {
      scheduler,
      jobs,
      timers,
      fired,
      pending: () => timers.filter((timer) => !timer.cleared),
      advance(ms: number) {
        clock += ms;
        for (const timer of [...timers]) {
          if (timer.cleared) continue;
          if (timer.ms <= ms) {
            timer.cleared = true;
            timer.fn();
          }
        }
      },
      get clock() {
        return clock;
      },
      set clock(value: number) {
        clock = value;
      },
    };
  }

  it('arms for the earliest due job', () => {
    const h = harness([
      job({ id: 'a', nextDueAt: new Date(1_020_000).toISOString() }),
      job({ id: 'b', nextDueAt: new Date(1_010_000).toISOString() }),
    ]);
    h.scheduler.start();
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0].ms).toBe(10_000);
    h.advance(10_000);
    expect(h.fired).toEqual([{ jobId: 'b', due: 1_010_000, decision: 'run' }]);
    h.scheduler.stop();
  });

  it('ignores disabled and manual jobs', () => {
    const h = harness([
      job({ id: 'disabled', enabled: false, nextDueAt: new Date(1_010_000).toISOString() }),
      job({ id: 'manual', schedule: { kind: 'manual', catchUp: 'skip' }, nextDueAt: new Date(1_010_000).toISOString() }),
    ]);
    h.scheduler.start();
    expect(h.pending()).toHaveLength(0);
    h.scheduler.stop();
  });

  it('applies the catch-up policy to overdue jobs', () => {
    const h = harness([
      job({
        id: 'late',
        nextDueAt: new Date(900_000).toISOString(),
        schedule: { kind: 'daily', timeOfDay: '09:00', catchUp: 'skip' },
      }),
    ], { graceMs: 1000 });
    h.scheduler.start();
    expect(h.pending()[0].ms).toBe(0);
    h.advance(0);
    expect(h.fired[0].decision).toBe('skip');
    h.scheduler.stop();
  });

  it('does not double-fire the same occurrence while re-arming', () => {
    const once = job({ id: 'once', schedule: { kind: 'once', at: new Date(1_000_000).toISOString(), catchUp: 'run_once' }, nextDueAt: new Date(1_000_000).toISOString() });
    const h = harness([once]);
    h.scheduler.start();
    h.advance(0);
    expect(h.fired).toHaveLength(1);
    expect(h.pending()).toHaveLength(0);
    // A manual re-run clears the cursor and allows the same occurrence again.
    h.scheduler.resetJob('once');
    h.scheduler.wake();
    expect(h.pending()).toHaveLength(1);
    h.advance(0);
    expect(h.fired).toHaveLength(2);
    h.scheduler.stop();
  });

  it('clamps long sleeps and stops cleanly', () => {
    const h = harness([job({ id: 'far', nextDueAt: new Date(10_000_000).toISOString() })], { maxWaitMs: 60_000 });
    h.scheduler.start();
    expect(h.pending()[0].ms).toBe(60_000);
    h.scheduler.stop();
    expect(h.scheduler.active).toBe(false);
    expect(h.pending()).toHaveLength(0);
  });

  it('computes the next due instant for countdowns', () => {
    const h = harness([
      job({ id: 'a', nextDueAt: new Date(1_030_000).toISOString() }),
      job({ id: 'b', nextDueAt: new Date(1_020_000).toISOString() }),
      job({ id: 'off', enabled: false, nextDueAt: new Date(1_001_000).toISOString() }),
    ]);
    expect(h.scheduler.nextDue()).toBe(1_020_000);
    expect(h.scheduler.entries()).toEqual([
      { jobId: 'a', dueAt: 1_030_000 },
      { jobId: 'b', dueAt: 1_020_000 },
      { jobId: 'off', dueAt: null },
    ]);
  });
});

describe('delayFor', () => {
  it('never goes negative and respects the ceiling', () => {
    expect(delayFor(500, 1000, 60_000)).toBe(0);
    expect(delayFor(2000, 1000, 60_000)).toBe(1000);
    expect(delayFor(1_000_000, 1000, 60_000)).toBe(60_000);
  });
});
