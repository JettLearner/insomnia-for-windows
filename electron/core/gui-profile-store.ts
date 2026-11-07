import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { matchGuiProfile, normalizeGuiProfile } from '../../shared/gui';
import type { GuiProfile } from '../../shared/soft-stop';
import type { Logger } from './logger';

const PROFILE_LIMIT = 100;

function writeAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { encoding: 'utf8' });
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

export class GuiProfileStore {
  private profiles: GuiProfile[] = [];
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return;
      this.profiles = raw
        .map(normalizeGuiProfile)
        .filter((profile): profile is GuiProfile => profile !== null)
        .slice(-PROFILE_LIMIT);
    } catch (error) {
      this.log.warn('could not read GUI profiles', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persist(): void {
    try {
      writeAtomic(this.file, `${JSON.stringify(this.profiles, null, 2)}\n`);
    } catch (error) {
      this.log.warn('could not persist GUI profiles', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  list(): GuiProfile[] {
    this.load();
    return [...this.profiles].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  findForWindow(processName: string, title: string): GuiProfile | null {
    this.load();
    return matchGuiProfile(this.profiles, processName, title);
  }

  save(raw: unknown): GuiProfile | null {
    this.load();
    const profile = normalizeGuiProfile(raw);
    if (!profile) return null;
    profile.updatedAt = Date.now();
    const index = this.profiles.findIndex((entry) => entry.id === profile.id);
    if (index >= 0) this.profiles[index] = profile;
    else this.profiles.push(profile);
    if (this.profiles.length > PROFILE_LIMIT) this.profiles = this.profiles.slice(-PROFILE_LIMIT);
    this.persist();
    return profile;
  }

  delete(id: string): boolean {
    this.load();
    const next = this.profiles.filter((profile) => profile.id !== id);
    if (next.length === this.profiles.length) return false;
    this.profiles = next;
    this.persist();
    return true;
  }

  isConfirmed(processName: string, title: string): boolean {
    return this.findForWindow(processName, title)?.confirmed === true;
  }

  confirm(processName: string, title: string): boolean {
    this.load();
    const profile = this.findForWindow(processName, title);
    if (!profile) return false;
    profile.confirmed = true;
    profile.updatedAt = Date.now();
    this.persist();
    return true;
  }
}
