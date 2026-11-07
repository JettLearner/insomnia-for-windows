import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_ERRORS,
  AUTOPILOT_ERROR_CODES,
  DEFAULT_AUTOPILOT_SETTINGS,
  MAX_SEND_CLICKS,
  catchUpDecision,
  describeSchedule,
  errorMeta,
  nextDueAt,
  retryDelayMs,
  sanitizeAutopilotSettings,
  sanitizeJob,
  sanitizeJobs,
  type AutopilotSchedule,
} from '../shared/autopilot';

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

const schedule = (patch: Partial<AutopilotSchedule>): AutopilotSchedule => ({
  kind: 'once',
  catchUp: 'run_once',
  ...patch,
});

describe('nextDueAt', () => {
  it('returns null for manual schedules', () => {
    expect(nextDueAt(schedule({ kind: 'manual' }), local(2026, 1, 5, 8))).toBeNull();
  });

  it('handles a one-shot in the future and ignores the past', () => {
    const at = new Date(local(2026, 1, 5, 12)).toISOString();
    expect(nextDueAt(schedule({ at }), local(2026, 1, 5, 11))).toBe(local(2026, 1, 5, 12));
    expect(nextDueAt(schedule({ at }), local(2026, 1, 5, 13))).toBeNull();
    expect(nextDueAt(schedule({}), local(2026, 1, 5, 13))).toBeNull();
  });

  it('schedules daily jobs today or tomorrow depending on the clock', () => {
    const s = schedule({ kind: 'daily', timeOfDay: '09:00' });
    expect(nextDueAt(s, local(2026, 1, 5, 8, 0))).toBe(local(2026, 1, 5, 9));
    expect(nextDueAt(s, local(2026, 1, 5, 9, 0))).toBe(local(2026, 1, 6, 9));
    expect(nextDueAt(s, local(2026, 1, 5, 23, 59))).toBe(local(2026, 1, 6, 9));
  });

  it('skips non-matching weekdays', () => {
    // 2026-01-05 is a Monday.
    const s = schedule({ kind: 'weekly', timeOfDay: '07:30', weekdays: [1] });
    expect(nextDueAt(s, local(2026, 1, 5, 6, 0))).toBe(local(2026, 1, 5, 7, 30));
    expect(nextDueAt(s, local(2026, 1, 5, 8, 0))).toBe(local(2026, 1, 12, 7, 30));
    // Sunday -> the coming Monday.
    expect(nextDueAt(s, local(2026, 1, 11, 20, 0))).toBe(local(2026, 1, 12, 7, 30));
  });

  it('treats an empty weekday list as every day', () => {
    const s = schedule({ kind: 'weekly', timeOfDay: '10:00', weekdays: [] });
    expect(nextDueAt(s, local(2026, 1, 5, 11, 0))).toBe(local(2026, 1, 6, 10));
  });

  it('aligns interval schedules to their anchor', () => {
    const anchor = new Date(local(2026, 1, 5, 8)).toISOString();
    const s = schedule({ kind: 'interval', everyMinutes: 60, anchor });
    expect(nextDueAt(s, local(2026, 1, 5, 8, 30))).toBe(local(2026, 1, 5, 9));
    expect(nextDueAt(s, local(2026, 1, 5, 9, 0))).toBe(local(2026, 1, 5, 10));
    expect(nextDueAt(s, local(2026, 1, 5, 7, 0))).toBe(local(2026, 1, 5, 8));
  });

  it('falls back to from + interval without an anchor', () => {
    const s = schedule({ kind: 'interval', everyMinutes: 15 });
    expect(nextDueAt(s, local(2026, 1, 5, 8, 0))).toBe(local(2026, 1, 5, 8, 15));
  });
});

