import { scoreModelName, type ThinkingLevel } from '../../shared/autopilot';
import {
  MODEL_NAME_PATTERN,
  MODEL_ROW_RATE,
  parseThinkingLabel,
  thinkingStop,
  THINKING_RING,
  WORKBUDDY_UI,
  ZCODE_POPUP,
  type RatioPoint,
} from '../../shared/autopilot-ui';
import {
  ROLE_BUTTON_DROPDOWN,
  ROLE_EDIT,
  ROLE_LIST_ITEM,
  ROLE_MENU_ITEM,
  ROLE_MENU_POPUP,
  ROLE_OUTLINE_ITEM,
  ROLE_PUSH_BUTTON,
  ROLE_SLIDER,
  ROLE_TEXT,
  STATE_SYSTEM_OFFSCREEN,
  ROLE_LINK,
  ROLE_PANE,
  nodeArea,
  rectContains,
  stateHas,
  type GuiNode,
  type GuiWindow,
  type OcrLine,
  type OcrResult,
} from './autopilot-gui';

export interface WindowSpec {
  processNames: string[];
  titleEquals?: string[];
  titleContains?: string[];
  className?: string;
  /** Match by class alone when the user did not name a process or title. */
  matchAny?: boolean;
}

export function pickTargetWindow(windows: readonly GuiWindow[], spec: WindowSpec): GuiWindow | null {
  const processNames = spec.processNames.map((value) => value.toLowerCase());
  const titleEquals = (spec.titleEquals ?? []).map((value) => value.toLowerCase());
  const titleContains = (spec.titleContains ?? []).map((value) => value.toLowerCase());
  const candidates = windows.filter((win) => {
    const processName = win.process.toLowerCase();
    const title = win.title.toLowerCase();
    const byProcess = processNames.includes(processName);
    const byTitle = titleEquals.includes(title) || titleContains.some((hint) => title.includes(hint));
    if (!spec.matchAny && !byProcess && !byTitle) return false;
    if (spec.className && win.class !== spec.className) return false;
    return win.rect[2] > 300 && win.rect[3] > 200;
  });
  if (!candidates.length) return null;
  const rank = (win: GuiWindow): number => {
    let score = nodeAreaWindow(win);
    if (win.visible) score += 1_000_000;
    if (!win.minimized) score += 2_000_000;
    if (titleEquals.includes(win.title.toLowerCase())) score += 3_000_000;
    return score;
  };
  return [...candidates].sort((a, b) => rank(b) - rank(a))[0];
}

