import type { ThinkingLevel } from './autopilot';

/**
 * Screen knowledge taught by the operator (2026-11-01) for the delivery
 * targets. Every coordinate is a ratio of the *window* (0,0 = client top-left,
 * 1,1 = client bottom-right) or of the popup it belongs to, so the values stay
 * valid when the target is not maximised, sits on a second monitor, or runs at
 * another DPI scale.
 *
 * Resolution order at runtime is always: MSAA accessible name/role -> OCR label
 * -> ratio anchor from this file. A ratio is only clicked after the current
 * tree/text snapshot confirms nothing better was found.
 */

export interface RatioPoint {
  x: number;
  y: number;
}

/** Ordered ring that ZCode walks through with a single Ctrl+T press. */
export const THINKING_RING: Array<{ level: ThinkingLevel; label: string }> = [
  { level: 'off', label: '关闭' },
  { level: 'low', label: '低' },
  { level: 'medium', label: '中' },
  { level: 'high', label: '高' },
  { level: 'max', label: '最高' },
];

const LABEL_LOOKUP = THINKING_RING.slice().sort((a, b) => b.label.length - a.label.length);

/** Reads the level out of strings like `思考强度 最高` or `deepseek-v4-pro 高`. */
export function parseThinkingLabel(text: string | undefined | null): ThinkingLevel | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s*(?:ctrl|shift|alt)\+\w+\s*$/i, '');
  for (const { label, level } of LABEL_LOOKUP) {
    // Longest label first so `最高` wins over `高`.
    if (trimmed === label || trimmed.endsWith(` ${label}`) || trimmed.endsWith(label)) return level;
  }
  return null;
}

export function thinkingLabelFor(level: ThinkingLevel): string {
  return THINKING_RING.find((entry) => entry.level === level)?.label ?? level;
}

/** Stop position (0..1 across the slider track) for a ring index. */
export function thinkingStop(index: number, count = THINKING_RING.length): number {
  if (count <= 1) return 0.5;
  const usable = 0.93;
  const lead = 0.035;
  return lead + (usable * index) / (count - 1);
}

/** Number of Ctrl+T presses that move `from` to `to` on the ring. */
export function thinkingSteps(from: ThinkingLevel, to: ThinkingLevel): number {
  const a = THINKING_RING.findIndex((entry) => entry.level === from);
  const b = THINKING_RING.findIndex((entry) => entry.level === to);
  if (a === -1 || b === -1) return -1;
  return (b - a + THINKING_RING.length) % THINKING_RING.length;
}

export interface AnchorSpec {
  /** Accessible/OCR labels, most specific first. */
  labels?: string[];
  /** Ratio fallback inside the window client area. */
  at?: RatioPoint;
  /** Ratio fallback inside the model popup. */
  inPopup?: RatioPoint;
  /**
   * Icon-only control found by walking left from a labelled sibling on the same
   * row (ZCode's refresh button sits left of `添加供应商`).
   */
  leftOfLabel?: string;
}

/** Composer toolbar + sidebar, ZCode. Ratios measured from a 1920x1140 capture. */
export const ZCODE_UI: Record<string, AnchorSpec> = {
  input: { labels: ['提出后续修改要求', '输入内容'], at: { x: 0.573, y: 0.868 } },
  attach: { labels: ['添加上下文', '附件'], at: { x: 0.285, y: 0.932 } },
  permission: { labels: ['完全访问', '允许完全访问'], at: { x: 0.335, y: 0.932 } },
  contextRing: { at: { x: 0.761, y: 0.932 } },
  modelTrigger: { at: { x: 0.833, y: 0.932 } },
  send: { labels: ['发送'], at: { x: 0.916, y: 0.932 } },
  modeTrigger: { labels: ['切换模式'], at: { x: 0.343, y: 0.918 } },
  newTask: { labels: ['新建任务'], at: { x: 0.049, y: 0.107 } },
  firstConversation: { at: { x: 0.075, y: 0.348 } },
  settingsGear: { labels: ['设置'], at: { x: 0.18, y: 0.958 } },
  workspaceSwitcher: { labels: ['工作区'], at: { x: 0.797, y: 0.041 } },
  settingsBack: { labels: ['返回工作区'], at: { x: 0.099, y: 0.103 } },
  settingsNavModel: { labels: ['模型设置'], at: { x: 0.049, y: 0.292 } },
  settingsAddProvider: { labels: ['添加供应商'], at: { x: 0.879, y: 0.178 } },
  settingsRefresh: { leftOfLabel: '添加供应商', at: { x: 0.824, y: 0.178 } },
  settingsAddModel: { labels: ['添加模型'], at: { x: 0.868, y: 0.686 } },
  /** Left column of the popup only appears after clicking the supplier header. */
  supplierHeader: { at: { x: 0.726, y: 0.092 }, inPopup: { x: 0.726, y: 0.092 } },
  manageModels: { labels: ['管理模型'], inPopup: { x: 0.14, y: 0.414 } },
  firstModelRow: { inPopup: { x: 0.72, y: 0.272 } },
  thinkingSlider: { labels: ['思考强度'], inPopup: { x: 0.717, y: 0.81 } },
};

/**
 * Model popup layout. The supplier list occupies the left part of the popup
 * when open, so model rows must be taken from the right part only — otherwise
 * `Start Plan` / `阿里云百炼` get mistaken for models.
 */
export const ZCODE_POPUP = {
  supplierSplit: 0.5,
  rowPitch: 0.111,
  rowCount: 4,
};

/** WorkBuddy exposes almost nothing to MSAA; labels are the primary channel. */
export const WORKBUDDY_UI: Record<string, AnchorSpec> = {
  input: { labels: ['今天帮你做些什么', '添加上下文', '调用技能与指令'], at: { x: 0.5, y: 0.82 } },
  attach: { at: { x: 0.045, y: 0.93 } },
  permission: { labels: ['允许完全访问', '完全访问'], at: { x: 0.16, y: 0.93 } },
  contextRing: { at: { x: 0.72, y: 0.93 } },
  modelTrigger: { at: { x: 0.79, y: 0.93 } },
  voiceInput: { at: { x: 0.87, y: 0.93 } },
  send: { labels: ['发送'], at: { x: 0.955, y: 0.93 } },
  configureModels: { labels: ['配置自定义模型'] },
  /** Preset rows are not models but do switch the model, so they are listed. */
  presets: { labels: ['快速', '均衡', '极致'] },
};

/** Rows in the WorkBuddy picker are labelled `名称 0.29x`; the rate is a stable OCR anchor. */
export const MODEL_ROW_RATE = /\d+(?:\.\d+)?x/;

/**
 * Names that identify a model wherever they are read. `Hy3` / `Hy4 preview`
 * are WorkBuddy's Hunyuan entries and carry no recognizable word otherwise.
 */
export const MODEL_NAME_PATTERN =
  /\b(glm|qwen|deepseek|kimi|doubao|gpt|claude|minimax|gemini|llama|hunyuan|hy\d|opc-|ernie|spark|grok|mistral|step-|dola|seed-|ring-)/i;

/** Text that marks a popup row as the currently selected model. */
export const SELECTED_MARKS = ['✓', '✔', '已选择', '当前'];

/**
 * Things that are never a conversation title in the ZCode sidebar. Message
 * actions (复制/赞/踩/分叉) are filtered by geometry, these by name.
 */
export const SIDEBAR_NOISE = ['新建任务', '自动化', '插件市场', '任务列表', '项目', '任务', '搜索', '筛选'];
