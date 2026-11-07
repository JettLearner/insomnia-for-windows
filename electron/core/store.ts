import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, type SessionState } from '../../shared/types';
import { sanitizeSession, sanitizeSettings } from '../../shared/settings';
import type { Logger } from './logger';

export function writeAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, 'utf8');
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

export function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export class SettingsStore {
  private value: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  load(): Settings {
    const raw = readJson(this.file);
    if (raw === undefined) {
      this.value = { ...DEFAULT_SETTINGS };
      return this.value;
    }
    const before = JSON.stringify(raw);
    this.value = sanitizeSettings(raw);
    if (before !== JSON.stringify(this.value)) {
      this.log.info('settings were normalized');
      this.persist();
    }
    return this.value;
  }

  get(): Settings {
    return this.value;
  }

  update(patch: SettingsPatch): Settings {
    const candidate = sanitizeSettings({ ...this.value, ...patch });
    this.value = candidate;
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.log.error('settings listener failed', error);
      }
    }
    return this.value;
  }

  replace(next: Settings): Settings {
    return this.update(next);
  }

  reset(): Settings {
    this.value = { ...DEFAULT_SETTINGS };
    this.persist();
    for (const listener of this.listeners) listener();
    return this.value;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  persist(): void {
    try {
      writeAtomic(this.file, `${JSON.stringify(this.value, null, 2)}\n`);
    } catch (error) {
      this.log.error('could not write settings', error);
    }
  }
}

interface PersistedSession {
  version: 1;
  savedAt: number;
  session: SessionState;
}

export class SessionStore {
  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  load(): SessionState | null {
    const raw = readJson(this.file) as Partial<PersistedSession> | undefined;
    if (!raw || raw.session === undefined) return null;
    const session = sanitizeSession(raw.session);
    if (!session) {
      this.clear();
      return null;
    }
    return session;
  }

  save(session: SessionState): void {
    if (!session.active) {
      this.clear();
      return;
    }
    try {
      const payload: PersistedSession = { version: 1, savedAt: Date.now(), session };
      writeAtomic(this.file, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      this.log.error('could not persist session', error);
    }
  }

  clear(): void {
    try {
      if (existsSync(this.file)) rmSync(this.file, { force: true });
    } catch (error) {
      this.log.error('could not clear session file', error);
    }
  }
}

export interface LidRecoveryRecord {
  version: string;
  scheme: string;
  ac: number;
  dc: number;
  appliedAt: string;
  pid: number;
}

/** Reads the helper's recovery sidecar without ever writing it from Node. */
export function hasLidRecovery(file: string): boolean {
  return existsSync(file);
}

export function readLidRecovery(file: string): LidRecoveryRecord | null {
  const raw = readJson(file) as Partial<LidRecoveryRecord> | undefined;
  if (!raw || typeof raw.scheme !== 'string') return null;
  return {
    version: typeof raw.version === 'string' ? raw.version : 'unknown',
    scheme: raw.scheme,
    ac: typeof raw.ac === 'number' ? raw.ac : -1,
    dc: typeof raw.dc === 'number' ? raw.dc : -1,
    appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : '',
    pid: typeof raw.pid === 'number' ? raw.pid : 0,
  };
}
