import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import type { Logger } from './logger';

export interface HelperExecution {
  active: boolean;
  system: boolean;
  display: boolean;
}

export interface HelperBattery {
  available: boolean;
  ac?: boolean;
  present?: boolean;
  percent?: number | null;
  charging?: boolean;
}

export interface HelperStatus {
  version?: string;
  elevated?: boolean;
  parentPid?: number;
  helperPid?: number;
  idleMs?: number;
  execution?: HelperExecution;
  lidSupported?: boolean;
  scheme?: string | null;
  lidAc?: number | null;
  lidDc?: number | null;
  lidReadAcError?: number;
  lidReadDcError?: number;
  lidApplied?: boolean;
  recoveryPending?: boolean;
  battery?: HelperBattery;
  [key: string]: unknown;
}

export interface LidData {
  applied?: boolean;
  readable?: boolean;
  scheme?: string | null;
  ac?: number | null;
  dc?: number | null;
  elevated?: boolean;
  originalAc?: number;
  originalDc?: number;
}

export class HelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface HelperClientOptions {
  exePath: string;
  recoveryPath: string;
  logPath: string;
  logger: Logger;
}

type ConnectionDeferred = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const PIPE_PREFIX = '\\\\.\\pipe\\';

/**
 * Owns the named-pipe connection to the C# helper. The helper is the only
 * component that writes protected power settings; Node never does.
 */
export class HelperClient extends EventEmitter {
  private readonly options: HelperClientOptions;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private buffer = '';
  private pipeName = '';
  private token = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private connectionDeferred: ConnectionDeferred | null = null;
  private child: ChildProcess | null = null;
  private elevatedHelper = false;
  private stopped = false;
  private connecting: Promise<HelperStatus> | null = null;
  private lastAttemptAt = 0;
  private status: HelperStatus | null = null;
  private lastError: string | null = null;

