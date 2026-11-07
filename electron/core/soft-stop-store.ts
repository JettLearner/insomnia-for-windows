import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import {
  EMPTY_SOFT_STOP_CYCLE,
  sanitizeSoftStopCycle,
  type SoftStopAuditEntry,
  type SoftStopCycle,
} from '../../shared/soft-stop';
import type { Logger } from './logger';

const AUDIT_LIMIT = 200;
const AUDIT_FILE_LIMIT = 120;

function writeAtomic(file: string, contents: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) });
  try {
    renameSync(tmp, file);
  } catch {
    copyFileSync(tmp, file);
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export class SoftStopAuditStore {
  private entries: SoftStopAuditEntry[] = [];
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJson(this.file);
    if (!Array.isArray(raw)) return;
    this.entries = raw
      .filter((entry): entry is SoftStopAuditEntry => {
        if (!entry || typeof entry !== 'object') return false;
        const item = entry as Record<string, unknown>;
        return (
          typeof item.ts === 'number' &&
          typeof item.action === 'string' &&
          typeof item.target === 'string' &&
          (item.result === 'ok' || item.result === 'failed' || item.result === 'info') &&
          typeof item.detail === 'string'
        );
      })
      .map((entry) => ({
        ts: entry.ts,
        action: entry.action,
        target: entry.target.slice(0, 200),
        result: entry.result,
        detail: entry.detail.slice(0, 300),
      }))
      .slice(-AUDIT_FILE_LIMIT);
  }

  append(entry: SoftStopAuditEntry): void {
    this.load();
    this.entries.push({
      ...entry,
      target: entry.target.slice(0, 200),
      detail: entry.detail.slice(0, 300),
    });
    if (this.entries.length > AUDIT_LIMIT) this.entries = this.entries.slice(-AUDIT_LIMIT);
    try {
      writeAtomic(this.file, `${JSON.stringify(this.entries, null, 2)}\n`);
    } catch (error) {
      this.log.warn('could not persist soft stop audit', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  list(limit = 50): SoftStopAuditEntry[] {
    this.load();
    return this.entries.slice(-Math.max(1, Math.min(AUDIT_LIMIT, limit))).reverse();
  }

  clear(): void {
    this.entries = [];
    this.loaded = true;
    try {
      if (existsSync(this.file)) rmSync(this.file, { force: true });
    } catch (error) {
      this.log.warn('could not clear soft stop audit', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

interface SecretFile {
  version: 1;
  httpKey: string;
}

export class SoftStopSecretStore {
  private key: string | null = null;
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJson(this.file) as Partial<SecretFile> | undefined;
    if (!raw || typeof raw.httpKey !== 'string' || !raw.httpKey) return;
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      this.key = safeStorage.decryptString(Buffer.from(raw.httpKey, 'base64'));
    } catch {
      this.log.warn('could not decrypt stored soft stop key; clearing it');
      this.key = null;
      try {
        rmSync(this.file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  getKey(): string | null {
    this.load();
    return this.key;
  }

  hasKey(): boolean {
    return this.getKey() !== null;
  }

  setKey(key: string | null): { ok: boolean; error?: string } {
    this.loaded = true;
    if (key === null || key.trim() === '') {
      this.key = null;
      try {
        if (existsSync(this.file)) rmSync(this.file, { force: true });
      } catch {
        /* ignore */
      }
      return { ok: true };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'KEY_STORE_UNAVAILABLE' };
    }
    try {
      this.key = key;
      const encrypted = safeStorage.encryptString(key).toString('base64');
      writeAtomic(
        this.file,
        `${JSON.stringify({ version: 1, httpKey: encrypted } satisfies SecretFile, null, 2)}\n`,
        0o600,
      );
      return { ok: true };
    } catch (error) {
      this.key = null;
      this.log.warn('could not store soft stop key', {
        message: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, error: 'KEY_STORE_FAILED' };
    }
  }
}

interface CycleFile {
  version: 1;
  cycle: SoftStopCycle;
}

export class SoftStopCycleStore {
  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  load(sessionStartedAt: number | null): SoftStopCycle {
    const raw = readJson(this.file) as Partial<CycleFile> | undefined;
    if (!raw || !raw.cycle) return { ...EMPTY_SOFT_STOP_CYCLE };
    return sanitizeSoftStopCycle(raw.cycle, sessionStartedAt);
  }

  save(cycle: SoftStopCycle): void {
    if (cycle.cycleStartedAt === null) {
      this.clear();
      return;
    }
    try {
      writeAtomic(this.file, `${JSON.stringify({ version: 1, cycle } satisfies CycleFile, null, 2)}\n`);
    } catch (error) {
      this.log.warn('could not persist soft stop cycle', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  clear(): void {
    try {
      if (existsSync(this.file)) rmSync(this.file, { force: true });
    } catch (error) {
      this.log.warn('could not clear soft stop cycle', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
