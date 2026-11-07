import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AUTOPILOT_SETTINGS,
  mergeCatalog,
  sanitizeAutopilotSettings,
  sanitizeJobs,
  type AutopilotJob,
  type AutopilotRun,
  type AutopilotSettings,
  type ModelCatalogEntry,
} from '../../shared/autopilot';
import { AutosaveController } from './autosave';
import type { Logger } from './logger';
import { readJson, writeAtomic } from './store';

export const AUTOPILOT_MAX_RUNS = 500;

interface JobsFile {
  version: 1;
  savedAt: string;
  jobs: AutopilotJob[];
}

interface RunsFile {
  version: 1;
  savedAt: string;
  runs: AutopilotRun[];
  /** Runs that were still `running` when the process died. */
  interrupted?: string[];
}

interface CatalogFile {
  version: 1;
  savedAt: string;
  entries: ModelCatalogEntry[];
  conversations: Record<string, string[]>;
}

export interface AutopilotStoreOptions {
  dir: string;
  log: Logger;
  /** 0..1 machine load estimate used to stretch autosave intervals. */
  load?: () => number;
  autosaveBaseMs?: number;
  autosaveMaxMs?: number;
  maxRuns?: number;
}

/**
 * Owns all Autopilot persistence. Jobs and settings are written immediately
 * (they are low-frequency and never acceptable to lose); run timelines are
 * coalesced through AutosaveController and force-flushed on terminal states.
 */
export class AutopilotStore {
  private readonly jobsFile: string;
  private readonly settingsFile: string;
  private readonly runsFile: string;
  private readonly catalogFile: string;
  private readonly maxRuns: number;
  private jobs: AutopilotJob[] = [];
  private settings: AutopilotSettings = DEFAULT_AUTOPILOT_SETTINGS;
  private runs: AutopilotRun[] = [];
  private catalog: ModelCatalogEntry[] = [];
  private conversations: Record<string, string[]> = {};
  private readonly autosave: AutosaveController;

  constructor(private readonly options: AutopilotStoreOptions) {
    this.jobsFile = join(options.dir, 'autopilot-jobs.json');
    this.settingsFile = join(options.dir, 'autopilot-settings.json');
    this.runsFile = join(options.dir, 'autopilot-runs.json');
    this.catalogFile = join(options.dir, 'autopilot-catalog.json');
    this.maxRuns = Math.max(50, options.maxRuns ?? AUTOPILOT_MAX_RUNS);
    this.autosave = new AutosaveController({
      baseIntervalMs: options.autosaveBaseMs,
      maxIntervalMs: options.autosaveMaxMs,
      load: options.load ?? (() => 0),
      write: () => this.persistRuns(),
      log: options.log,
    });
    this.autosave.start();
  }

  load(): void {
    const jobsRaw = this.read('jobs', this.jobsFile);
    if (jobsRaw === undefined) {
      this.jobs = [];
    } else {
      const parsed = jobsRaw as Partial<JobsFile> | undefined;
      const list = Array.isArray(parsed?.jobs) ? parsed.jobs : Array.isArray(jobsRaw) ? jobsRaw : [];
      this.jobs = sanitizeJobs(list);
    }

    const settingsRaw = this.read('settings', this.settingsFile);
    this.settings = sanitizeAutopilotSettings(settingsRaw);

    const runsRaw = this.read('runs', this.runsFile);
    const runsParsed = runsRaw as Partial<RunsFile> | undefined;
    const runsList = Array.isArray(runsParsed?.runs) ? runsParsed.runs : [];
    this.runs = runsList.filter(isRun).slice(-this.maxRuns);
    let recovered = false;
    for (const run of this.runs) {
      if (run.state === 'running') {
        run.state = 'interrupted';
        run.endedAt = run.endedAt ?? new Date().toISOString();
        recovered = true;
      }
    }
    if (recovered) this.persistRuns();

    const catalogRaw = this.read('catalog', this.catalogFile);
    const catalogParsed = catalogRaw as Partial<CatalogFile> | undefined;
    this.catalog = sanitizeCatalog(catalogParsed?.entries);
    this.conversations = sanitizeConversations(catalogParsed?.conversations);
  }

