import { describe, expect, it } from 'vitest';
import {
  EMPTY_SOFT_STOP_CYCLE,
  adapterMatchesHost,
  adapterMatchesPort,
  adapterMatchesProcess,
  clampSoftStopThresholds,
  getPathValue,
  guiTargetAllowed,
  isLoopbackHost,
  normalizeAllowlist,
  normalizeEndpoint,
  normalizeModelName,
  normalizeProfileId,
  normalizeSoftStopPrompt,
  pickModelFromPayload,
  planSoftStopTick,
  processMatchesPattern,
  renderDeep,
  renderTemplate,
  requestHasAiActivity,
  sanitizeSoftStopCycle,
  shouldResetSoftStopCycle,
  softStopCycleActive,
  type AiActivitySnapshot,
  type SoftStopAdapter,
  type SoftStopCycle,
} from '../shared/soft-stop';

const cycle = (patch: Partial<SoftStopCycle> = {}): SoftStopCycle => ({
  cycleStartedAt: 1_000,
  triggered: false,
  attempts: 0,
  lastAttemptAt: null,
  ...patch,
});

const baseTick = {
  enabled: true,
  active: true,
  ac: false,
  percent: 25,
  threshold: 30,
  sleepThreshold: 10,
  dryRun: false,
  cycle: cycle(),
  hasActivity: false,
  activityKnown: false,
  now: 1_000_000,
};

const snapshot = (patch: Partial<AiActivitySnapshot> = {}): AiActivitySnapshot => ({
  ts: 1,
  network: { adapters: [], throughputBps: 0 },
  local: [],
  remote: [],
  streaming: 'none',
  confidence: 0,
  evidence: [],
  ...patch,
});

describe('renderTemplate', () => {
  it('replaces every known placeholder and leaves unknown ones alone', () => {
    const rendered = renderTemplate(
      '{prompt} | {percent}% / {threshold}% -> {sleepThreshold}% | {model} | {unknown}',
      {
        prompt: 'stop',
        percent: 28,
        threshold: 30,
        sleepThreshold: 10,
        model: 'llama3',
      },
    );
    expect(rendered).toBe('stop | 28% / 30% -> 10% | llama3 | {unknown}');
  });

  it('does not expand placeholders that appear inside the prompt', () => {
    expect(renderTemplate('{prompt}', { prompt: 'keep {model} literal' })).toBe(
      'keep {model} literal',
    );
  });

  it('renders empty strings and zero but skips null values', () => {
    expect(renderTemplate('[{model}] [{percent}]', { model: '', percent: null })).toBe('[] [{percent}]');
    expect(renderTemplate('{percent}', { percent: 0 })).toBe('0');
  });

  it('renders nested request bodies without mutating the source', () => {
    const body = {
      model: '{model}',
      messages: [{ role: 'user', content: '{prompt}' }],
      stream: false,
      max_tokens: 128,
    };
    const rendered = renderDeep(body, { model: 'm', prompt: 'p' });
    expect(rendered).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'p' }],
      stream: false,
      max_tokens: 128,
    });
    expect(body.model).toBe('{model}');
  });
});

describe('thresholds', () => {
  it('clamps A to 10..95 and B to 5..A-5', () => {
    expect(clampSoftStopThresholds(30, 10)).toEqual({ threshold: 30, sleepThreshold: 10 });
    expect(clampSoftStopThresholds(5, 99)).toEqual({ threshold: 10, sleepThreshold: 5 });
    expect(clampSoftStopThresholds(95, 90)).toEqual({ threshold: 95, sleepThreshold: 90 });
    expect(clampSoftStopThresholds(30, 80)).toEqual({ threshold: 30, sleepThreshold: 25 });
    expect(clampSoftStopThresholds(Number.NaN, Number.NaN)).toEqual({
      threshold: 30,
      sleepThreshold: 10,
    });
  });
});

