import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SoftStopAdapter,
  SoftStopAdapterKind,
  SoftStopKnowledgeBase,
} from '../../shared/soft-stop';
import type { Logger } from './logger';

export const KNOWLEDGE_FILE = 'soft-stop-knowledge.json';

export const AI_HOST_SUFFIXES: string[] = [
  'api.openai.com',
  'chat.openai.com',
  'chatgpt.com',
  'openai.com',
  'api.anthropic.com',
  'claude.ai',
  'anthropic.com',
  'generativelanguage.googleapis.com',
  'ai.google.dev',
  'gemini.google.com',
  'bard.google.com',
  'aistudio.google.com',
  'api.deepseek.com',
  'chat.deepseek.com',
  'deepseek.com',
  'api.moonshot.cn',
  'kimi.moonshot.cn',
  'moonshot.cn',
  'open.bigmodel.cn',
  'chatglm.cn',
  'bigmodel.cn',
  'dashscope.aliyuncs.com',
  'bailian.aliyuncs.com',
  'tongyi.aliyun.com',
  'chat.qwen.ai',
  'qwen.ai',
  'qwenlm.ai',
  'ark.cn-beijing.volces.com',
  'ark.cn-shanghai.volces.com',
  'doubao.com',
  'qianfan.baidubce.com',
  'yiyan.baidu.com',
  'ernie.baidu.com',
  'hunyuan.tencentcloudapi.com',
  'yuanbao.tencent.com',
  'spark-api.xf-yun.com',
  'xinghuo.xfyun.cn',
  'api.cohere.ai',
  'cohere.com',
  'api.mistral.ai',
  'chat.mistral.ai',
  'mistral.ai',
  'api.groq.com',
  'groq.com',
  'openrouter.ai',
  'api.together.xyz',
  'together.ai',
  'api.fireworks.ai',
  'fireworks.ai',
  'api.perplexity.ai',
  'perplexity.ai',
  'api.x.ai',
  'x.ai',
  'grok.com',
  'api.githubcopilot.com',
  'githubcopilot.com',
  'copilot.microsoft.com',
  'api2.cursor.sh',
  'cursor.com',
  'cursor.sh',
  'codeium.com',
  'windsurf.com',
  'api.codeium.com',
  'qoder.com',
  'qoder.cn',
  'api-inference.huggingface.co',
  'huggingface.co',
  'api.replicate.com',
  'replicate.com',
  'api.siliconflow.cn',
  'siliconflow.cn',
  'api.minimax.chat',
  'minimax.chat',
  'hailuoai.com',
  'api.stepfun.com',
  'stepfun.com',
  'api.novita.ai',
  'novita.ai',
  'hyperbolic.xyz',
  'api.ppio.com',
  '01.ai',
  'platform.01.ai',
  'api.baichuan-ai.com',
  'baichuan-ai.com',
  'sensenova.cn',
  'api.sensenova.cn',
];

const OPENAI_SEND_BODY = {
  model: '{model}',
  messages: [{ role: 'user', content: '{prompt}' }],
  max_tokens: 128,
  temperature: 0.2,
  stream: false,
};

const OPENAI_DISCOVER = { path: '/v1/models', modelPath: 'data.0.id' };

function httpAdapter(
  id: string,
  label: string,
  processes: string[],
  ports: number[],
  base: string,
  overrides: Partial<SoftStopAdapter['http']> = {},
): SoftStopAdapter {
  return {
    id,
    label,
    kind: 'http',
    match: { processes, ports, hosts: [] },
    http: {
      base,
      discover: OPENAI_DISCOVER,
      send: { path: '/v1/chat/completions', body: OPENAI_SEND_BODY },
      timeoutMs: 20_000,
      ...overrides,
    },
  };
}

