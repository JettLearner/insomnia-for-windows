import { existsSync, readFileSync, statSync } from 'node:fs';
import type { AutopilotErrorCode, AutopilotRoute } from '../../shared/autopilot';
import type { DeliveryRequest, DeliveryResult, TargetAdapter } from './autopilot-engine';
import type { Logger } from './logger';

const TEXT_EXT =
  /\.(md|txt|json|jsonl|csv|tsv|log|xml|ya?ml|ini|toml|env|ps1|sh|bat|py|js|mjs|cjs|ts|tsx|jsx|css|html|c|h|cpp|hpp|cs|go|rs|java|kt|sql|ipynb|docx?|xlsx?|pptx?)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_INLINE_BYTES = 200_000;
const MAX_IMAGE_BYTES = 8_000_000;

interface Channel {
  kind: 'ollama' | 'api';
  url: string;
  model: string;
  key?: string;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
  /** Ollama-specific; ignored by the OpenAI-compatible branch. */
  images?: string[];
}

export interface FallbackOptions {
  log: Logger;
  /** DPAPI-backed emergency key; never logged and never returned to the renderer. */
  apiKey: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Last-resort delivery: loopback Ollama first, then the operator's emergency
 * OpenAI-compatible endpoint. Neither reaches the target app, so the prompt is
 * answered by a different model; the run timeline records which one.
 */
export class FallbackAdapter implements TargetAdapter {
  readonly id = 'fallback';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: FallbackOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const fallback = request.settings.fallback;
    const channels = this.channels(fallback, request);
    if (!channels.length) {
      const missingKey = fallback.remoteEnabled && !this.options.apiKey();
      const code: AutopilotErrorCode = missingKey ? 'FALLBACK_NO_KEY' : 'FALLBACK_UNCONFIGURED';
      request.onStep({ step: 'fallback', ok: false, code, ms: 0, detail: 'no channel' });
      return {
        ok: false,
        code,
        message: missingKey
          ? 'the emergency api is enabled but no key is stored'
          : 'neither ollama nor remote api is enabled',
      };
    }

    const message = this.buildMessage(request);
    let lastCode: AutopilotErrorCode = 'FALLBACK_UNCONFIGURED';
    let lastMessage = 'no channel attempted';

    for (const channel of channels) {
      if (request.shouldCancel()) {
        return { ok: false, code: 'UNEXPECTED_EXCEPTION', message: 'cancelled', fatal: true };
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const started = Date.now();
        const outcome = await this.attempt(channel, message, request);
        const ms = Date.now() - started;
        if (outcome.ok) {
          request.onStep({
            step: 'fallback',
            ok: true,
            ms,
            detail: `${channel.kind}:${channel.model}`,
          });
          return { ok: true, route: channel.kind === 'ollama' ? 'fallback-ollama' : 'fallback-api' };
        }
        lastCode = outcome.code;
        lastMessage = outcome.message;
        request.onStep({ step: 'fallback', ok: false, code: outcome.code, ms, detail: `${channel.kind}#${attempt}` });
        if (!outcome.retryable) break;
        if (attempt < 3) await this.sleep(500 * attempt * attempt);
      }
    }

    return { ok: false, code: lastCode, message: lastMessage };
  }

  /** The GUI route already retried; the fallback keeps the reply, not the thread. */
  private channels(
    settings: { ollamaEnabled: boolean; ollamaBaseUrl: string; ollamaModel: string; remoteEnabled: boolean; baseUrl: string; model: string },
    request: DeliveryRequest,
  ): Channel[] {
    const out: Channel[] = [];
    if (settings.ollamaEnabled && settings.ollamaBaseUrl) {
      out.push({
        kind: 'ollama',
        url: joinUrl(settings.ollamaBaseUrl, '/api/chat'),
        model: settings.ollamaModel || request.job.model?.name || 'llama3.1',
      });
    }
    if (settings.remoteEnabled && settings.baseUrl) {
      const key = this.options.apiKey();
      if (key) {
        out.push({
          kind: 'api',
          url: joinUrl(settings.baseUrl, '/chat/completions'),
          model: settings.model || request.job.model?.name || 'gpt-4o-mini',
          key,
        });
      }
    }
    return out;
  }

  private buildMessage(request: DeliveryRequest): ChatMessage {
    const parts: string[] = [request.prompt];
    const images: string[] = [];
    const inlineLimit = Math.min(MAX_INLINE_BYTES, request.settings.maxAttachmentBytes);
    for (const attachment of request.attachments) {
      const path = attachment.usePath;
      if (!path || !existsSync(path)) continue;
      const size = statSync(path).size;
      if (IMAGE_EXT.test(path)) {
        if (size <= MAX_IMAGE_BYTES) images.push(readFileSync(path).toString('base64'));
        continue;
      }
      if (!TEXT_EXT.test(path) || size > inlineLimit) continue;
      try {
        const body = readFileSync(path, 'utf8');
        parts.push(`\n\n--- ${attachment.displayName} ---\n${body}`);
      } catch (error) {
        this.options.log.warn('fallback could not read attachment', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const message: ChatMessage = { role: 'user', content: parts.join('') };
    if (images.length) message.images = images;
    return message;
  }

  private async attempt(
    channel: Channel,
    message: ChatMessage,
    request: DeliveryRequest,
  ): Promise<{ ok: true } | { ok: false; code: AutopilotErrorCode; message: string; retryable: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(channel.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(channel.key ? { authorization: `Bearer ${channel.key}` } : {}),
        },
        body: JSON.stringify({
          model: channel.model,
          stream: false,
          ...(channel.kind === 'ollama'
            ? { messages: [message], options: ollamaOptions(request) }
            : { messages: [openAiMessage(message)], temperature: temperature(request) }),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        // Bodies can echo the prompt; only the status is kept.
        return {
          ok: false,
          code: response.status === 429 ? 'RATE_LIMITED' : 'FALLBACK_HTTP_ERROR',
          message: `${channel.kind} responded ${response.status}`,
          retryable,
        };
      }

      const payload = (await response.json().catch(() => null)) as
        | { message?: { content?: string }; choices?: Array<{ message?: { content?: string } }> }
        | null;
      const reply = channel.kind === 'ollama' ? payload?.message?.content : payload?.choices?.[0]?.message?.content;
      if (!reply || reply.trim().length === 0) {
        return { ok: false, code: 'FALLBACK_EMPTY_REPLY', message: `${channel.kind} returned no text`, retryable: true };
      }
      return { ok: true };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        code: aborted ? 'NETWORK_DOWN' : 'FALLBACK_HTTP_ERROR',
        message: aborted ? `${channel.kind} timed out after ${this.timeoutMs}ms` : 'fallback request failed',
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function openAiMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role, content: message.content };
}

function temperature(request: DeliveryRequest): number {
  const value = request.job.model?.params?.temperature;
  return typeof value === 'number' ? value : 0.7;
}

function ollamaOptions(request: DeliveryRequest): Record<string, number> {
  const params = request.job.model?.params ?? {};
  const options: Record<string, number> = { temperature: temperature(request) };
  if (typeof params.topP === 'number') options.top_p = params.topP;
  if (typeof params.maxTokens === 'number') options.num_predict = Math.round(params.maxTokens);
  return options;
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`;
}

/** Route used when a job is configured to skip the GUI entirely. */
export function fallbackRoute(channel: 'ollama' | 'api'): AutopilotRoute {
  return channel === 'ollama' ? 'fallback-ollama' : 'fallback-api';
}