describe('prompt and allowlist normalisation', () => {
  it('strips controls, normalises newlines, trims and caps the prompt', () => {
    expect(normalizeSoftStopPrompt('  a\u0000b\r\nc\tD  ')).toBe('ab\nc\tD');
    expect(normalizeSoftStopPrompt('x'.repeat(2500))).toHaveLength(2000);
    expect(normalizeSoftStopPrompt(42)).toBe('');
  });

  it('caps, trims and dedupes the allowlist case-insensitively', () => {
    const entries = Array.from({ length: 40 }, (_, index) => `App${index}.exe`);
    expect(normalizeAllowlist(entries)).toHaveLength(32);
    expect(normalizeAllowlist(['Qoder.exe', 'qoder.EXE', '  ', 42])).toEqual(['Qoder.exe']);
    expect(normalizeAllowlist('nope')).toEqual([]);
  });

  it('accepts only safe profile ids and model names', () => {
    expect(normalizeProfileId('ollama')).toBe('ollama');
    expect(normalizeProfileId('my.agent_1')).toBe('my.agent_1');
    expect(normalizeProfileId('has space')).toBeNull();
    expect(normalizeProfileId('__proto__')).toBeNull();
    expect(normalizeProfileId('x'.repeat(81))).toBeNull();
    expect(normalizeModelName('  llama3:8b  ')).toBe('llama3:8b');
    expect(normalizeModelName('bad\u0000name')).toBe('badname');
  });
});