function nodeAreaWindow(win: GuiWindow): number {
  return Math.max(0, win.rect[2]) * Math.max(0, win.rect[3]);
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function visible(node: GuiNode): boolean {
  return !stateHas(node.state, STATE_SYSTEM_OFFSCREEN) && node.rect[2] > 0 && node.rect[3] > 0;
}

export function pickInputNode(nodes: readonly GuiNode[], bounds: Bounds): GuiNode | null {
  const bottomStart = bounds.y + bounds.h * 0.6;
  const candidates = nodes.filter(
    (node) =>
      visible(node) &&
      (node.role === ROLE_EDIT || node.role === ROLE_TEXT || node.role === ROLE_PANE) &&
      node.rect[1] + node.rect[3] / 2 >= bottomStart &&
      node.rect[2] > bounds.w * 0.2 &&
      node.rect[3] >= 24 &&
      node.rect[3] <= bounds.h * 0.4,
  );
  if (candidates.length) {
    const editable = candidates.filter((node) => node.role === ROLE_EDIT);
    return [...(editable.length ? editable : candidates)].sort((a, b) => nodeArea(b) - nodeArea(a))[0];
  }
  // ZCode exposes the composer as a pane whose name is the placeholder text.
  const placeholder = nodes.filter(
    (node) =>
      visible(node) &&
      node.role === ROLE_PANE &&
      node.rect[1] >= bottomStart &&
      /提出|输入|提问|message|ask/i.test(node.name) &&
      node.rect[2] > bounds.w * 0.25,
  );
  return placeholder.sort((a, b) => nodeArea(b) - nodeArea(a))[0] ?? null;
}

export function pickSendButton(nodes: readonly GuiNode[], bounds: Bounds): GuiNode | null {
  const bottom = bounds.y + bounds.h * 0.72;
  const candidates = nodes.filter(
    (node) =>
      visible(node) &&
      (node.role === ROLE_PUSH_BUTTON || node.role === ROLE_LINK) &&
      node.rect[1] >= bottom &&
      node.rect[0] >= bounds.x + bounds.w * 0.6 &&
      node.rect[2] >= 24 &&
      node.rect[2] <= 160 &&
      node.rect[3] >= 24 &&
      node.rect[3] <= 160 &&
      (/发送|send/i.test(node.name) || node.name.trim() === ''),
  );
  if (!candidates.length) return null;
  const named = candidates.filter((node) => /发送|send/i.test(node.name));
  const pool = named.length ? named : candidates;
  return pool.sort((a, b) => b.rect[0] + b.rect[2] - (a.rect[0] + a.rect[2]))[0];
}

export function pickModelTrigger(nodes: readonly GuiNode[], bounds: Bounds): GuiNode | null {
  const bottom = bounds.y + bounds.h * 0.72;
  const candidates = nodes.filter(
    (node) =>
      visible(node) &&
      node.role === ROLE_BUTTON_DROPDOWN &&
      node.rect[1] >= bottom &&
      node.rect[0] >= bounds.x + bounds.w * 0.45,
  );
  if (candidates.length) {
    return [...candidates].sort((a, b) => b.rect[0] + b.rect[2] - (a.rect[0] + a.rect[2]))[0];
  }
  return (
    nodes.filter(
      (node) =>
        visible(node) &&
        node.role === ROLE_BUTTON_DROPDOWN &&
        (MODEL_NAME_PATTERN.test(node.name) || /模型/i.test(node.name)),
    )[0] ?? null
  );
}

export function pickModeTrigger(nodes: readonly GuiNode[], bounds: Bounds): GuiNode | null {
  const bottom = bounds.y + bounds.h * 0.72;
  return (
    nodes.filter(
      (node) =>
        visible(node) &&
        node.role === ROLE_BUTTON_DROPDOWN &&
        node.rect[1] >= bottom &&
        node.rect[0] < bounds.x + bounds.w * 0.45 &&
        /模式|mode/i.test(node.name),
    )[0] ?? null
  );
}

export function findPopup(nodes: readonly GuiNode[]): GuiNode | null {
  const popups = nodes.filter(
    (node) => visible(node) && node.role === ROLE_MENU_POPUP && nodeArea(node) > 5_000,
  );
  return popups.sort((a, b) => nodeArea(b) - nodeArea(a))[0] ?? null;
}

export function popupItems(nodes: readonly GuiNode[], popup: GuiNode): GuiNode[] {
  return nodes.filter(
    (node) =>
      visible(node) &&
      node !== popup &&
      rectContains(popup.rect, node.rect) &&
      (node.role === ROLE_MENU_ITEM ||
        node.role === ROLE_SLIDER ||
        node.role === ROLE_PUSH_BUTTON ||
        node.role === ROLE_TEXT ||
        node.role === ROLE_LIST_ITEM),
  );
}

const NON_MODEL_LABELS = [
  '管理模型',
  '新供应商',
  '添加供应商',
  '供应商',
  '模型',
  '思考强度',
  '返回工作区',
  '刷新',
  '加载中',
  '添加模型',
  '套餐',
  '升级',
  '购买',
  '设置',
];

const SUPPLIER_HINTS = ['start plan', '免费', '供应商', '百炼', 'z.ai', '智谱', 'provider', ' api'];

export function plausibleModelItems(items: readonly GuiNode[]): GuiNode[] {
  return items.filter((node) => {
    if (node.role !== ROLE_MENU_ITEM && node.role !== ROLE_LIST_ITEM) return false;
    const name = node.name.trim();
    if (name.length < 2) return false;
    const lower = name.toLowerCase();
    if (SUPPLIER_HINTS.some((hint) => lower.includes(hint))) return false;
    return !NON_MODEL_LABELS.some((label) => lower.includes(label.toLowerCase()));
  });
}

export function supplierItems(items: readonly GuiNode[]): GuiNode[] {
  return items.filter(
    (node) =>
      (node.role === ROLE_MENU_ITEM || node.role === ROLE_LIST_ITEM) &&
      /start plan|z\.ai|智谱|阿里|百炼|供应商|api|provider/i.test(node.name),
  );
}

export function looksLikeNoQuota(items: readonly GuiNode[], popup: GuiNode): boolean {
  const text = [popup.name, ...items.map((item) => item.name)].join('\n');
  if (/余额不足|额度|暂无可用|无可用模型|已用完|请充值|购买套餐|升级套餐|no quota|out of credits/i.test(text)) {
    return true;
  }
  return plausibleModelItems(items).length === 0;
}

export function pickConversationNode(
  nodes: readonly GuiNode[],
  name: string,
  bounds: Bounds,
): { node: GuiNode | null; ambiguous: boolean } {
  const leftLimit = bounds.x + bounds.w * 0.4;
  const candidates = nodes.filter(
    (node) =>
      visible(node) &&
      node.rect[0] < leftLimit &&
      (node.role === ROLE_PUSH_BUTTON ||
        node.role === ROLE_LIST_ITEM ||
        node.role === ROLE_OUTLINE_ITEM ||
        node.role === ROLE_LINK) &&
      node.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (!candidates.length) return { node: null, ambiguous: false };
  const uniqueRects = new Set(candidates.map((node) => node.rect.join(',')));
  return { node: candidates[0], ambiguous: uniqueRects.size > 1 };
}

export function findNamedNode(
  nodes: readonly GuiNode[],
  names: readonly string[],
  options: { roles?: number[]; exact?: boolean; limit?: number } = {},
): GuiNode | null {
  const roles = options.roles ?? [];
  const exact = options.exact !== false;
  const matches = nodes.filter((node) => {
    if (!visible(node)) return false;
    if (roles.length && !roles.includes(node.role)) return false;
    const name = node.name.trim().toLowerCase();
    return names.some((query) => {
      const q = query.trim().toLowerCase();
      return exact ? name === q : name.includes(q);
    });
  });
  return matches[0] ?? null;
}

export function capabilityNodes(nodes: readonly GuiNode[], name: string): GuiNode[] {
  return nodes.filter(
    (node) =>
      visible(node) &&
      (node.role === ROLE_PUSH_BUTTON || node.role === ROLE_MENU_ITEM || node.role === ROLE_LIST_ITEM) &&
      node.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
}

/** Digest of visible node names, used to detect transcript changes. */
export function transcriptDigest(nodes: readonly GuiNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (!node.name) continue;
    if (node.rect[3] < 8) continue;
    parts.push(`${node.role}:${node.name}`);
  }
  let hash = 2166136261;
  const text = parts.join('\u0001');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

const THINKING_FRACTIONS: Record<ThinkingLevel, number> = {
  off: 0.04,
  low: 0.27,
  medium: 0.5,
  high: 0.73,
  max: 0.96,
};

export function thinkingClickPoint(slider: GuiNode, level: ThinkingLevel): { x: number; y: number } {
  const fraction = THINKING_FRACTIONS[level] ?? thinkingStop(THINKING_RING.length - 1);
  return {
    x: slider.rect[0] + Math.round(slider.rect[2] * fraction),
    y: slider.rect[1] + Math.round(slider.rect[3] / 2),
  };
}

/** The popup row that both names the current supplier and toggles the list. */
export function pickSupplierHeader(items: readonly GuiNode[], popup: GuiNode): GuiNode | null {
  const right = items.filter(
    (node) =>
      node.rect[0] >= popup.rect[0] + popup.rect[2] * ZCODE_POPUP.supplierSplit &&
      node.role === ROLE_MENU_ITEM &&
      node.rect[1] < popup.rect[1] + popup.rect[3] * 0.25,
  );
  return right.sort((a, b) => a.rect[1] - b.rect[1])[0] ?? null;
}

/**
 * Model rows live in the right column; when the supplier list is open its rows
 * occupy the left column and must not be offered as models.
 */
export function modelRowsInPopup(items: readonly GuiNode[], popup: GuiNode): GuiNode[] {
  const splitX = popup.rect[0] + popup.rect[2] * ZCODE_POPUP.supplierSplit;
  const models = plausibleModelItems(items);
  const supplierColumn = items.filter(
    (node) =>
      node.role === ROLE_MENU_ITEM &&
      node.rect[0] < splitX &&
      SUPPLIER_HINTS.some((hint) => node.name.toLowerCase().includes(hint)),
  );
  if (supplierColumn.length < 2) return models;
  return models.filter((node) => node.rect[0] >= splitX - 10);
}

export function readThinkingLevel(items: readonly GuiNode[]): ThinkingLevel | null {
  for (const node of items) {
    if (!node.name.includes('思考强度')) continue;
    const level = parseThinkingLabel(node.name.replace(/思考强度/, '').replace(/Ctrl\+T/i, ''));
    if (level) return level;
  }
  return null;
}

/**
 * Icon-only control that sits on the same row immediately left of a labelled
 * sibling — ZCode's model-refresh button next to `添加供应商`.
 */
export function pickIconLeftOf(
  nodes: readonly GuiNode[],
  label: string,
  options: { roles?: number[] } = {},
): GuiNode | null {
  const roles = options.roles ?? [ROLE_PUSH_BUTTON];
  const anchor = nodes.find(
    (node) => roles.includes(node.role) && node.name.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!anchor) return null;
  const anchorCentreY = anchor.rect[1] + anchor.rect[3] / 2;
  const neighbours = nodes.filter(
    (node) =>
      node !== anchor &&
      visible(node) &&
      roles.includes(node.role) &&
      Math.abs(node.rect[1] + node.rect[3] / 2 - anchorCentreY) <= Math.max(12, anchor.rect[3] * 0.6) &&
      node.rect[0] + node.rect[2] <= anchor.rect[0] + 4 &&
      node.rect[2] <= anchor.rect[2],
  );
  return neighbours.sort((a, b) => b.rect[0] + b.rect[2] - (a.rect[0] + a.rect[2]))[0] ?? null;
}

/**
 * Point just left of a labelled button, used when the neighbouring icon has no
 * accessible name of its own (ZCode's refresh sits one gap left of `添加供应商`).
 */
export function leftOfAnchorPoint(anchor: GuiNode): { x: number; y: number } {
  return {
    x: Math.round(anchor.rect[0] - anchor.rect[2] * 0.35),
    y: Math.round(anchor.rect[1] + anchor.rect[3] / 2),
  };
}

/** Last-resort click point derived from the taught window ratios. */
export function ratioPoint(bounds: Bounds, at: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.w * at.x),
    y: Math.round(bounds.y + bounds.h * at.y),
  };
}

/** Popup-relative point, used when a control has neither a name nor a node. */
export function popupRatioPoint(popup: GuiNode, at: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(popup.rect[0] + popup.rect[2] * at.x),
    y: Math.round(popup.rect[1] + popup.rect[3] * at.y),
  };
}

