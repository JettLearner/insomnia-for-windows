import {
  guiTargetAllowed,
  type GuiAncestorInfo,
  type GuiCandidate,
  type GuiConversationTarget,
  type GuiElementCounts,
  type GuiElementInfo,
  type GuiFingerprint,
  type GuiLabel,
  type GuiPreview,
  type GuiPreviewTarget,
  type GuiProfile,
  type GuiRect,
  type GuiRecordEvent,
  type GuiRecordResult,
  type GuiRecordStatus,
  type GuiRecordWindow,
  type GuiSendPlan,
  type GuiSendStep,
  type GuiWindowInfo,
} from './soft-stop';

export interface RawGuiRect {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
}

export interface RawGuiAncestor {
  name?: unknown;
  automationId?: unknown;
  controlType?: unknown;
}

export interface RawGuiElement {
  ref?: unknown;
  name?: unknown;
  automationId?: unknown;
  className?: unknown;
  controlType?: unknown;
  rect?: RawGuiRect;
  enabled?: unknown;
  keyboardFocusable?: unknown;
  editable?: unknown;
  invokable?: unknown;
  selectable?: unknown;
  selected?: unknown;
  expandable?: unknown;
  legacyRole?: unknown;
  ancestors?: RawGuiAncestor[];
}

export interface RawGuiWindow {
  hwnd?: unknown;
  ref?: unknown;
  pid?: unknown;
  process?: unknown;
  title?: unknown;
  className?: unknown;
  rect?: RawGuiRect;
  foreground?: unknown;
  candidates?: RawGuiElement[];
  counts?: Record<string, unknown>;
  error?: unknown;
}

export interface RawGuiScan {
  scannedAt?: unknown;
  windowCount?: unknown;
  windows?: RawGuiWindow[];
}

export interface RawGuiRecordWindow {
  hwnd?: unknown;
  pid?: unknown;
  process?: unknown;
  title?: unknown;
  className?: unknown;
  rect?: RawGuiRect;
  foreground?: unknown;
}

export interface RawGuiRecordEvent {
  kind?: unknown;
  at?: unknown;
  offsetMs?: unknown;
  x?: unknown;
  y?: unknown;
  window?: RawGuiRecordWindow;
  element?: RawGuiElement | null;
}

export interface RawGuiRecordResult {
  recording?: unknown;
  startedAt?: unknown;
  durationMs?: unknown;
  autoStopped?: unknown;
  count?: unknown;
  events?: RawGuiRecordEvent[];
}

export interface RawGuiRecordStatus {
  recording?: unknown;
  startedAt?: unknown;
  maxSeconds?: unknown;
  remainingMs?: unknown;
  autoStopped?: unknown;
  eventCount?: unknown;
}

export interface GuiWindowBase {
  ref: string;
  handle: number;
  pid: number;
  process: string;
  title: string;
  className: string;
  rect: GuiRect;
  foreground: boolean;
  counts?: Partial<GuiElementCounts>;
  error?: string;
}

export interface MappedGuiWindow {
  window: GuiWindowBase;
  elements: GuiElementInfo[];
}

const MSAA_PUSH_BUTTON = 0x2b;
const MSAA_BUTTON_DROPDOWN = 0x38;

const WINDOW_CONTROL = /^(close|minimize|maximize|restore|system menu|关闭|最小化|最大化|还原|系统菜单)(\s|$)/i;
const CHROME_CONTROL =
  /^(settings|preferences|help|about|more( options)?|refresh|reload|back|forward|share|copy|inspect|设置|首选项|帮助|关于|更多|刷新|重新加载|后退|前进|分享|复制)$/i;
const SEARCH_WORD = /(^|\s)(search|find|filter)(\s|$)|搜索|查找|筛选|过滤/i;
const INPUT_WORD =
  /(^|\s)(message|prompt|chat|ask|composer|reply)(\s|$)|输入|消息|提问|对话|问题|回复|发送消息/i;
const INPUT_ANCHOR = /composer|prompt|chat.?input|message.?input|textbox|rich.?text|editor|输入/i;
const SEND_WORD =
  /(^|\s)(send|submit)(\s|$)|send (message|prompt|now)|submit (message|prompt)|发送|提交|送出|送信|보내기|전송|envoyer|soumettre|senden|absenden|enviar|отправить|invia|إرسال|भेज|gönder|gửi|kirim|verzenden|wyślij|ส่ง/i;
const SEND_ANCHOR = /(send|submit)[-_ ]?(button|btn|action|message|prompt)?/i;
const ARROW_GLYPH = /[➤➢➣▶►▷→↑➜➔✈⏎⏩⬆⤴]/;
const STOP_WORD =
  /(^|\s)(stop|halt|abort)(\s|$)|stop (generating|generation|response|output|answering)|cancel (generation|response)|停止|中止|终止|中断|取消生成|停止生成|停止回复|停止回答|生成を停止|중지|멈춤|정지|arrêter|stoppen|detener|остановить|إيقاف|dừng|dur|berhenti/i;
