export const SOFT_STOP_PROMPT_MAX = 2000;
export const SOFT_STOP_RETRY_COOLDOWN_MS = 5 * 60_000;
export const SOFT_STOP_MAX_ATTEMPTS = 2;

export type SoftStopAdapterKind = 'http' | 'cli' | 'webhook';
export type SoftStopActionKind = 'none' | 'detect' | 'dry-run' | 'sent' | 'failed' | 'sleep' | 'skipped' | 'reset';
export type SoftStopPhase =
  | 'off'
  | 'idle'
  | 'monitoring'
  | 'detected'
  | 'sending'
  | 'sent'
  | 'cooldown'
  | 'sleeping'
  | 'error';

export type AiStreamingLevel = 'none' | 'suspected' | 'likely';
export type NetworkAdapterType = 'wifi' | 'wwan' | 'ethernet' | 'other';

export interface NetworkAdapterInfo {
  name: string;
  type: NetworkAdapterType;
  up: boolean;
}

export interface LocalAiRuntime {
  id: string;
  label: string;
  process: string;
  pid: number | null;
  port: number | null;
  evidence: string[];
}

export interface RemoteAiHost {
  host: string;
  evidence: string[];
}

export interface AiActivitySnapshot {
  ts: number;
  network: {
    adapters: NetworkAdapterInfo[];
    throughputBps: number;
  };
  local: LocalAiRuntime[];
  remote: RemoteAiHost[];
  streaming: AiStreamingLevel;
  confidence: number;
  evidence: string[];
}

export interface SoftStopStatus {
  phase: SoftStopPhase;
  triggeredThisCycle: boolean;
  attempts: number;
  lastSample: AiActivitySnapshot | null;
  lastAction: SoftStopActionKind;
  lastActionAt: number | null;
  lastActionTarget: string | null;
  lastError: string | null;
  hasHttpKey: boolean;
  profileCount: number;
}

export const EMPTY_SOFT_STOP_STATUS: SoftStopStatus = {
  phase: 'off',
  triggeredThisCycle: false,
  attempts: 0,
  lastSample: null,
  lastAction: 'none',
  lastActionAt: null,
  lastActionTarget: null,
  lastError: null,
  hasHttpKey: false,
  profileCount: 0,
};

export type SoftStopAuditAction =
  | 'detect'
  | 'send'
  | 'dry-run'
  | 'skip'
  | 'sleep'
  | 'error'
  | 'reset'
  | 'profile'
  | 'record';

export interface SoftStopAuditEntry {
  ts: number;
  action: SoftStopAuditAction;
  target: string;
  result: 'ok' | 'failed' | 'info';
  detail: string;
}

export interface SoftStopCycle {
  cycleStartedAt: number | null;
  triggered: boolean;
  attempts: number;
  lastAttemptAt: number | null;
}

export const EMPTY_SOFT_STOP_CYCLE: SoftStopCycle = {
  cycleStartedAt: null,
  triggered: false,
  attempts: 0,
  lastAttemptAt: null,
};

export interface SoftStopTemplateVars {
  prompt: string;
  percent: number | null;
  threshold: number;
  sleepThreshold: number;
  model: string;
}

const TEMPLATE_KEYS: Array<keyof SoftStopTemplateVars> = [
  'prompt',
  'percent',
  'threshold',
  'sleepThreshold',
  'model',
];

export function renderTemplate(template: string, vars: Partial<SoftStopTemplateVars>): string {
  let output = template;
  for (const key of TEMPLATE_KEYS) {
    const value = vars[key];
    if (value === undefined || value === null) continue;
    output = output.split(`{${key}}`).join(String(value));
  }
  return output;
}

export function renderDeep<T>(value: T, vars: Partial<SoftStopTemplateVars>): T {
  if (typeof value === 'string') return renderTemplate(value, vars) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, vars)) as unknown as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = renderDeep(item, vars);
    }
    return result as unknown as T;
  }
  return value;
}

export function clampSoftStopThresholds(a: unknown, b: unknown): { threshold: number; sleepThreshold: number } {
  const rawA = typeof a === 'number' && Number.isFinite(a) ? Math.round(a) : 30;
  const rawB = typeof b === 'number' && Number.isFinite(b) ? Math.round(b) : 10;
  const threshold = Math.min(95, Math.max(10, rawA));
  const sleepThreshold = Math.min(threshold - 5, Math.max(5, rawB));
  return { threshold, sleepThreshold };
}