export const BUILTIN_ADAPTERS: SoftStopAdapter[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'http',
    match: {
      processes: ['ollama.exe', 'ollama app.exe', 'ollama_llama_server.exe'],
      ports: [11434],
      hosts: [],
    },
    http: {
      base: 'http://127.0.0.1:11434',
      discover: {
        path: '/api/ps',
        modelPath: 'models.0.name',
        fallbackPath: '/api/tags',
        fallbackModelPath: 'models.0.name',
      },
      send: {
        path: '/api/chat',
        body: {
          model: '{model}',
          messages: [{ role: 'user', content: '{prompt}' }],
          stream: false,
          options: { num_predict: 128 },
        },
      },
      timeoutMs: 20_000,
    },
  },
  httpAdapter(
    'lmstudio',
    'LM Studio',
    ['LM Studio.exe', 'lms.exe', 'lm-studio.exe'],
    [1234],
    'http://127.0.0.1:1234',
  ),
  httpAdapter('vllm', 'vLLM', ['vllm.exe'], [8000], 'http://127.0.0.1:8000'),
  httpAdapter(
    'llamacpp',
    'llama.cpp server',
    ['llama-server.exe', 'llama-server', 'llamacpp-server.exe', 'llama.cpp*'],
    [8080, 8081],
    'http://127.0.0.1:8080',
  ),
  httpAdapter('localai', 'LocalAI', ['localai.exe', 'local-ai.exe'], [8080], 'http://127.0.0.1:8080'),
  httpAdapter(
    'textgenwebui',
    'text-generation-webui',
    ['text-generation-webui*', 'oobabooga*'],
    [5000, 7860],
    'http://127.0.0.1:5000',
  ),
  {
    id: 'koboldcpp',
    label: 'KoboldCpp',
    kind: 'http',
    match: { processes: ['koboldcpp.exe', 'koboldcpp*'], ports: [5001], hosts: [] },
    http: {
      base: 'http://127.0.0.1:5001',
      discover: { path: '/api/v1/model', modelPath: 'result' },
      send: {
        path: '/api/v1/generate',
        body: {
          prompt: '{prompt}',
          max_length: 128,
          temperature: 0.2,
          top_p: 0.9,
        },
      },
      timeoutMs: 20_000,
    },
  },
  httpAdapter('jan', 'Jan', ['jan.exe'], [1337], 'http://127.0.0.1:1337'),
  httpAdapter(
    'gpt4all',
    'GPT4All',
    ['gpt4all*.exe', 'gpt4all.exe'],
    [4891],
    'http://127.0.0.1:4891',
  ),
  httpAdapter('llamafile', 'llamafile', ['llamafile*'], [8080], 'http://127.0.0.1:8080'),
  {
    id: 'generic-openai',
    label: 'OpenAI-compatible endpoint',
    kind: 'http',
    match: { processes: [], ports: [], hosts: [] },
    http: {
      base: 'http://127.0.0.1:8000',
      discover: OPENAI_DISCOVER,
      send: { path: '/v1/chat/completions', body: OPENAI_SEND_BODY },
      auth: { header: 'Authorization', scheme: 'Bearer' },
      timeoutMs: 20_000,
    },
    notes: 'Uses the API base and model from Soft Stop settings; API keys are stored with Windows DPAPI.',
  },
  {
    id: 'generic-webhook',
    label: 'Agent webhook',
    kind: 'webhook',
    match: { processes: [], ports: [], hosts: [] },
    webhook: {
      url: 'http://127.0.0.1:8765/soft-stop',
      body: {
        event: 'soft-stop',
        prompt: '{prompt}',
        percent: '{percent}',
        threshold: '{threshold}',
        sleepThreshold: '{sleepThreshold}',
        model: '{model}',
      },
      timeoutMs: 10_000,
    },
    notes: 'Posts the fixed prompt to a self-written agent webhook. Uses the API base from Soft Stop settings.',
  },
  {
    id: 'cli-codex',
    label: 'Codex CLI (new run)',
    kind: 'cli',
    match: { processes: [], ports: [], hosts: [] },
    cli: { command: 'codex', args: ['exec', '--skip-git-repo-check', '{prompt}'], timeoutMs: 15_000 },
    spawnOnly: true,
    notes: 'Starts a new non-interactive run; it does not type into an existing terminal session.',
  },
  {
    id: 'cli-claude',
    label: 'Claude Code CLI (new run)',
    kind: 'cli',
    match: { processes: [], ports: [], hosts: [] },
    cli: { command: 'claude', args: ['-p', '{prompt}'], timeoutMs: 15_000 },
    spawnOnly: true,
  },
  {
    id: 'cli-gemini',
    label: 'Gemini CLI (new run)',
    kind: 'cli',
    match: { processes: [], ports: [], hosts: [] },
    cli: { command: 'gemini', args: ['-p', '{prompt}'], timeoutMs: 15_000 },
    spawnOnly: true,
  },
  {
    id: 'cli-opencode',
    label: 'opencode (new run)',
    kind: 'cli',
    match: { processes: [], ports: [], hosts: [] },
    cli: { command: 'opencode', args: ['run', '{prompt}'], timeoutMs: 15_000 },
    spawnOnly: true,
  },
  {
    id: 'cli-llm',
    label: 'llm CLI (new run)',
    kind: 'cli',
    match: { processes: [], ports: [], hosts: [] },
    cli: { command: 'llm', args: ['{prompt}'], timeoutMs: 15_000 },
    spawnOnly: true,
  },
];

export const BUILTIN_KNOWLEDGE: SoftStopKnowledgeBase = {
  version: 1,
  adapters: BUILTIN_ADAPTERS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, maxLength);
    if (trimmed) result.push(trimmed);
    if (result.length >= maxItems) break;
  }
  return result;
}

function numberList(value: unknown, maxItems: number): number[] {
  if (!Array.isArray(value)) return [];
  const result: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 65535) continue;
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function httpUrl(value: unknown): string | null {
  const candidate = text(value, 300);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return candidate;
  } catch {
    return null;
  }
}