const BUSY_WORD =
  /(generating|generation in progress|thinking|working|running|streaming|responding)|生成中|正在生成|思考中|运行中|处理中|回答中|响应中|응답 중|생성 중|génération en cours|generando|выполняется/i;
const SIDEBAR_WORD =
  /sidebar|side bar|navigation|nav pane|drawer|hamburger|侧边栏|侧栏|导航|菜单|会话列表|对话列表|聊天记录|历史记录|展开|收起|(^|\s)(menu|conversations|history|expand|collapse)(\s|$)|☰|≡/i;
const SIDEBAR_ANCHOR = /sidebar|nav(igation)?|drawer|hamburger|侧栏|侧边/i;
const NEW_CHAT_WORD =
  /(^|\s)(new chat|new conversation|new thread)(\s|$)|新建(对话|会话|聊天)|新对话|新会话|新的对话/i;

const INPUT_MIN = 6;
const SEND_MIN = 6;
const SIDEBAR_MIN = 6;
const CONVERSATION_MIN = 5;
const BUSY_MIN = 4;

interface Score {
  score: number;
  reasons: string[];
}

function emptyScore(): Score {
  return { score: 0, reasons: [] };
}

function asString(value: unknown, max = 300): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function asInt(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function asBool(value: unknown): boolean {
  return value === true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asRect(value: RawGuiRect | GuiRect | undefined): GuiRect {
  if (!value) return { x: 0, y: 0, w: 0, h: 0 };
  const input = value as RawGuiRect;
  return {
    x: asInt(input.x),
    y: asInt(input.y),
    w: Math.max(0, asInt(input.w)),
    h: Math.max(0, asInt(input.h)),
  };
}

function centerX(rect: GuiRect): number {
  return rect.x + rect.w / 2;
}

function centerY(rect: GuiRect): number {
  return rect.y + rect.h / 2;
}

function relX(rect: GuiRect, window: GuiRect): number {
  return (centerX(rect) - window.x) / Math.max(1, window.w);
}

function relY(rect: GuiRect, window: GuiRect): number {
  return (centerY(rect) - window.y) / Math.max(1, window.h);
}

function isPressable(element: GuiElementInfo): boolean {
  return (
    element.invokable ||
    element.controlType === 'Button' ||
    element.legacyRole === MSAA_PUSH_BUTTON ||
    element.legacyRole === MSAA_BUTTON_DROPDOWN
  );
}

function nearInput(element: GuiElementInfo, input: GuiElementInfo): Score {
  const result = emptyScore();
  const dx = Math.abs(centerX(element.rect) - centerX(input.rect));
  const dy = Math.abs(centerY(element.rect) - centerY(input.rect));
  if (dx <= Math.max(280, input.rect.w * 0.6) && dy <= 150) {
    result.score += 3;
    result.reasons.push('near-input');
  }
  const rightOfInput = element.rect.x >= input.rect.x + input.rect.w - 40;
  if (rightOfInput && dy <= 140) {
    result.score += 2;
    result.reasons.push('right-of-input');
  }
  const belowInput = element.rect.y >= input.rect.y + input.rect.h - 20 && element.rect.y <= input.rect.y + input.rect.h + 180;
  if (belowInput && dx <= input.rect.w) {
    result.score += 2;
    result.reasons.push('below-input');
  }
  return result;
}

function scoreInput(element: GuiElementInfo, window: GuiRect): Score {
  const result = emptyScore();
  if (!element.editable) return result;
  if (SEARCH_WORD.test(element.name)) return result;
  if (element.rect.w < 30 || element.rect.h < 12) return result;

  result.score = 5;
  result.reasons.push('editable');
  const y = relY(element.rect, window);
  if (y >= 0.55) {
    result.score += 2;
    result.reasons.push('lower-half');
  } else if (y >= 0.35) {
    result.score += 1;
  } else if (y < 0.13) {
    result.score -= 4;
    result.reasons.push('top-bar');
  }
  if (element.rect.w >= window.w * 0.25) {
    result.score += 1;
    result.reasons.push('wide');
  }
  const haystack = `${element.name} ${element.automationId} ${element.className}`;
  if (INPUT_WORD.test(haystack)) {
    result.score += 3;
    result.reasons.push('input-hint');
  }
  if (INPUT_ANCHOR.test(haystack)) {
    result.score += 2;
    result.reasons.push('input-anchor');
  }
  if (element.controlType === 'Document') {
    result.score += 1;
    result.reasons.push('rich-editor');
  }
  return result;
}

function scoreSend(element: GuiElementInfo, input: GuiElementInfo | null, window: GuiRect): Score {
  const result = emptyScore();
  if (WINDOW_CONTROL.test(element.name) || CHROME_CONTROL.test(element.name)) return result;
  if (STOP_WORD.test(element.name) || STOP_WORD.test(element.automationId)) return result;
  const nameHasSend = SEND_WORD.test(element.name);
  const nameHasArrow = ARROW_GLYPH.test(element.name);
  if (!isPressable(element) && !nameHasSend && !nameHasArrow) return result;

  const haystack = `${element.automationId} ${element.className}`;
  const hasAnchor = SEND_ANCHOR.test(haystack);
  const near = input ? nearInput(element, input) : emptyScore();
  if (!nameHasSend && !nameHasArrow && !hasAnchor) {
    // Geometry alone is only trustworthy for a compact icon button sitting at
    // the right edge of the input; otherwise attachments and toolbar buttons
    // would masquerade as send.
    const rightEdge = near.reasons.includes('right-of-input');
    const compact = element.rect.w <= 120 && element.rect.h <= 120;
    if (!rightEdge || !compact) return result;
  }

  if (nameHasSend) {
    result.score += 6;
    result.reasons.push('send-name');
  } else if (nameHasArrow) {
    result.score += 5;
    result.reasons.push('send-arrow');
  }
  if (hasAnchor) {
    result.score += 3;
    result.reasons.push('send-anchor');
  }
  if (isPressable(element)) {
    result.score += 1;
    result.reasons.push('pressable');
  }
  if (input) {
    result.score += near.score;
    result.reasons.push(...near.reasons);
  }
  if (relY(element.rect, window) < 0.12) {
    result.score -= 4;
    result.reasons.push('top-bar');
  }
  if (element.rect.w > window.w * 0.8) {
    result.score -= 5;
    result.reasons.push('too-wide');
  }
  return result;
}

function scoreSidebar(element: GuiElementInfo, window: GuiRect): Score {
  const result = emptyScore();
  if (WINDOW_CONTROL.test(element.name) || CHROME_CONTROL.test(element.name)) return result;
  const haystack = `${element.name} ${element.automationId} ${element.className}`;
  const named = SIDEBAR_WORD.test(element.name);
  if (!named && !SIDEBAR_ANCHOR.test(haystack)) return result;

  result.score = named ? 5 : 3;
  result.reasons.push('sidebar-name');
  if (element.expandable) {
    result.score += 2;
    result.reasons.push('expandable');
  }
  if (isPressable(element)) {
    result.score += 1;
    result.reasons.push('pressable');
  }
  if (relX(element.rect, window) <= 0.12) {
    result.score += 2;
    result.reasons.push('left-edge');
  }
  if (relY(element.rect, window) <= 0.2) {
    result.score += 1;
    result.reasons.push('top-left');
  }
  if (element.rect.w <= 80 && element.rect.h <= 80) {
    result.score += 1;
    result.reasons.push('compact');
  }
  if (!SIDEBAR_ANCHOR.test(haystack) && relX(element.rect, window) > 0.16) {
    result.score -= 2;
    result.reasons.push('not-edge');
  }
  return result;
}

function scoreConversation(element: GuiElementInfo, window: GuiRect): Score {
  const result = emptyScore();
  const listLike =
    element.selectable || element.controlType === 'ListItem' || element.controlType === 'TabItem';
  if (!listLike) return result;
  if (STOP_WORD.test(element.name)) return result;

  result.score = 3;
  result.reasons.push('list-like');
  const x = relX(element.rect, window);
  if (x <= 0.32) {
    result.score += 2;
    result.reasons.push('sidebar-area');
  } else if (element.controlType === 'ListItem' && x <= 0.45) {
    result.score += 1;
  }
  if (element.name) {
    result.score += 1;
    result.reasons.push('named');
  }
  if (element.selected) {
    result.score += 1;
    result.reasons.push('selected');
  }
  if (NEW_CHAT_WORD.test(element.name)) {
    result.score -= 4;
    result.reasons.push('new-chat');
  }
  if (BUSY_WORD.test(element.name)) {
    result.score += 1;
    result.reasons.push('busy-name');
  }
  return result;
}

function scoreBusy(element: GuiElementInfo, input: GuiElementInfo | null, window: GuiRect): Score {
  const result = emptyScore();
  const stopName = STOP_WORD.test(element.name);
  const stopAnchor = STOP_WORD.test(element.automationId);
  const busyName = BUSY_WORD.test(element.name);
  const busyAnchor = BUSY_WORD.test(element.automationId);
  if (!stopName && !stopAnchor && !busyName && !busyAnchor) return result;

  if (stopName) {
    result.score += 5;
    result.reasons.push('stop-name');
  }
  if (stopAnchor) {
    result.score += 2;
    result.reasons.push('stop-anchor');
  }
  if (busyName) {
    result.score += 3;
    result.reasons.push('busy-name');
  }
  if (busyAnchor) {
    result.score += 1;
    result.reasons.push('busy-anchor');
  }
  if (isPressable(element)) {
    result.score += 1;
    result.reasons.push('pressable');
  }
  if (input) {
    const dx = Math.abs(centerX(element.rect) - centerX(input.rect));
    const dy = Math.abs(centerY(element.rect) - centerY(input.rect));
    if (dx <= 320 && dy <= 220) {
      result.score += 1;
      result.reasons.push('near-input');
    }
  }
  if (relY(element.rect, window) < 0.12 && result.score < 6) {
    result.score -= 1;
    result.reasons.push('top-bar');
  }
  return result;
}

function confidenceFrom(score: number, base = 0.4, step = 0.05): number {
  return Math.round(clamp(base + score * step, 0, 0.97) * 100) / 100;
}

export function mapGuiElement(raw: RawGuiElement): GuiElementInfo {
  const ancestors: GuiAncestorInfo[] = Array.isArray(raw.ancestors)
    ? raw.ancestors.slice(0, 6).map((item) => ({
        name: asString(item?.name, 120),
        automationId: asString(item?.automationId, 120),
        controlType: asString(item?.controlType, 60),
      }))
    : [];
  const legacyRole = asInt(raw.legacyRole, -1);
  return {
    ref: asString(raw.ref, 20),
    name: asString(raw.name, 300),
    automationId: asString(raw.automationId, 120),
    className: asString(raw.className, 120),
    controlType: asString(raw.controlType, 60) || 'Unknown',
    rect: asRect(raw.rect),
    enabled: raw.enabled !== false,
    keyboardFocusable: asBool(raw.keyboardFocusable),
    editable: asBool(raw.editable),
    invokable: asBool(raw.invokable),
    selectable: asBool(raw.selectable),
    selected: asBool(raw.selected),
    expandable: asBool(raw.expandable),
    ...(legacyRole >= 0 ? { legacyRole } : {}),
    ancestors,
  };
}

export function mapGuiWindow(raw: RawGuiWindow): GuiWindowBase {
  const counts: Partial<GuiElementCounts> = {};
  if (raw.counts && typeof raw.counts === 'object') {
    for (const [key, value] of Object.entries(raw.counts)) {
      counts[key] = asInt(value);
    }
  }
  return {
    ref: asString(raw.ref, 20),
    handle: asInt(raw.hwnd),
    pid: asInt(raw.pid),
    process: asString(raw.process, 120),
    title: asString(raw.title, 300),
    className: asString(raw.className, 120),
    rect: asRect(raw.rect),
    foreground: asBool(raw.foreground),
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
    ...(raw.error ? { error: asString(raw.error, 300) } : {}),
  };
}

export function mapScan(raw: unknown): MappedGuiWindow[] {
  if (!raw || typeof raw !== 'object') return [];
  const input = raw as RawGuiScan;
  const windows = Array.isArray(input.windows) ? input.windows.slice(0, 10) : [];
  return windows.map((window) => ({
    window: mapGuiWindow(window),
    elements: Array.isArray(window.candidates)
      ? window.candidates.slice(0, 600).map(mapGuiElement)
      : [],
  }));
}

export function fingerprintFor(element: GuiElementInfo, window: GuiRect): GuiFingerprint {
  const relRect: GuiRect = {
    x: Math.round(((element.rect.x - window.x) / Math.max(1, window.w)) * 1000) / 1000,
    y: Math.round(((element.rect.y - window.y) / Math.max(1, window.h)) * 1000) / 1000,
    w: Math.round((element.rect.w / Math.max(1, window.w)) * 1000) / 1000,
    h: Math.round((element.rect.h / Math.max(1, window.h)) * 1000) / 1000,
  };
  const ancestorPath = (element.ancestors ?? [])
    .slice(0, 4)
    .map((ancestor) => `${ancestor.controlType}:${ancestor.automationId || ancestor.name}`)
    .join('>');
  return {
    automationId: element.automationId.slice(0, 120),
    className: element.className.slice(0, 120),
    controlType: element.controlType.slice(0, 60),
    name: element.name.slice(0, 300),
    ancestorPath: ancestorPath.slice(0, 400),
    relRect,
  };
}

function rectClose(a: GuiRect, b: GuiRect, tolerance = 0.08): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance &&
    Math.abs(a.h - b.h) <= tolerance
  );
}

