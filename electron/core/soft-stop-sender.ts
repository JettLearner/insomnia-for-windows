import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type {
  AiActivitySnapshot,
  LocalAiRuntime,
  SoftStopAdapter,
  SoftStopAdapterInfo,
  SoftStopKnowledgeBase,
  SoftStopSendResult,
  SoftStopTemplateVars,
} from '../../shared/soft-stop';
import {
  findAdapter,
  isLoopbackHost,
  pickModelFromPayload,
  renderDeep,
  renderTemplate,
  runtimeIsIdle,
} from '../../shared/soft-stop';
import type { Settings } from '../../shared/types';
import { BUILTIN_ADAPTERS } from './knowledge';
import type { Logger } from './logger';

export interface SoftStopSecretReader {
  getKey(): string | null;
  hasKey(): boolean;
}

export interface SoftStopTarget {
  kind: 'http' | 'webhook' | 'cli' | 'gui';
  adapter: SoftStopAdapter | null;
  label: string;
  base: string | null;
  model: string;
  reason: string;
}

export interface SoftStopSenderOptions {
  knowledge: SoftStopKnowledgeBase;
  getSettings: () => Settings;
  secrets: SoftStopSecretReader;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

const BUILTIN_IDS = new Set(BUILTIN_ADAPTERS.map((adapter) => adapter.id));

function runtimeModel(runtime: LocalAiRuntime | undefined): string {
  if (!runtime) return '';
  for (const item of runtime.evidence) {
    if (item.startsWith('model:')) return item.slice(6).trim();
  }
  return '';
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'TIMEOUT';
    return error.message.replace(/\s+/g, ' ').slice(0, 160);
  }
  return String(error).slice(0, 160);
}

export class SoftStopSender {
  private readonly options: SoftStopSenderOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SoftStopSenderOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get secrets(): SoftStopSecretReader {
    return this.options.secrets;
  }

