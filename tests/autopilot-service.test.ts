import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutopilotJob } from '../shared/autopilot';
import { AutopilotService } from '../electron/core/autopilot-service';
import type { Logger } from '../electron/core/logger';

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const baseJob = {
  title: 'nightly build review',
  target: 'zcode',
  prompt: 'run the checks and summarise failures',
  schedule: { kind: 'manual', catchUp: 'run_once' },
} as const;

describe('autopilot service', () => {
  let dir: string;
  let service: AutopilotService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'autopilot-service-'));
    service = new AutopilotService({
      userDataDir: dir,
      log: silent,
      autoHelperExe: join(dir, 'missing.exe'),
      tempDir: () => dir,
    });
    service.start();
  });

  afterAll(() => {
    service.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty but with the seeded catalog', () => {
    const snapshot = service.snapshot();
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.catalog.length).toBeGreaterThan(0);
    expect(snapshot.paused).toBe(false);
    expect(snapshot.helperAlive).toBe(false);
  });

  it('rejects a job without a prompt', () => {
    expect(service.saveJob({ ...baseJob, prompt: '' }).ok).toBe(false);
    expect(service.snapshot().jobs).toEqual([]);
  });

  it('assigns an id and persists a saved job', () => {
    const saved = service.saveJob(baseJob);
    expect(saved.ok).toBe(true);
    const id = saved.job?.id ?? '';
    expect(id.length).toBeGreaterThan(0);
    expect(service.snapshot().jobs.map((job: AutopilotJob) => job.id)).toContain(id);

    const reopened = new AutopilotService({
      userDataDir: dir,
      log: silent,
      autoHelperExe: join(dir, 'missing.exe'),
      tempDir: () => dir,
    });
    reopened.start();
    expect(reopened.snapshot().jobs.map((job) => job.title)).toContain('nightly build review');
    reopened.dispose();
  });

  it('updates, toggles and deletes', () => {
    const id = service.saveJob(baseJob).job?.id ?? '';
    expect(service.setEnabled(id, false).ok).toBe(true);
    expect(service.snapshot().jobs.find((job) => job.id === id)?.enabled).toBe(false);
    const renamed = service.saveJob({ ...baseJob, id, title: 'renamed task', enabled: false });
    expect(renamed.job?.title).toBe('renamed task');
    expect(renamed.job?.createdAt).toBe(service.snapshot().jobs.find((job) => job.id === id)?.createdAt);
    expect(service.deleteJob(id).ok).toBe(true);
    expect(service.deleteJob(id).ok).toBe(false);
  });

  it('keeps settings sanitised', () => {
    const next = service.updateSettings({ attemptsBudget: 999, backupRetentionDays: -5 });
    expect(next.attemptsBudget).toBeLessThan(999);
    expect(next.backupRetentionDays).toBeGreaterThanOrEqual(1);
    expect(service.setPaused(true).ok).toBe(true);
    expect(service.snapshot().paused).toBe(true);
    service.setPaused(false);
  });

  it('reports unknown attachments instead of throwing', () => {
    expect(service.attachmentAction({ type: 'restore', attachmentId: 'nope', jobId: 'nope' }).ok).toBe(false);
  });
});