// ---------------------------------------------------------------------------
// OCR (WorkBuddy) heuristics
// ---------------------------------------------------------------------------

export interface OcrRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function ocrInputRegion(ocr: OcrResult): OcrRegion | null {
  const width = ocr.width;
  const height = ocr.height;
  const bottomStart = height * 0.55;
  const placeholder = ocr.lines.filter(
    (line) =>
      line.y >= bottomStart &&
      line.w >= width * 0.12 &&
      line.w <= width * 0.9 &&
      /请输入|输入|提问|发消息|做些什么|message|ask|reply/i.test(line.text),
  );
  if (placeholder.length) {
    const line = placeholder.sort((a, b) => b.y - a.y)[0];
    return {
      x: Math.max(0, line.x - 24),
      y: Math.max(0, line.y - 16),
      w: Math.min(width - line.x, Math.max(line.w + 48, width * 0.6)),
      h: Math.max(48, line.h + 32),
    };
  }
  // Fall back to the widest text-less band in the bottom third.
  return { x: Math.round(width * 0.18), y: Math.round(height * 0.82), w: Math.round(width * 0.62), h: Math.round(height * 0.1) };
}

export function ocrSendPoint(
  ocr: OcrResult,
  input: OcrRegion | null,
  at: RatioPoint = WORKBUDDY_UI.send.at as RatioPoint,
): { x: number; y: number } | null {
  const candidates = ocr.lines.filter((line) => /发送|send|^[↑➤→]$/i.test(line.text.trim()));
  const inBottom = candidates.filter((line) => input === null || line.y + line.h >= input.y - 40);
  if (inBottom.length) {
    const line = inBottom.sort((a, b) => b.x - a.x)[0];
    return { x: line.x + Math.round(line.w / 2), y: line.y + Math.round(line.h / 2) };
  }
  if (!input) return null;
  // The send control sits on the toolbar row under the text, hard right. The
  // taught ratio is window-relative, so it survives a non-maximised window.
  const x = Math.round(ocr.width * at.x);
  const rowBottom = Math.min(input.y + input.h + Math.round(input.h * 0.8), ocr.height - 8);
  return { x, y: Math.max(Math.round(ocr.height * at.y), rowBottom) };
}