export function fingerprintMatches(
  fingerprint: GuiFingerprint,
  element: GuiElementInfo,
  window: GuiRect,
): boolean {
  if (fingerprint.controlType && element.controlType !== fingerprint.controlType) return false;
  const rel = fingerprintFor(element, window).relRect;
  if (fingerprint.automationId && fingerprint.automationId === element.automationId) return true;
  if (fingerprint.className && fingerprint.className === element.className && rectClose(fingerprint.relRect, rel)) {
    return true;
  }
  if (fingerprint.name && fingerprint.name === element.name && rectClose(fingerprint.relRect, rel, 0.12)) {
    return true;
  }
  return false;
}

export function matchGuiProfile(
  profiles: readonly GuiProfile[],
  processName: string,
  title: string,
): GuiProfile | null {
  const process = processName.toLowerCase().replace(/\.exe$/, '');
  const windowTitle = title.toLowerCase();
  let best: GuiProfile | null = null;
  for (const profile of profiles) {
    const target = profile.process.toLowerCase().replace(/\.exe$/, '');
    if (target !== '*' && target !== process) continue;
    if (profile.titlePattern && !windowTitle.includes(profile.titlePattern.toLowerCase())) continue;
    if (!best || profile.updatedAt > best.updatedAt) best = profile;
  }
  return best;
}