function sanitizeAdapter(raw: unknown): SoftStopAdapter | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id, 80);
  const label = text(raw.label, 80);
  const kind = raw.kind;
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || !label) return null;
  if (kind !== 'http' && kind !== 'cli' && kind !== 'webhook') return null;

  const matchInput = isRecord(raw.match) ? raw.match : {};
  const adapter: SoftStopAdapter = {
    id,
    label,
    kind: kind as SoftStopAdapterKind,
    match: {
      processes: stringList(matchInput.processes, 24, 120),
      ports: numberList(matchInput.ports, 24),
      hosts: stringList(matchInput.hosts, 24, 120),
    },
  };

  if (kind === 'http') {
    if (!isRecord(raw.http)) return null;
    const base = httpUrl(raw.http.base);
    if (!base) return null;
    const sendInput = isRecord(raw.http.send) ? raw.http.send : null;
    const sendPath = sendInput ? text(sendInput.path, 300) : null;
    if (!sendInput || !sendPath || !sendPath.startsWith('/')) return null;
    const discoverInput = isRecord(raw.http.discover) ? raw.http.discover : null;
    const discoverPath = discoverInput ? text(discoverInput.path, 300) : null;
    if (discoverInput && (!discoverPath || !discoverPath.startsWith('/'))) return null;
    const authInput = isRecord(raw.http.auth) ? raw.http.auth : null;
    const authHeader = authInput ? text(authInput.header, 80) : null;
    adapter.http = {
      base,
      send: {
        path: sendPath,
        body: sendInput.body === undefined ? {} : sendInput.body,
        headers: isRecord(sendInput.headers)
          ? Object.fromEntries(
              Object.entries(sendInput.headers)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                .slice(0, 16),
            )
          : undefined,
      },
      discover: discoverInput && discoverPath
        ? {
            path: discoverPath,
            modelPath: text(discoverInput.modelPath, 200) ?? undefined,
            fallbackPath: text(discoverInput.fallbackPath, 300) ?? undefined,
            fallbackModelPath: text(discoverInput.fallbackModelPath, 200) ?? undefined,
          }
        : undefined,
      auth: authInput && authHeader
        ? { header: authHeader, scheme: text(authInput.scheme, 40) ?? undefined }
        : undefined,
      timeoutMs: typeof raw.http.timeoutMs === 'number' ? raw.http.timeoutMs : undefined,
    };
  } else if (kind === 'cli') {
    if (!isRecord(raw.cli)) return null;
    const command = text(raw.cli.command, 200);
    if (!command) return null;
    adapter.cli = {
      command,
      args: stringList(raw.cli.args, 64, 1000),
      timeoutMs: typeof raw.cli.timeoutMs === 'number' ? raw.cli.timeoutMs : undefined,
    };
  } else {
    if (!isRecord(raw.webhook)) return null;
    const url = httpUrl(raw.webhook.url);
    if (!url) return null;
    adapter.webhook = {
      url,
      body: raw.webhook.body === undefined ? {} : raw.webhook.body,
      headers: isRecord(raw.webhook.headers)
        ? Object.fromEntries(
            Object.entries(raw.webhook.headers)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
              .slice(0, 16),
          )
        : undefined,
      timeoutMs: typeof raw.webhook.timeoutMs === 'number' ? raw.webhook.timeoutMs : undefined,
    };
  }

  adapter.spawnOnly = raw.spawnOnly === true;
  adapter.notes = text(raw.notes, 500) ?? undefined;
  return adapter;
}

export interface LoadedKnowledge {
  knowledge: SoftStopKnowledgeBase;
  customCount: number;
  source: 'builtin' | 'merged';
  error: string | null;
}

export function loadKnowledgeBase(userDataDir: string, logger?: Logger): LoadedKnowledge {
  const path = join(userDataDir, KNOWLEDGE_FILE);
  if (!existsSync(path)) {
    return { knowledge: BUILTIN_KNOWLEDGE, customCount: 0, source: 'builtin', error: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.adapters)) {
      throw new Error('expected { version, adapters[] }');
    }
    const merged = new Map(BUILTIN_ADAPTERS.map((adapter) => [adapter.id, adapter]));
    let customCount = 0;
    for (const raw of parsed.adapters) {
      const adapter = sanitizeAdapter(raw);
      if (!adapter) continue;
      merged.set(adapter.id, adapter);
      customCount += 1;
    }
    logger?.info('loaded custom soft stop knowledge', { path, customCount });
    return {
      knowledge: { version: 1, adapters: [...merged.values()] },
      customCount,
      source: 'merged',
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn('could not load custom soft stop knowledge', { message });
    return { knowledge: BUILTIN_KNOWLEDGE, customCount: 0, source: 'builtin', error: message };
  }
}
