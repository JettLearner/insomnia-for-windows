import type { AutopilotErrorCode } from '../../shared/autopilot';
import { AutoBridgeError, type AutoBridge } from './auto-bridge';

export interface GuiWindow {
  hwnd: number;
  pid: number;
  title: string;
  class: string;
  process: string;
  visible: boolean;
  minimized: boolean;
  showCmd: number;
  rect: [number, number, number, number];
  dpi: number;
}

export interface GuiNode {
  path: string;
  ci: number;
  role: number;
  state: number;
  name: string;
  action?: string;
  value?: string;
  rect: [number, number, number, number];
  depth?: number;
  children?: number;
}

export interface MsaaDump {
  count: number;
  hash: string;
  truncated: boolean;
  nodes: GuiNode[];
}

export interface OcrWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  words: OcrWord[];
}

export interface OcrResult {
  language: string;
  width: number;
  height: number;
  lineCount: number;
  lines: OcrLine[];
}

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
  rect: [number, number, number, number];
  dpi: number;
  printWindow: boolean;
}

export interface ClipboardSnapshot {
  text: string;
  files: string[];
}

/** MSAA state bits we rely on. */
export const STATE_SYSTEM_SELECTED = 0x2;
export const STATE_SYSTEM_FOCUSED = 0x4;
export const STATE_SYSTEM_CHECKED = 0x10;
export const STATE_SYSTEM_UNAVAILABLE = 0x1;
export const STATE_SYSTEM_FOCUSABLE = 0x100000;
export const STATE_SYSTEM_INVISIBLE = 0x8000;
export const STATE_SYSTEM_OFFSCREEN = 0x10000;

export const ROLE_PUSH_BUTTON = 43;
export const ROLE_LINK = 30;
export const ROLE_TEXT = 41;
export const ROLE_EDIT = 42;
export const ROLE_PANE = 16;
export const ROLE_CLIENT = 10;
export const ROLE_DIALOG = 18;
export const ROLE_LIST = 33;
export const ROLE_LIST_ITEM = 34;
export const ROLE_MENU_POPUP = 11;
export const ROLE_MENU_ITEM = 12;
export const ROLE_SLIDER = 51;
export const ROLE_BUTTON_DROPDOWN = 57;
export const ROLE_OUTLINE_ITEM = 36;

export function stateHas(state: number, bit: number): boolean {
  return (state & bit) !== 0;
}

export function nodeCenter(node: Pick<GuiNode, 'rect'>): { x: number; y: number } {
  const [x, y, w, h] = node.rect;
  return { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) };
}

export function nodeArea(node: Pick<GuiNode, 'rect'>): number {
  return Math.max(0, node.rect[2]) * Math.max(0, node.rect[3]);
}

export function rectContains(outer: [number, number, number, number], inner: [number, number, number, number]): boolean {
  const cx = inner[0] + inner[2] / 2;
  const cy = inner[1] + inner[3] / 2;
  return cx >= outer[0] && cx <= outer[0] + outer[2] && cy >= outer[1] && cy <= outer[1] + outer[3];
}

export function nameMatches(name: string, query: string): boolean {
  return name.trim().toLowerCase() === query.trim().toLowerCase();
}