export function normalizeSoftStopPrompt(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return cleaned.length > SOFT_STOP_PROMPT_MAX ? cleaned.slice(0, SOFT_STOP_PROMPT_MAX) : cleaned;
}

export function normalizeAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const entry = raw
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 100);
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length >= 32) break;
  }
  return result;
}

export function normalizeProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(trimmed) ? trimmed : null;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

export interface NormalizedEndpoint {
  base: string | null;
  remote: boolean;
}

export function normalizeEndpoint(value: unknown): NormalizedEndpoint {
  if (typeof value !== 'string') return { base: null, remote: false };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300) return { base: null, remote: false };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { base: null, remote: false };
    if (url.username || url.password) return { base: null, remote: false };
    if (url.search || url.hash) return { base: null, remote: false };
    const path = url.pathname.replace(/\/+$/, '');
    const base = `${url.protocol}//${url.host}${path}`;
    return { base, remote: !isLoopbackHost(url.hostname) };
  } catch {
    return { base: null, remote: false };
  }
}

export function normalizeModelName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

export function runtimeIsIdle(runtime: LocalAiRuntime): boolean {
  return runtime.evidence.includes('idle');
}

export function requestHasAiActivity(snapshot: AiActivitySnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.local.some((runtime) => !runtimeIsIdle(runtime))) return true;
  return snapshot.streaming !== 'none';
}

export function guiTargetAllowed(
  allowlist: readonly string[],
  processName: string | null | undefined,
  title: string | null | undefined,
): boolean {
  if (allowlist.length === 0) return false;
  const process = (processName ?? '').toLowerCase();
  const windowTitle = (title ?? '').toLowerCase();
  return allowlist.some((entry) => {
    const needle = entry.toLowerCase();
    return (process.length > 0 && (process === needle || process.includes(needle))) ||
      (windowTitle.length > 0 && windowTitle.includes(needle));
  });
}

export interface SoftStopCycleContext {
  enabled: boolean;
  active: boolean;
  ac: boolean;
  percent: number | null;
  threshold: number;
  sleepThreshold: number;
  dryRun: boolean;
  cycle: SoftStopCycle;
  hasActivity: boolean;
  activityKnown: boolean;
  now: number;
  retryCooldownMs?: number;
  maxAttempts?: number;
}

export type SoftStopDecision =
  | { type: 'inactive'; reason: 'disabled' | 'inactive-session' | 'ac' | 'no-battery' }
  | { type: 'wait'; reason: 'above-threshold' | 'already-triggered' }
  | { type: 'sleep' }
  | { type: 'detect' }
  | { type: 'send'; dryRun: boolean }
  | { type: 'cooldown'; retryAt: number }
  | { type: 'exhausted' }
  | { type: 'wait-activity' };

export function planSoftStopTick(input: SoftStopCycleContext): SoftStopDecision {
  if (!input.enabled) return { type: 'inactive', reason: 'disabled' };
  if (!input.active) return { type: 'inactive', reason: 'inactive-session' };
  if (input.ac) return { type: 'inactive', reason: 'ac' };
  if (input.percent === null) return { type: 'inactive', reason: 'no-battery' };

  if (input.percent <= input.sleepThreshold) return { type: 'sleep' };
  if (input.percent > input.threshold) return { type: 'wait', reason: 'above-threshold' };
  if (input.cycle.triggered) return { type: 'wait', reason: 'already-triggered' };

  const maxAttempts = input.maxAttempts ?? SOFT_STOP_MAX_ATTEMPTS;
  if (input.cycle.attempts >= maxAttempts) return { type: 'exhausted' };

  const cooldown = input.retryCooldownMs ?? SOFT_STOP_RETRY_COOLDOWN_MS;
  if (input.cycle.lastAttemptAt !== null && input.now - input.cycle.lastAttemptAt < cooldown) {
    return { type: 'cooldown', retryAt: input.cycle.lastAttemptAt + cooldown };
  }

  if (!input.activityKnown) return { type: 'detect' };
  if (!input.hasActivity) return { type: 'wait-activity' };
  return { type: 'send', dryRun: input.dryRun };
}

export function softStopCycleActive(cycle: SoftStopCycle, sessionStartedAt: number | null): SoftStopCycle {
  if (sessionStartedAt === null) return { ...EMPTY_SOFT_STOP_CYCLE };
  if (cycle.cycleStartedAt === sessionStartedAt) return cycle;
  return { cycleStartedAt: sessionStartedAt, triggered: false, attempts: 0, lastAttemptAt: null };
}

