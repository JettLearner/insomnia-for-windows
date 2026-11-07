import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentService } from '../electron/core/autopilot-attachments';
import { AutopilotEngine, type DeliveryRequest, type DeliveryResult, type GuardState } from '../electron/core/autopilot-engine';
import { AutopilotScheduler } from '../electron/core/autopilot-scheduler';
import { AutopilotStore } from '../electron/core/autopilot-store';
import type { Logger } from '../electron/core/logger';
import { sanitizeJob, type AutopilotJob } from '../shared/autopilot';

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
  tail: () => '',
  path: '',
} as unknown as Logger;

let dir = '';
let store: AutopilotStore;
let engine: AutopilotEngine;
let scheduler: AutopilotScheduler;
let guardState: GuardState;
let softStop: boolean;
let sleeps: number[];
let requests: DeliveryRequest[];
let notifications: string[];
let results: DeliveryResult[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insomniaz-engine-'));
  store = new AutopilotStore({ dir, log: silentLog });
  store.load();
  guardState = 'ok';
  softStop = false;
  sleeps = [];
  requests = [];
  notifications = [];
  results = [];
});

afterEach(() => {
  engine?.dispose();
  store?.dispose();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeJob(patch: Record<string, unknown> = {}): AutopilotJob {
  const job = sanitizeJob(
    {
      id: 'job-1',
      title: 'daily report',
      prompt: 'write the report',
      target: 'zcode',
      schedule: { kind: 'daily', timeOfDay: '09:00' },
      ...patch,
    },
    'job-1',
  )!;
  return store.upsertJob(job);
}

function build(): AutopilotEngine {
  const adapter = {
    id: 'fake',
    deliver: async (request: DeliveryRequest): Promise<DeliveryResult> => {
      requests.push(request);
      request.onStep({ step: 'resolve_target', ok: true, ms: 1 });
      const next = results.shift() ?? { ok: true };
      if (!next.ok && next.code === 'SEND_UNCONFIRMED') {
        request.onStep({ step: 'send', ok: true, ms: 1 });
      }
      if (next.ok) request.onStep({ step: 'send', ok: true, ms: 1 });
      return next;
    },
  };
  scheduler = new AutopilotScheduler({
    listJobs: () => store.listJobs(),
    onDue: (job, due, decision) => engine.enqueue(job, due, decision),
    graceMs: () => store.getSettings().backlogMs,
    maxWaitMs: 60_000,
  });
  engine = new AutopilotEngine({
    store,
    scheduler,
    attachments: new AttachmentService({ dir, log: silentLog }),
    adapters: { zcode: adapter, generic: adapter, 'fallback-only': adapter, workbuddy: adapter, 'workbuddy-ai': adapter },
    log: silentLog,
    guard: () => guardState,
    softStopActive: () => softStop,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    notify: (event) => notifications.push(`${event.kind}:${event.run.state}`),
  });
  return engine;
}

describe('AutopilotEngine', () => {
  it('delivers a job and advances the schedule', async () => {
    const job = makeJob();
    const run = await build().runNow(job.id);
    expect(run?.state).toBe('sent');
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt).toBe('write the report');
    expect(run?.steps.map((step) => step.step)).toEqual(['resolve_target', 'send']);
    expect(store.getJob(job.id)?.lastStatus).toBe('sent');
    const due = Date.parse(store.getJob(job.id)!.nextDueAt!);
    expect(due).toBeGreaterThan(Date.now());
    expect(notifications).toContain('sent:sent');
  });

  it('retries a retryable failure with the catalog backoff', async () => {
    const job = makeJob();
    results.push({ ok: false, code: 'TARGET_BUSY' }, { ok: true });
    const run = await build().runNow(job.id);
    expect(run?.state).toBe('sent');
    expect(run?.attempts).toBe(2);
    expect(sleeps).toEqual([30_000]);
    expect(run?.steps.some((step) => step.step === 'retry')).toBe(true);
  });

  it('gives up after the code retry budget', async () => {
    const job = makeJob();
    results.push(
      { ok: false, code: 'SEND_DISABLED' },
      { ok: false, code: 'SEND_DISABLED' },
      { ok: false, code: 'SEND_DISABLED' },
      { ok: false, code: 'SEND_DISABLED' },
    );
    const run = await build().runNow(job.id);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('SEND_DISABLED');
    expect(requests).toHaveLength(4);
  });

  it('defers account-level failures instead of retrying them', async () => {
    const job = makeJob();
    results.push({ ok: false, code: 'QUOTA_EXPIRED' });
    const run = await build().runNow(job.id);
    expect(run?.state).toBe('deferred');
    expect(store.getJob(job.id)?.lastStatus).toBe('deferred');
    expect(requests).toHaveLength(1);
    expect(notifications).toContain('deferred:deferred');
  });

  it('stops instead of clicking send a third time', async () => {
    const job = makeJob();
    results.push({ ok: false, code: 'SEND_UNCONFIRMED' }, { ok: false, code: 'SEND_UNCONFIRMED' });
    const run = await build().runNow(job.id);
    expect(requests).toHaveLength(2);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('DUPLICATE_RISK');
    expect(store.getJob(job.id)?.lastStatus).toBe('blocked');
  });

  it('defers while the screen is captured and resumes afterwards', async () => {
    const job = makeJob();
    guardState = 'capturing';
    const deferred = await build().runNow(job.id);
    expect(deferred?.state).toBe('deferred');
    expect(requests).toHaveLength(0);
    expect(deferred?.error?.code).toBe('PROTECTION_DEFERRED');

    guardState = 'ok';
    engine.resumeDeferred();
    const run = await engine.runNow(job.id);
    expect(run?.state).toBe('sent');
    expect(requests).toHaveLength(1);
  });

  it('yields to soft stop', async () => {
    const job = makeJob();
    softStop = true;
    const run = await build().runNow(job.id);
    expect(run?.state).toBe('deferred');
    expect(run?.error?.code).toBe('SOFT_STOP_INTERCEPT');
    expect(requests).toHaveLength(0);
  });

  it('marks a cancelled run as skipped', async () => {
    const job = makeJob();
    const built = build();
    const adapter = {
      id: 'slow',
      deliver: async (request: DeliveryRequest): Promise<DeliveryResult> => {
        requests.push(request);
        engine.cancelRun(request.runId);
        return { ok: true };
      },
    };
    (engine as unknown as { options: { adapters: Record<string, unknown> } }).options.adapters.zcode = adapter;
    const run = await built.runNow(job.id);
    expect(run?.state).toBe('skipped');
    expect(run?.error?.message).toBe('cancelled by user');
  });

  it('appends the missing-attachment note to the delivered prompt', async () => {
    const job = makeJob({
      attachments: [{ id: 'a1', originalPath: join(dir, 'not-there', 'spec.pdf'), displayName: 'spec.pdf' }],
    });
    const run = await build().runNow(job.id);
    expect(run?.state).toBe('sent');
    expect(requests[0].prompt).toContain('【附件缺失说明】');
    expect(requests[0].prompt).toContain('spec.pdf');
    expect(requests[0].attachments[0].usePath).toBeNull();
  });

  it('delivers an existing attachment and records its backup', async () => {
    const original = join(dir, 'src', 'spec.txt');
    const job = makeJob({
      attachments: [{ id: 'a1', originalPath: original, displayName: 'spec.txt' }],
    });
    store.updateSettings({ backupEnabled: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(original, 'content');

    const run = await build().runNow(job.id);
    expect(run?.state).toBe('sent');
    expect(requests[0].attachments[0].usePath).toBe(original);
    expect(requests[0].attachments[0].backupPath).toBeTruthy();
  });

  it('ignores due jobs when the subsystem is disabled', async () => {
    const job = makeJob();
    build();
    store.updateSettings({ enabled: false });
    engine.enqueue(job, Date.now(), 'run');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
  });

  it('skips when the catch-up policy says to', async () => {
    const job = makeJob({ schedule: { kind: 'daily', timeOfDay: '09:00', catchUp: 'skip' } });
    build();
    engine.enqueue(job, Date.now() - 3_600_000, 'skip');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const runs = store.listRuns(10).filter((run) => run.jobId === job.id);
    expect(runs[0].state).toBe('skipped');
    expect(requests).toHaveLength(0);
  });
});
