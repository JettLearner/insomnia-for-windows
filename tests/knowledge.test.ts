import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AI_HOST_SUFFIXES,
  BUILTIN_ADAPTERS,
  KNOWLEDGE_FILE,
  loadKnowledgeBase,
} from '../electron/core/knowledge';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'insomniaz-kb-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('built-in soft stop knowledge', () => {
  it('has unique ids and a delivery payload for every adapter', () => {
    const ids = new Set<string>();
    for (const adapter of BUILTIN_ADAPTERS) {
      expect(ids.has(adapter.id)).toBe(false);
      ids.add(adapter.id);
      expect(adapter.label.length).toBeGreaterThan(0);
      if (adapter.kind === 'http') {
        expect(adapter.http).toBeDefined();
        expect(adapter.http?.send.path.startsWith('/')).toBe(true);
        expect(JSON.stringify(adapter.http?.send.body)).toContain('{prompt}');
      } else if (adapter.kind === 'webhook') {
        expect(adapter.webhook).toBeDefined();
        expect(JSON.stringify(adapter.webhook?.body)).toContain('{prompt}');
      } else {
        expect(adapter.cli).toBeDefined();
        expect(adapter.cli?.args.join(' ')).toContain('{prompt}');
        expect(adapter.spawnOnly).toBe(true);
      }
    }
    expect(BUILTIN_ADAPTERS.length).toBeGreaterThanOrEqual(10);
  });

  it('keeps every built-in HTTP endpoint on loopback', () => {
    for (const adapter of BUILTIN_ADAPTERS) {
      if (adapter.kind !== 'http' || !adapter.http) continue;
      const url = new URL(adapter.http.base);
      expect(['127.0.0.1', 'localhost', '::1']).toContain(url.hostname);
    }
  });

  it('ships a useful AI host list without bare consumer domains', () => {
    expect(AI_HOST_SUFFIXES).toContain('api.openai.com');
    expect(AI_HOST_SUFFIXES).toContain('api.anthropic.com');
    expect(AI_HOST_SUFFIXES).toContain('qoder.com');
    expect(AI_HOST_SUFFIXES).not.toContain('baidu.com');
    expect(AI_HOST_SUFFIXES).not.toContain('aliyuncs.com');
  });

  it('loads the built-ins when no user file exists', () => {
    const loaded = loadKnowledgeBase(tempDir());
    expect(loaded.source).toBe('builtin');
    expect(loaded.customCount).toBe(0);
    expect(loaded.knowledge.adapters.map((adapter) => adapter.id)).toEqual(
      BUILTIN_ADAPTERS.map((adapter) => adapter.id),
    );
  });

  it('merges and overrides user adapters', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, KNOWLEDGE_FILE),
      JSON.stringify({
        version: 1,
        adapters: [
          {
            id: 'my-agent',
            label: 'My agent',
            kind: 'webhook',
            match: { processes: ['my-agent.exe'] },
            webhook: {
              url: 'http://127.0.0.1:9999/stop',
              body: { prompt: '{prompt}', percent: '{percent}' },
            },
          },
          {
            id: 'ollama',
            label: 'Ollama custom',
            kind: 'http',
            match: { ports: [11434] },
            http: {
              base: 'http://127.0.0.1:11434',
              send: { path: '/api/chat', body: { prompt: '{prompt}' } },
            },
          },
          { id: 'bad id', label: 'nope', kind: 'http' },
          { id: 'bad-kind', label: 'nope', kind: 'carrier-pigeon' },
        ],
      }),
    );
    const loaded = loadKnowledgeBase(dir);
    expect(loaded.source).toBe('merged');
    expect(loaded.customCount).toBe(2);
    expect(loaded.knowledge.adapters.find((adapter) => adapter.id === 'my-agent')?.label).toBe(
      'My agent',
    );
    expect(loaded.knowledge.adapters.find((adapter) => adapter.id === 'ollama')?.label).toBe(
      'Ollama custom',
    );
    expect(loaded.knowledge.adapters.some((adapter) => adapter.id === 'bad-kind')).toBe(false);
  });

  it('falls back to built-ins when the user file is broken', () => {
    const dir = tempDir();
    writeFileSync(join(dir, KNOWLEDGE_FILE), '{ not json');
    const loaded = loadKnowledgeBase(dir);
    expect(loaded.source).toBe('builtin');
    expect(loaded.error).not.toBeNull();
    expect(loaded.knowledge.adapters.length).toBe(BUILTIN_ADAPTERS.length);
  });

  it('rejects HTTP adapters with a malformed endpoint or send path', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, KNOWLEDGE_FILE),
      JSON.stringify({
        adapters: [
          {
            id: 'bad-url',
            label: 'Bad',
            kind: 'http',
            http: { base: 'ftp://127.0.0.1', send: { path: '/x', body: {} } },
          },
          {
            id: 'bad-path',
            label: 'Bad',
            kind: 'http',
            http: { base: 'http://127.0.0.1:1', send: { path: 'x', body: {} } },
          },
        ],
      }),
    );
    const loaded = loadKnowledgeBase(dir);
    expect(loaded.customCount).toBe(0);
    expect(loaded.knowledge.adapters.some((adapter) => adapter.id === 'bad-url')).toBe(false);
    expect(loaded.knowledge.adapters.some((adapter) => adapter.id === 'bad-path')).toBe(false);
  });
});