export function nameContains(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

/**
 * Thin, typed wrapper around the automation helper. One instance is shared by
 * every adapter so that a dead helper is restarted once, not per adapter.
 */
export class GuiSession {
  constructor(private readonly bridge: AutoBridge) {}

  get connected(): boolean {
    return this.bridge.alive;
  }

  restart(): void {
    this.bridge.restart();
  }

  async listWindows(args: { pid?: number; includeInvisible?: boolean } = {}): Promise<GuiWindow[]> {
    const data = await this.bridge.request<{ windows: GuiWindow[] }>('win.list', args);
    return Array.isArray(data?.windows) ? data.windows : [];
  }

  async show(hwnd: number, state: 'restore' | 'minimize' | 'maximize' | 'noactivate' | 'hide'): Promise<void> {
    await this.bridge.request('win.show', { hwnd, state });
  }

  async focus(hwnd: number, settleMs = 150): Promise<boolean> {
    const data = await this.bridge.request<{ ok: boolean; foreground: number }>('win.focus', { hwnd, settleMs });
    return data.foreground === hwnd;
  }

  async probe(hwnd: number, x: number, y: number): Promise<boolean> {
    const data = await this.bridge.request<{ matches: boolean }>('win.probe', { hwnd, x, y });
    return data.matches === true;
  }

  async capture(hwnd: number, path: string): Promise<CaptureResult> {
    return this.bridge.request<CaptureResult>('win.capture', { hwnd, path }, 30_000);
  }

  async dump(hwnd: number, limit = 3000, depth = 40): Promise<MsaaDump> {
    const data = await this.bridge.request<MsaaDump>('msaa.dump', { hwnd, limit, depth }, 25_000);
    return {
      count: Number(data?.count ?? 0),
      hash: String(data?.hash ?? ''),
      truncated: data?.truncated === true,
      nodes: Array.isArray(data?.nodes) ? data.nodes : [],
    };
  }

  async find(
    hwnd: number,
    args: {
      name?: string;
      match?: 'exact' | 'contains' | 'prefix' | 'regex';
      roles?: number[];
      stateMust?: number[];
      stateNot?: number[];
      max?: number;
      allowEmptyName?: boolean;
    },
  ): Promise<GuiNode[]> {
    const data = await this.bridge.request<{ matches: GuiNode[] }>('msaa.find', { hwnd, ...args }, 25_000);
    return Array.isArray(data?.matches) ? data.matches : [];
  }

  async act(
    hwnd: number,
    args: {
      path?: string;
      ci?: number;
      name?: string;
      match?: 'exact' | 'contains';
      roles?: number[];
      action: 'focus' | 'invoke' | 'setvalue' | 'state' | 'click' | 'rect';
      at?: 'left' | 'center' | 'right';
      offsetX?: number;
      offsetY?: number;
      value?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.bridge.request<Record<string, unknown>>('msaa.act', { hwnd, ...args }, 20_000);
  }

  async clickAt(hwnd: number, x: number, y: number, moveOnly = false): Promise<void> {
    await this.bridge.request('input.click', { hwnd, x, y, moveOnly });
  }

  async keys(combo: string): Promise<void> {
    await this.bridge.request('input.keys', { keys: combo });
  }

  async readClipboard(): Promise<ClipboardSnapshot> {
    const data = await this.bridge.request<{ text: string; files: string[] }>('clip.read', {});
    return { text: String(data?.text ?? ''), files: Array.isArray(data?.files) ? data.files : [] };
  }

  async writeClipboardText(text: string): Promise<void> {
    await this.bridge.request('clip.write', { text });
  }

  async writeClipboardFiles(files: string[]): Promise<void> {
    await this.bridge.request('clip.writeFiles', { files });
  }

  async ocr(path: string): Promise<OcrResult> {
    return this.bridge.request<OcrResult>('ocr.recognize', { path }, 45_000);
  }

  async perf(): Promise<{ cpuBusy: number; memoryLoad: number }> {
    return this.bridge.request<{ cpuBusy: number; memoryLoad: number }>('perf.sample', {});
  }

  async hello(): Promise<{ version: string; pid: number; ocr: boolean }> {
    return this.bridge.request<{ version: string; pid: number; ocr: boolean }>('hello', {});
  }
}

/** Saves the user's clipboard and restores it even when a step throws. */
export class ClipboardGuard {
  private snapshot: ClipboardSnapshot | null = null;

  constructor(private readonly session: GuiSession) {}

  async save(): Promise<void> {
    try {
      this.snapshot = await this.session.readClipboard();
    } catch {
      this.snapshot = null;
    }
  }

  async restore(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.snapshot = null;
    try {
      if (snapshot.files.length > 0) {
        await this.session.writeClipboardFiles(snapshot.files);
        return;
      }
      await this.session.writeClipboardText(snapshot.text);
    } catch (error) {
      this.logError(error);
    }
  }

  private logError(error: unknown): void {
    void error;
  }
}

export function toAutopilotError(error: unknown): { code: AutopilotErrorCode; message: string } {
  if (error instanceof AutoBridgeError) {
    return { code: normalizeCode(error.code), message: error.message };
  }
  if (error instanceof Error) return { code: 'UNEXPECTED_EXCEPTION', message: error.message };
  return { code: 'UNEXPECTED_EXCEPTION', message: String(error) };
}

function normalizeCode(code: string): AutopilotErrorCode {
  switch (code) {
    case 'TARGET_NOT_RUNNING':
    case 'TARGET_NO_WINDOW':
    case 'WINDOW_MINIMIZED':
    case 'WINDOW_OCCLUDED':
    case 'TREE_EMPTY':
    case 'CLIPBOARD_OCCUPIED':
    case 'INPUT_NOT_FOUND':
    case 'SEND_DISABLED':
    case 'SEND_UNCONFIRMED':
    case 'OCR_ENGINE_MISSING':
    case 'AUTO_HELPER_DEAD':
    case 'AUTO_HELPER_DENIED':
    case 'ATTACHMENT_MISSING':
    case 'MODEL_LOADING':
    case 'NODE_GONE':
      return code === 'NODE_GONE' ? 'UNEXPECTED_EXCEPTION' : code;
    case 'UNEXPECTED_EXCEPTION':
      return 'UNEXPECTED_EXCEPTION';
    default:
      return 'UNEXPECTED_EXCEPTION';
  }
}