export function ocrTextIn(ocr: OcrResult, region: OcrRegion): string {
  return ocr.lines
    .filter((line) => rectContainsOcr(region, line))
    .map((line) => line.text)
    .join('\n');
}

export function ocrTranscript(ocr: OcrResult, input: OcrRegion): string {
  return ocr.lines
    .filter((line) => line.y + line.h < input.y - 8)
    .map((line) => line.text)
    .join('\n');
}

function rectContainsOcr(outer: OcrRegion, inner: OcrRegion): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

export function pickOcrModelName(ocr: OcrResult, input: OcrRegion): string | null {
  return pickOcrModelTrigger(ocr, input)?.text.trim() ?? null;
}

/** Toolbar line that carries the active model, with clickable bounds. */
export function pickOcrModelTrigger(ocr: OcrResult, input: OcrRegion): OcrLine | null {
  const reach = Math.max(120, input.h * 2);
  const band = ocr.lines.filter(
    (line) =>
      line.y > input.y - 160 &&
      line.y < input.y + input.h + reach &&
      !MODEL_ROW_RATE.test(line.text) &&
      MODEL_NAME_PATTERN.test(line.text),
  );
  return band.sort((a, b) => b.x - a.x)[0] ?? null;
}

/**
 * Row inside an opened model picker. WorkBuddy appends a consumption rate to
 * every row, which is what separates `GLM-5.3 0.69x` from the toolbar label.
 */
