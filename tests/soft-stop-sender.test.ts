import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import type { AiActivitySnapshot } from '../shared/soft-stop';
import { BUILTIN_KNOWLEDGE, BUILTIN_ADAPTERS } from '../electron/core/knowledge';
import { SoftStopSender, type SoftStopSecretReader } from '../electron/core/soft-stop-sender';
import type { Logger } from '../electron/core/logger';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const noSecrets: SoftStopSecretReader = {
  getKey: () => null,
  hasKey: () => false,
};

function snapshot(patch: Partial<AiActivitySnapshot> = {}): AiActivitySnapshot {
  return {
    ts: 1,
    network: { adapters: [], throughputBps: 0 },
    local: [],
    remote: [],
    streaming: 'none',
    confidence: 0,
    evidence: [],
    ...patch,
  };
}

function makeSender(
  patch: Partial<Settings> = {},
  options: {
    fetchImpl?: typeof fetch;
    secrets?: SoftStopSecretReader;
    knowledge?: typeof BUILTIN_KNOWLEDGE;
  } = {},
): { sender: SoftStopSender; settings: () => Settings; set: (next: Partial<Settings>) => void } {
  let current: Settings = { ...DEFAULT_SETTINGS, ...patch };
  const sender = new SoftStopSender({
    knowledge: options.knowledge ?? BUILTIN_KNOWLEDGE,
    getSettings: () => current,
    secrets: options.secrets ?? noSecrets,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    sender,
    settings: () => current,
    set: (next) => {
      current = { ...current, ...next };
    },
  };
}

const ollamaLocal = {
  id: 'ollama',
  label: 'Ollama',
  process: 'ollama.exe',
  pid: 100,
  port: 11434,
  evidence: ['process:ollama.exe', 'port:11434', 'api:/api/ps', 'model:llama3:8b'],
};

describe('target selection', () => {
  it('prefers a detected local runtime in auto mode', () => {
    const { sender } = makeSender();
    const target = sender.chooseTarget(snapshot({ local: [ollamaLocal] }));
    expect(target).toMatchObject({
      kind: 'http',
      label: 'Ollama',
      base: 'http://127.0.0.1:11434',
      model: 'llama3:8b',
      reason: 'local:ollama',
    });
    expect(target?.adapter?.id).toBe('ollama');
  });

  it('honours an explicitly selected adapter even when another runtime is detected', () => {
    const { sender } = makeSender({ softStopProfileId: 'lmstudio' });
    const target = sender.chooseTarget(snapshot({ local: [ollamaLocal] }));
    expect(target?.adapter?.id).toBe('lmstudio');
    expect(target?.reason).toBe('configured');
  });

  it('uses the configured endpoint when no runtime is detected', () => {
    const { sender } = makeSender({ softStopHttpBase: 'http://127.0.0.1:9000' });
    const target = sender.chooseTarget(snapshot());
    expect(target?.adapter?.id).toBe('generic-openai');
    expect(target?.base).toBe('http://127.0.0.1:9000');
    expect(target?.reason).toBe('configured-endpoint');
  });

  it('falls back to the GUI agent only when GUI automation is enabled', () => {
    const disabled = makeSender().sender.chooseTarget(snapshot());
    expect(disabled).toBeNull();
    const enabled = makeSender({ softStopGuiEnabled: true }).sender.chooseTarget(snapshot());
    expect(enabled).toMatchObject({ kind: 'gui', reason: 'gui' });
  });

  it('supports forcing the GUI agent from the settings', () => {
    const { sender } = makeSender({ softStopProfileId: 'generic-gui' });
    expect(sender.chooseTarget(snapshot({ local: [ollamaLocal] }))?.kind).toBe('gui');
  });
});

describe('HTTP delivery', () => {
  it('sends the fixed prompt to Ollama with the detected model', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"message":{"content":"ok"}}', { status: 200 }),
    );
    const { sender } = makeSender(
      {
        softStopProfileId: 'ollama',
        softStopHttpModel: 'llama3:8b',
        softStopPrompt: 'Stop at {percent}%. Save state.',
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const result = await sender.send(
      sender.chooseTarget(snapshot({ local: [ollamaLocal] }))!,
      29,
      false,
    );
    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      adapterId: 'ollama',
      model: 'llama3:8b',
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:11434/api/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      options: { num_predict: number };
    };
    expect(body.model).toBe('llama3:8b');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'Stop at 29%. Save state.' });
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(128);
  });

  it('discovers a model before sending to OpenAI-compatible endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b' }] }), { status: 200 });
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    const { sender } = makeSender(
      { softStopProfileId: 'lmstudio', softStopPrompt: 'Please stop.' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const result = await sender.send(
      sender.chooseTarget(
        snapshot({
          local: [
            {
              ...ollamaLocal,
              id: 'lmstudio',
              process: 'LM Studio.exe',
              port: 1234,
              evidence: ['process:LM Studio.exe', 'port:1234', 'api:/v1/models'],
            },
          ],
        }),
      )!,
      25,
      false,
    );
    expect(result.ok).toBe(true);
    expect(result.model).toBe('qwen2.5-7b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [postUrl, postInit] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(postUrl)).toBe('http://127.0.0.1:1234/v1/chat/completions');
    const body = JSON.parse(String(postInit.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe('qwen2.5-7b');
    expect(body.messages[0].content).toBe('Please stop.');
  });

  it('does not touch the network in dry-run mode', async () => {
    const fetchMock = vi.fn();
    const { sender } = makeSender(
      { softStopProfileId: 'ollama', softStopHttpModel: 'llama3' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const result = await sender.send(
      sender.chooseTarget(snapshot({ local: [ollamaLocal] }))!,
      20,
      true,
    );
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(result.detail).toContain('dry-run');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a remote endpoint unless the user opted in', async () => {
    const fetchMock = vi.fn();
    const { sender } = makeSender(
      {
        softStopHttpBase: 'https://api.example.com',
        softStopHttpModel: 'gpt-4o-mini',
        softStopPrompt: 'stop',
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const target = sender.chooseTarget(snapshot())!;
    const result = await sender.send(target, 20, false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('REMOTE_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a remote endpoint after explicit opt-in', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const { sender } = makeSender(
      {
        softStopHttpBase: 'https://api.example.com',
        softStopHttpModel: 'gpt-4o-mini',
        softStopPrompt: 'stop',
        softStopAllowRemote: true,
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const result = await sender.send(sender.chooseTarget(snapshot())!, 20, false);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [URL])[0])).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('attaches a stored API key only to adapters that declare auth', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const secrets: SoftStopSecretReader = {
      getKey: () => 'sk-secret',
      hasKey: () => true,
    };
    const { sender } = makeSender(
      {
        softStopProfileId: 'generic-openai',
        softStopHttpBase: 'http://127.0.0.1:9000',
        softStopHttpModel: 'local-model',
        softStopPrompt: 'stop',
      },
      { fetchImpl: fetchMock as unknown as typeof fetch, secrets },
    );
    const result = await sender.send(sender.chooseTarget(snapshot())!, 20, false);
    expect(result.ok).toBe(true);
    const init = (fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-secret');
  });

  it('reports a non-2xx response without leaking the prompt', async () => {
    const fetchMock = vi.fn(async () => new Response('server says no', { status: 500 }));
    const { sender } = makeSender(
      { softStopProfileId: 'ollama', softStopHttpModel: 'llama3', softStopPrompt: 'TOPSECRET' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const result = await sender.send(
      sender.chooseTarget(snapshot({ local: [ollamaLocal] }))!,
      20,
      false,
    );
    expect(result).toMatchObject({ ok: false, status: 500, error: 'HTTP_500' });
    expect(JSON.stringify(result)).not.toContain('TOPSECRET');
  });

  it('reports a missing model instead of posting an empty model', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const { sender } = makeSender(
      { softStopProfileId: 'generic-openai', softStopPrompt: 'stop' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const result = await sender.send(sender.chooseTarget(snapshot())!, 20, false);
    expect(result.error).toBe('NO_MODEL');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('webhook delivery', () => {
  it('posts the prompt to a configured agent webhook', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }));
    const { sender } = makeSender(
      {
        softStopProfileId: 'generic-webhook',
        softStopHttpBase: 'http://127.0.0.1:9999/stop',
        softStopPrompt: 'halt now',
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const result = await sender.send(sender.chooseTarget(snapshot())!, 12, false);
    expect(result).toMatchObject({ ok: true, status: 202, adapterId: 'generic-webhook' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:9999/stop');
    expect(JSON.parse(String(init.body))).toMatchObject({
      event: 'soft-stop',
      prompt: 'halt now',
      percent: '12',
      threshold: String(DEFAULT_SETTINGS.softStopThreshold),
      sleepThreshold: String(DEFAULT_SETTINGS.softStopSleepThreshold),
    });
  });
});

describe('adapter listing', () => {
  it('marks built-ins and spawn-only adapters for the UI', () => {
    const { sender } = makeSender();
    const adapters = sender.listAdapters();
    expect(adapters.length).toBe(BUILTIN_ADAPTERS.length);
    expect(adapters.find((adapter) => adapter.id === 'ollama')?.builtin).toBe(true);
    expect(adapters.filter((adapter) => adapter.spawnOnly).every((adapter) => adapter.kind === 'cli')).toBe(
      true,
    );
  });
});
