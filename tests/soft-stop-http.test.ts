import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import type { AiActivitySnapshot } from '../shared/soft-stop';
import { BUILTIN_KNOWLEDGE } from '../electron/core/knowledge';
import { SoftStopSender, type SoftStopSecretReader } from '../electron/core/soft-stop-sender';
import type { Logger } from '../electron/core/logger';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const secrets: SoftStopSecretReader = {
  getKey: () => 'sk-integration',
  hasKey: () => true,
};

const emptySnapshot: AiActivitySnapshot = {
  ts: 1,
  network: { adapters: [], throughputBps: 0 },
  local: [],
  remote: [],
  streaming: 'none',
  confidence: 0,
  evidence: [],
};

type Captured = {
  method: string;
  url: string;
  auth: string | undefined;
  body: {
    model?: string;
    stream?: boolean;
    messages?: Array<{ role: string; content: string }>;
  } | null;
};

let server: Server;
let base = '';
let captured: Captured[] = [];
let failNext = false;

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body: Captured['body'] = null;
      try {
        body = raw ? (JSON.parse(raw) as Captured['body']) : null;
      } catch {
        body = null;
      }
      captured.push({
        method: request.method ?? '',
        url: request.url ?? '',
        auth: request.headers.authorization,
        body,
      });
      response.setHeader('Connection', 'close');
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'mock-qwen' }] }));
        return;
      }
      if (request.url === '/v1/chat/completions') {
        if (failNext) {
          response.writeHead(500, { 'Content-Type': 'text/plain' });
          response.end('mock failure');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'acknowledged' } }] }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  failNext = false;
});

function makeSender(patch: Partial<Settings> = {}): SoftStopSender {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    softStopHttpBase: base,
    softStopPrompt: 'Stop work now. Battery {percent}%, prompt threshold {threshold}%.',
    softStopDryRun: false,
    softStopAllowRemote: false,
    ...patch,
  };
  return new SoftStopSender({
    knowledge: BUILTIN_KNOWLEDGE,
    getSettings: () => settings,
    secrets,
    logger,
  });
}

describe('soft stop over a real HTTP socket', () => {
  it('discovers a model, posts the rendered prompt and attaches the stored key', async () => {
    const sender = makeSender();
    const target = sender.chooseTarget(emptySnapshot);
    expect(target?.kind).toBe('http');

    const result = await sender.send(target!, 24, false);

    expect(result).toMatchObject({ ok: true, dryRun: false, status: 200, model: 'mock-qwen' });
    const discovery = captured.find((entry) => entry.url === '/v1/models');
    expect(discovery?.method).toBe('GET');
    expect(discovery?.auth).toBe('Bearer sk-integration');

    const post = captured.find((entry) => entry.url === '/v1/chat/completions');
    expect(post).toBeDefined();
    expect(post?.method).toBe('POST');
    expect(post?.auth).toBe('Bearer sk-integration');
    expect(post?.body?.model).toBe('mock-qwen');
    expect(post?.body?.stream).toBe(false);
    expect(post?.body?.messages).toEqual([
      {
        role: 'user',
        content: 'Stop work now. Battery 24%, prompt threshold 30%.',
      },
    ]);
  });

  it('reports a rejected request without echoing the prompt', async () => {
    failNext = true;
    const sender = makeSender({ softStopPrompt: 'TOPSECRET-PROMPT' });
    const result = await sender.send(sender.chooseTarget(emptySnapshot)!, 20, false);

    expect(result).toMatchObject({ ok: false, status: 500, error: 'HTTP_500' });
    expect(JSON.stringify(result)).not.toContain('TOPSECRET-PROMPT');
  });

  it('never opens a socket in dry-run mode when the model is known', async () => {
    const sender = makeSender({ softStopDryRun: true, softStopHttpModel: 'mock-qwen' });
    const result = await sender.send(sender.chooseTarget(emptySnapshot)!, 20, true);

    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(captured).toHaveLength(0);
  });
});
