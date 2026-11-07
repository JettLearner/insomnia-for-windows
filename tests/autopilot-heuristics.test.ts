import { describe, expect, it } from 'vitest';
import type { GuiNode, GuiWindow, OcrResult } from '../electron/core/autopilot-gui';
import {
  findNamedNode,
  findPopup,
  looksLikeNoQuota,
  ocrInputRegion,
  ocrSendPoint,
  ocrTextIn,
  ocrTranscript,
  pickConversationNode,
  pickInputNode,
  pickModelTrigger,
  pickModeTrigger,
  pickOcrModelName,
  pickOcrModelRow,
  pickOcrPresetRow,
  pickSendButton,
  pickSupplierHeader,
  pickTargetWindow,
  leftOfAnchorPoint,
  modelRowsInPopup,
  pickIconLeftOf,
  plausibleModelItems,
  popupItems,
  ratioPoint,
  readThinkingLevel,
  thinkingClickPoint,
  transcriptDigest,
} from '../electron/core/autopilot-heuristics';
import {
  parseThinkingLabel,
  thinkingSteps,
  thinkingStop,
  ZCODE_UI,
} from '../shared/autopilot-ui';

// Geometry mirrors the measured ZCode window: 1942x1162 physical pixels.
const bounds = { x: 0, y: 0, w: 1942, h: 1162 };

const node = (patch: Partial<GuiNode> & Pick<GuiNode, 'role' | 'name' | 'rect'>): GuiNode => ({
  path: patch.path ?? '1',
  ci: patch.ci ?? 0,
  state: patch.state ?? 0,
  ...patch,
});

const input = node({ path: '5', role: 42, name: '提出后续修改要求', rect: [527, 967, 1259, 60] });
const send = node({ path: '6', role: 43, name: '发送', rect: [1744, 1045, 42, 42] });
const modelTrigger = node({ path: '7', role: 57, name: 'GLM-5.3-Flash 最高', rect: [1494, 1045, 244, 42] });
const modeTrigger = node({ path: '8', role: 57, name: '切换模式', rect: [575, 1045, 167, 42] });
const attach = node({ path: '9', role: 43, name: '添加上下文', rect: [527, 1045, 42, 42] });
const popup = node({ path: '10', role: 11, name: '', rect: [1342, 731, 432, 311] });
const popupModel = node({ path: '10.3', role: 12, name: 'GLM-5.3-Flash', rect: [1360, 800, 380, 32] });
const popupModel2 = node({ path: '10.4', role: 12, name: 'GLM-5.3', rect: [1360, 840, 380, 32] });
const popupManage = node({ path: '10.5', role: 12, name: '管理模型', rect: [1360, 980, 380, 32] });
const popupSlider = node({ path: '10.6', role: 51, name: '思考强度', rect: [1360, 880, 380, 24] });
const supplier = node({ path: '10.1', role: 12, name: 'Start Plan 免费', rect: [1360, 760, 380, 28] });

const zcodeNodes = [input, send, modelTrigger, modeTrigger, attach, popup, supplier, popupModel, popupModel2, popupManage, popupSlider];

const window = (patch: Partial<GuiWindow> = {}): GuiWindow => ({
  hwnd: 263522,
  pid: 19616,
  title: 'ZCode',
  class: 'Chrome_WidgetWin_1',
  process: 'ZCode',
  visible: true,
  minimized: false,
  showCmd: 3,
  rect: [-11, -11, 1942, 1162],
  dpi: 144,
  ...patch,
});

describe('window discovery', () => {
  it('prefers the visible, non-minimized main window', () => {
    const windows = [
      window({ hwnd: 1, visible: false, rect: [0, 0, 100, 100] }),
      window({ hwnd: 2, minimized: true, rect: [-32000, -32000, 237, 39] }),
      window({ hwnd: 3 }),
      window({ hwnd: 4, title: 'Other app', process: 'chrome' }),
    ];
    const picked = pickTargetWindow(windows, {
      processNames: ['zcode'],
      titleContains: ['zcode'],
      className: 'Chrome_WidgetWin_1',
    });
    expect(picked?.hwnd).toBe(3);
  });

  it('returns null when the target is absent', () => {
    expect(
      pickTargetWindow([window({ process: 'chrome', title: 'Chrome' })], {
        processNames: ['zcode'],
        className: 'Chrome_WidgetWin_1',
      }),
    ).toBeNull();
  });
});