export function shouldResetSoftStopCycle(
  cycle: SoftStopCycle,
  ac: boolean,
  percent: number | null,
  threshold: number,
): boolean {
  if (cycle.cycleStartedAt === null) return false;
  if (ac) return cycle.triggered || cycle.attempts > 0;
  if (percent !== null && percent > threshold + 5) return cycle.triggered || cycle.attempts > 0;
  return false;
}

export function sanitizeSoftStopCycle(raw: unknown, sessionStartedAt: number | null): SoftStopCycle {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SOFT_STOP_CYCLE, cycleStartedAt: sessionStartedAt };
  const input = raw as Record<string, unknown>;
  if (sessionStartedAt === null) return { ...EMPTY_SOFT_STOP_CYCLE };
  if (input.cycleStartedAt !== sessionStartedAt) {
    return { cycleStartedAt: sessionStartedAt, triggered: false, attempts: 0, lastAttemptAt: null };
  }
  const attempts =
    typeof input.attempts === 'number' && Number.isFinite(input.attempts)
      ? Math.min(SOFT_STOP_MAX_ATTEMPTS, Math.max(0, Math.round(input.attempts)))
      : 0;
  const lastAttemptAt =
    input.lastAttemptAt === null
      ? null
      : typeof input.lastAttemptAt === 'number' && Number.isFinite(input.lastAttemptAt)
        ? input.lastAttemptAt
        : null;
  return {
    cycleStartedAt: sessionStartedAt,
    triggered: input.triggered === true,
    attempts,
    lastAttemptAt,
  };
}

export interface SoftStopHttpDiscover {
  path: string;
  modelPath?: string;
  fallbackPath?: string;
  fallbackModelPath?: string;
}

export interface SoftStopHttpRequest {
  path: string;
  body: unknown;
  headers?: Record<string, string>;
}

export interface SoftStopHttpAuth {
  header: string;
  scheme?: string;
}

export interface SoftStopHttpProfile {
  base: string;
  discover?: SoftStopHttpDiscover;
  send: SoftStopHttpRequest;
  auth?: SoftStopHttpAuth;
  timeoutMs?: number;
}

