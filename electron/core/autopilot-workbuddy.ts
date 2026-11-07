import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveryRequest, DeliveryResult, TargetAdapter } from './autopilot-engine';
import {
  ClipboardGuard,
  GuiSession,
  toAutopilotError,
  type GuiWindow,
  type OcrLine,
  type OcrResult,
} from './autopilot-gui';
import {
  ocrInputRegion,
  ocrSendPoint,
  ocrTextIn,
  ocrTranscript,
  pickOcrModelName,
  pickOcrModelRow,
  pickOcrModelTrigger,
  pickOcrPresetRow,
  pickTargetWindow,
  type OcrRegion,
} from './autopilot-heuristics';
import { MODEL_NAME_PATTERN, MODEL_ROW_RATE } from '../../shared/autopilot-ui';
import {
  scoreModelName,
  type ModelCatalogEntry,
  type ThinkingLevel,
} from '../../shared/autopilot';
import type { Logger } from './logger';

/** WorkBuddy offers thinking strength as three named presets instead of a slider. */
const PRESET_FOR_THINKING: Record<ThinkingLevel, string> = {
  off: '快速',
  low: '快速',
  medium: '均衡',
  high: '极致',
  max: '极致',
};

const WORKBUDDY_WINDOW = {
  processNames: ['workbuddyai', 'workbuddy'],
  titleContains: ['workbuddy'],
  className: 'Chrome_WidgetWin_1',
};

interface WorkBuddyOptions {
  session: GuiSession;
  log: Logger;
  tempDir: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
}