describe('catchUpDecision', () => {
  it('runs on time', () => {
    expect(catchUpDecision(schedule({}), 1000, 1000, 5000)).toBe('run');
  });

  it('runs inside the grace window regardless of policy', () => {
    expect(catchUpDecision(schedule({ catchUp: 'skip' }), 1000, 3000, 5000)).toBe('run');
  });

  it('applies the policy outside the grace window', () => {
    expect(catchUpDecision(schedule({ catchUp: 'run_once' }), 1000, 10_000, 5000)).toBe('run');
    expect(catchUpDecision(schedule({ catchUp: 'skip' }), 1000, 10_000, 5000)).toBe('skip');
    expect(catchUpDecision(schedule({ catchUp: 'ask' }), 1000, 10_000, 5000)).toBe('ask');
  });

  it('never runs manual jobs', () => {
    expect(catchUpDecision(schedule({ kind: 'manual' }), 1000, 1000, 5000)).toBe('skip');
  });
});

describe('describeSchedule', () => {
  it('renders both locales', () => {
    expect(describeSchedule(schedule({ kind: 'manual' }), 'zh-CN')).toContain('手动');
    expect(describeSchedule(schedule({ kind: 'interval', everyMinutes: 30 }), 'en-US')).toContain('30');
    expect(describeSchedule(schedule({ kind: 'daily', timeOfDay: '08:05' }), 'zh-CN')).toContain('08:05');
  });
});

describe('sanitizeJob', () => {
  it('derives a title from the prompt and fills defaults', () => {
    const job = sanitizeJob({ prompt: '做一份周报\n第二行' }, 'fallback');
    expect(job).not.toBeNull();
    expect(job!.title).toBe('做一份周报');
    expect(job!.target).toBe('zcode');
    expect(job!.attemptsBudget).toBe(12);
    expect(job!.enabled).toBe(true);
    expect(job!.schedule.kind).toBe('once');
  });

  it('rejects empty jobs and unknown targets fall back to zcode', () => {
    expect(sanitizeJob({}, 'x')).toBeNull();
    expect(sanitizeJob({ title: 'x', target: 'shell' }, 'x')!.target).toBe('zcode');
  });

  it('truncates long prompts and caps attachments', () => {
    const job = sanitizeJob(
      {
        title: 'big',
        prompt: 'a'.repeat(250_000),
        attachments: Array.from({ length: 90 }, (_, i) => ({ originalPath: `C:\\f${i}.txt` })),
      },
      'x',
    )!;
    expect(job.prompt.length).toBe(200_000);
    expect(job.attachments.length).toBe(40);
    expect(job.attachments[0].displayName).toBe('f0.txt');
  });

  it('normalizes schedule fields', () => {
    const job = sanitizeJob(
      { title: 't', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 999_999 } },
      'x',
    )!;
    expect(job.schedule.everyMinutes).toBe(7 * 24 * 60);
    const daily = sanitizeJob({ title: 't', prompt: 'p', schedule: { kind: 'daily', timeOfDay: '7:5' } }, 'x')!;
    expect(daily.schedule.timeOfDay).toBe('09:00');
    const weekly = sanitizeJob(
      { title: 't', prompt: 'p', schedule: { kind: 'weekly', weekdays: [5, 1, 5, 9] } },
      'x',
    )!;
    expect(weekly.schedule.weekdays).toEqual([1, 5]);
  });

  it('keeps model and capability details but drops junk', () => {
    const job = sanitizeJob(
      {
        title: 't',
        prompt: 'p',
        model: { provider: 'Start Plan', name: ' GLM-5.3-Flash ', thinking: 'max', params: { temperature: 0.2, bad: {}, deep: null } },
        capabilities: { mode: '完全访问', skills: ['a', 'A', ' b '], mcp: [1, 'x'] },
      },
      'x',
    )!;
    expect(job.model).toEqual({
      provider: 'Start Plan',
      name: 'GLM-5.3-Flash',
      thinking: 'max',
      params: { temperature: 0.2 },
    });
    expect(job.capabilities).toEqual({ mode: '完全访问', skills: ['a', 'b'], mcp: ['x'] });
  });

  it('drops the conversation block when it carries no information', () => {
    const job = sanitizeJob({ title: 't', prompt: 'p', conversation: { kind: 'current' } }, 'x')!;
    expect(job.conversation).toBeUndefined();
    const named = sanitizeJob({ title: 't', prompt: 'p', conversation: { kind: 'named', name: '会话 A' } }, 'x')!;
    expect(named.conversation).toEqual({ kind: 'named', name: '会话 A' });
  });

  it('deduplicates by id across a job list', () => {
    const jobs = sanitizeJobs([
      { id: 'a', title: 'one', prompt: 'p' },
      { id: 'a', title: 'two', prompt: 'p' },
      { id: 'b', title: 'three', prompt: 'p' },
    ]);
    expect(jobs.map((job) => job.id)).toEqual(['a', 'b']);
  });
});

