/**
 * Autopilot (scheduled prompt delivery) shared contract: types, sanitizers,
 * schedule math, model-name matching and the built-in error catalog.
 *
 * Pure module — no Node/Electron imports, so the renderer and Vitest can use it.
 */

// ---------------------------------------------------------------------------
// Targets & capabilities
// ---------------------------------------------------------------------------

export const AUTOPILOT_TARGETS = ['zcode', 'workbuddy', 'workbuddy-ai', 'generic', 'fallback-only'] as const;
export type AutopilotTarget = (typeof AUTOPILOT_TARGETS)[number];

export const AUTOPILOT_JOB_STATUSES = [
  'idle',
  'queued',
  'running',
  'sent',
  'failed',
  'skipped',
  'deferred',
  'blocked',
] as const;
export type AutopilotJobStatus = (typeof AUTOPILOT_JOB_STATUSES)[number];

export type AutopilotRunState = 'running' | 'sent' | 'failed' | 'skipped' | 'deferred' | 'interrupted';
export type AutopilotRoute = 'gui-zcode' | 'gui-workbuddy' | 'fallback-ollama' | 'fallback-api' | 'cli';

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

export interface AutopilotConversationRef {
  kind: 'named' | 'current' | 'new';
  name?: string;
  workspace?: string;
}

/** How the generic adapter finds its window; ignored by fixed targets. */
export interface AutopilotWindowRef {
  process?: string;
  title?: string;
  className?: string;
  /** Title matching mode; defaults to a case-insensitive substring match. */
  titleMatch?: 'contains' | 'equals';
}

export interface AutopilotModelSpec {
  provider?: string;
  name?: string;
  thinking?: ThinkingLevel;
  params?: Record<string, string | number | boolean>;
}

export interface AutopilotCapabilities {
  mode?: string;
  skills?: string[];
  mcp?: string[];
  plugins?: string[];
  experts?: string[];
  workspace?: string;
}

export type AutopilotRetention = 'delete_now' | 'keep' | 'expire';