  constructor(options: HelperClientOptions) {
    super();
    this.options = options;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get elevated(): boolean {
    return this.elevatedHelper;
  }

  get lastStatus(): HelperStatus | null {
    return this.status;
  }

  get error(): string | null {
    return this.lastError;
  }

  get attemptedAt(): number {
    return this.lastAttemptAt;
  }

  async ensure(): Promise<boolean> {
    if (this.connected) return true;
    if (this.connecting) {
      try {
        await this.connecting;
        return this.connected;
      } catch {
        return false;
      }
    }
    if (Date.now() - this.lastAttemptAt < 4000) return false;
    try {
      await this.start(false);
      return this.connected;
    } catch {
      return false;
    }
  }

  async start(elevated: boolean, timeoutMs = elevated ? 90_000 : 20_000): Promise<HelperStatus> {
    if (this.connected && this.elevatedHelper === elevated) {
      return this.status ?? (await this.refreshStatus());
    }
    if (this.connecting) return this.connecting;

    const task = this.doStart(elevated, timeoutMs).finally(() => {
      this.connecting = null;
    });
    this.connecting = task;
    return task;
  }

  private async doStart(elevated: boolean, timeoutMs: number): Promise<HelperStatus> {
    this.lastAttemptAt = Date.now();
    this.stopped = false;
    await this.stopHelperOnly();
    this.stopped = false;

    if (!this.options.exePath) throw new HelperError('HELPER_MISSING', 'Power helper path is not configured.');

    this.log('info', elevated ? 'starting elevated power helper' : 'starting power helper');
    this.pipeName = `insomniaz-${randomBytes(10).toString('hex')}`;
    this.token = randomBytes(24).toString('hex');
    this.buffer = '';
    this.elevatedHelper = elevated;

    await this.createPipeServer();

    const args = [
      '--pipe',
      this.pipeName,
      '--token',
      this.token,
      '--parent-pid',
      String(process.pid),
      '--recovery',
      this.options.recoveryPath,
      '--log',
      this.options.logPath,
    ];


    if (elevated) {
      this.spawnElevated(args);
    } else {
      this.spawnDirect(args);
    }

    try {
      await this.waitForSocket(timeoutMs);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.stopHelperOnly();
      throw error instanceof HelperError
        ? error
        : new HelperError(elevated ? 'ELEVATION_DENIED' : 'HELPER_TIMEOUT', this.lastError);
    }

    try {
      const hello = (await this.request('hello', {}, 10_000)) as HelperStatus;
      this.status = hello;
      this.elevatedHelper = hello.elevated === true;
      if (elevated && hello.elevated !== true) {
        throw new HelperError('ELEVATION_REQUIRED', 'The helper started without administrator rights.');
      }
      this.lastError = null;
      this.log('info', 'power helper connected', {
        version: hello.version ?? 'unknown',
        elevated: hello.elevated === true,
        lidSupported: hello.lidSupported === true,
      });
      this.emit('connected', hello);
      return hello;
    } catch (error) {
      await this.stopHelperOnly();
      throw error;
    }
  }

  private spawnDirect(args: string[]): void {
    const child = spawn(this.options.exePath, args, {
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
    });
    this.child = child;
    child.on('error', (error) => {
      this.log('error', 'helper process could not start', { message: error.message });
      this.connectionDeferred?.reject(new HelperError('HELPER_START_FAILED', error.message));
    });
    child.on('exit', (code, signal) => {
      this.log('warn', 'helper process exited', { code: code ?? -1, signal: signal ?? '' });
      this.child = null;
      if (!this.stopped && this.connected) this.handleSocketClosed('helper process exited');
    });
  }

  private spawnElevated(args: string[]): ChildProcess {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$exe = ${quote(this.options.exePath)}`,
      `$arguments = @(${args.map(quote).join(', ')})`,
      'Start-Process -FilePath $exe -ArgumentList $arguments -Verb RunAs',
      'exit 0',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    ps.stderr?.setEncoding('utf8');
    ps.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    ps.on('error', (error) => {
      this.log('error', 'could not launch elevation prompt', { message: error.message });
      this.connectionDeferred?.reject(new HelperError('ELEVATION_DENIED', this.lastError ?? error.message));
    });
    ps.on('exit', (code) => {
      if (code === 0) {
        this.log('info', 'elevation prompt accepted');
        return;
      }
      this.log('warn', 'elevation prompt did not complete', { code: code ?? -1 });
      if (!this.connected) {
        this.lastError = stderr.trim() || 'Administrator approval was not granted.';
        this.connectionDeferred?.reject(new HelperError('ELEVATION_DENIED', this.lastError));
      }
    });
    return ps;
  }

  private async createPipeServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      server.once('error', (error) => {
        this.log('error', 'named pipe server failed', { message: error.message });
        reject(new HelperError('PIPE_ERROR', error.message));
      });
      server.listen(`${PIPE_PREFIX}${this.pipeName}`, () => resolve());
      this.server = server;
    });
  }

  private handleConnection(socket: Socket): void {
    if (this.socket) {
      // Only one helper may own the pipe. The random pipe name and token make
      // a stray connection extremely unlikely.
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    this.buffer = '';
    socket.on('data', (chunk: string) => this.handleData(chunk));
    socket.on('error', (error) => {
      this.log('warn', 'helper pipe error', { message: error.message });
    });
    socket.on('close', () => this.handleSocketClosed('pipe closed'));
    this.connectionDeferred?.resolve();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: {
        id?: number;
        ok?: boolean;
        data?: unknown;
        error?: { code?: string; message?: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        this.log('warn', 'helper sent malformed JSON; ignoring');
        continue;
      }
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) {
        this.log('debug', 'helper sent a response with no waiter');
        continue;
      }
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.data);
      } else {
        const code = message.error?.code ?? 'HELPER_ERROR';
        const detail = message.error?.message ?? 'The power helper reported an error.';
        pending.reject(new HelperError(code, detail));
      }
    }
  }

  private handleSocketClosed(reason: string): void {
    const wasConnected = this.socket !== null;
    this.socket = null;
    this.buffer = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HelperError('HELPER_OFFLINE', 'The power helper is offline.'));
    }
    this.pending.clear();
    if (wasConnected && !this.stopped) {
      this.log('warn', 'power helper disconnected', { reason });
      this.lastError = reason;
      this.emit('disconnected', reason);
    }
  }

  private waitForSocket(timeoutMs: number): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionDeferred = null;
        reject(new HelperError('HELPER_TIMEOUT', 'The power helper did not connect in time.'));
      }, timeoutMs);
      this.connectionDeferred = {
        resolve: () => {
          clearTimeout(timer);
          this.connectionDeferred = null;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.connectionDeferred = null;
          reject(error);
        },
        timer,
      };
    });
  }

  async request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new HelperError('HELPER_OFFLINE', 'The power helper is offline.');
    const id = this.nextId++;
    const payload = JSON.stringify({ id, cmd, token: this.token, args });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError('HELPER_TIMEOUT', `The power helper did not answer ${cmd} in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        socket.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HelperError('HELPER_OFFLINE', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  async refreshStatus(): Promise<HelperStatus> {
    const status = (await this.request('status', {}, 8000)) as HelperStatus;
    this.status = status;
    this.elevatedHelper = status.elevated === true;
    return status;
  }

  async setExecution(display: boolean, system: boolean): Promise<void> {
    await this.request('setExecution', { display, system }, 5000);
  }

  async jiggle(): Promise<{ sent: boolean; idleBefore: number; idleAfter: number }> {
    return this.request('jiggle', {}, 5000);
  }

  async applyLid(): Promise<LidData> {
    return this.request('applyLid', {}, 90_000);
  }

  async restoreLid(): Promise<LidData> {
    return this.request('restoreLid', {}, 30_000);
  }

  async recoverLid(): Promise<HelperStatus> {
    const status = (await this.request('recover', {}, 45_000)) as HelperStatus;
    this.status = status;
    return status;
  }

  async restartElevated(): Promise<HelperStatus> {
    await this.shutdownHelper();
    this.stopped = false;
    this.elevatedHelper = false;
    return this.start(true, 90_000);
  }

  /**
   * Gracefully close the helper and wait for it to restore the lid policy.
   * The helper's cleanup is synchronous with process exit, so a short wait is
   * enough for the common case.
   */
  async shutdownHelper(): Promise<void> {
    const hadSocket = this.connected;
    if (hadSocket) {
      try {
        await this.request('shutdown', {}, 2500);
      } catch {
        /* helper may have died already */
      }
    }
    this.closeSocket();
    this.stopped = true;
    if (this.child) {
      const child = this.child;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          resolve();
        }, 1200);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.child = null;
    } else if (hadSocket) {
      // Elevated helpers have no process handle; allow the pipe shutdown and
      // policy restore to finish.
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }

  private async stopHelperOnly(): Promise<void> {
    await this.shutdownHelper();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      const server = this.server;
      this.server = null;
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
      // close() only waits for the listening socket; connections are ours.
      setTimeout(resolve, 300);
    });
    this.status = null;
    this.elevatedHelper = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.stopHelperOnly();
    this.removeAllListeners();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.end();
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.handleSocketClosed('client closed');
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
    if (level === 'error') this.options.logger.error(`[helper] ${message}`, extra?.message ?? extra);
    else this.options.logger.log(level, `[helper] ${message}`, extra);
  }
}