describe('ZCode control picking', () => {
  it('finds the composer, send button and model trigger', () => {
    expect(pickInputNode(zcodeNodes, bounds)?.path).toBe('5');
    expect(pickSendButton(zcodeNodes, bounds)?.path).toBe('6');
    expect(pickModelTrigger(zcodeNodes, bounds)?.path).toBe('7');
    expect(pickModeTrigger(zcodeNodes, bounds)?.path).toBe('8');
  });

  it('ignores the send button while it is disabled', () => {
    const disabled = { ...send, state: 0x1 };
    const picked = pickSendButton([disabled, input], bounds);
    expect(picked).not.toBeNull();
    expect((picked?.state ?? 0) & 1).toBe(1);
  });

  it('opens the popup items and separates model entries from menu chrome', () => {
    const popupNode = findPopup(zcodeNodes);
    expect(popupNode?.path).toBe('10');
    const items = popupItems(zcodeNodes, popupNode!);
    expect(items.map((item) => item.name)).toContain('GLM-5.3-Flash');
    const models = plausibleModelItems(items);
    expect(models.map((item) => item.name)).toEqual(['GLM-5.3-Flash', 'GLM-5.3']);
    expect(models.map((item) => item.name)).not.toContain('管理模型');
  });

  it('recognises a quota wall from an empty model list', () => {
    expect(looksLikeNoQuota(popupItems(zcodeNodes, popup), popup)).toBe(false);
    const onlyChrome = [supplier, popupManage];
    expect(looksLikeNoQuota(onlyChrome, popup)).toBe(true);
    const quotaMessage = node({ role: 12, name: '额度已用完，请升级套餐', rect: [1360, 800, 380, 32] });
    expect(looksLikeNoQuota([quotaMessage, popupManage], popup)).toBe(true);
  });

  it('maps thinking levels onto the slider', () => {
    const low = thinkingClickPoint(popupSlider, 'low');
    const max = thinkingClickPoint(popupSlider, 'max');
    expect(low.x).toBeGreaterThan(popupSlider.rect[0]);
    expect(max.x).toBeGreaterThan(low.x);
    expect(max.x).toBeLessThanOrEqual(popupSlider.rect[0] + popupSlider.rect[2]);
  });
});

describe('conversation picking', () => {
  const conversation = (patch: Partial<GuiNode>): GuiNode =>
    node({ role: 43, name: 'daily news', rect: [12, 775, 252, 48], ...patch });

  it('matches a conversation in the left outline', () => {
    const result = pickConversationNode([conversation({}), input], 'daily news', bounds);
    expect(result.node?.path).toBe('1');
    expect(result.ambiguous).toBe(false);
  });

  it('flags duplicate names', () => {
    const result = pickConversationNode(
      [conversation({ path: '1', rect: [12, 500, 252, 48] }), conversation({ path: '2', rect: [12, 700, 252, 48] })],
      'daily news',
      bounds,
    );
    expect(result.ambiguous).toBe(true);
  });

  it('does not match a conversation on the right side', () => {
    const result = pickConversationNode([conversation({ rect: [1000, 300, 300, 48] })], 'daily news', bounds);
    expect(result.node).toBeNull();
  });
});

describe('generic lookups', () => {
  it('finds a named node with and without roles', () => {
    expect(findNamedNode(zcodeNodes, ['发送'], { roles: [43] })?.path).toBe('6');
    expect(findNamedNode(zcodeNodes, ['发送'], { roles: [41] })).toBeNull();
    expect(findNamedNode(zcodeNodes, ['管理'], { roles: [12], exact: false })?.name).toBe('管理模型');
  });

  it('changes the transcript digest when names change', () => {
    const base = transcriptDigest([input, send, node({ role: 41, name: '你好', rect: [100, 100, 300, 20] })]);
    const changed = transcriptDigest([input, send, node({ role: 41, name: '你好，世界', rect: [100, 100, 300, 20] })]);
    expect(base).not.toBe(changed);
    expect(transcriptDigest([])).toBe(transcriptDigest([]));
  });
});

const ocr2 = (
  lines: OcrResult['lines'],
  size: { width: number; height: number } = { width: 1942, height: 1162 },
): OcrResult => ({
  language: 'zh-Hans-CN',
  width: size.width,
  height: size.height,
  lineCount: lines.length,
  lines,
});