class StepFailure extends Error {
  constructor(
    readonly code: import('../../shared/autopilot').AutopilotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Snapshot {
  window: GuiWindow;
  ocr: OcrResult;
  input: OcrRegion;
}

/**
 * WorkBuddy only exposes an empty accessibility document, so every decision is
 * made from a PrintWindow capture plus WinRT OCR. Clicks are still physical.
 */
export class WorkBuddyAdapter implements TargetAdapter {
  readonly id = 'workbuddy';
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verifyTimeoutMs: number;
  private captureSeq = 0;

  constructor(private readonly options: WorkBuddyOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 10_000;
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const { session, log } = this.options;
    let window: GuiWindow;
    try {
      window = await this.locate();
    } catch (error) {
      const mapped = toAutopilotError(error);
      request.onStep({ step: 'locate', ok: false, ms: 0, code: mapped.code, detail: mapped.message });
      return { ok: false, code: mapped.code, message: mapped.message };
    }

    const guard = new ClipboardGuard(session);
    const wasMinimized = window.minimized;
    await guard.save();

    try {
      await this.step(request, 'locate', async () => {
        if (wasMinimized) {
          await session.show(window.hwnd, 'restore');
          await this.sleep(400);
        }
        await session.focus(window.hwnd);
      });

      let snapshot = await this.step(request, 'capture', () => this.capture(window));
      await this.step(request, 'occlusion', async () => {
        const center = {
          x: snapshot.input.x + Math.round(snapshot.input.w / 2),
          y: snapshot.input.y + Math.round(snapshot.input.h / 2),
        };
        if (await session.probe(window.hwnd, center.x, center.y)) return;
        await session.show(window.hwnd, 'noactivate');
        await this.sleep(250);
        if (await session.probe(window.hwnd, center.x, center.y)) return;
        throw new StepFailure('WINDOW_OCCLUDED', 'another window covers the WorkBuddy composer');
      });

      if (request.job.model?.name || request.job.model?.thinking) {
        await this.step(request, 'model', () => this.ensureModel(request, window, snapshot));
        snapshot = await this.step(request, 'capture-model', () => this.capture(window));
      }

      await this.step(request, 'paste', async () => {
        await this.clickInput(snapshot);
        await session.writeClipboardText(request.prompt);
        await session.keys('ctrl+v');
        await this.sleep(500);
        let verified = await this.verifyPasted(window, request.prompt);
        if (!verified) {
          await this.clickInput(snapshot);
          await session.writeClipboardText(request.prompt);
          await session.keys('ctrl+v');
          await this.sleep(650);
          verified = await this.verifyPasted(window, request.prompt);
        }
        if (!verified) throw new StepFailure('PASTE_UNCONFIRMED', 'WorkBuddy composer did not receive the paste');
      });

      const files = request.attachments
        .map((attachment) => attachment.usePath)
        .filter((value): value is string => Boolean(value));
      if (files.length) {
        await this.step(request, 'attachments', async () => {
          try {
            await this.clickInput(snapshot);
            await session.writeClipboardFiles(files);
            await session.keys('ctrl+v');
            await this.sleep(700);
          } catch (error) {
            const mapped = toAutopilotError(error);
            log.warn('workbuddy attachment paste failed', { code: mapped.code, message: mapped.message });
            request.onStep({ step: 'attachments-skipped', ok: true, ms: 0, detail: mapped.code });
          }
        });
      }

      await this.step(request, 'send', async () => {
        snapshot = await this.capture(window);
        const point = ocrSendPoint(snapshot.ocr, snapshot.input);
        if (!point) throw new StepFailure('SEND_DISABLED', 'send control not found');
        if (!(await session.probe(window.hwnd, point.x, point.y))) {
          throw new StepFailure('WINDOW_OCCLUDED', 'send control is covered by another window');
        }
        await session.clickAt(window.hwnd, point.x, point.y);
      });

      await this.step(request, 'verify', () => this.verifySent(request, window));
      return { ok: true };
    } catch (error) {
      if (error instanceof StepFailure) {
        return { ok: false, code: error.code, message: error.message };
      }
      const mapped = toAutopilotError(error);
      return { ok: false, code: mapped.code, message: mapped.message };
    } finally {
      try {
        await guard.restore();
      } catch (error) {
        log.warn('workbuddy clipboard restore failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (wasMinimized) {
        try {
          await session.show(window.hwnd, 'minimize');
        } catch {
          /* window may be gone */
        }
      }
    }
  }

  /**
   * WorkBuddy keeps its model list behind the toolbar label: clicking it opens
   * a right-hand column where every row carries a consumption rate, which is
   * what separates a real row from chat text that merely mentions a model.
   */
  async snapshotModels(): Promise<ModelCatalogEntry[]> {
    const { session } = this.options;
    const window = await this.locate();
    await session.focus(window.hwnd);
    const snapshot = await this.capture(window);
    const trigger = pickOcrModelTrigger(snapshot.ocr, snapshot.input);
    if (!trigger) return [];
    await session.clickAt(
      window.hwnd,
      trigger.x + Math.round(trigger.w / 2),
      trigger.y + Math.round(trigger.h / 2),
    );
    await this.sleep(600);
    const open = await this.capture(window);
    const observedAt = new Date(this.now()).toISOString();
    const seen = new Set<string>();
    const entries: ModelCatalogEntry[] = [];
    for (const line of open.ocr.lines) {
      const text = line.text.trim();
      if (!text || !MODEL_NAME_PATTERN.test(text) || !MODEL_ROW_RATE.test(text)) continue;
      const name = text.split(/\s+/)[0];
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      entries.push({ provider: 'WorkBuddy', name, source: 'observed', observedAt });
    }
    await this.closePicker();
    return entries;
  }

  private async ensureModel(
    request: DeliveryRequest,
    window: GuiWindow,
    snapshot: Snapshot,
  ): Promise<void> {
    const { session } = this.options;
    const wanted = request.job.model?.name?.trim();
    const thinking = request.job.model?.thinking;
    const trigger = pickOcrModelTrigger(snapshot.ocr, snapshot.input);
    const current = trigger?.text.trim() ?? '';
    if (wanted && current && scoreModelName(current, wanted) >= 80) return;
    if (!trigger) throw new StepFailure('MODEL_POPUP_NOT_OPENED', 'model trigger is not readable');
    await session.clickAt(
      window.hwnd,
      trigger.x + Math.round(trigger.w / 2),
      trigger.y + Math.round(trigger.h / 2),
    );
    await this.sleep(600);
    const open = await this.capture(window);

    let target: OcrLine | null = null;
    let label = '';
    if (wanted) {
      const row = pickOcrModelRow(open.ocr, wanted, { exclude: current });
      if (row) {
        target = row.line;
        label = row.line.text.trim();
      }
    } else {
      label = PRESET_FOR_THINKING[thinking ?? 'medium'];
      target = pickOcrPresetRow(open.ocr, label);
    }

    if (!target) {
      await this.closePicker();
      if (!request.settings.strictModelMatch) {
        request.onStep({ step: 'model-skipped', ok: true, ms: 0, detail: `MODEL_NOT_IN_CATALOG ${label}` });
        return;
      }
      throw new StepFailure('MODEL_NOT_IN_CATALOG', `WorkBuddy does not offer ${wanted || label}`);
    }

    await session.clickAt(
      window.hwnd,
      target.x + Math.round(target.w / 2),
      target.y + Math.round(target.h / 2),
    );
    await this.sleep(500);
    await this.closePicker();
    if (!wanted) return;

    const after = await this.capture(window);
    const shown = pickOcrModelName(after.ocr, after.input);
    const confirmed =
      !!shown && (scoreModelName(shown, wanted) >= 60 || scoreModelName(shown, label) >= 60);
    if (!confirmed) {
      if (!request.settings.strictModelMatch) {
        request.onStep({
          step: 'model-unconfirmed',
          ok: true,
          ms: 0,
          detail: `MODEL_SWITCH_UNCONFIRMED ${shown ?? 'unreadable'}`,
        });
        return;
      }
      throw new StepFailure('MODEL_SWITCH_UNCONFIRMED', `WorkBuddy still shows ${shown ?? 'no model'}`);
    }
  }

  /** A picker left open would swallow the paste that follows. */
  private async closePicker(): Promise<void> {
    try {
      await this.options.session.keys('esc');
    } catch {
      /* the window may already be gone; the next click dismisses it anyway */
    }
    await this.sleep(200);
  }

  private async locate(): Promise<GuiWindow> {
    const windows = await this.options.session.listWindows({ includeInvisible: true });
    const window = pickTargetWindow(windows, WORKBUDDY_WINDOW);
    if (!window) throw new StepFailure('TARGET_NOT_RUNNING', 'WorkBuddy window not found');
    return window;
  }

  private async capture(window: GuiWindow): Promise<Snapshot> {
    const { session } = this.options;
    const name = `workbuddy-${this.now()}-${(this.captureSeq += 1)}.png`;
    const path = join(this.options.tempDir(), name);
    let file = path;
    try {
      const capture = await session.capture(window.hwnd, path);
      if (!capture.printWindow) {
        throw new StepFailure('WINDOW_OCCLUDED', 'PrintWindow returned a blank frame');
      }
      const ocr = await session.ocr(path);
      if (!ocr.lines.length) throw new StepFailure('TREE_EMPTY', 'OCR found no text in the WorkBuddy window');
      const input = ocrInputRegion(ocr);
      if (!input) throw new StepFailure('INPUT_NOT_FOUND', 'composer region not recognized');
      return { window, ocr, input };
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      const mapped = toAutopilotError(error);
      if (mapped.code === 'AUTO_HELPER_DEAD') throw error;
      throw new StepFailure(mapped.code === 'UNEXPECTED_EXCEPTION' ? 'OCR_ENGINE_MISSING' : mapped.code, mapped.message);
    } finally {
      if (file) {
        try {
          rmSync(file, { force: true });
        } catch {
          /* temp files may be locked briefly by the OCR engine */
        }
      }
    }
  }

  private async clickInput(snapshot: Snapshot): Promise<void> {
    const { session } = this.options;
    const center = { x: snapshot.input.x + Math.round(snapshot.input.w / 2), y: snapshot.input.y + Math.round(snapshot.input.h / 2) };
    await session.clickAt(snapshot.window.hwnd, center.x, center.y);
    await this.sleep(150);
    await session.focus(snapshot.window.hwnd, 80);
  }

  private async verifyPasted(window: GuiWindow, prompt: string): Promise<boolean> {
    const snapshot = await this.capture(window);
    const text = ocrTextIn(snapshot.ocr, snapshot.input);
    const marker = prompt.trim().slice(0, 12);
    if (marker.length >= 6 && text.replace(/\s+/g, '').includes(marker.replace(/\s+/g, ''))) return true;
    return text.trim().length >= Math.min(40, prompt.trim().length / 3);
  }

  private async verifySent(request: DeliveryRequest, window: GuiWindow): Promise<void> {
    const started = this.now();
    const marker = request.prompt.trim().slice(0, 16);
    while (this.now() - started < this.verifyTimeoutMs) {
      if (request.shouldCancel()) throw new StepFailure('UNEXPECTED_EXCEPTION', 'cancelled');
      await this.sleep(700);
      const snapshot = await this.capture(window);
      const transcript = ocrTranscript(snapshot.ocr, snapshot.input);
      const composer = ocrTextIn(snapshot.ocr, snapshot.input);
      const markerInTranscript = marker.length >= 6 && transcript.includes(marker);
      const markerStillInComposer = marker.length >= 6 && composer.includes(marker);
      if (markerInTranscript && !markerStillInComposer) return;
      if (!markerStillInComposer && composer.trim().length < 4 && transcript.length > 0) return;
    }
    throw new StepFailure('SEND_UNCONFIRMED', 'WorkBuddy did not show the prompt in the transcript');
  }

  private async step<T>(request: DeliveryRequest, name: string, fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      const value = await fn();
      request.onStep({ step: name, ok: true, ms: this.now() - started });
      return value;
    } catch (error) {
      const mapped = toAutopilotError(error);
      request.onStep({
        step: name,
        ok: false,
        ms: this.now() - started,
        code: mapped.code,
        detail: mapped.message.slice(0, 200),
      });
      throw error;
    }
  }
}
