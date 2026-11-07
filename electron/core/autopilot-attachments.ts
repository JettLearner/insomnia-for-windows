import {
  createHash,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { AutopilotAttachment } from '../../shared/autopilot';
import type { Logger } from './logger';
import { readJson, writeAtomic } from './store';

export interface AttachmentLedgerEntry {
  attachmentId: string;
  jobId: string;
  originalPath: string;
  displayName: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  backupPath: string | null;
  knownPaths: string[];
  updatedAt: string;
}

export interface AttachmentLimits {
  backupEnabled: boolean;
  backupMaxBytes: number;
  maxAttachmentBytes: number;
}

export type AttachmentSource = 'original' | 'restored' | 'missing';

export interface ResolvedAttachment {
  id: string;
  displayName: string;
  originalPath: string;
  /** Path handed to the target application; null when unusable. */
  usePath: string | null;
  source: AttachmentSource;
  backupPath: string | null;
  reason?: 'not_found' | 'too_large' | 'restore_target_unavailable';
  size?: number;
}

export interface AttachmentPreparation {
  items: ResolvedAttachment[];
  /** Prompt with the missing-attachment note appended (unchanged if none). */
  prompt: string;
  note: string;
}

export interface AttachmentServiceOptions {
  /** Autopilot data directory; backups live under `<dir>/attachments`. */
  dir: string;
  log: Logger;
  now?: () => number;
  /** Extra roots used when a file has moved. */
  searchRoots?: string[];
  /** Test seam: overrides the wall-clock budget of a search. */
  searchBudgetMs?: number;
}

interface SearchHit {
  path: string;
  size: number;
  mtimeMs: number;
}

const SYSTEM_SEGMENTS = new Set([
  'windows',
  'windows.old',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  'node_modules',
  '$recycle.bin',
  'system volume information',
]);

/**
 * Resolves attachments before delivery, keeps optional backups, and restores a
 * backup to its original path before the target app reads it.
 *
 * The read path is always the user's original location, never the backup
 * directory — a backup is only a way to bring the original file back.
 */
export class AttachmentService {
  private readonly backupRoot: string;
  private readonly ledgerFile: string;
  private readonly now: () => number;
  private readonly searchBudgetMs: number;
  private ledger = new Map<string, AttachmentLedgerEntry>();

  constructor(private readonly options: AttachmentServiceOptions) {
    this.backupRoot = join(options.dir, 'attachments');
    this.ledgerFile = join(options.dir, 'autopilot-attachments.json');
    this.now = options.now ?? Date.now;
    this.searchBudgetMs = Math.max(200, options.searchBudgetMs ?? 3000);
    this.loadLedger();
  }

  get backupsDirectory(): string {
    return this.backupRoot;
  }

  listLedger(): AttachmentLedgerEntry[] {
    return [...this.ledger.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  entryFor(attachmentId: string): AttachmentLedgerEntry | null {
    const entry = this.ledger.get(attachmentId);
    return entry ? { ...entry, knownPaths: [...entry.knownPaths] } : null;
  }

  prepare(
    jobId: string,
    prompt: string,
    attachments: readonly AutopilotAttachment[],
    limits: AttachmentLimits,
  ): AttachmentPreparation {
    const items = attachments.map((attachment) => this.resolveOne(jobId, attachment, limits));
    const missing = items.filter((item) => item.source === 'missing');
    const note = buildMissingNote(missing);
    return { items, prompt: note ? `${prompt}\n\n${note}` : prompt, note };
  }

  /** Copies the original into the backup store; returns the backup path. */
  ensureBackup(jobId: string, attachment: AutopilotAttachment, limits: AttachmentLimits): string | null {
    if (!limits.backupEnabled || !attachment.backup) return null;
    const existing = this.ledger.get(attachment.id);
    if (existing?.backupPath && existsSync(existing.backupPath)) return existing.backupPath;

    const stat = safeStat(attachment.originalPath);
    if (!stat) return null;
    const hash = hashFile(attachment.originalPath);
    if (!hash) return null;

    this.enforceQuota(limits.backupMaxBytes, stat.size);
    const targetDir = join(this.backupRoot, sanitizeSegment(jobId), sanitizeSegment(attachment.id));
    const fileName = `${hash.slice(0, 8)}-${sanitizeSegment(attachment.displayName)}`;
    const target = join(targetDir, fileName);
    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(attachment.originalPath, target);
      if (!existsSync(target) || statSync(target).size !== stat.size) throw new Error('copy verification failed');
    } catch (error) {
      this.options.log.error('attachment backup failed', error);
      return null;
    }
    this.upsertLedger({
      attachmentId: attachment.id,
      jobId,
      originalPath: attachment.originalPath,
      displayName: attachment.displayName,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: hash,
      backupPath: target,
      knownPaths: [attachment.originalPath],
      updatedAt: new Date(this.now()).toISOString(),
    });
    return target;
  }

  /** Copies a backup back to the original location, which is what delivery reads. */
  restoreBackup(attachmentId: string): { ok: boolean; path?: string; error?: string } {
    const entry = this.ledger.get(attachmentId);
    if (!entry) return { ok: false, error: 'ATTACHMENT_NOT_FOUND' };
    if (!entry.backupPath || !existsSync(entry.backupPath)) return { ok: false, error: 'BACKUP_MISSING' };
    if (existsSync(entry.originalPath) && statSync(entry.originalPath).size === entry.size) {
      return { ok: true, path: entry.originalPath };
    }
    if (!this.restore(entry.backupPath, entry.originalPath)) return { ok: false, error: 'RESTORE_FAILED' };
    entry.updatedAt = new Date(this.now()).toISOString();
    this.persistLedger();
    return { ok: true, path: entry.originalPath };
  }

  deleteBackup(attachmentId: string): boolean {
    const entry = this.ledger.get(attachmentId);
    if (!entry?.backupPath) return false;
    const removed = removeBackupFile(this.backupRoot, entry.backupPath);
    entry.backupPath = null;
    entry.updatedAt = new Date(this.now()).toISOString();
    this.persistLedger();
    return removed;
  }

  deleteAllBackups(): number {
    let removed = 0;
    for (const entry of this.ledger.values()) {
      if (!entry.backupPath) continue;
      if (removeBackupFile(this.backupRoot, entry.backupPath)) removed += 1;
      entry.backupPath = null;
    }
    this.persistLedger();
    return removed;
  }

  /** Deletes backups older than the retention window. */
  cleanupExpired(retentionDays: number): number {
    const cutoff = this.now() - Math.max(1, retentionDays) * 24 * 60 * 60_000;
    let removed = 0;
    for (const entry of this.ledger.values()) {
      if (!entry.backupPath) continue;
      const stat = safeStat(entry.backupPath);
      if (!stat) {
        entry.backupPath = null;
        continue;
      }
      if (stat.mtimeMs < cutoff) {
        if (removeBackupFile(this.backupRoot, entry.backupPath)) removed += 1;
        entry.backupPath = null;
      }
    }
    if (removed) this.persistLedger();
    return removed;
  }

  /** Total bytes currently held under the backup root. */
  backupUsage(): number {
    let total = 0;
    for (const entry of this.ledger.values()) {
      if (!entry.backupPath) continue;
      total += safeStat(entry.backupPath)?.size ?? 0;
    }
    return total;
  }

  // -- internals ------------------------------------------------------------

  private resolveOne(jobId: string, attachment: AutopilotAttachment, limits: AttachmentLimits): ResolvedAttachment {
    const base: ResolvedAttachment = {
      id: attachment.id,
      displayName: attachment.displayName,
      originalPath: attachment.originalPath,
      usePath: null,
      source: 'missing',
      backupPath: null,
    };

    const original = safeStat(attachment.originalPath);
    if (original && attachment.originalPath) {
      if (original.size > limits.maxAttachmentBytes) {
        return { ...base, size: original.size, reason: 'too_large' };
      }
      const backupPath = this.ensureBackup(jobId, attachment, limits);
      this.remember(jobId, attachment, original.size, original.mtimeMs, backupPath);
      return { ...base, usePath: attachment.originalPath, source: 'original', backupPath, size: original.size };
    }

    const backup = this.ledger.get(attachment.id)?.backupPath ?? null;
    const hasBackup = Boolean(backup && existsSync(backup));
    if (hasBackup && this.restore(backup!, attachment.originalPath)) {
      const restored = safeStat(attachment.originalPath);
      if (restored) {
        return {
          ...base,
          usePath: attachment.originalPath,
          source: 'restored',
          backupPath: backup,
          size: restored.size,
        };
      }
    }

    const found = this.search(attachment);
    if (found) {
      if (found.size > limits.maxAttachmentBytes) {
        return { ...base, size: found.size, reason: 'too_large' };
      }
      const backupPath = this.ensureBackupFrom(found.path, jobId, attachment, limits);
      this.upsertKnownPath(attachment.id, found.path);
      this.remember(jobId, attachment, found.size, found.mtimeMs, backupPath);
      return { ...base, usePath: found.path, source: 'original', backupPath, size: found.size };
    }

    if (hasBackup) return { ...base, backupPath: backup, reason: 'restore_target_unavailable' };
    return { ...base, reason: 'not_found' };
  }

  private ensureBackupFrom(
    sourcePath: string,
    jobId: string,
    attachment: AutopilotAttachment,
    limits: AttachmentLimits,
  ): string | null {
    if (!limits.backupEnabled || !attachment.backup) return null;
    const existing = this.ledger.get(attachment.id);
    if (existing?.backupPath && existsSync(existing.backupPath)) return existing.backupPath;
    const stat = safeStat(sourcePath);
    if (!stat) return null;
    const hash = hashFile(sourcePath);
    if (!hash) return null;
    this.enforceQuota(limits.backupMaxBytes, stat.size);
    const targetDir = join(this.backupRoot, sanitizeSegment(jobId), sanitizeSegment(attachment.id));
    const target = join(targetDir, `${hash.slice(0, 8)}-${sanitizeSegment(attachment.displayName)}`);
    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(sourcePath, target);
      if (!existsSync(target) || statSync(target).size !== stat.size) throw new Error('copy verification failed');
    } catch (error) {
      this.options.log.error('attachment backup failed', error);
      return null;
    }
    this.upsertLedger({
      attachmentId: attachment.id,
      jobId,
      originalPath: attachment.originalPath,
      displayName: attachment.displayName,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: hash,
      backupPath: target,
      knownPaths: [attachment.originalPath, sourcePath],
      updatedAt: new Date(this.now()).toISOString(),
    });
    return target;
  }

  private restore(backupPath: string, originalPath: string): boolean {
    try {
      const parent = dirname(originalPath);
      mkdirSync(parent, { recursive: true });
      copyFileSync(backupPath, originalPath);
      return existsSync(originalPath) && statSync(originalPath).size === statSync(backupPath).size;
    } catch (error) {
      this.options.log.error('attachment restore failed', error);
      return false;
    }
  }

  private search(attachment: AutopilotAttachment): SearchHit | null {
    const targetName = attachment.displayName.toLowerCase();
    if (!targetName) return null;
    const entry = this.ledger.get(attachment.id);
    const expectedSize = entry?.size ?? null;
    const started = this.now();
    const roots = this.searchRoots(attachment);
    const seen = new Set<string>();
    let visited = 0;
    const queue: Array<{ dir: string; depth: number }> = roots.map((root) => ({ dir: root, depth: 0 }));
    const hits: SearchHit[] = [];

    while (queue.length) {
      if (visited > 50_000 || this.now() - started > this.searchBudgetMs) break;
      const { dir, depth } = queue.shift()!;
      if (seen.has(dir.toLowerCase())) continue;
      seen.add(dir.toLowerCase());
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        visited += 1;
        if (visited > 50_000) break;
        const full = join(dir, name);
        const lower = name.toLowerCase();
        if (lower === targetName) {
          const stat = safeStat(full);
          if (stat && this.matchesEvidence(entry, full, stat.size)) {
            hits.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
            if (expectedSize !== null && stat.size === expectedSize) return hits[hits.length - 1];
          }
          continue;
        }
        if (depth >= 3) continue;
        if (SYSTEM_SEGMENTS.has(lower)) continue;
        if (lower.startsWith('.')) continue;
        const stat = safeStat(full);
        if (stat?.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => Math.abs(a.size - (expectedSize ?? a.size)) - Math.abs(b.size - (expectedSize ?? b.size)));
    return hits[0];
  }

  /** A namesake alone is not evidence: once we know the file, size or hash must agree. */
  private matchesEvidence(entry: AttachmentLedgerEntry | undefined, path: string, size: number): boolean {
    if (!entry) return true;
    if (entry.size > 0 && size === entry.size) return true;
    return Boolean(entry.sha256) && hashFile(path) === entry.sha256;
  }

  private searchRoots(attachment: AutopilotAttachment): string[] {
    const roots = new Set<string>();
    const original = attachment.originalPath;
    const parent = dirname(original);
    roots.add(parent);
    roots.add(dirname(parent));
    const entry = this.ledger.get(attachment.id);
    for (const known of entry?.knownPaths ?? []) roots.add(dirname(known));
    for (const root of this.options.searchRoots ?? []) roots.add(root);
    if (process.env.USERPROFILE) {
      roots.add(join(process.env.USERPROFILE, 'Desktop'));
      roots.add(join(process.env.USERPROFILE, 'Documents'));
      roots.add(join(process.env.USERPROFILE, 'Downloads'));
    }
    return [...roots].filter((root) => {
      if (!root || root.startsWith('\\\\')) return false;
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private remember(
    jobId: string,
    attachment: AutopilotAttachment,
    size: number,
    mtimeMs: number,
    backupPath: string | null,
  ): void {
    const existing = this.ledger.get(attachment.id);
    const sha = existing?.sha256 ?? hashFile(attachment.originalPath) ?? '';
    this.upsertLedger({
      attachmentId: attachment.id,
      jobId,
      originalPath: attachment.originalPath,
      displayName: attachment.displayName,
      size,
      mtimeMs,
      sha256: sha,
      backupPath: backupPath ?? existing?.backupPath ?? null,
      knownPaths: existing?.knownPaths ?? [attachment.originalPath],
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  private upsertKnownPath(attachmentId: string, path: string): void {
    const entry = this.ledger.get(attachmentId);
    if (!entry) return;
    const known = new Set([...entry.knownPaths, path]);
    if (known.size > 20) {
      // Keep the 20 most recent paths.
      const trimmed = [...known].slice(-20);
      entry.knownPaths = trimmed;
    } else {
      entry.knownPaths = [...known];
    }
    entry.updatedAt = new Date(this.now()).toISOString();
    this.persistLedger();
  }

  private enforceQuota(maxBytes: number, incoming: number): void {
    const entries = [...this.ledger.values()].filter((entry) => entry.backupPath && existsSync(entry.backupPath));
    let total = entries.reduce((sum, entry) => sum + (safeStat(entry.backupPath!)?.size ?? 0), 0);
    if (total + incoming <= maxBytes) return;
    entries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const entry of entries) {
      if (total + incoming <= maxBytes) break;
      const size = safeStat(entry.backupPath!)?.size ?? 0;
      if (removeBackupFile(this.backupRoot, entry.backupPath!)) {
        total -= size;
        entry.backupPath = null;
      }
    }
    this.persistLedger();
  }

  private upsertLedger(entry: AttachmentLedgerEntry): void {
    const previous = this.ledger.get(entry.attachmentId);
    const known = new Set([...(previous?.knownPaths ?? []), ...entry.knownPaths]);
    this.ledger.set(entry.attachmentId, { ...entry, knownPaths: [...known].slice(-20) });
    this.persistLedger();
  }

  private loadLedger(): void {
    const raw = readJson(this.ledgerFile);
    if (!raw || typeof raw !== 'object') return;
    const entries = (raw as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return;
    for (const candidate of entries) {
      if (!candidate || typeof candidate !== 'object') continue;
      const entry = candidate as Partial<AttachmentLedgerEntry>;
      if (typeof entry.attachmentId !== 'string' || typeof entry.originalPath !== 'string') continue;
      this.ledger.set(entry.attachmentId, {
        attachmentId: entry.attachmentId,
        jobId: typeof entry.jobId === 'string' ? entry.jobId : '',
        originalPath: entry.originalPath,
        displayName: typeof entry.displayName === 'string' ? entry.displayName : basename(entry.originalPath),
        size: typeof entry.size === 'number' ? entry.size : 0,
        mtimeMs: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : 0,
        sha256: typeof entry.sha256 === 'string' ? entry.sha256 : '',
        backupPath: typeof entry.backupPath === 'string' ? entry.backupPath : null,
        knownPaths: Array.isArray(entry.knownPaths)
          ? entry.knownPaths.filter((path): path is string => typeof path === 'string')
          : [],
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
      });
    }
  }

  private persistLedger(): void {
    try {
      writeAtomic(this.ledgerFile, `${JSON.stringify({ version: 1, entries: [...this.ledger.values()] }, null, 2)}\n`);
    } catch (error) {
      this.options.log.error('could not persist attachment ledger', error);
    }
  }
}

export function buildMissingNote(missing: readonly ResolvedAttachment[]): string {
  if (!missing.length) return '';
  const lines = missing.map((item) => {
    const detail =
      item.reason === 'too_large'
        ? '文件过大，已跳过'
        : item.reason === 'restore_target_unavailable'
          ? `备份无法复原到原目录（${dirname(item.originalPath)}）`
          : '原始路径已失效';
    const backup = item.backupPath ? '有备份但无法使用' : '无备份';
    return `- ${item.displayName}（${detail}；${backup}）`;
  });
  return ['【附件缺失说明】以下附件在计划发送时不可读，已跳过：', ...lines].join('\n');
}

/** Removes a backup file only when it is inside the managed backup root. */
function removeBackupFile(backupRoot: string, file: string): boolean {
  try {
    const root = resolve(backupRoot).toLowerCase();
    const target = resolve(file).toLowerCase();
    if (!target.startsWith(root + sep.toLowerCase())) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+$/, '_').slice(0, 120);
  return cleaned || '_';
}

function safeStat(path: string): { size: number; mtimeMs: number; isDirectory: () => boolean } | null {
  if (!path) return null;
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** SHA-256 of the first 64 KiB — enough to recognise a moved file cheaply. */
function hashFile(path: string): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(64 * 1024, statSync(path).size || 1));
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