function profileLabel(
  profile: GuiProfile | null,
  element: GuiElementInfo,
  window: GuiRect,
): GuiLabel | null {
  if (!profile) return null;
  for (const label of ['input', 'send', 'sidebar', 'conversation', 'busy'] as const) {
    const fingerprint = profile.labels[label];
    if (fingerprint && fingerprintMatches(fingerprint, element, window)) return label;
  }
  return null;
}

export function suggestGuiLabel(element: GuiElementInfo, window: GuiRect): Score & { label: GuiLabel } {
  if (WINDOW_CONTROL.test(element.name) || CHROME_CONTROL.test(element.name)) {
    return { label: 'ignore', score: 0, reasons: ['chrome-control'] };
  }
  const busy = scoreBusy(element, null, window);
  if (busy.score >= BUSY_MIN && (STOP_WORD.test(element.name) || STOP_WORD.test(element.automationId))) {
    return { label: 'busy', score: busy.score, reasons: busy.reasons };
  }
  const input = scoreInput(element, window);
  if (input.score >= INPUT_MIN) {
    return { label: 'input', score: input.score, reasons: input.reasons };
  }
  const send = scoreSend(element, null, window);
  if (send.score >= SEND_MIN) {
    return { label: 'send', score: send.score, reasons: send.reasons };
  }
  if (busy.score >= BUSY_MIN) {
    return { label: 'busy', score: busy.score, reasons: busy.reasons };
  }
  const sidebar = scoreSidebar(element, window);
  if (sidebar.score >= SIDEBAR_MIN) {
    return { label: 'sidebar', score: sidebar.score, reasons: sidebar.reasons };
  }
  const conversation = scoreConversation(element, window);
  if (conversation.score >= CONVERSATION_MIN) {
    return { label: 'conversation', score: conversation.score, reasons: conversation.reasons };
  }
  return { label: 'ignore', score: 0, reasons: [] };
}

