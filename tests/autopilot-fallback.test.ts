import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOPILOT_SETTINGS,
  type AutopilotJob,
  type AutopilotSettings,
} from '../shared/autopilot';
import type { DeliveryRequest } from '../electron/core/autopilot-engine';
import { FallbackAdapter } from '../electron/core/autopilot-fallback';

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

const job: AutopilotJob = {
  id: 'job-1',
  schemaVersion: 1,
  title: 'triage',
  target: 'zcode',
  prompt: 'summarise the failing tests',
  attachments: [],
  schedule: { kind: 'manual', catchUp: 'run_once' },
  enabled: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  attemptsBudget: 2,
};

function request(overrides: {
  settings?: AutopilotSettings;
  attachments?: DeliveryRequest['attachments'];
  shouldCancel?: () => boolean;
} = {}): DeliveryRequest {
  return {
    job,
    prompt: job.prompt,
    attachments: overrides.attachments ?? [],
    settings: overrides.settings ?? DEFAULT_AUTOPILOT_SETTINGS,
    runId: 'run-1',
    elapsed: () => 0,
    shouldCancel: overrides.shouldCancel ?? (() => false),
    onStep: () => undefined,
  };
}

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function stubFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = async (input: unknown, init: unknown) => {
    const requestInit = init as RequestInit;
    calls.push({
      url: String(input),
      body: JSON.parse(String(requestInit.body)) as Record<string, unknown>,
      headers: (requestInit.headers ?? {}) as Record<string, string>,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as never;
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

const ollamaOk = { message: { content: 'three tests failed on windows' } };
const openAiOk = { choices: [{ message: { content: 'three tests failed' } }] };

const noSleep = async () => undefined;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'autopilot-fallback-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fallback delivery', () => {
  it('refuses to invent a channel', async () => {
    const { calls, impl } = stubFetch([{ status: 200, body: ollamaOk }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => null, fetchImpl: impl, sleep: noSleep });
    const settings: AutopilotSettings = {
      ...DEFAULT_AUTOPILOT_SETTINGS,
      fallback: { ...DEFAULT_AUTOPILOT_SETTINGS.fallback, ollamaEnabled: false, remoteEnabled: false },
    };
    const result = await adapter.deliver(request({ settings }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FALLBACK_UNCONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('prefers loopback ollama and reports the route', async () => {
    const { calls, impl } = stubFetch([{ status: 200, body: ollamaOk }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => null, fetchImpl: impl, sleep: noSleep });
    const result = await adapter.deliver(request());
    expect(result).toEqual({ ok: true, route: 'fallback-ollama' });
    expect(calls[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0].body.model).toBe('qwen2.5-coder:7b');
    const messages = calls[0].body.messages as Array<{ content: string }>;
    expect(messages[0].content).toBe('summarise the failing tests');
    expect((calls[0].body.options as { temperature: number }).temperature).toBeGreaterThan(0);
  });

  it('retries a busy ollama before giving up', async () => {
    const { calls, impl } = stubFetch([{ status: 503, body: {} }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => null, fetchImpl: impl, sleep: noSleep });
    const result = await adapter.deliver(request());
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(3);
    if (!result.ok) expect(result.code).toBe('FALLBACK_HTTP_ERROR');
  });

  it('treats an empty completion as a failure', async () => {
    const { impl } = stubFetch([{ status: 200, body: { message: { content: '   ' } } }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => null, fetchImpl: impl, sleep: noSleep });
    const result = await adapter.deliver(request());
    expect(!result.ok && result.code).toBe('FALLBACK_EMPTY_REPLY');
  });

  it('only reaches the paid endpoint when it is enabled and keyed', async () => {
    const { calls, impl } = stubFetch([{ status: 200, body: openAiOk }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => 'secret-key', fetchImpl: impl, sleep: noSleep });
    const settings: AutopilotSettings = {
      ...DEFAULT_AUTOPILOT_SETTINGS,
      fallback: { ...DEFAULT_AUTOPILOT_SETTINGS.fallback, ollamaEnabled: false, remoteEnabled: true },
    };
    const result = await adapter.deliver(request({ settings }));
    expect(result).toEqual({ ok: true, route: 'fallback-api' });
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer secret-key');
  });

  it('skips the paid endpoint without a key instead of failing the run silently', async () => {
    const { calls, impl } = stubFetch([{ status: 200, body: openAiOk }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => null, fetchImpl: impl, sleep: noSleep });
    const settings: AutopilotSettings = {
      ...DEFAULT_AUTOPILOT_SETTINGS,
      fallback: { ...DEFAULT_AUTOPILOT_SETTINGS.fallback, ollamaEnabled: false, remoteEnabled: true },
    };
    const result = await adapter.deliver(request({ settings }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FALLBACK_NO_KEY');
    expect(calls).toHaveLength(0);
  });

  it('never sends the key to the local daemon', async () => {
    const { calls, impl } = stubFetch([{ status: 200, body: ollamaOk }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => 'secret-key', fetchImpl: impl, sleep: noSleep });
    await adapter.deliver(request());
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('inlines small text attachments and respects the size limit', async () => {
    const note = join(dir, 'notes.md');
    writeFileSync(note, '# findings\nline two');
    const huge = join(dir, 'huge.txt');
    writeFileSync(huge, 'x'.repeat(4096));
    const { calls, impl } = stubFetch([{ status: 200, body: ollamaOk }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => null, fetchImpl: impl, sleep: noSleep });
    const settings: AutopilotSettings = { ...DEFAULT_AUTOPILOT_SETTINGS, maxAttachmentBytes: 2048 };
    await adapter.deliver(
      request({
        settings,
        attachments: [
          { id: 'a1', displayName: 'notes.md', originalPath: note, usePath: note, source: 'original', backupPath: null },
          { id: 'a2', displayName: 'huge.txt', originalPath: huge, usePath: huge, source: 'original', backupPath: null },
        ],
      }),
    );
    const content = (calls[0].body.messages as Array<{ content: string }>)[0].content;
    expect(content).toContain('# findings');
    expect(content).not.toContain('xxxx');
  });

  it('stops before the network when the run is cancelled', async () => {
    const { calls, impl } = stubFetch([{ status: 200, body: ollamaOk }]);
    const adapter = new FallbackAdapter({ log: silent, apiKey: () => null, fetchImpl: impl, sleep: noSleep });
    const result = await adapter.deliver(request({ shouldCancel: () => true }));
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