export interface SoftStopCliProfile {
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface SoftStopWebhookProfile {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface SoftStopAdapter {
  id: string;
  label: string;
  kind: SoftStopAdapterKind;
  match: {
    processes?: string[];
    ports?: number[];
    hosts?: string[];
  };
  http?: SoftStopHttpProfile;
  cli?: SoftStopCliProfile;
  webhook?: SoftStopWebhookProfile;
  spawnOnly?: boolean;
  notes?: string;
}

export interface SoftStopKnowledgeBase {
  version: number;
  adapters: SoftStopAdapter[];
}

export function findAdapter(kb: SoftStopKnowledgeBase, id: string | null): SoftStopAdapter | null {
  if (!id) return null;
  return kb.adapters.find((adapter) => adapter.id === id) ?? null;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function processMatchesPattern(processName: string, pattern: string): boolean {
  return wildcardToRegExp(pattern).test(processName);
}

export function adapterMatchesProcess(adapter: SoftStopAdapter, processName: string): boolean {
  return (adapter.match.processes ?? []).some((pattern) => processMatchesPattern(processName, pattern));
}

export function adapterMatchesHost(adapter: SoftStopAdapter, host: string): boolean {
  const needle = host.toLowerCase();
  return (adapter.match.hosts ?? []).some((candidate) => {
    const pattern = candidate.toLowerCase();
    return needle === pattern || needle.endsWith(`.${pattern}`);
  });
}

export function adapterMatchesPort(adapter: SoftStopAdapter, port: number): boolean {
  return (adapter.match.ports ?? []).includes(port);
}

export function getPathValue(value: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function pickModelFromPayload(payload: unknown, discover: SoftStopHttpDiscover | undefined): string {
  if (!discover) return '';
  const first = getPathValue(payload, discover.modelPath ?? '');
  if (typeof first === 'string' && first.trim()) return first.trim();
  const fallback = getPathValue(payload, discover.fallbackModelPath ?? '');
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return '';
}

export interface SoftStopSendResult {
  ok: boolean;
  dryRun: boolean;
  adapterId: string | null;
  target: string | null;
  model: string | null;
  detail: string;
  status?: number;
  error?: string;
}

export interface SoftStopAdapterInfo {
  id: string;
  label: string;
  kind: SoftStopAdapterKind;
  builtin: boolean;
  spawnOnly: boolean;
}

export interface GuiRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GuiAncestorInfo {
  name: string;
  automationId: string;
  controlType: string;
}

export interface GuiElementInfo {
  ref: string;
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  rect: GuiRect;
  enabled: boolean;
  keyboardFocusable: boolean;
  editable: boolean;
  invokable: boolean;
  selectable: boolean;
  selected: boolean;
  expandable: boolean;
  legacyRole?: number;
  ancestors?: GuiAncestorInfo[];
}

export interface GuiElementCounts {
  edits: number;
  documents: number;
  buttons: number;
  listItems: number;
  tabItems: number;
  hyperlinks: number;
  editable: number;
  [key: string]: number;
}

export type GuiLabel = 'input' | 'send' | 'sidebar' | 'conversation' | 'busy' | 'ignore';

export interface GuiCandidate extends GuiElementInfo {
  windowRef: string;
  windowHandle: number;
  windowTitle: string;
  process: string;
  label: GuiLabel;
  confidence: number;
  reasons: string[];
}

export interface GuiWindowInfo {
  ref: string;
  handle: number;
  pid: number;
  process: string;
  title: string;
  className: string;
  rect: GuiRect;
  foreground: boolean;
  candidates: GuiCandidate[];
  counts?: Partial<GuiElementCounts>;
  profileId?: string;
  error?: string;
}

export interface GuiPreviewTarget {
  windowRef: string;
  handle: number;
  process: string;
  title: string;
  foreground: boolean;
  busy: boolean;
  confidence: number;
}

export interface GuiPreview {
  ts: number;
  windows: GuiWindowInfo[];
  candidates: GuiCandidate[];
  target: GuiPreviewTarget | null;
  allowlisted: boolean;
  dryRun: boolean;
  needsConfirmation: boolean;
  blocked: string | null;
  profileId: string | null;
  screenshot: string | null;
}

export interface GuiFingerprint {
  automationId: string;
  className: string;
  controlType: string;
  name: string;
  ancestorPath: string;
  relRect: GuiRect;
}

export interface GuiProfile {
  id: string;
  app: string;
  process: string;
  titlePattern: string;
  createdAt: number;
  updatedAt: number;
  source: 'recording' | 'scan';
  labels: Partial<Record<Exclude<GuiLabel, 'ignore'>, GuiFingerprint>>;
  sampleCount: number;
  confirmed?: boolean;
}

export interface GuiConversationTarget {
  ref: string;
  name: string;
  selected: boolean;
  busy: boolean;
  rect: GuiRect;
}

export type GuiSendStepAction = 'setup' | 'select' | 'input' | 'send';

export interface GuiSendStep {
  action: GuiSendStepAction;
  ref: string;
  description: string;
}

export interface GuiSendPlan {
  target: GuiPreviewTarget;
  inputRef: string;
  sendRef: string;
  conversations: GuiConversationTarget[];
  mode: 'active' | 'busy';
  steps: GuiSendStep[];
}

export interface GuiSendStepResult {
  action: GuiSendStepAction;
  conversation: string | null;
  ok: boolean;
  method?: string;
  error?: string;
}

export interface GuiSendResult {
  ok: boolean;
  dryRun: boolean;
  blocked: string | null;
  needsConfirmation: boolean;
  target: GuiPreviewTarget | null;
  attempts: number;
  sent: number;
  steps: GuiSendStepResult[];
  detail: string;
  preview: GuiPreview | null;
}

export interface GuiRecordWindow {
  handle: number;
  pid: number;
  process: string;
  title: string;
  className: string;
  rect: GuiRect;
  foreground: boolean;
}

export interface GuiRecordEvent {
  ts: number;
  offsetMs: number;
  kind: 'click' | 'hover';
  x: number;
  y: number;
  window: GuiRecordWindow;
  element: GuiElementInfo | null;
  suggested: GuiLabel;
  confidence: number;
  reasons: string[];
}

export interface GuiRecordResult {
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  autoStopped: boolean;
  events: GuiRecordEvent[];
}

export interface GuiRecordStatus {
  recording: boolean;
  startedAt: number | null;
  maxSeconds: number;
  remainingMs: number;
  autoStopped: boolean;
  eventCount: number;
}

export interface GuiRecordStartResult {
  ok: boolean;
  startedAt: number | null;
  error?: string;
}