export function windowIsBusy(elements: readonly GuiElementInfo[]): boolean {
  return elements.some(
    (element) =>
      STOP_WORD.test(element.name) ||
      STOP_WORD.test(element.automationId) ||
      BUSY_WORD.test(element.name),
  );
}

export function classifyWindow(
  window: GuiWindowBase,
  elements: readonly GuiElementInfo[],
  profile: GuiProfile | null = null,
): GuiCandidate[] {
  const scored = elements.map((element) => ({
    element,
    input: scoreInput(element, window.rect),
    send: scoreSend(element, null, window.rect),
    sidebar: scoreSidebar(element, window.rect),
    conversation: scoreConversation(element, window.rect),
    busy: scoreBusy(element, null, window.rect),
  }));

  const inputCandidates = scored
    .filter((entry) => entry.input.score >= INPUT_MIN)
    .sort((a, b) => b.input.score - a.input.score || b.element.rect.y - a.element.rect.y);
  const bestInput = inputCandidates[0]?.element ?? null;

  for (const entry of scored) {
    if (bestInput) entry.send = scoreSend(entry.element, bestInput, window.rect);
    entry.busy = scoreBusy(entry.element, bestInput, window.rect);
  }

  const sendCandidates = scored
    .filter((entry) => entry.send.score >= SEND_MIN)
    .sort((a, b) => b.send.score - a.send.score);
  const sidebarCandidates = scored
    .filter((entry) => entry.sidebar.score >= SIDEBAR_MIN)
    .sort((a, b) => b.sidebar.score - a.sidebar.score)
    .slice(0, 2);
  const conversationCandidates = scored
    .filter((entry) => entry.conversation.score >= CONVERSATION_MIN)
    .sort((a, b) => a.element.rect.y - b.element.rect.y)
    .slice(0, 12);

  const chosen = new Set<GuiElementInfo>();
  const labelFor = new Map<GuiElementInfo, { label: GuiLabel; confidence: number; reasons: string[] }>();
  const blacklisted = new Set<GuiElementInfo>();
  for (const entry of scored) {
    if (WINDOW_CONTROL.test(entry.element.name) || CHROME_CONTROL.test(entry.element.name)) {
      blacklisted.add(entry.element);
    }
  }

  const assign = (
    element: GuiElementInfo,
    label: GuiLabel,
    score: number,
    reasons: string[],
  ): void => {
    if (chosen.has(element) || blacklisted.has(element)) return;
    chosen.add(element);
    labelFor.set(element, { label, confidence: confidenceFrom(score), reasons: reasons.slice(0, 6) });
  };

  for (const entry of scored) {
    const override = profileLabel(profile, entry.element, window.rect);
    if (override && !blacklisted.has(entry.element)) {
      chosen.add(entry.element);
      labelFor.set(entry.element, { label: override, confidence: 0.92, reasons: ['profile-match'] });
    }
  }

  if (bestInput && !chosen.has(bestInput)) {
    const score = inputCandidates[0]?.input.score ?? INPUT_MIN;
    const reasons = inputCandidates[0]?.input.reasons ?? [];
    chosen.add(bestInput);
    labelFor.set(bestInput, { label: 'input', confidence: confidenceFrom(score), reasons });
  }

  for (const entry of scored) {
    if (entry.busy.score >= BUSY_MIN) {
      assign(entry.element, 'busy', entry.busy.score, entry.busy.reasons);
    }
  }
  for (const entry of sendCandidates) {
    if (entry.send.score >= SEND_MIN) {
      assign(entry.element, 'send', entry.send.score, entry.send.reasons);
    }
  }
  for (const entry of sidebarCandidates) {
    assign(entry.element, 'sidebar', entry.sidebar.score, entry.sidebar.reasons);
  }
  for (const entry of conversationCandidates) {
    assign(entry.element, 'conversation', entry.conversation.score, entry.conversation.reasons);
  }

  return elements.map((element) => {
    const assignment = labelFor.get(element);
    return {
      ...element,
      windowRef: window.ref,
      windowHandle: window.handle,
      windowTitle: window.title,
      process: window.process,
      label: assignment?.label ?? 'ignore',
      confidence: assignment?.confidence ?? 0,
      reasons: assignment?.reasons ?? [],
    };
  });
}