  listAdapters(): SoftStopAdapterInfo[] {
    return this.options.knowledge.adapters.map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      kind: adapter.kind,
      builtin: BUILTIN_IDS.has(adapter.id),
      spawnOnly: adapter.spawnOnly === true,
    }));
  }

  chooseTarget(snapshot: AiActivitySnapshot): SoftStopTarget | null {
    const settings = this.options.getSettings();
    const profileId = settings.softStopProfileId;

    if (profileId === 'generic-gui') {
      return { kind: 'gui', adapter: null, label: 'GUI agent', base: null, model: '', reason: 'configured' };
    }
    if (profileId) {
      const adapter = findAdapter(this.options.knowledge, profileId);
      if (!adapter) return null;
      const runtime = snapshot.local.find((entry) => entry.id === adapter.id);
      return this.targetForAdapter(adapter, runtime, 'configured');
    }

    for (const runtime of snapshot.local) {
      if (runtimeIsIdle(runtime)) continue;
      const adapter = findAdapter(this.options.knowledge, runtime.id);
      if (!adapter || adapter.kind !== 'http' || adapter.spawnOnly) continue;
      return this.targetForAdapter(adapter, runtime, `local:${runtime.id}`);
    }

    if (settings.softStopHttpBase) {
      const generic = findAdapter(this.options.knowledge, 'generic-openai');
      if (generic) return this.targetForAdapter(generic, undefined, 'configured-endpoint');
    }
    if (settings.softStopGuiEnabled) {
      return { kind: 'gui', adapter: null, label: 'GUI agent', base: null, model: '', reason: 'gui' };
    }
    return null;
  }

  private targetForAdapter(
    adapter: SoftStopAdapter,
    runtime: LocalAiRuntime | undefined,
    reason: string,
  ): SoftStopTarget {
    const settings = this.options.getSettings();
    const model = settings.softStopHttpModel || runtimeModel(runtime);
    const base =
      adapter.kind === 'http'
        ? settings.softStopHttpBase || adapter.http?.base || null
        : adapter.kind === 'webhook'
          ? settings.softStopHttpBase || adapter.webhook?.url || null
          : null;
    return {
      kind: adapter.kind,
      adapter,
      label: adapter.label,
      base,
      model,
      reason,
    };
  }

  private checkRemote(url: URL): string | null {
    if (isLoopbackHost(url.hostname)) return null;
    return this.options.getSettings().softStopAllowRemote ? null : 'REMOTE_NOT_ALLOWED';
  }

  private endpointUrl(base: string, path: string): { url: URL | null; error: string | null } {
    try {
      const suffix = path === '' ? '' : path.startsWith('/') ? path : `/${path}`;
      const url = new URL(`${base.replace(/\/+$/, '')}${suffix}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { url: null, error: 'INVALID_URL' };
      }
      const remoteError = this.checkRemote(url);
      if (remoteError) return { url: null, error: remoteError };
      return { url, error: null };
    } catch {
      return { url: null, error: 'INVALID_URL' };
    }
  }

  private authHeaders(adapter: SoftStopAdapter): Record<string, string> {
    const headers: Record<string, string> = {};
    const auth = adapter.http?.auth;
    if (!auth) return headers;
    const key = this.options.secrets.getKey();
    if (!key) return headers;
    headers[auth.header] = auth.scheme ? `${auth.scheme} ${key}` : key;
    return headers;
  }

  private async discoverModel(adapter: SoftStopAdapter, base: string): Promise<string> {
    const http = adapter.http;
    if (!http?.discover) return '';
    const timeout = Math.min(4000, Math.max(1000, http.timeoutMs ?? 5000));
    const headers = { Accept: 'application/json', ...this.authHeaders(adapter) };
    const readModel = async (path: string, modelPath: string | undefined): Promise<string> => {
      const endpoint = this.endpointUrl(base, path);
      if (!endpoint.url) return '';
      try {
        const response = await this.fetchImpl(endpoint.url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) return '';
        const body = await response.text();
        if (body.length > 2_000_000) return '';
        const payload = JSON.parse(body) as unknown;
        return pickModelFromPayload(payload, { path, modelPath });
      } catch {
        return '';
      }
    };
    const primary = await readModel(http.discover.path, http.discover.modelPath);
    if (primary) return primary;
    if (http.discover.fallbackPath) {
      return readModel(http.discover.fallbackPath, http.discover.fallbackModelPath);
    }
    return '';
  }

  private modelRequired(adapter: SoftStopAdapter): boolean {
    if (adapter.kind !== 'http') return false;
    try {
      return JSON.stringify(adapter.http?.send.body ?? {}).includes('{model}');
    } catch {
      return false;
    }
  }

  async send(
    target: SoftStopTarget,
    percent: number | null,
    dryRun: boolean,
  ): Promise<SoftStopSendResult> {
    const settings = this.options.getSettings();
    const adapter = target.adapter;
    if (target.kind === 'gui') {
      return {
        ok: false,
        dryRun,
        adapterId: null,
        target: target.label,
        model: null,
        detail: 'GUI target is handled by the GUI agent',
        error: 'GUI_TARGET',
      };
    }
    if (!adapter) {
      return {
        ok: false,
        dryRun,
        adapterId: null,
        target: target.label,
        model: null,
        detail: 'No adapter',
        error: 'NO_ADAPTER',
      };
    }

    let model = target.model;
    if (adapter.kind === 'http' && !model && adapter.http?.discover) {
      model = await this.discoverModel(adapter, target.base ?? adapter.http.base);
    }
    const vars: SoftStopTemplateVars = {
      prompt: '',
      percent,
      threshold: settings.softStopThreshold,
      sleepThreshold: settings.softStopSleepThreshold,
      model,
    };
    vars.prompt = renderTemplate(settings.softStopPrompt, vars).trim();
    if (!vars.prompt) {
      return {
        ok: false,
        dryRun,
        adapterId: adapter.id,
        target: target.label,
        model: model || null,
        detail: 'The soft stop prompt is empty',
        error: 'EMPTY_PROMPT',
      };
    }
    if (this.modelRequired(adapter) && !model) {
      return {
        ok: false,
        dryRun,
        adapterId: adapter.id,
        target: target.label,
        model: null,
        detail: 'No model could be discovered for this endpoint',
        error: 'NO_MODEL',
      };
    }

    const targetLabel = `${target.label}${model ? ` · ${model}` : ''}`;
    if (dryRun) {
      this.options.logger.info('soft stop: dry-run', {
        adapter: adapter.id,
        target: targetLabel,
        promptLength: vars.prompt.length,
      });
      return {
        ok: true,
        dryRun: true,
        adapterId: adapter.id,
        target: targetLabel,
        model: model || null,
        detail: `dry-run: would send to ${targetLabel}`,
      };
    }

    try {
      if (adapter.kind === 'http' && adapter.http) {
        const base = target.base ?? adapter.http.base;
        const endpoint = this.endpointUrl(base, adapter.http.send.path);
        if (!endpoint.url) {
          throw new Error(endpoint.error ?? 'INVALID_URL');
        }
        const body = renderDeep(adapter.http.send.body, vars);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...adapter.http.send.headers,
          ...this.authHeaders(adapter),
        };
        return await this.postJson(
          adapter,
          endpoint.url,
          body,
          headers,
          adapter.http.timeoutMs ?? 20_000,
          targetLabel,
          model,
          dryRun,
        );
      }

      if (adapter.kind === 'webhook' && adapter.webhook) {
        const base = target.base ?? adapter.webhook.url;
        const endpoint = this.endpointUrl(base, '');
        if (!endpoint.url) throw new Error(endpoint.error ?? 'INVALID_URL');
        const body = renderDeep(adapter.webhook.body, vars);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...adapter.webhook.headers,
        };
        return await this.postJson(
          adapter,
          endpoint.url,
          body,
          headers,
          adapter.webhook.timeoutMs ?? 10_000,
          targetLabel,
          model,
          dryRun,
        );
      }

      if (adapter.kind === 'cli' && adapter.cli) {
        const command = renderTemplate(adapter.cli.command, vars);
        const args = adapter.cli.args.map((arg) => renderTemplate(arg, vars));
        await this.spawnDetached(command, args);
        this.options.logger.info('soft stop: CLI dispatched', {
          adapter: adapter.id,
          command,
          promptLength: vars.prompt.length,
        });
        return {
          ok: true,
          dryRun: false,
          adapterId: adapter.id,
          target: targetLabel,
          model: model || null,
          detail: `spawned ${command}`,
        };
      }
    } catch (error) {
      const detail = safeError(error);
      this.options.logger.warn('soft stop: send failed', { adapter: adapter.id, detail });
      return {
        ok: false,
        dryRun: false,
        adapterId: adapter.id,
        target: targetLabel,
        model: model || null,
        detail,
        error: detail,
      };
    }

    return {
      ok: false,
      dryRun,
      adapterId: adapter.id,
      target: target.label,
      model: model || null,
      detail: 'Unsupported adapter',
      error: 'UNSUPPORTED_ADAPTER',
    };
  }

  private async postJson(
    adapter: SoftStopAdapter,
    url: URL,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs: number,
    targetLabel: string,
    model: string,
    dryRun: boolean,
  ): Promise<SoftStopSendResult> {
    const timeout = Math.min(120_000, Math.max(1000, Math.round(timeoutMs)));
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    if (!response.ok) {
      this.options.logger.warn('soft stop: endpoint rejected prompt', {
        adapter: adapter.id,
        status: response.status,
      });
      return {
        ok: false,
        dryRun,
        adapterId: adapter.id,
        target: targetLabel,
        model: model || null,
        detail: `HTTP ${response.status}`,
        status: response.status,
        error: `HTTP_${response.status}`,
      };
    }
    this.options.logger.info('soft stop: prompt delivered', {
      adapter: adapter.id,
      status: response.status,
      responseBytes: Math.min(text.length, 1_000_000),
    });
    return {
      ok: true,
      dryRun: false,
      adapterId: adapter.id,
      target: targetLabel,
      model: model || null,
      detail: `HTTP ${response.status}`,
      status: response.status,
    };
  }

  private spawnDetached(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(command, args, {
        cwd: homedir(),
        detached: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('SPAWN_TIMEOUT'));
      }, 5000);
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.unref();
        resolve();
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}