describe('sanitizeAutopilotSettings', () => {
  it('returns defaults for garbage', () => {
    const settings = sanitizeAutopilotSettings(null);
    expect(settings).toEqual(DEFAULT_AUTOPILOT_SETTINGS);
  });

  it('clamps numbers and rejects non-http base urls', () => {
    const settings = sanitizeAutopilotSettings({
      attemptsBudget: 999,
      backlogMs: -5,
      autosaveMaxIntervalMs: 10,
      fallback: { baseUrl: 'file:///etc/passwd', ollamaBaseUrl: 'http://127.0.0.1:11434/', remoteEnabled: true },
      protection: { cpuBusyThreshold: 5, allowlist: [' OBS ', 'obs', 'x'] },
    });
    expect(settings.attemptsBudget).toBe(60);
    expect(settings.backlogMs).toBe(0);
    expect(settings.autosaveMaxIntervalMs).toBe(1000);
    expect(settings.fallback.baseUrl).toBe(DEFAULT_AUTOPILOT_SETTINGS.fallback.baseUrl);
    expect(settings.fallback.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(settings.fallback.remoteEnabled).toBe(true);
    expect(settings.protection.cpuBusyThreshold).toBe(0.99);
    expect(settings.protection.allowlist).toEqual(['OBS', 'x']);
  });

  it('keeps remote fallback disabled by default', () => {
    expect(sanitizeAutopilotSettings({}).fallback.remoteEnabled).toBe(false);
    expect(sanitizeAutopilotSettings({}).catalogRefresh).toBe(false);
  });

  it('only accepts http(s) catalog refresh urls', () => {
    expect(sanitizeAutopilotSettings({ catalogRefreshUrl: 'ftp://x' }).catalogRefreshUrl).toBe('');
    expect(sanitizeAutopilotSettings({ catalogRefreshUrl: 'https://example.com/list.json' }).catalogRefreshUrl).toBe(
      'https://example.com/list.json',
    );
  });
});

describe('error catalog', () => {
  it('has metadata for every declared code', () => {
    for (const code of AUTOPILOT_ERROR_CODES) {
      const meta = errorMeta(code);
      expect(meta.code).toBe(code);
      expect(meta.maxAttempts).toBeGreaterThanOrEqual(0);
      expect(meta.backoffMs.length).toBeGreaterThan(0);
      expect(meta.label.zh.length).toBeGreaterThan(0);
      expect(meta.label.en.length).toBeGreaterThan(0);
    }
    expect(Object.keys(AUTOPILOT_ERRORS).sort()).toEqual([...AUTOPILOT_ERROR_CODES].sort());
  });

  it('marks account-level problems as non-retryable', () => {
    expect(AUTOPILOT_ERRORS.QUOTA_EXPIRED.retryable).toBe(false);
    expect(AUTOPILOT_ERRORS.QUOTA_EXPIRED.terminal).toBe('blocked');
    expect(AUTOPILOT_ERRORS.DUPLICATE_RISK.retryable).toBe(false);
    expect(AUTOPILOT_ERRORS.DUPLICATE_RISK.terminal).toBe('blocked');
    expect(AUTOPILOT_ERRORS.SEND_UNCONFIRMED.terminal).toBe('fallback');
  });

  it('repeats the last backoff entry', () => {
    expect(retryDelayMs('MODEL_UNAVAILABLE_NO_QUOTA', 1)).toBe(2000);
    expect(retryDelayMs('MODEL_UNAVAILABLE_NO_QUOTA', 3)).toBe(10_000);
    expect(retryDelayMs('MODEL_UNAVAILABLE_NO_QUOTA', 99)).toBe(10_000);
    expect(retryDelayMs('RATE_LIMITED', 0)).toBe(30_000);
  });

  it('caps send clicks per run', () => {
    expect(MAX_SEND_CLICKS).toBe(2);
  });
});
