import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttachmentService,
  buildMissingNote,
  sanitizeSegment,
  type AttachmentLimits,
} from '../electron/core/autopilot-attachments';
import type { Logger } from '../electron/core/logger';
import { sanitizeJob } from '../shared/autopilot';

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
  tail: () => '',
  path: '',
} as unknown as Logger;

const limits = (patch: Partial<AttachmentLimits> = {}): AttachmentLimits => ({
  backupEnabled: true,
  backupMaxBytes: 10 * 1024 * 1024,
  maxAttachmentBytes: 1024 * 1024,
  ...patch,
});

let root = '';
let dataDir = '';
const realUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insomniaz-attach-'));
  dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  // Keep the search away from the developer's real Desktop/Documents/Downloads.
  process.env.USERPROFILE = join(root, 'profile');
  mkdirSync(join(root, 'profile', 'Desktop'), { recursive: true });
});

afterEach(() => {
  process.env.USERPROFILE = realUserProfile;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function file(path: string, contents = 'hello attachment'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

function attachment(path: string, patch: Record<string, unknown> = {}) {
  const job = sanitizeJob(
    {
      title: 't',
      prompt: 'p',
      attachments: [
        {
          id: 'att-1',
          originalPath: path,
          displayName: path.split(/[\\/]/).pop(),
          ...patch,
        },
      ],
    },
    'job',
  )!;
  return job.attachments[0];
}

describe('AttachmentService', () => {
  it('reads the original file and never the backup path (quadrant 1 & 2)', () => {
    const original = file(join(root, 'docs', 'report.txt'));
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    const result = service.prepare('job-1', 'prompt', [attachment(original)], limits());

    expect(result.items[0].source).toBe('original');
    expect(result.items[0].usePath).toBe(original);
    expect(result.note).toBe('');
    expect(result.prompt).toBe('prompt');

    const backup = service.entryFor('att-1')?.backupPath;
    expect(backup).toBeTruthy();
    expect(existsSync(backup!)).toBe(true);
    expect(backup).not.toBe(original);
    expect(readFileSync(backup!, 'utf8')).toBe('hello attachment');
  });

  it('skips backups when disabled but still uses the original', () => {
    const original = file(join(root, 'a.txt'));
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    const result = service.prepare('job-1', 'p', [attachment(original)], limits({ backupEnabled: false }));
    expect(result.items[0].usePath).toBe(original);
    expect(service.entryFor('att-1')?.backupPath ?? null).toBeNull();
    expect(existsSync(join(dataDir, 'attachments'))).toBe(false);
  });

  it('restores a backup to the original directory before use (quadrant 3)', () => {
    const original = file(join(root, 'work', 'notes.md'), 'v1 content');
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    service.prepare('job-1', 'p', [attachment(original)], limits());
    expect(service.entryFor('att-1')?.backupPath).toBeTruthy();

    rmSync(original);
    rmSync(join(root, 'work'), { recursive: true, force: true });

    const result = service.prepare('job-1', 'p', [attachment(original)], limits());
    expect(result.items[0].source).toBe('restored');
    expect(result.items[0].usePath).toBe(original);
    expect(existsSync(original)).toBe(true);
    expect(readFileSync(original, 'utf8')).toBe('v1 content');
  });

  it('reports a missing attachment and appends the note (quadrant 4)', () => {
    const original = join(root, 'gone', 'missing.pdf');
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    const result = service.prepare('job-1', 'do it', [attachment(original)], limits());

    expect(result.items[0].source).toBe('missing');
    expect(result.items[0].usePath).toBeNull();
    expect(result.items[0].reason).toBe('not_found');
    expect(result.note).toContain('【附件缺失说明】');
    expect(result.note).toContain('missing.pdf');
    expect(result.note).toContain('无备份');
    expect(result.prompt.startsWith('do it\n\n')).toBe(true);
    expect(result.prompt).toContain('missing.pdf');
  });

  it('finds a moved file inside a configured search root', () => {
    const movedTo = file(join(root, 'elsewhere', 'deep', 'moved.txt'), 'moved body');
    const original = join(root, 'unrelated', 'moved.txt');
    const service = new AttachmentService({
      dir: dataDir,
      log: silentLog,
      searchRoots: [join(root, 'elsewhere')],
    });
    const result = service.prepare('job-1', 'p', [attachment(original)], limits());
    expect(result.items[0].source).toBe('original');
    expect(result.items[0].usePath).toBe(movedTo);
    expect(result.note).toBe('');
  });

  it('refuses an unrelated namesake once the file is known', () => {
    const original = file(join(root, 'known', 'notes.md'), 'v1 content');
    const service = new AttachmentService({
      dir: dataDir,
      log: silentLog,
      searchRoots: [join(root, 'elsewhere')],
    });
    service.prepare('job-1', 'p', [attachment(original)], limits());
    service.deleteBackup('att-1');
    rmSync(original);
    const namesake = file(join(root, 'elsewhere', 'NOTES.md'), 'a completely different document');

    const result = service.prepare('job-1', 'p', [attachment(original)], limits());
    expect(result.items[0].source).toBe('missing');
    expect(result.items[0].usePath).toBeNull();
    expect(existsSync(namesake)).toBe(true);
    expect(result.note).toContain('notes.md');
  });

  it('refuses attachments above the size cap', () => {
    const original = file(join(root, 'big.bin'), 'x'.repeat(2048));
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    const result = service.prepare('job-1', 'p', [attachment(original)], limits({ maxAttachmentBytes: 1024 }));
    expect(result.items[0].source).toBe('missing');
    expect(result.items[0].reason).toBe('too_large');
    expect(result.note).toContain('文件过大');
  });

  it('reports an unusable restore target instead of writing elsewhere', () => {
    const original = file(join(root, 'blocked', 'x.txt'), 'body');
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    service.prepare('job-1', 'p', [attachment(original)], limits());
    rmSync(original);
    rmSync(join(root, 'blocked'), { recursive: true, force: true });
    file(join(root, 'blocked'), 'this is a file, not a directory');

    const result = service.prepare('job-1', 'p', [attachment(original)], limits());
    expect(result.items[0].source).toBe('missing');
    expect(result.items[0].reason).toBe('restore_target_unavailable');
    expect(result.note).toContain('备份无法复原到原目录');
  });

  it('deletes backups without touching the original', () => {
    const original = file(join(root, 'keep.txt'));
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    service.prepare('job-1', 'p', [attachment(original)], limits());
    const backup = service.entryFor('att-1')!.backupPath!;
    expect(service.deleteBackup('att-1')).toBe(true);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(original)).toBe(true);
    expect(service.deleteBackup('att-1')).toBe(false);
  });

  it('never deletes a file outside the backup root', () => {
    const original = file(join(root, 'outside.txt'));
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    service.prepare('job-1', 'p', [attachment(original)], limits());
    // Corrupt the ledger so it points at the original path.
    const ledgerFile = join(dataDir, 'autopilot-attachments.json');
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    ledger.entries[0].backupPath = original;
    writeFileSync(ledgerFile, JSON.stringify(ledger), 'utf8');

    const reloaded = new AttachmentService({ dir: dataDir, log: silentLog });
    expect(reloaded.deleteBackup('att-1')).toBe(false);
    expect(existsSync(original)).toBe(true);
  });

  it('cleans expired backups by retention window', () => {
    const original = file(join(root, 'old.txt'));
    let clock = Date.now();
    const service = new AttachmentService({ dir: dataDir, log: silentLog, now: () => clock });
    service.prepare('job-1', 'p', [attachment(original)], limits());
    const backup = service.entryFor('att-1')!.backupPath!;
    const past = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    utimesSync(backup, past, past);
    clock += 1000;

    expect(service.cleanupExpired(7)).toBe(1);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(original)).toBe(true);
  });

  it('evicts the oldest backups when the quota is exceeded', () => {
    const first = file(join(root, 'one.txt'), 'a'.repeat(700));
    let clock = Date.now();
    const service = new AttachmentService({ dir: dataDir, log: silentLog, now: () => clock });
    service.prepare('job-1', 'p', [attachment(first)], limits({ backupMaxBytes: 1000 }));
    const firstBackup = service.entryFor('att-1')!.backupPath!;
    expect(existsSync(firstBackup)).toBe(true);

    clock += 60_000;
    const second = file(join(root, 'two.txt'), 'b'.repeat(700));
    const job = sanitizeJob(
      { title: 't', prompt: 'p', attachments: [{ id: 'att-2', originalPath: second, displayName: 'two.txt' }] },
      'job',
    )!;
    service.prepare('job-2', 'p', [job.attachments[0]], limits({ backupMaxBytes: 1000 }));
    expect(existsSync(firstBackup)).toBe(false);
    expect(existsSync(service.entryFor('att-2')!.backupPath!)).toBe(true);
  });

  it('persists the ledger across instances', () => {
    const original = file(join(root, 'persist.txt'));
    const first = new AttachmentService({ dir: dataDir, log: silentLog });
    first.prepare('job-1', 'p', [attachment(original)], limits());

    const second = new AttachmentService({ dir: dataDir, log: silentLog });
    const entry = second.entryFor('att-1');
    expect(entry?.originalPath).toBe(original);
    expect(entry?.backupPath).toBeTruthy();
    expect(entry?.size).toBeGreaterThan(0);
  });

  it('keeps a stable backup when the same attachment is prepared twice', () => {
    const original = file(join(root, 'twice.txt'));
    const service = new AttachmentService({ dir: dataDir, log: silentLog });
    service.prepare('job-1', 'p', [attachment(original)], limits());
    const first = service.entryFor('att-1')!.backupPath;
    service.prepare('job-1', 'p', [attachment(original)], limits());
    expect(service.entryFor('att-1')!.backupPath).toBe(first);
  });
});

describe('buildMissingNote', () => {
  it('returns an empty string when nothing is missing', () => {
    expect(buildMissingNote([])).toBe('');
  });

  it('lists each failure with backup state', () => {
    const note = buildMissingNote([
      {
        id: '1',
        displayName: 'a.pdf',
        originalPath: 'C:\\x\\a.pdf',
        usePath: null,
        source: 'missing',
        backupPath: null,
        reason: 'not_found',
      },
      {
        id: '2',
        displayName: 'b.pdf',
        originalPath: 'C:\\y\\b.pdf',
        usePath: null,
        source: 'missing',
        backupPath: 'C:\\backup\\b.pdf',
        reason: 'restore_target_unavailable',
      },
    ]);
    expect(note).toContain('- a.pdf（原始路径已失效；无备份）');
    expect(note).toContain('- b.pdf（备份无法复原到原目录（C:\\y）；有备份但无法使用）');
  });
});

describe('sanitizeSegment', () => {
  it('strips path separators and control characters', () => {
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeSegment('...')).toBe('_');
    expect(sanitizeSegment('')).toBe('_');
    expect(sanitizeSegment('x'.repeat(300)).length).toBe(120);
  });
});
