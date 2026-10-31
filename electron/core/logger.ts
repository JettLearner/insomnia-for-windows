import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_BYTES = 1024 * 1024;

/**
 * Small synchronous file logger. Intentionally dependency-free and
 * conservative: it never logs tokens, message bodies, or file paths beyond
 * the app's own data directory.
 */
export class Logger {
  private readonly file: string;

  constructor(dir: string, name = 'insomniaz.log') {
    this.file = join(dir, name);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* logging must never break the app */
    }
  }

  get path(): string {
    return this.file;
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size < MAX_BYTES) return;
      const old = `${this.file}.old`;
      if (existsSync(old)) unlinkSync(old);
      renameSync(this.file, old);
    } catch {
      /* ignore */
    }
  }

  log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    const detail = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
    const line = `${new Date().toISOString()} [${level}] ${message}${detail}`;
    if (level === 'debug') {
      if (process.env.NODE_ENV !== 'development') return;
      console.debug(line);
    } else if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
    try {
      this.rotateIfNeeded();
      appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      /* ignore disk errors */
    }
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log('warn', message, extra);
  }

  error(message: string, error?: unknown): void {
    const detail =
      error instanceof Error
        ? { message: error.message, code: (error as NodeJS.ErrnoException).code }
        : error !== undefined
          ? { message: String(error) }
          : undefined;
    this.log('error', message, detail);
  }

  tail(maxLines = 200): string {
    try {
      if (!existsSync(this.file)) return '';
      // Files are small (1 MB cap); reading them whole is fine.
      const lines = readFileSync(this.file, 'utf8').split(/\r?\n/);
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '';
    }
  }
}