describe('endpoint validation', () => {
  it('recognises loopback hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.8.9.10', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['192.168.1.2', 'example.com', '10.0.0.1', 'localhost.example.com']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('normalises HTTP endpoints and flags remote hosts', () => {
    expect(normalizeEndpoint(' http://127.0.0.1:11434/ ')).toEqual({
      base: 'http://127.0.0.1:11434',
      remote: false,
    });
    expect(normalizeEndpoint('https://api.example.com/v1/')).toEqual({
      base: 'https://api.example.com/v1',
      remote: true,
    });
    expect(normalizeEndpoint('https://user:pass@example.com')).toEqual({ base: null, remote: false });
    expect(normalizeEndpoint('file:///c:/secrets')).toEqual({ base: null, remote: false });
    expect(normalizeEndpoint(undefined)).toEqual({ base: null, remote: false });
  });
});

describe('activity helpers', () => {
  it('requires local runtimes or streaming before calling it AI activity', () => {
    expect(requestHasAiActivity(null)).toBe(false);
    expect(requestHasAiActivity(snapshot())).toBe(false);
    expect(
      requestHasAiActivity(
        snapshot({
          local: [
            { id: 'ollama', label: 'Ollama', process: 'ollama.exe', pid: 1, port: 11434, evidence: [] },
          ],
        }),
      ),
    ).toBe(true);
    expect(requestHasAiActivity(snapshot({ streaming: 'suspected' }))).toBe(true);
    expect(
      requestHasAiActivity(
        snapshot({
          local: [
            {
              id: 'ollama',
              label: 'Ollama',
              process: 'ollama.exe',
              pid: 1,
              port: 11434,
              evidence: ['port:11434', 'model:qwen', 'idle'],
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      requestHasAiActivity(
        snapshot({ remote: [{ host: 'api.openai.com', evidence: ['dns'] }] }),
      ),
    ).toBe(false);
  });

  it('matches GUI targets by process or window title, case-insensitively', () => {
    expect(guiTargetAllowed([], 'qoder.exe', 'Qoder')).toBe(false);
    expect(guiTargetAllowed(['qoder'], 'Qoder.exe', 'Qoder - chat')).toBe(true);
    expect(guiTargetAllowed(['Chat App'], 'other.exe', 'My Chat App')).toBe(true);
    expect(guiTargetAllowed(['qoder'], 'code.exe', 'Visual Studio Code')).toBe(false);
    expect(guiTargetAllowed(['qoder'], null, null)).toBe(false);
  });
});

describe('planSoftStopTick', () => {
  it('is inactive when disabled, stopped, charging or without a battery reading', () => {
    expect(planSoftStopTick({ ...baseTick, enabled: false })).toEqual({
      type: 'inactive',
      reason: 'disabled',
    });
    expect(planSoftStopTick({ ...baseTick, active: false })).toEqual({
      type: 'inactive',
      reason: 'inactive-session',
    });
    expect(planSoftStopTick({ ...baseTick, ac: true })).toEqual({ type: 'inactive', reason: 'ac' });
    expect(planSoftStopTick({ ...baseTick, percent: null })).toEqual({
      type: 'inactive',
      reason: 'no-battery',
    });
  });

  it('always sleeps at or below B, even after a successful send', () => {
    expect(planSoftStopTick({ ...baseTick, percent: 10 })).toEqual({ type: 'sleep' });
    expect(
      planSoftStopTick({
        ...baseTick,
        percent: 4,
        cycle: cycle({ triggered: true, attempts: 1 }),
      }),
    ).toEqual({ type: 'sleep' });
    expect(
      planSoftStopTick({
        ...baseTick,
        percent: 10,
        cycle: cycle({ triggered: true, attempts: 2 }),
      }),
    ).toEqual({ type: 'sleep' });
  });

  it('waits while the battery is above A or after this cycle already sent', () => {
    expect(planSoftStopTick({ ...baseTick, percent: 31 })).toEqual({
      type: 'wait',
      reason: 'above-threshold',
    });
    expect(
      planSoftStopTick({ ...baseTick, cycle: cycle({ triggered: true, attempts: 1 }) }),
    ).toEqual({ type: 'wait', reason: 'already-triggered' });
  });

  it('asks for detection before deciding to send', () => {
    expect(planSoftStopTick(baseTick)).toEqual({ type: 'detect' });
    expect(planSoftStopTick({ ...baseTick, activityKnown: true })).toEqual({
      type: 'wait-activity',
    });
    expect(planSoftStopTick({ ...baseTick, activityKnown: true, hasActivity: true })).toEqual({
      type: 'send',
      dryRun: false,
    });
    expect(
      planSoftStopTick({ ...baseTick, activityKnown: true, hasActivity: true, dryRun: true }),
    ).toEqual({ type: 'send', dryRun: true });
  });

  it('honours the retry cooldown and the attempt cap', () => {
    expect(
      planSoftStopTick({
        ...baseTick,
        cycle: cycle({ attempts: 1, lastAttemptAt: baseTick.now - 60_000 }),
      }),
    ).toEqual({ type: 'cooldown', retryAt: baseTick.now - 60_000 + 300_000 });
    expect(
      planSoftStopTick({
        ...baseTick,
        cycle: cycle({ attempts: 1, lastAttemptAt: baseTick.now - 300_000 }),
        activityKnown: true,
        hasActivity: true,
      }),
    ).toEqual({ type: 'send', dryRun: false });
    expect(
      planSoftStopTick({
        ...baseTick,
        cycle: cycle({ attempts: 2, lastAttemptAt: baseTick.now - 3_600_000 }),
      }),
    ).toEqual({ type: 'exhausted' });
  });
});

describe('cycle bookkeeping', () => {
  it('starts a fresh cycle when the session changes', () => {
    const previous = cycle({ triggered: true, attempts: 2, lastAttemptAt: 500 });
    expect(softStopCycleActive(previous, 2_000)).toEqual({
      cycleStartedAt: 2_000,
      triggered: false,
      attempts: 0,
      lastAttemptAt: null,
    });
    expect(softStopCycleActive(previous, 1_000)).toBe(previous);
    expect(softStopCycleActive(previous, null)).toEqual(EMPTY_SOFT_STOP_CYCLE);
  });

  it('resets after connecting AC or recovering more than five points above A', () => {
    const triggered = cycle({ triggered: true, attempts: 1 });
    expect(shouldResetSoftStopCycle(triggered, true, 30, 30)).toBe(true);
    expect(shouldResetSoftStopCycle(triggered, false, 36, 30)).toBe(true);
    expect(shouldResetSoftStopCycle(triggered, false, 35, 30)).toBe(false);
    expect(shouldResetSoftStopCycle(cycle(), true, 30, 30)).toBe(false);
    expect(shouldResetSoftStopCycle(EMPTY_SOFT_STOP_CYCLE, true, 30, 30)).toBe(false);
  });

  it('sanitises a persisted cycle against the current session', () => {
    expect(
      sanitizeSoftStopCycle(
        { cycleStartedAt: 1_000, triggered: true, attempts: 99, lastAttemptAt: 123 },
        1_000,
      ),
    ).toEqual({ cycleStartedAt: 1_000, triggered: true, attempts: 2, lastAttemptAt: 123 });
    expect(
      sanitizeSoftStopCycle({ cycleStartedAt: 999, triggered: true, attempts: 2 }, 1_000),
    ).toEqual({ cycleStartedAt: 1_000, triggered: false, attempts: 0, lastAttemptAt: null });
    expect(sanitizeSoftStopCycle('junk', 1_000)).toEqual({
      cycleStartedAt: 1_000,
      triggered: false,
      attempts: 0,
      lastAttemptAt: null,
    });
    expect(sanitizeSoftStopCycle({}, null)).toEqual(EMPTY_SOFT_STOP_CYCLE);
  });
});

describe('knowledge helpers', () => {
  const adapter: SoftStopAdapter = {
    id: 'ollama',
    label: 'Ollama',
    kind: 'http',
    match: {
      processes: ['ollama*.exe'],
      ports: [11434],
      hosts: ['openai.com', 'ollama.com'],
    },
    http: {
      base: 'http://127.0.0.1:11434',
      discover: { path: '/api/ps', modelPath: 'models.0.name', fallbackPath: '/api/tags' },
      send: { path: '/api/chat', body: {} },
    },
  };

  it('matches process wildcards and host suffixes', () => {
    expect(processMatchesPattern('ollama.exe', 'ollama*.exe')).toBe(true);
    expect(processMatchesPattern('ollama_llama_server.exe', 'ollama*.exe')).toBe(true);
    expect(processMatchesPattern('not-ollama.exe', 'ollama*.exe')).toBe(false);
    expect(processMatchesPattern('OLLAMA.EXE', 'ollama.exe')).toBe(true);
    expect(adapterMatchesProcess(adapter, 'ollama.exe')).toBe(true);
    expect(adapterMatchesProcess(adapter, 'code.exe')).toBe(false);
    expect(adapterMatchesHost(adapter, 'api.openai.com')).toBe(true);
    expect(adapterMatchesHost(adapter, 'openai.com')).toBe(true);
    expect(adapterMatchesHost(adapter, 'evilopenai.com')).toBe(false);
    expect(adapterMatchesPort(adapter, 11434)).toBe(true);
    expect(adapterMatchesPort(adapter, 1234)).toBe(false);
  });

  it('walks dotted paths through objects and arrays', () => {
    const payload = { models: [{ name: 'llama3:8b' }], data: [{ id: 'second' }] };
    expect(getPathValue(payload, 'models.0.name')).toBe('llama3:8b');
    expect(getPathValue(payload, 'data.0.id')).toBe('second');
    expect(getPathValue(payload, 'models.9.name')).toBeUndefined();
    expect(getPathValue(payload, '')).toBeUndefined();
    expect(getPathValue(null, 'a.b')).toBeUndefined();
  });

  it('falls back to the secondary discovery path', () => {
    const discover = adapter.http?.discover;
    expect(pickModelFromPayload({ models: [{ name: 'a' }] }, discover)).toBe('a');
    expect(pickModelFromPayload({ models: [] }, discover)).toBe('');
    expect(
      pickModelFromPayload({ models: [], tags: undefined }, {
        path: '/x',
        modelPath: 'models.0.name',
        fallbackModelPath: 'tags.0.name',
      }),
    ).toBe('');
    expect(
      pickModelFromPayload({ tags: [{ name: 'fallback' }] }, {
        path: '/x',
        modelPath: 'models.0.name',
        fallbackModelPath: 'tags.0.name',
      }),
    ).toBe('fallback');
  });
});