describe('WorkBuddy OCR heuristics', () => {
  const frame = ocr2([
    { text: 'WorkBuddy', x: 600, y: 40, w: 180, h: 26, words: [] },
    { text: '请帮我检查一下这个项目的构建脚本', x: 520, y: 400, w: 500, h: 24, words: [] },
    { text: '请输入你的问题', x: 540, y: 1000, w: 260, h: 24, words: [] },
    { text: '发送', x: 1850, y: 1040, w: 40, h: 20, words: [] },
    { text: 'GLM-5.3-Flash', x: 1600, y: 1050, w: 150, h: 20, words: [] },
  ]);

  it('extracts the composer region from the placeholder line', () => {
    const region = ocrInputRegion(frame);
    expect(region?.y).toBeGreaterThan(900);
    expect(region?.w).toBeGreaterThan(800);
  });

  it('finds the send control near the composer', () => {
    const region = ocrInputRegion(frame)!;
    const point = ocrSendPoint(frame, region);
    expect(point?.x).toBeGreaterThan(1800);
  });

  it('reads the composer text and transcript separately', () => {
    const region = ocrInputRegion(frame)!;
    expect(ocrTextIn(frame, region)).toContain('请输入');
    expect(ocrTranscript(frame, region)).toContain('构建脚本');
  });

  it('detects a model name in the toolbar', () => {
    const region = ocrInputRegion(frame)!;
    expect(pickOcrModelName(frame, region)).toContain('GLM');
  });
});

// ---------------------------------------------------------------------------
// Taught UI knowledge (operator screenshots, 2026-11-01). Geometry below is a
// deliberately small, non-maximised popup: nothing may depend on full screen.
// ---------------------------------------------------------------------------

const teachPopup = node({ path: '20', role: 11, name: '', rect: [700, 380, 300, 220] });
const teachSupplier1 = node({ path: '20.1', role: 12, name: 'Start Plan 免费', rect: [705, 385, 140, 26] });
const teachSupplier2 = node({ path: '20.2', role: 12, name: '新供应商 API', rect: [705, 415, 140, 26] });
const teachSupplier3 = node({ path: '20.3', role: 12, name: '阿里云百炼（中国） API', rect: [705, 445, 140, 26] });
const teachManage = node({ path: '20.4', role: 12, name: '管理模型', rect: [705, 478, 140, 26] });
const teachHeader = node({ path: '20.5', role: 12, name: 'Z.ai API', rect: [858, 385, 132, 26] });
const teachModelA = node({ path: '20.6', role: 12, name: 'deepseek-v4-pro', rect: [858, 420, 132, 26] });
const teachModelB = node({ path: '20.7', role: 12, name: 'kimi-k3 视觉', rect: [858, 450, 132, 26] });
const teachThinking = node({
  path: '20.8',
  role: 51,
  name: '思考强度 最高 Ctrl+T',
  rect: [858, 520, 132, 20],
});
const teachItems = [
  teachSupplier1,
  teachSupplier2,
  teachSupplier3,
  teachManage,
  teachHeader,
  teachModelA,
  teachModelB,
  teachThinking,
];

describe('thinking strength ring', () => {
  it('reads the level out of the popup label', () => {
    expect(parseThinkingLabel('思考强度 最高')).toBe('max');
    expect(parseThinkingLabel('思考强度 关闭 Ctrl+T')).toBe('off');
    expect(parseThinkingLabel('deepseek-v4-pro 高')).toBe('high');
    expect(parseThinkingLabel('GLM-5.3-Flash')).toBeNull();
  });

  it('counts Ctrl+T presses around the ring', () => {
    expect(thinkingSteps('off', 'max')).toBe(4);
    expect(thinkingSteps('max', 'off'), 'the ring wraps').toBe(1);
    expect(thinkingSteps('low', 'low')).toBe(0);
  });

  it('exposes the level shown next to the slider', () => {
    expect(readThinkingLevel(teachItems)).toBe('max');
  });

  it('spends five stops across the slider track', () => {
    expect(thinkingStop(0)).toBeLessThan(thinkingStop(4));
    expect(thinkingStop(4)).toBeLessThanOrEqual(1);
    const slider = teachThinking;
    expect(thinkingClickPoint(slider, 'off').x).toBeLessThan(thinkingClickPoint(slider, 'max').x);
  });
});

describe('model popup columns', () => {
  it('keeps model rows out of the supplier column', () => {
    const rows = modelRowsInPopup(teachItems, teachPopup).map((item) => item.name);
    expect(rows).toEqual(['deepseek-v4-pro', 'kimi-k3 视觉']);
  });

  it('falls back to every row while the supplier column is closed', () => {
    const closed = [teachHeader, teachModelA, teachModelB, teachThinking];
    expect(modelRowsInPopup(closed, teachPopup).length).toBe(2);
  });

  it('finds the header row that reveals the supplier list', () => {
    expect(pickSupplierHeader(teachItems, teachPopup)?.name).toBe('Z.ai API');
  });
});

