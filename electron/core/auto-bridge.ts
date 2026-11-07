import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import type { Logger } from './logger';

export class AutoBridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'AutoBridgeError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AutoBridgeOptions {
  /** Path to InsomniaZAuto.exe (or an executable stub in tests). */
  executable: string;
  /** Extra argv entries placed before the bridge's own flags. */
  extraArgs?: string[];
  /** Helper log path; the helper appends its own errors there. */
  logPath: string;
  parentPid?: number;
  defaultTimeoutMs?: number;
  log: Logger;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RawResponse {
  id: string | number | null;
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

/**
 * Line-delimited JSON transport for the non-elevated automation helper.
 * The child is spawned lazily and restarted on demand; every request fails
 * with AUTO_HELPER_DEAD rather than hanging when the process disappears.
 */
export class AutoBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly token = randomBytes(24).toString('hex');
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: AutoBridgeOptions) {}

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.disposed;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this.disposed) throw new AutoBridgeError('AUTO_HELPER_DEAD', 'bridge disposed', false);
    const child = this.ensureChild();
    const id = this.nextId++;
    const timeout = Math.max(500, timeoutMs ?? this.options.defaultTimeoutMs ?? 20_000);
    const payload = JSON.stringify({ id, cmd, token: this.token, args });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AutoBridgeError('TIMEOUT', `${cmd} timed out after ${timeout}ms`, true));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        child.stdin.write(`${payload}\n`, 'utf8');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AutoBridgeError('AUTO_HELPER_DEAD', error instanceof Error ? error.message : String(error), true));
      }
    });
  }

  restart(): void {
    this.stopChild(new AutoBridgeError('AUTO_HELPER_DEAD', 'restarted', true));
  }

  dispose(): void {
    this.disposed = true;
    this.stopChild(new AutoBridgeError('AUTO_HELPER_DEAD', 'bridge disposed', false));
  }

  private stopChild(error: Error): void {
    const child = this.child;
    this.child = null;
    this.reader?.close();
    this.reader = null;
    this.failPending(error);
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const args = [
      ...(this.options.extraArgs ?? []),
      '--token',
      this.token,
      '--parent-pid',
      String(this.options.parentPid ?? process.pid),
      '--log',
      this.options.logPath,
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.executable, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new AutoBridgeError(
        'AUTO_HELPER_DEAD',
        `failed to spawn helper: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    this.child = child;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.options.log.warn('auto helper stderr', { line: text.slice(0, 400) });
    });
    child.on('error', (error) => {
      this.options.log.warn('auto helper spawn failed', { message: error.message });
      if (this.child === child) {
        this.child = null;
        this.reader?.close();
        this.reader = null;
      }
      this.failPending(new AutoBridgeError('AUTO_HELPER_DEAD', error.message, true));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.reader?.close();
        this.reader = null;
        this.failPending(
          new AutoBridgeError('AUTO_HELPER_DEAD', `helper exited (code=${code}, signal=${signal ?? '-'})`, true),
        );
      }
    });
    return child;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let response: RawResponse;
    try {
      response = JSON.parse(trimmed) as RawResponse;
    } catch {
      this.options.log.warn('auto helper emitted non-JSON output', { line: trimmed.slice(0, 200) });
      return;
    }
    if (response.id === null || response.id === undefined) return;
    const id = Number(response.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.data);
      return;
    }
    const error = response.error ?? {};
    pending.reject(
      new AutoBridgeError(
        typeof error.code === 'string' ? error.code : 'UNEXPECTED_EXCEPTION',
        typeof error.message === 'string' ? error.message : 'helper call failed',
        error.retryable !== false,
      ),
    );
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