export function buildGuiWindows(
  mapped: readonly MappedGuiWindow[],
  profiles: readonly GuiProfile[] = [],
): GuiWindowInfo[] {
  return mapped.map((entry) => {
    const profile = matchGuiProfile(profiles, entry.window.process, entry.window.title);
    return {
      ...entry.window,
      candidates: classifyWindow(entry.window, entry.elements, profile),
      ...(profile ? { profileId: profile.id } : {}),
    };
  });
}

function windowScore(window: GuiWindowInfo, allowlist: readonly string[]): number {
  const inputs = window.candidates.filter((candidate) => candidate.label === 'input');
  const sends = window.candidates.filter((candidate) => candidate.label === 'send');
  const conversations = window.candidates.filter((candidate) => candidate.label === 'conversation');
  let score = 0;
  if (guiTargetAllowed(allowlist, window.process, window.title)) score += 30;
  if (window.foreground) score += 12;
  if (windowIsBusy(window.candidates)) score += 8;
  score += (inputs[0]?.confidence ?? 0) * 4;
  score += (sends[0]?.confidence ?? 0) * 3;
  if (conversations.length > 0) score += 2;
  score += Math.min(3, (window.rect.w * window.rect.h) / 1_000_000);
  return score;
}

export function chooseGuiTarget(
  windows: readonly GuiWindowInfo[],
  allowlist: readonly string[],
): GuiPreviewTarget | null {
  const eligible = windows.filter((window) => {
    if (window.error) return false;
    const inputs = window.candidates.filter((candidate) => candidate.label === 'input');
    const sends = window.candidates.filter((candidate) => candidate.label === 'send');
    return inputs.length > 0 && sends.length > 0;
  });
  const filtered =
    allowlist.length > 0
      ? eligible.filter((window) => guiTargetAllowed(allowlist, window.process, window.title))
      : eligible;
  const pool = filtered.length > 0 ? filtered : allowlist.length > 0 ? [] : eligible;
  if (pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => windowScore(b, allowlist) - windowScore(a, allowlist));
  const best = sorted[0];
  const inputs = best.candidates.filter((candidate) => candidate.label === 'input');
  const sends = best.candidates.filter((candidate) => candidate.label === 'send');
  const confidence = Math.round(
    clamp(0.35 + (inputs[0]?.confidence ?? 0) * 0.3 + (sends[0]?.confidence ?? 0) * 0.3, 0, 0.99) * 100,
  ) / 100;
  return {
    windowRef: best.ref,
    handle: best.handle,
    process: best.process,
    title: best.title,
    foreground: best.foreground,
    busy: windowIsBusy(best.candidates),
    confidence,
  };
}

export interface BuildGuiPreviewOptions {
  allowlist: readonly string[];
  dryRun: boolean;
  autoSend: boolean;
  confirmed: boolean | ((target: GuiPreviewTarget | null) => boolean);
  screenshot?: string | null;
}

export function buildGuiPreview(
  mapped: readonly MappedGuiWindow[],
  profiles: readonly GuiProfile[],
  options: BuildGuiPreviewOptions,
): GuiPreview {
  const windows = buildGuiWindows(mapped, profiles);
  const candidates = windows.flatMap((window) => window.candidates);
  const target = chooseGuiTarget(windows, options.allowlist);
  const targetWindow = target ? windows.find((window) => window.handle === target.handle) ?? null : null;
  const allowlisted = target ? guiTargetAllowed(options.allowlist, target.process, target.title) : false;
  const confirmed =
    typeof options.confirmed === 'function' ? options.confirmed(target) : options.confirmed;
  const needsConfirmation =
    target !== null && !options.dryRun && !options.autoSend && !confirmed;
  let blocked: string | null = null;
  if (!target) blocked = 'NO_TARGET';
  else if (!options.dryRun && !allowlisted) blocked = 'NOT_ALLOWLISTED';
  else if (!options.dryRun && needsConfirmation) blocked = 'NEEDS_CONFIRMATION';

  return {
    ts: Date.now(),
    windows,
    candidates,
    target,
    allowlisted,
    dryRun: options.dryRun,
    needsConfirmation,
    blocked,
    profileId: targetWindow?.profileId ?? null,
    screenshot: options.screenshot ?? null,
  };
}