export interface AutopilotAttachment {
  id: string;
  originalPath: string;
  displayName: string;
  backup: boolean;
  retention: AutopilotRetention;
  retentionDays?: number;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type AutopilotScheduleKind = 'once' | 'daily' | 'weekly' | 'interval' | 'manual';
export const AUTOPILOT_SCHEDULE_KINDS: AutopilotScheduleKind[] = [
  'once',
  'daily',
  'weekly',
  'interval',
  'manual',
];

export type AutopilotCatchUp = 'run_once' | 'skip' | 'ask';

export interface AutopilotSchedule {
  kind: AutopilotScheduleKind;
  /** ISO instant, required when kind === 'once'. */
  at?: string;
  /** 'HH:mm' local time, used by daily/weekly. */
  timeOfDay?: string;
  /** 0 = Sunday. Empty means every day. */
  weekdays?: number[];
  everyMinutes?: number;
  /** Anchor instant for interval schedules; without it the first run is from + interval. */
  anchor?: string;
  catchUp: AutopilotCatchUp;
}

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_CATCH_UP_GRACE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Job & run
// ---------------------------------------------------------------------------

export const AUTOPILOT_MAX_PROMPT_CHARS = 200_000;
export const AUTOPILOT_MAX_ATTACHMENTS = 40;
export const AUTOPILOT_DEFAULT_ATTEMPTS_BUDGET = 12;
export const AUTOPILOT_MAX_ATTEMPTS_BUDGET = 60;

export interface AutopilotJob {
  id: string;
  schemaVersion: 1;
  title: string;
  target: AutopilotTarget;
  conversation?: AutopilotConversationRef;
  prompt: string;
  model?: AutopilotModelSpec;
  capabilities?: AutopilotCapabilities;
  window?: AutopilotWindowRef;
  attachments: AutopilotAttachment[];
  schedule: AutopilotSchedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: AutopilotJobStatus;
  nextDueAt?: string;
  attemptsBudget: number;
}

export interface AutopilotRunStep {
  t: string;
  step: string;
  ok: boolean;
  code?: AutopilotErrorCode;
  ms: number;
  detail?: string;
}

export interface AutopilotRun {
  id: string;
  jobId: string;
  startedAt: string;
  endedAt?: string;
  scheduledAt: string;
  state: AutopilotRunState;
  route: AutopilotRoute;
  attempts: number;
  steps: AutopilotRunStep[];
  error?: { code: AutopilotErrorCode; message: string };
  promptDigest: string;
  heartbeatAt?: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AutopilotFallbackSettings {
  /** Remote emergency API. Off by default; requires an explicit key. */
  remoteEnabled: boolean;
  baseUrl: string;
  model: string;
  /** Loopback Ollama before remote API. */
  ollamaEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
}

export interface AutopilotProtectionSettings {
  hideOnCapture: boolean;
  hideOnRemoteControl: boolean;
  throttleOnLoad: boolean;
  cpuBusyThreshold: number;
  allowlist: string[];
}

export interface AutopilotSettings {
  schemaVersion: 1;
  enabled: boolean;
  backlogMs: number;
  autosaveMaxIntervalMs: number;
  attemptsBudget: number;
  strictModelMatch: boolean;
  autoLaunchTargets: boolean;
  restorePromptClipboard: boolean;
  backupEnabled: boolean;
  backupRetentionDays: number;
  backupMaxBytes: number;
  maxAttachmentBytes: number;
  catalogRefresh: boolean;
  catalogRefreshUrl: string;
  fallback: AutopilotFallbackSettings;
  protection: AutopilotProtectionSettings;
}

export const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings = {
  schemaVersion: 1,
  enabled: true,
  backlogMs: DEFAULT_CATCH_UP_GRACE_MS,
  autosaveMaxIntervalMs: 15_000,
  attemptsBudget: AUTOPILOT_DEFAULT_ATTEMPTS_BUDGET,
  strictModelMatch: false,
  autoLaunchTargets: true,
  restorePromptClipboard: true,
  backupEnabled: false,
  backupRetentionDays: 7,
  backupMaxBytes: 2 * 1024 * 1024 * 1024,
  maxAttachmentBytes: 512 * 1024 * 1024,
  catalogRefresh: false,
  catalogRefreshUrl: '',
  fallback: {
    remoteEnabled: false,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3-flash',
    ollamaEnabled: true,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5-coder:7b',
  },
  protection: {
    hideOnCapture: true,
    hideOnRemoteControl: true,
    throttleOnLoad: true,
    cpuBusyThreshold: 0.75,
    allowlist: [],
  },
};

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function strList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const text = str(entry, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function clampTimeOfDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function sanitizeAutopilotSettings(raw: unknown): AutopilotSettings {
  const input = obj(raw);
  const d = DEFAULT_AUTOPILOT_SETTINGS;
  const fallback = obj(input.fallback);
  const protection = obj(input.protection);
  const base = str(fallback.baseUrl, 500);
  return {
    schemaVersion: 1,
    enabled: bool(input.enabled, d.enabled),
    backlogMs: boundedInt(input.backlogMs, d.backlogMs, 0, 24 * 60 * 60_000),
    autosaveMaxIntervalMs: boundedInt(input.autosaveMaxIntervalMs, d.autosaveMaxIntervalMs, 1000, 60_000),
    attemptsBudget: boundedInt(input.attemptsBudget, d.attemptsBudget, 1, AUTOPILOT_MAX_ATTEMPTS_BUDGET),
    strictModelMatch: bool(input.strictModelMatch, d.strictModelMatch),
    autoLaunchTargets: bool(input.autoLaunchTargets, d.autoLaunchTargets),
    restorePromptClipboard: bool(input.restorePromptClipboard, d.restorePromptClipboard),
    backupEnabled: bool(input.backupEnabled, d.backupEnabled),
    backupRetentionDays: boundedInt(input.backupRetentionDays, d.backupRetentionDays, 1, 3650),
    backupMaxBytes: boundedInt(
      input.backupMaxBytes,
      d.backupMaxBytes,
      64 * 1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    maxAttachmentBytes: boundedInt(
      input.maxAttachmentBytes,
      d.maxAttachmentBytes,
      1024 * 1024,
      16 * 1024 * 1024 * 1024,
    ),
    catalogRefresh: bool(input.catalogRefresh, d.catalogRefresh),
    catalogRefreshUrl: /^https?:\/\//i.test(str(input.catalogRefreshUrl, 500) ?? '')
      ? (str(input.catalogRefreshUrl, 500) as string)
      : '',
    fallback: {
      remoteEnabled: bool(fallback.remoteEnabled, d.fallback.remoteEnabled),
      baseUrl: sanitizeBaseUrl(base, d.fallback.baseUrl),
      model: str(fallback.model, 120) ?? d.fallback.model,
      ollamaEnabled: bool(fallback.ollamaEnabled, d.fallback.ollamaEnabled),
      ollamaBaseUrl: sanitizeBaseUrl(str(fallback.ollamaBaseUrl, 500), d.fallback.ollamaBaseUrl),
      ollamaModel: str(fallback.ollamaModel, 120) ?? d.fallback.ollamaModel,
    },
    protection: {
      hideOnCapture: bool(protection.hideOnCapture, d.protection.hideOnCapture),
      hideOnRemoteControl: bool(protection.hideOnRemoteControl, d.protection.hideOnRemoteControl),
      throttleOnLoad: bool(protection.throttleOnLoad, d.protection.throttleOnLoad),
      cpuBusyThreshold: clampNumber(protection.cpuBusyThreshold, d.protection.cpuBusyThreshold, 0.3, 0.99),
      allowlist: strList(protection.allowlist, 32, 120) ?? [],
    },
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeBaseUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return fallback;
  }
}

const SCHEDULE_KINDS = new Set<string>(AUTOPILOT_SCHEDULE_KINDS);

function sanitizeSchedule(raw: unknown): AutopilotSchedule {
  const input = obj(raw);
  const kindRaw = typeof input.kind === 'string' && SCHEDULE_KINDS.has(input.kind) ? input.kind : 'once';
  const kind = kindRaw as AutopilotScheduleKind;
  const at = isoOrUndefined(input.at);
  const timeOfDay = clampTimeOfDay(input.timeOfDay) ?? (kind === 'daily' || kind === 'weekly' ? '09:00' : undefined);
  const weekdays = Array.isArray(input.weekdays)
    ? [...new Set(input.weekdays.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
        .map((d) => Math.round(d)))].sort((a, b) => a - b)
    : undefined;
  const everyMinutes =
    typeof input.everyMinutes === 'number' && Number.isFinite(input.everyMinutes)
      ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(input.everyMinutes)))
      : kind === 'interval'
        ? 60
        : undefined;
  const anchor = isoOrUndefined(input.anchor);
  const catchRaw = input.catchUp;
  const catchUp: AutopilotCatchUp =
    catchRaw === 'skip' || catchRaw === 'ask' || catchRaw === 'run_once' ? catchRaw : 'run_once';

  return {
    kind,
    ...(at ? { at } : {}),
    ...(timeOfDay ? { timeOfDay } : {}),
    ...(weekdays && weekdays.length ? { weekdays } : {}),
    ...(everyMinutes ? { everyMinutes } : {}),
    ...(anchor ? { anchor } : {}),
    catchUp,
  };
}

function sanitizeModel(raw: unknown): AutopilotModelSpec | undefined {
  const input = obj(raw);
  const provider = str(input.provider, 120);
  const name = str(input.name, 120);
  const thinkingRaw = input.thinking;
  const thinking = THINKING_LEVELS.includes(thinkingRaw as ThinkingLevel)
    ? (thinkingRaw as ThinkingLevel)
    : undefined;
  let params: Record<string, string | number | boolean> | undefined;
  if (input.params && typeof input.params === 'object' && !Array.isArray(input.params)) {
    params = {};
    for (const [key, value] of Object.entries(input.params as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length > 60) continue;
      if (typeof value === 'string') params[key] = value.slice(0, 500);
      else if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
      else if (typeof value === 'boolean') params[key] = value;
      if (Object.keys(params).length >= 32) break;
    }
    if (!Object.keys(params).length) params = undefined;
  }
  if (!provider && !name && !thinking && !params) return undefined;
  return { ...(provider ? { provider } : {}), ...(name ? { name } : {}), ...(thinking ? { thinking } : {}), ...(params ? { params } : {}) };
}

function sanitizeCapabilities(raw: unknown): AutopilotCapabilities | undefined {
  const input = obj(raw);
  const out: AutopilotCapabilities = {};
  const mode = str(input.mode, 80);
  if (mode) out.mode = mode;
  const workspace = str(input.workspace, 400);
  if (workspace) out.workspace = workspace;
  const skills = strList(input.skills, 100, 120);
  if (skills?.length) out.skills = skills;
  const mcp = strList(input.mcp, 100, 120);
  if (mcp?.length) out.mcp = mcp;
  const plugins = strList(input.plugins, 100, 120);
  if (plugins?.length) out.plugins = plugins;
  const experts = strList(input.experts, 100, 120);
  if (experts?.length) out.experts = experts;
  return Object.keys(out).length ? out : undefined;
}

function sanitizeWindowRef(raw: unknown): AutopilotWindowRef | undefined {
  const input = obj(raw);
  const processName = str(input.process, 120);
  const title = str(input.title, 300);
  const className = str(input.className, 120);
  const titleMatch = input.titleMatch === 'equals' ? 'equals' : 'contains';
  if (!processName && !title && !className) return undefined;
  return {
    ...(processName ? { process: processName } : {}),
    ...(title ? { title, titleMatch } : {}),
    ...(className ? { className } : {}),
  };
}

function sanitizeAttachments(raw: unknown): AutopilotAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: AutopilotAttachment[] = [];
  for (const entry of raw) {
    const input = obj(entry);
    const originalPath = str(input.originalPath, 4000);
    if (!originalPath) continue;
    const displayName = str(input.displayName, 260) ?? originalPath.split(/[\\/]/).pop() ?? originalPath;
    const retention: AutopilotRetention =
      input.retention === 'keep' || input.retention === 'expire' || input.retention === 'delete_now'
        ? input.retention
        : 'delete_now';
    out.push({
      id: str(input.id, 120) ?? `${out.length}-${displayName}`,
      originalPath,
      displayName,
      backup: input.backup !== false,
      retention,
      ...(retention === 'expire'
        ? { retentionDays: boundedInt(input.retentionDays, 7, 1, 3650) }
        : {}),
    });
    if (out.length >= AUTOPILOT_MAX_ATTACHMENTS) break;
  }
  return out;
}

const JOB_STATUSES = new Set<string>(AUTOPILOT_JOB_STATUSES);

export function sanitizeJob(raw: unknown, fallbackId: string): AutopilotJob | null {
  const input = obj(raw);
  const prompt = typeof input.prompt === 'string' ? input.prompt.slice(0, AUTOPILOT_MAX_PROMPT_CHARS) : '';
  const title = str(input.title, 200) ?? '';
  if (!prompt.trim() && !title) return null;
  const id = str(input.id, 120) ?? fallbackId;
  const targetRaw = typeof input.target === 'string' ? input.target : '';
  const target = (AUTOPILOT_TARGETS as readonly string[]).includes(targetRaw)
    ? (targetRaw as AutopilotTarget)
    : 'zcode';
  const conversationInput = obj(input.conversation);
  const convKind =
    conversationInput.kind === 'current' || conversationInput.kind === 'new' || conversationInput.kind === 'named'
      ? conversationInput.kind
      : 'current';
  const convName = str(conversationInput.name, 400);
  const convWorkspace = str(conversationInput.workspace, 400);
  const conversation: AutopilotConversationRef = {
    kind: convKind,
    ...(convName ? { name: convName } : {}),
    ...(convWorkspace ? { workspace: convWorkspace } : {}),
  };
  const createdAt = isoOrUndefined(input.createdAt) ?? new Date(0).toISOString();
  const updatedAt = isoOrUndefined(input.updatedAt) ?? createdAt;
  const lastStatusRaw = typeof input.lastStatus === 'string' ? input.lastStatus : '';
  const nextDueAt = isoOrUndefined(input.nextDueAt);

  return {
    id,
    schemaVersion: 1,
    title: title || prompt.split(/\r?\n/)[0]?.slice(0, 80) || 'Autopilot job',
    target,
    conversation: convKind === 'current' && !convName && !convWorkspace ? undefined : conversation,
    prompt,
    ...(sanitizeModel(input.model) ? { model: sanitizeModel(input.model) } : {}),
    ...(sanitizeCapabilities(input.capabilities) ? { capabilities: sanitizeCapabilities(input.capabilities) } : {}),
    ...(sanitizeWindowRef(input.window) ? { window: sanitizeWindowRef(input.window) } : {}),
    attachments: sanitizeAttachments(input.attachments),
    schedule: sanitizeSchedule(input.schedule),
    enabled: bool(input.enabled, true),
    createdAt,
    updatedAt,
    ...(isoOrUndefined(input.lastRunAt) ? { lastRunAt: isoOrUndefined(input.lastRunAt) } : {}),
    ...(JOB_STATUSES.has(lastStatusRaw) ? { lastStatus: lastStatusRaw as AutopilotJobStatus } : {}),
    ...(nextDueAt ? { nextDueAt } : {}),
    attemptsBudget: boundedInt(
      input.attemptsBudget,
      AUTOPILOT_DEFAULT_ATTEMPTS_BUDGET,
      1,
      AUTOPILOT_MAX_ATTEMPTS_BUDGET,
    ),
  };
}

export function sanitizeJobs(raw: unknown): AutopilotJob[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AutopilotJob[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const job = sanitizeJob(raw[i], `job-${i}`);
    if (!job) continue;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(job);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schedule math (local time)
// ---------------------------------------------------------------------------

function atLocalTime(day: Date, timeOfDay: string): Date {
  const [h, m] = timeOfDay.split(':').map(Number);
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
  return next;
}

/** Next instant strictly after `from`, or null when the schedule never fires again. */
export function nextDueAt(schedule: AutopilotSchedule, from: number): number | null {
  switch (schedule.kind) {
    case 'manual':
      return null;
    case 'once': {
      if (!schedule.at) return null;
      const at = Date.parse(schedule.at);
      return Number.isFinite(at) && at > from ? at : null;
    }
    case 'daily': {
      const time = schedule.timeOfDay ?? '09:00';
      const base = new Date(from);
      let candidate = atLocalTime(base, time).getTime();
      if (candidate <= from) {
        candidate = atLocalTime(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1), time).getTime();
      }
      return candidate;
    }
    case 'weekly': {
      const time = schedule.timeOfDay ?? '09:00';
      const days = schedule.weekdays?.length ? schedule.weekdays : [0, 1, 2, 3, 4, 5, 6];
      const base = new Date(from);
      for (let offset = 0; offset <= 7; offset += 1) {
        const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
        if (!days.includes(day.getDay())) continue;
        const candidate = atLocalTime(day, time).getTime();
        if (candidate > from) return candidate;
      }
      return null;
    }
    case 'interval': {
      const every = (schedule.everyMinutes ?? 60) * 60_000;
      const anchor = schedule.anchor ? Date.parse(schedule.anchor) : NaN;
      if (!Number.isFinite(anchor)) return from + every;
      if (anchor > from) return anchor;
      const steps = Math.floor((from - anchor) / every) + 1;
      return anchor + steps * every;
    }
    default:
      return null;
  }
}

export type CatchUpDecision = 'run' | 'skip' | 'ask';

/**
 * Decides what to do with one missed occurrence.
 * `scheduledAt` is the missed due time, `now` is the current instant.
 */
export function catchUpDecision(
  schedule: AutopilotSchedule,
  scheduledAt: number,
  now: number,
  graceMs: number = DEFAULT_CATCH_UP_GRACE_MS,
): CatchUpDecision {
  if (schedule.kind === 'manual') return 'skip';
  if (now <= scheduledAt) return 'run';
  if (now - scheduledAt <= Math.max(0, graceMs)) return 'run';
  if (schedule.catchUp === 'run_once') return 'run';
  if (schedule.catchUp === 'ask') return 'ask';
  return 'skip';
}

/** Human-readable description used by the UI and by run logs. */
export function describeSchedule(schedule: AutopilotSchedule, locale: 'en-US' | 'zh-CN'): string {
  const zh = locale === 'zh-CN';
  switch (schedule.kind) {
    case 'manual':
      return zh ? '手动' : 'Manual';
    case 'once':
      return schedule.at
        ? `${zh ? '一次' : 'Once'} · ${new Date(Date.parse(schedule.at)).toLocaleString()}`
        : zh ? '一次' : 'Once';
    case 'daily':
      return `${zh ? '每天' : 'Daily'} · ${schedule.timeOfDay ?? '09:00'}`;
    case 'weekly': {
      const days = schedule.weekdays?.length ? schedule.weekdays.join(',') : zh ? '每天' : 'all days';
      return `${zh ? '每周' : 'Weekly'} · ${days} · ${schedule.timeOfDay ?? '09:00'}`;
    }
    case 'interval':
      return zh
        ? `每 ${schedule.everyMinutes ?? 60} 分钟`
        : `Every ${schedule.everyMinutes ?? 60} min`;
    default:
      return schedule.kind;
  }
}

// ---------------------------------------------------------------------------
// Model catalog & name matching
// ---------------------------------------------------------------------------

export type ModelCatalogSource = 'seed' | 'observed' | 'remote';

export interface ModelCatalogEntry {
  provider: string;
  name: string;
  aliases?: string[];
  contextWindow?: number;
  vision?: boolean;
  thinkingLevels?: ThinkingLevel[];
  source: ModelCatalogSource;
  observedAt?: string;
}

/**
 * Offline seed. ZCode hides the model list when the account has no quota, so a
 * built-in catalog is the only way to offer choices before the first sync.
 */
export const AUTOPILOT_MODEL_SEEDS: ModelCatalogEntry[] = [
  {
    provider: 'Start Plan',
    name: 'GLM-5.3-Flash',
    aliases: ['glm-5.3-flash', 'GLM 5.3 Flash', 'GLM-5.3-Flash 视觉'],
    contextWindow: 1_000_000,
    vision: true,
    thinkingLevels: ['low', 'medium', 'high', 'max'],
    source: 'seed',
  },
  {
    provider: 'Start Plan',
    name: 'GLM-5.3',
    aliases: ['glm-5.3', 'GLM 5.3'],
    contextWindow: 1_000_000,
    thinkingLevels: ['low', 'medium', 'high', 'max'],
    source: 'seed',
  },
  {
    provider: 'Start Plan',
    name: 'GLM-5.3-FlashX',
    aliases: ['glm-5.3-flashx', 'GLM-5.3-FlashX 视觉'],
    contextWindow: 1_000_000,
    vision: true,
    thinkingLevels: ['low', 'medium', 'high', 'max'],
    source: 'seed',
  },
  {
    provider: 'Start Plan',
    name: 'GLM-5.2',
    aliases: ['glm-5.2', 'GLM 5.2'],
    contextWindow: 200_000,
    thinkingLevels: ['low', 'medium', 'high'],
    source: 'seed',
  },
  {
    provider: 'Z.ai',
    name: 'GLM-5.3-Flash',
    aliases: ['glm-5.3-flash'],
    contextWindow: 1_000_000,
    vision: true,
    thinkingLevels: ['low', 'medium', 'high', 'max'],
    source: 'seed',
  },
  {
    provider: '阿里云百炼（中国）',
    name: 'Qwen3-Coder',
    aliases: ['qwen3-coder-plus', 'Qwen3 Coder'],
    contextWindow: 1_000_000,
    source: 'seed',
  },
  {
    provider: '阿里云百炼（中国）',
    name: 'Qwen3-Max',
    aliases: ['qwen3-max'],
    contextWindow: 262_144,
    source: 'seed',
  },
  {
    provider: '阿里云百炼（中国）',
    name: 'Qwen3-VL',
    aliases: ['qwen3-vl-plus'],
    contextWindow: 262_144,
    vision: true,
    source: 'seed',
  },
];

const BRACKET_SUFFIX = /[（(][^）)]*[）)]/g;

/** Folds width/case/spacing/version separators and drops parenthetical qualifiers. */
export function normalizeModelName(value: string): string {
  let text = value.normalize('NFKC');
  text = text.replace(BRACKET_SUFFIX, ' ');
  text = text.replace(/[\u3000\s]+/g, ' ').trim().toLowerCase();
  text = text.replace(/\s*[-_/]\s*/g, '-');
  text = text.replace(/\s+/g, '');
  return text;
}

function tokenSet(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLowerCase();
  return new Set(
    normalized
      .replace(BRACKET_SUFFIX, ' ')
      .split(/[^\p{L}\p{N}.]+/u)
      .filter((token) => token.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols);
  let cur = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[cols - 1];
}

export interface ModelMatch<T> {
  value: T;
  score: number;
  tier: 'exact' | 'prefix' | 'fuzzy' | 'weak' | 'none';
}

/**
 * Scores a candidate label against a requested name.
 * 100 exact (alias aware) · 80 containment · 55 token overlap · 30 edit distance.
 */
export function scoreModelName(candidate: string, query: string): number {
  const c = normalizeModelName(candidate);
  const q = normalizeModelName(query);
  if (!c || !q) return 0;
  if (c === q) return 100;
  if (c.startsWith(q) || c.endsWith(q) || q.startsWith(c) || q.endsWith(c)) return 80;
  const jac = jaccard(tokenSet(candidate), tokenSet(query));
  if (jac >= 0.6) return 55;
  const distance = editDistance(c, q);
  if (distance <= 2) return 30;
  return 0;
}

export function tierForScore(score: number): ModelMatch<never>['tier'] {
  if (score >= 100) return 'exact';
  if (score >= 80) return 'prefix';
  if (score >= 55) return 'fuzzy';
  if (score > 0) return 'weak';
  return 'none';
}

/**
 * Picks the best candidate. Ties are broken by list order (the target app shows
 * current first, so the first hit is usually the most relevant).
 */
export function matchModelName<T>(
  items: readonly T[],
  query: string,
  label: (item: T) => string,
  aliases: (item: T) => readonly string[] = () => [],
): ModelMatch<T> | null {
  let best: ModelMatch<T> | null = null;
  for (const item of items) {
    const primary = scoreModelName(label(item), query);
    const aliasScore = aliases(item).reduce((acc, alias) => Math.max(acc, scoreModelName(alias, query)), 0);
    const score = Math.max(primary, aliasScore);
    if (!best || score > best.score) {
      best = { value: item, score, tier: tierForScore(score) };
    }
  }
  if (!best || best.score === 0) return null;
  return best;
}

export interface ResolvedModelChoice<T> {
  value: T;
  score: number;
  tier: ModelMatch<never>['tier'];
  /** True when a human/target confirmation click is required before accepting. */
  needsConfirmation: boolean;
}

/**
 * Threshold policy: an exact match is accepted directly (re-reading CHECKED
 * afterwards); anything looser must be the unique best candidate and always
 * needs confirmation, so a near-miss can never silently switch the model.
 */
export function chooseModel<T>(
  items: readonly T[],
  query: string,
  label: (item: T) => string,
  aliases: (item: T) => readonly string[] = () => [],
): ResolvedModelChoice<T> | null {
  const scored: Array<ModelMatch<T>> = [];
  for (const item of items) {
    const primary = scoreModelName(label(item), query);
    const aliasScore = aliases(item).reduce((acc, alias) => Math.max(acc, scoreModelName(alias, query)), 0);
    const score = Math.max(primary, aliasScore);
    if (score > 0) scored.push({ value: item, score, tier: tierForScore(score) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const tied = scored.filter((entry) => entry.score === best.score);
  if (best.score >= 100) {
    return { value: best.value, score: best.score, tier: best.tier, needsConfirmation: tied.length > 1 };
  }
  if (best.score >= 55) {
    if (tied.length !== 1) return null;
    return { value: best.value, score: best.score, tier: best.tier, needsConfirmation: true };
  }
  return null;
}

/** Merges observed/remote entries over seeds; key is (provider, name). */
export function mergeCatalog(entries: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const map = new Map<string, ModelCatalogEntry>();
  const rank: Record<ModelCatalogSource, number> = { seed: 0, remote: 1, observed: 2 };
  for (const entry of entries) {
    const key = `${entry.provider}\u0000${entry.name}`.toLowerCase();
    const existing = map.get(key);
    if (!existing || rank[entry.source] >= rank[existing.source]) map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Error catalog
// ---------------------------------------------------------------------------

export const AUTOPILOT_ERROR_CODES = [
  'TARGET_NOT_RUNNING',
  'TARGET_NO_WINDOW',
  'WINDOW_MINIMIZED',
  'WINDOW_OCCLUDED',
  'DPI_CHANGED',
  'RESOLUTION_CHANGED',
  'TARGET_BUSY',
  'TREE_EMPTY',
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_AMBIGUOUS',
  'SESSION_DRIFT',
  'WORKSPACE_MISSING',
  'WORKSPACE_UNWRITABLE',
  'MODEL_POPUP_NOT_OPENED',
  'MODEL_UNAVAILABLE_NO_QUOTA',
  'MODEL_LOADING',
  'MODEL_REFRESH_FAILED',
  'QUOTA_EXPIRED',
  'PROVIDER_NOT_READY',
  'MODEL_NOT_IN_CATALOG',
  'MODEL_SWITCH_UNCONFIRMED',
  'THINKING_LEVEL_NOT_SET',
  'CLIPBOARD_OCCUPIED',
  'PASTE_UNCONFIRMED',
  'INPUT_NOT_FOUND',
  'SEND_DISABLED',
  'SEND_UNCONFIRMED',
  'DUPLICATE_RISK',
  'RATE_LIMITED',
  'NETWORK_DOWN',
  'APP_UPDATING',
  'MODAL_INTERCEPTED',
  'GUI_BUSY_BY_AI',
  'ATTACHMENT_MISSING',
  'RESTORE_TARGET_UNAVAILABLE',
  'BACKUP_FAILED',
  'BACKUP_QUOTA_EXCEEDED',
  'DROP_UNSUPPORTED',
  'ATTACHMENT_TOO_LARGE',
  'AUTO_HELPER_DEAD',
  'AUTO_HELPER_DENIED',
  'OCR_ENGINE_MISSING',
  'SAVE_FAILED',
  'PROTECTION_DEFERRED',
  'SOFT_STOP_INTERCEPT',
  'FALLBACK_UNCONFIGURED',
  'FALLBACK_NO_KEY',
  'FALLBACK_HTTP_ERROR',
  'FALLBACK_EMPTY_REPLY',
  'SHUTDOWN_IMMINENT',
  'SUSPEND',
  'UNEXPECTED_EXCEPTION',
] as const;

export type AutopilotErrorCode = (typeof AUTOPILOT_ERROR_CODES)[number];

export interface AutopilotErrorMeta {
  code: AutopilotErrorCode;
  /** Whether the same step may be retried at all. */
  retryable: boolean;
  /** Per-run retry cap for this specific code. */
  maxAttempts: number;
  /** Delay before retry, milliseconds; last value repeats. */
  backoffMs: number[];
  /** What the engine does when the cap is reached. */
  terminal: 'fallback' | 'deferred' | 'blocked' | 'failed' | 'skip' | 'continue' | 'next-candidate';
  /** Short zh/en label for the UI timeline. */
  label: { en: string; zh: string };
}

function meta(
  code: AutopilotErrorCode,
  retryable: boolean,
  maxAttempts: number,
  backoffMs: number[],
  terminal: AutopilotErrorMeta['terminal'],
  en: string,
  zh: string,
): AutopilotErrorMeta {
  return { code, retryable, maxAttempts, backoffMs: backoffMs.length ? backoffMs : [0], terminal, label: { en, zh } };
}

export const AUTOPILOT_ERRORS: Record<AutopilotErrorCode, AutopilotErrorMeta> = {
  TARGET_NOT_RUNNING: meta('TARGET_NOT_RUNNING', true, 2, [5000, 15_000], 'fallback', 'Target app not running', '目标应用未运行'),
  TARGET_NO_WINDOW: meta('TARGET_NO_WINDOW', true, 3, [3000], 'fallback', 'Target window missing', '目标窗口不存在'),
  WINDOW_MINIMIZED: meta('WINDOW_MINIMIZED', true, 1, [0], 'deferred', 'Window minimized', '窗口最小化'),
  WINDOW_OCCLUDED: meta('WINDOW_OCCLUDED', true, 2, [1000], 'fallback', 'Window occluded', '窗口被遮挡'),
  DPI_CHANGED: meta('DPI_CHANGED', true, 1, [0], 'failed', 'DPI changed', 'DPI 变化'),
  RESOLUTION_CHANGED: meta('RESOLUTION_CHANGED', true, 1, [0], 'deferred', 'Display layout changed', '显示布局变化'),
  TARGET_BUSY: meta('TARGET_BUSY', true, 2, [30_000], 'fallback', 'Target busy', '目标繁忙'),
  TREE_EMPTY: meta('TREE_EMPTY', true, 2, [2000], 'fallback', 'Accessibility tree empty', '可访问性树为空'),
  CONVERSATION_NOT_FOUND: meta('CONVERSATION_NOT_FOUND', true, 2, [1000], 'deferred', 'Conversation not found', '会话不存在'),
  CONVERSATION_AMBIGUOUS: meta('CONVERSATION_AMBIGUOUS', true, 1, [0], 'continue', 'Conversation name ambiguous', '会话重名'),
  SESSION_DRIFT: meta('SESSION_DRIFT', true, 2, [500], 'deferred', 'Session changed unexpectedly', '会话被切换'),
  WORKSPACE_MISSING: meta('WORKSPACE_MISSING', false, 1, [0], 'blocked', 'Workspace not found', '工作区不存在'),
  WORKSPACE_UNWRITABLE: meta('WORKSPACE_UNWRITABLE', false, 0, [0], 'blocked', 'Workspace not writable', '工作区不可写'),
  MODEL_POPUP_NOT_OPENED: meta('MODEL_POPUP_NOT_OPENED', true, 3, [300], 'next-candidate', 'Model menu did not open', '模型菜单未打开'),
  MODEL_UNAVAILABLE_NO_QUOTA: meta('MODEL_UNAVAILABLE_NO_QUOTA', true, 3, [2000, 5000, 10_000], 'fallback', 'Model list unavailable (quota)', '模型列表不可用（额度）'),
  MODEL_LOADING: meta('MODEL_LOADING', true, 1, [0], 'next-candidate', 'Model settings still loading', '模型设置加载中'),
  MODEL_REFRESH_FAILED: meta('MODEL_REFRESH_FAILED', true, 2, [5000], 'fallback', 'Model refresh failed', '模型刷新失败'),
  QUOTA_EXPIRED: meta('QUOTA_EXPIRED', false, 0, [0], 'blocked', 'Quota expired', '额度已过期'),
  PROVIDER_NOT_READY: meta('PROVIDER_NOT_READY', true, 2, [3000], 'next-candidate', 'Provider not ready', '供应商未就绪'),
  MODEL_NOT_IN_CATALOG: meta('MODEL_NOT_IN_CATALOG', true, 1, [0], 'next-candidate', 'Model not in catalog', '目录中无此模型'),
  MODEL_SWITCH_UNCONFIRMED: meta('MODEL_SWITCH_UNCONFIRMED', true, 2, [500], 'continue', 'Model switch unconfirmed', '模型切换未确认'),
  THINKING_LEVEL_NOT_SET: meta('THINKING_LEVEL_NOT_SET', true, 2, [0], 'continue', 'Thinking level not applied', '思考强度未生效'),
  CLIPBOARD_OCCUPIED: meta('CLIPBOARD_OCCUPIED', true, 2, [500], 'fallback', 'Clipboard busy', '剪贴板被占用'),
  PASTE_UNCONFIRMED: meta('PASTE_UNCONFIRMED', true, 2, [500], 'fallback', 'Paste unconfirmed', '粘贴未确认'),
  INPUT_NOT_FOUND: meta('INPUT_NOT_FOUND', true, 2, [1000], 'fallback', 'Composer input not found', '输入框不存在'),
  SEND_DISABLED: meta('SEND_DISABLED', true, 3, [500], 'fallback', 'Send button disabled', '发送按钮不可用'),
  SEND_UNCONFIRMED: meta('SEND_UNCONFIRMED', true, 1, [800], 'fallback', 'Send not confirmed', '发送未确认'),
  DUPLICATE_RISK: meta('DUPLICATE_RISK', false, 0, [0], 'blocked', 'Duplicate delivery risk', '存在重复投递风险'),
  RATE_LIMITED: meta('RATE_LIMITED', true, 4, [30_000, 60_000, 120_000, 300_000], 'fallback', 'Rate limited', '被限流'),
  NETWORK_DOWN: meta('NETWORK_DOWN', true, 5, [60_000], 'fallback', 'Network down', '网络不可用'),
  APP_UPDATING: meta('APP_UPDATING', true, 1, [0], 'deferred', 'Target is updating', '目标正在更新'),
  MODAL_INTERCEPTED: meta('MODAL_INTERCEPTED', true, 2, [1000], 'deferred', 'Modal dialog intercepted', '被弹窗拦截'),
  GUI_BUSY_BY_AI: meta('GUI_BUSY_BY_AI', true, 3, [30_000], 'deferred', 'Target agent is streaming', '目标 AI 正在输出'),
  ATTACHMENT_MISSING: meta('ATTACHMENT_MISSING', false, 1, [0], 'continue', 'Attachment missing', '附件缺失'),
  RESTORE_TARGET_UNAVAILABLE: meta('RESTORE_TARGET_UNAVAILABLE', false, 0, [0], 'continue', 'Restore target unavailable', '无法复原到原目录'),
  BACKUP_FAILED: meta('BACKUP_FAILED', true, 1, [1000], 'continue', 'Backup failed', '备份失败'),
  BACKUP_QUOTA_EXCEEDED: meta('BACKUP_QUOTA_EXCEEDED', true, 1, [0], 'continue', 'Backup quota exceeded', '备份配额超限'),
  DROP_UNSUPPORTED: meta('DROP_UNSUPPORTED', true, 2, [500], 'continue', 'File drop unsupported', '不支持文件粘贴'),
  ATTACHMENT_TOO_LARGE: meta('ATTACHMENT_TOO_LARGE', false, 0, [0], 'continue', 'Attachment too large', '附件过大'),
  AUTO_HELPER_DEAD: meta('AUTO_HELPER_DEAD', true, 3, [1000, 3000, 5000], 'fallback', 'Automation helper exited', '自动化助手退出'),
  AUTO_HELPER_DENIED: meta('AUTO_HELPER_DENIED', true, 1, [0], 'fallback', 'Automation helper denied', '自动化助手被拒绝'),
  OCR_ENGINE_MISSING: meta('OCR_ENGINE_MISSING', false, 1, [0], 'fallback', 'OCR engine unavailable', 'OCR 引擎不可用'),
  SAVE_FAILED: meta('SAVE_FAILED', true, 3, [500], 'failed', 'Could not persist state', '状态保存失败'),
  PROTECTION_DEFERRED: meta('PROTECTION_DEFERRED', true, Number.MAX_SAFE_INTEGER, [30_000], 'deferred', 'Deferred while screen is captured', '检测到采集，已推迟'),
  SOFT_STOP_INTERCEPT: meta('SOFT_STOP_INTERCEPT', true, Number.MAX_SAFE_INTEGER, [30_000], 'deferred', 'Soft stop in progress', '软叫停进行中'),
  SHUTDOWN_IMMINENT: meta('SHUTDOWN_IMMINENT', true, 1, [0], 'deferred', 'System is shutting down', '系统即将关机'),
  SUSPEND: meta('SUSPEND', true, Number.MAX_SAFE_INTEGER, [60_000], 'deferred', 'System suspended', '系统休眠'),
  FALLBACK_UNCONFIGURED: meta('FALLBACK_UNCONFIGURED', false, 1, [0], 'failed', 'No fallback channel is enabled', '未启用任何兜底通道'),
  FALLBACK_NO_KEY: meta('FALLBACK_NO_KEY', false, 1, [0], 'failed', 'Emergency API key is not stored', '未保存应急 API 密钥'),
  FALLBACK_HTTP_ERROR: meta('FALLBACK_HTTP_ERROR', true, 3, [1000, 3000, 8000], 'failed', 'Fallback endpoint rejected the request', '兜底接口拒绝请求'),
  FALLBACK_EMPTY_REPLY: meta('FALLBACK_EMPTY_REPLY', true, 2, [1500, 4000], 'failed', 'Fallback model returned nothing', '兜底模型没有返回内容'),
  UNEXPECTED_EXCEPTION: meta('UNEXPECTED_EXCEPTION', true, 2, [2000], 'failed', 'Unexpected error', '未预期错误'),
};

export function errorMeta(code: AutopilotErrorCode): AutopilotErrorMeta {
  return AUTOPILOT_ERRORS[code];
}

/** Delay before the n-th retry (1-based) of a code, clamped to the last entry. */
export function retryDelayMs(code: AutopilotErrorCode, attempt: number): number {
  const backoff = AUTOPILOT_ERRORS[code].backoffMs;
  if (!backoff.length) return 0;
  const index = Math.max(0, Math.min(backoff.length - 1, attempt - 1));
  return backoff[index];
}

/** Absolute ceiling on send clicks per run, regardless of error codes. */
export const MAX_SEND_CLICKS = 2;

// ---------------------------------------------------------------------------
// UI contract
// ---------------------------------------------------------------------------

export interface AutopilotAttachmentView {
  attachmentId: string;
  jobId: string;
  displayName: string;
  originalPath: string;
  size: number;
  sha256: string;
  backupPath: string | null;
  updatedAt: string;
  /** False when the original is gone; the backup may still be restorable. */
  originalExists: boolean;
}

export interface AutopilotWindowInfo {
  hwnd: number;
  title: string;
  process: string;
  className: string;
  visible: boolean;
  minimized: boolean;
  rect: [number, number, number, number];
}

export type AutopilotGuardState = 'ok' | 'capturing' | 'taken_over' | 'hot';

export interface AutopilotSnapshot {
  settings: AutopilotSettings;
  jobs: AutopilotJob[];
  runs: AutopilotRun[];
  catalog: ModelCatalogEntry[];
  /** Conversations observed per target, newest snapshot first. */
  conversations: Record<string, string[]>;
  attachments: AutopilotAttachmentView[];
  paused: boolean;
  activeRunId: string | null;
  helperAlive: boolean;
  guard: AutopilotGuardState;
  now: number;
}

export interface AutopilotJobSaveResult {
  ok: boolean;
  job?: AutopilotJob;
  error?: string;
}

export interface AutopilotSyncResult {
  ok: boolean;
  models: number;
  conversations: number;
  error?: string;
}

export interface AutopilotRunActionResult {
  ok: boolean;
  run?: AutopilotRun | null;
  error?: string;
}

export interface AutopilotAction {
  type: 'delete' | 'restore' | 'backup';
  attachmentId: string;
  jobId: string;
}

export interface AutopilotApi {
  snapshot: () => Promise<AutopilotSnapshot>;
  saveJob: (raw: unknown) => Promise<AutopilotJobSaveResult>;
  deleteJob: (id: string) => Promise<{ ok: boolean }>;
  setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean }>;
  runNow: (id: string) => Promise<AutopilotRunActionResult>;
  cancelRun: (runId: string) => Promise<{ ok: boolean }>;
  updateSettings: (patch: Partial<AutopilotSettings>) => Promise<AutopilotSettings>;
  setPaused: (paused: boolean) => Promise<{ ok: boolean }>;
  windows: () => Promise<AutopilotWindowInfo[]>;
  sync: (target: AutopilotTarget) => Promise<AutopilotSyncResult>;
  clearRuns: () => Promise<{ ok: boolean }>;
  attachmentAction: (action: AutopilotAction) => Promise<{ ok: boolean; error?: string }>;
  pickFiles: () => Promise<string[]>;
  setApiKey: (key: string | null) => Promise<{ ok: boolean; error?: string }>;
  hasApiKey: () => Promise<boolean>;
  onUpdate: (listener: (snapshot: AutopilotSnapshot) => void) => () => void;
}