export function pickOcrModelRow(
  ocr: OcrResult,
  query: string,
  options: { exclude?: string; minScore?: number } = {},
): { line: OcrLine; score: number } | null {
  const minScore = options.minScore ?? 60;
  const exclude = options.exclude?.trim().toLowerCase();
  const rateRows: Array<{ line: OcrLine; score: number }> = [];
  const nameRows: Array<{ line: OcrLine; score: number }> = [];
  for (const line of ocr.lines) {
    const text = line.text.trim();
    if (!text || text.toLowerCase() === exclude) continue;
    if (!MODEL_NAME_PATTERN.test(text)) continue;
    const score = scoreModelName(text, query);
    if (score < minScore) continue;
    (MODEL_ROW_RATE.test(text) ? rateRows : nameRows).push({ line, score });
  }
  // Transcript text can mention model names; the picker is the right-hand
  // column and every row carries a consumption rate, so rate rows win and
  // name-only rows are only trusted when they sit where the picker opens.
  const pool = rateRows.length
    ? rateRows
    : nameRows.filter((entry) => entry.line.x > ocr.width * 0.5);
  return pool.sort((a, b) => b.score - a.score)[0] ?? null;
}

/** Preset rows (快速 / 均衡 / 极致) are WorkBuddy's stand-in for thinking strength. */
export function pickOcrPresetRow(ocr: OcrResult, label: string): OcrLine | null {
  const matches = ocr.lines.filter((line) => {
    const text = line.text.trim();
    return text === label || text.startsWith(`${label} `);
  });
  if (!matches.length) return null;
  // A rate-bearing row is a picker entry; a bare word may be chat text.
  return matches.find((line) => MODEL_ROW_RATE.test(line.text)) ?? matches[0];
}