export function isConversationBusy(candidate: GuiCandidate): boolean {
  return BUSY_WORD.test(candidate.name) || STOP_WORD.test(candidate.name);
}

export function buildGuiSendPlan(preview: GuiPreview): GuiSendPlan | null {
  if (!preview.target) return null;
  const window = preview.windows.find((entry) => entry.handle === preview.target?.handle);
  if (!window) return null;
  const inputs = window.candidates.filter((candidate) => candidate.label === 'input');
  const sends = window.candidates.filter((candidate) => candidate.label === 'send');
  const input = [...inputs].sort((a, b) => b.confidence - a.confidence)[0];
  const send = [...sends].sort((a, b) => b.confidence - a.confidence)[0];
  if (!input || !send) return null;

  const conversations: GuiConversationTarget[] = window.candidates
    .filter((candidate) => candidate.label === 'conversation')
    .map((candidate) => ({
      ref: candidate.ref,
      name: candidate.name,
      selected: candidate.selected,
      busy: isConversationBusy(candidate),
      rect: candidate.rect,
    }))
    .slice(0, 12);

  const busyConversations = conversations.filter((conversation) => conversation.busy);
  const selectedConversations = conversations.filter((conversation) => conversation.selected);
  const chosenConversations =
    busyConversations.length > 0
      ? busyConversations.slice(0, 5)
      : selectedConversations.length > 0
        ? selectedConversations.slice(0, 5)
        : conversations.slice(0, 1);
  const mode: 'active' | 'busy' = busyConversations.length > 0 ? 'busy' : 'active';

  const steps: GuiSendStep[] = [];
  if (chosenConversations.length === 0) {
    steps.push({ action: 'input', ref: input.ref, description: 'fill the prompt input' });
    steps.push({ action: 'send', ref: send.ref, description: 'activate the send control' });
  } else {
    for (const conversation of chosenConversations) {
      if (!conversation.selected) {
        steps.push({
          action: 'select',
          ref: conversation.ref,
          description: `select conversation ${conversation.name || conversation.ref}`,
        });
      }
      steps.push({ action: 'input', ref: input.ref, description: 'fill the prompt input' });
      steps.push({ action: 'send', ref: send.ref, description: 'activate the send control' });
    }
  }

  return {
    target: preview.target,
    inputRef: input.ref,
    sendRef: send.ref,
    conversations,
    mode,
    steps,
  };
}

export function mapRecordWindow(raw: RawGuiRecordWindow | undefined): GuiRecordWindow {
  return {
    handle: asInt(raw?.hwnd),
    pid: asInt(raw?.pid),
    process: asString(raw?.process, 120),
    title: asString(raw?.title, 300),
    className: asString(raw?.className, 120),
    rect: asRect(raw?.rect),
    foreground: asBool(raw?.foreground),
  };
}

export function mapRecordResult(raw: unknown): GuiRecordResult {
  const input = (raw && typeof raw === 'object' ? raw : {}) as RawGuiRecordResult;
  const stoppedAt = Date.now();
  const durationMs = Math.max(0, asInt(input.durationMs));
  const startedAtRaw = typeof input.startedAt === 'string' ? Date.parse(input.startedAt) : NaN;
  const startedAt = Number.isFinite(startedAtRaw) ? startedAtRaw : stoppedAt - durationMs;
  const rawEvents = Array.isArray(input.events) ? input.events.slice(0, 300) : [];
  const events: GuiRecordEvent[] = [];
  for (const item of rawEvents) {
    if (!item) continue;
    const kind = item.kind === 'click' ? 'click' : item.kind === 'hover' ? 'hover' : null;
    if (!kind) continue;
    const window = mapRecordWindow(item.window);
    if (!window.handle) continue;
    const element = item.element ? mapGuiElement(item.element) : null;
    const suggestion = element
      ? suggestGuiLabel(element, window.rect)
      : { label: 'ignore' as GuiLabel, score: 0, reasons: [] as string[] };
    const offsetMs = Math.max(0, asInt(item.offsetMs));
    events.push({
      ts: startedAt + offsetMs,
      offsetMs,
      kind,
      x: asInt(item.x),
      y: asInt(item.y),
      window,
      element,
      suggested: suggestion.label,
      confidence: suggestion.label === 'ignore' ? 0.2 : confidenceFrom(suggestion.score, 0.45, 0.06),
      reasons: suggestion.reasons,
    });
  }
  return {
    startedAt,
    stoppedAt,
    durationMs,
    autoStopped: input.autoStopped === true,
    events,
  };
}