  private read(label: string, file: string): unknown {
    if (!existsSync(file)) return undefined;
    const raw = readJson(file);
    if (raw !== undefined) return raw;
    // Preserve the damaged file instead of silently dropping user data.
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, backup);
      this.options.log.warn(`autopilot ${label} file was corrupt; kept a copy`, { backup });
    } catch (error) {
      this.options.log.error(`autopilot ${label} file was corrupt and could not be preserved`, error);
    }
    return undefined;
  }

  // -- jobs -----------------------------------------------------------------

  listJobs(): AutopilotJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  getJob(id: string): AutopilotJob | null {
    const found = this.jobs.find((job) => job.id === id);
    return found ? { ...found } : null;
  }

  upsertJob(job: AutopilotJob): AutopilotJob {
    const index = this.jobs.findIndex((entry) => entry.id === job.id);
    const next: AutopilotJob = { ...job, updatedAt: new Date().toISOString() };
    if (index === -1) this.jobs = [...this.jobs, next];
    else this.jobs = this.jobs.map((entry, i) => (i === index ? next : entry));
    this.persistJobs();
    return { ...next };
  }

  deleteJob(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    if (this.jobs.length === before) return false;
    this.persistJobs();
    return true;
  }

  patchJob(id: string, patch: Partial<AutopilotJob>): AutopilotJob | null {
    const existing = this.jobs.find((job) => job.id === id);
    if (!existing) return null;
    const next: AutopilotJob = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
    this.jobs = this.jobs.map((job) => (job.id === id ? next : job));
    this.persistJobs();
    return { ...next };
  }

  // -- settings -------------------------------------------------------------

  getSettings(): AutopilotSettings {
    return this.settings;
  }

  updateSettings(patch: Partial<AutopilotSettings>): AutopilotSettings {
    this.settings = sanitizeAutopilotSettings({ ...this.settings, ...patch });
    try {
      writeAtomic(this.settingsFile, `${JSON.stringify(this.settings, null, 2)}\n`);
    } catch (error) {
      this.options.log.error('could not write autopilot settings', error);
    }
    return this.settings;
  }

  // -- catalog & conversations ------------------------------------------------

  listCatalog(): ModelCatalogEntry[] {
    return this.catalog.map((entry) => ({ ...entry }));
  }

  /** Merges observed entries in; returns how many were new or upgraded. */
  observeCatalog(entries: readonly ModelCatalogEntry[]): number {
    const before = this.catalog.length;
    this.catalog = mergeCatalog([...this.catalog, ...sanitizeCatalog(entries)]);
    this.persistCatalog();
    return this.catalog.length - before;
  }

  listConversations(): Record<string, string[]> {
    return { ...this.conversations };
  }

  observeConversations(target: string, names: readonly string[]): void {
    const clean = names
      .map((name) => String(name).trim())
      .filter((name) => name.length > 0 && name.length <= 200)
      .slice(0, 200);
    this.conversations = { ...this.conversations, [target]: clean };
    this.persistCatalog();
  }

  private persistCatalog(): void {
    const payload: CatalogFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      entries: this.catalog,
      conversations: this.conversations,
    };
    try {
      writeAtomic(this.catalogFile, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      this.options.log.error('could not write autopilot catalog', error);
    }
  }

  // -- runs -----------------------------------------------------------------

  listRuns(limit = 100): AutopilotRun[] {
    return this.runs.slice(-Math.max(1, limit)).reverse().map(cloneRun);
  }

  getRun(id: string): AutopilotRun | null {
    const found = this.runs.find((run) => run.id === id);
    return found ? cloneRun(found) : null;
  }

  recordRun(run: AutopilotRun): void {
    this.runs = [...this.runs.filter((entry) => entry.id !== run.id), cloneRun(run)].slice(-this.maxRuns);
    this.autosave.markDirty();
  }

  patchRun(id: string, patch: Partial<AutopilotRun>, options: { flush?: boolean } = {}): AutopilotRun | null {
    const index = this.runs.findIndex((run) => run.id === id);
    if (index === -1) return null;
    const next: AutopilotRun = { ...this.runs[index], ...patch, id };
    this.runs = this.runs.map((run, i) => (i === index ? next : run));
    if (options.flush) this.autosave.flushNow();
    else this.autosave.markDirty();
    return cloneRun(next);
  }

  /** Marks runs as interrupted (used when an execution heartbeat goes stale). */
  markInterrupted(id: string): void {
    const run = this.runs.find((entry) => entry.id === id);
    if (!run || run.state !== 'running') return;
    this.patchRun(id, { state: 'interrupted', endedAt: new Date().toISOString() }, { flush: true });
  }

  clearRuns(): void {
    this.runs = [];
    this.persistRuns();
  }

  flush(): void {
    this.autosave.flushNow();
  }

  dispose(): void {
    this.autosave.flushNow();
    this.autosave.stop();
  }

  private persistJobs(): void {
    const payload: JobsFile = { version: 1, savedAt: new Date().toISOString(), jobs: this.jobs };
    try {
      writeAtomic(this.jobsFile, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      this.options.log.error('could not write autopilot jobs', error);
    }
  }

  private persistRuns(): void {
    const payload: RunsFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      runs: this.runs,
      interrupted: this.runs.filter((run) => run.state === 'interrupted').map((run) => run.id),
    };
    try {
      writeAtomic(this.runsFile, `${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.options.log.error('could not write autopilot runs', error);
      throw error;
    }
  }
}

const CATALOG_SOURCES = ['seed', 'observed', 'remote'] as const;

function sanitizeCatalog(raw: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelCatalogEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const source = CATALOG_SOURCES.includes(entry.source as (typeof CATALOG_SOURCES)[number])
      ? (entry.source as ModelCatalogEntry['source'])
      : 'observed';
    if (!name) continue;
    out.push({
      provider: provider || 'unknown',
      name,
      source,
      ...(Array.isArray(entry.aliases)
        ? { aliases: entry.aliases.filter((v): v is string => typeof v === 'string') }
        : {}),
      ...(typeof entry.contextWindow === 'number' ? { contextWindow: entry.contextWindow } : {}),
      ...(typeof entry.vision === 'boolean' ? { vision: entry.vision } : {}),
      ...(typeof entry.observedAt === 'string' ? { observedAt: entry.observedAt } : {}),
    });
  }
  return out;
}

function sanitizeConversations(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.filter((item): item is string => typeof item === 'string').slice(0, 200);
  }
  return out;
}

function cloneRun(run: AutopilotRun): AutopilotRun {
  return { ...run, steps: run.steps.map((step) => ({ ...step })) };
}

function isRun(value: unknown): value is AutopilotRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === 'string' && typeof run.jobId === 'string' && Array.isArray(run.steps);
}