describe('icon-only controls', () => {
  const addProvider = node({ path: '30', role: 43, name: '添加供应商', rect: [1620, 180, 120, 36] });
  const refresh = node({ path: '31', role: 43, name: '', rect: [1556, 180, 44, 36] });
  const farRight = node({ path: '32', role: 43, name: '', rect: [1800, 180, 44, 36] });
  const settingsNodes = [addProvider, refresh, farRight];

  it('walks left from a labelled sibling', () => {
    expect(pickIconLeftOf(settingsNodes, '添加供应商')).toBe(refresh);
  });

  it('aims at the same spot when the icon has no accessible node', () => {
    const point = leftOfAnchorPoint(addProvider);
    expect(point.x).toBeGreaterThanOrEqual(refresh.rect[0]);
    expect(point.x).toBeLessThanOrEqual(refresh.rect[0] + refresh.rect[2]);
    expect(point.y).toBeGreaterThanOrEqual(refresh.rect[1]);
    expect(point.y).toBeLessThanOrEqual(refresh.rect[1] + refresh.rect[3]);
  });
});

describe('ratio anchors', () => {
  it('scales with the window instead of assuming full screen', () => {
    const half = ratioPoint({ x: 200, y: 100, w: 971, h: 581 }, ZCODE_UI.send.at!);
    const full = ratioPoint({ x: 0, y: 0, w: 1942, h: 1162 }, ZCODE_UI.send.at!);
    expect((half.x - 200) / 971).toBeCloseTo((full.x - 0) / 1942, 2);
    expect((half.y - 100) / 581).toBeCloseTo(full.y / 1162, 2);
  });

  it('places composer anchors in the taught left-to-right order', () => {
    const ids = ['attach', 'permission', 'contextRing', 'modelTrigger', 'send'] as const;
    const xs = ids.map((id) => ZCODE_UI[id].at!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
});

describe('WorkBuddy model picker', () => {
  const size = { width: 1400, height: 900 };
  const picker = ocr2(
    [
      { text: '我用 GLM-5.2 试过那个方案', x: 120, y: 300, w: 300, h: 22, words: [] },
      { text: '今天帮你做些什么？@ 添加上下文，/调用技能与指令', x: 60, y: 700, w: 520, h: 24, words: [] },
      { text: '允许完全访问', x: 150, y: 800, w: 130, h: 22, words: [] },
      { text: 'Hy3', x: 1050, y: 800, w: 60, h: 22, words: [] },
      { text: '快速 0.15x', x: 830, y: 480, w: 180, h: 22, words: [] },
      { text: '均衡 0.50x', x: 830, y: 530, w: 180, h: 22, words: [] },
      { text: '极致 1.00x', x: 830, y: 580, w: 180, h: 22, words: [] },
      { text: 'Hy4 preview 0.29x', x: 830, y: 640, w: 200, h: 22, words: [] },
      { text: 'Hy3 限时免费 0.00x', x: 830, y: 690, w: 210, h: 22, words: [] },
      { text: 'DeepSeek-V4.1-Flash 夜间折扣 0.11x', x: 830, y: 740, w: 280, h: 22, words: [] },
      { text: 'GLM-5.3 订阅优先 0.69x', x: 830, y: 790, w: 230, h: 22, words: [] },
      { text: '配置自定义模型', x: 830, y: 860, w: 160, h: 22, words: [] },
    ],
    size,
  );
  const input = ocrInputRegion(picker)!;

  it('finds the composer from the taught placeholder text', () => {
    expect(input.y).toBeLessThan(720);
  });

  it('reads the toolbar label rather than a rate row', () => {
    expect(pickOcrModelName(picker, input)).toBe('Hy3');
  });

  it('prefers the rate-bearing row over transcript text', () => {
    const row = pickOcrModelRow(picker, 'GLM-5.3', { exclude: 'Hy3' });
    expect(row?.line.text).toContain('GLM-5.3 订阅优先');
    expect(row?.line.y).toBe(790);
  });

  it('matches a Hunyuan alias without stealing the toolbar row', () => {
    const row = pickOcrModelRow(picker, 'Hy3', { exclude: 'Hy3' });
    expect(row?.line.text).toContain('限时免费');
  });

  it('finds the thinking presets', () => {
    expect(pickOcrPresetRow(picker, '均衡')?.y).toBe(530);
    expect(pickOcrPresetRow(picker, '不存在')).toBeNull();
  });

  it('guesses send from the taught ratio when nothing is labelled', () => {
    const bare = picker.lines.filter((line) => !/发送/.test(line.text));
    const point = ocrSendPoint(ocr2(bare, size), input)!;
    expect(point.x).toBeGreaterThan(1300);
    expect(point.y).toBeGreaterThan(input.y + input.h);
    expect(point.y).toBeLessThan(size.height);
  });
});