export function mapRecordStatus(raw: unknown): GuiRecordStatus {
  const input = (raw && typeof raw === 'object' ? raw : {}) as RawGuiRecordStatus;
  const startedAtRaw = typeof input.startedAt === 'string' ? Date.parse(input.startedAt) : NaN;
  return {
    recording: input.recording === true,
    startedAt: Number.isFinite(startedAtRaw) ? startedAtRaw : null,
    maxSeconds: clamp(asInt(input.maxSeconds, 300), 15, 300),
    remainingMs: Math.max(0, asInt(input.remainingMs)),
    autoStopped: input.autoStopped === true,
    eventCount: Math.max(0, asInt(input.eventCount)),
  };
}

const PROFILE_LABELS: Array<Exclude<GuiLabel, 'ignore'>> = [
  'input',
  'send',
  'sidebar',
  'conversation',
  'busy',
];

function sanitizeFingerprint(raw: unknown): GuiFingerprint | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const rect = asRect(input.relRect as RawGuiRect | undefined);
  return {
    automationId: asString(input.automationId, 120),
    className: asString(input.className, 120),
    controlType: asString(input.controlType, 60),
    name: asString(input.name, 300),
    ancestorPath: asString(input.ancestorPath, 400),
    relRect: {
      x: clamp(rect.x, -1, 2),
      y: clamp(rect.y, -1, 2),
      w: clamp(rect.w, 0, 2),
      h: clamp(rect.h, 0, 2),
    },
  };
}

export function normalizeGuiProfile(raw: unknown): GuiProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const process = asString(input.process, 120);
  if (!process) return null;
  const labels: GuiProfile['labels'] = {};
  if (input.labels && typeof input.labels === 'object') {
    const source = input.labels as Record<string, unknown>;
    for (const label of PROFILE_LABELS) {
      const fingerprint = sanitizeFingerprint(source[label]);
      if (fingerprint) labels[label] = fingerprint;
    }
  }
  const id = asString(input.id, 80);
  const createdAt = asInt(input.createdAt, Date.now());
  return {
    id: /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id : `gui-${process.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${createdAt}`,
    app: asString(input.app, 120) || process,
    process,
    titlePattern: asString(input.titlePattern, 200),
    createdAt,
    updatedAt: asInt(input.updatedAt, createdAt),
    source: input.source === 'recording' ? 'recording' : 'scan',
    labels,
    sampleCount: clamp(asInt(input.sampleCount, 1), 1, 1000),
    confirmed: input.confirmed === true,
  };
}

export function profileFromPreview(
  preview: GuiPreview,
  options: {
    id: string;
    titlePattern?: string;
    confirmed?: boolean;
    labels?: Partial<Record<Exclude<GuiLabel, 'ignore'>, GuiLabel>>;
  },
): GuiProfile | null {
  if (!preview.target) return null;
  const window = preview.windows.find((entry) => entry.handle === preview.target?.handle);
  if (!window) return null;
  const labels: GuiProfile['labels'] = {};
  for (const label of PROFILE_LABELS) {
    const forced = options.labels?.[label];
    const candidates = window.candidates.filter((candidate) => candidate.label === (forced ?? label));
    const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
    if (best) labels[label] = fingerprintFor(best, window.rect);
  }
  const now = Date.now();
  return {
    id: options.id,
    app: window.process,
    process: window.process,
    titlePattern: options.titlePattern ?? '',
    createdAt: now,
    updatedAt: now,
    source: 'scan',
    labels,
    sampleCount: 1,
    confirmed: options.confirmed === true,
  };
}

export function profileFromRecording(
  events: readonly GuiRecordEvent[],
  options: {
    id: string;
    titlePattern?: string;
    labels?: Partial<Record<Exclude<GuiLabel, 'ignore'>, GuiLabel>>;
    confirmed?: boolean;
  },
): GuiProfile | null {
  const usable = events.filter((event) => event.element && event.window.handle);
  if (usable.length === 0) return null;
  const counts = new Map<string, { count: number; title: string; rect: GuiRect }>();
  for (const event of usable) {
    const key = event.window.process || 'unknown';
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { count: 1, title: event.window.title, rect: event.window.rect });
  }
  const [process, meta] = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  if (!process || !meta) return null;

  const labels: GuiProfile['labels'] = {};
  const best = new Map<Exclude<GuiLabel, 'ignore'>, { confidence: number; fingerprint: GuiFingerprint }>();
  for (const event of usable) {
    if (event.window.process !== process || !event.element) continue;
    for (const label of PROFILE_LABELS) {
      const forced = options.labels?.[label];
      if ((forced ?? event.suggested) !== label) continue;
      const existing = best.get(label);
      if (!existing || event.confidence > existing.confidence) {
        best.set(label, {
          confidence: event.confidence,
          fingerprint: fingerprintFor(event.element, meta.rect),
        });
      }
    }
  }
  for (const [label, entry] of best) labels[label] = entry.fingerprint;
  const now = Date.now();
  return {
    id: options.id,
    app: process,
    process,
    titlePattern: options.titlePattern ?? '',
    createdAt: now,
    updatedAt: now,
    source: 'recording',
    labels,
    sampleCount: usable.length,
    confirmed: options.confirmed === true,
  };
}
