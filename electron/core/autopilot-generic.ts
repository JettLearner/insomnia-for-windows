import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  chooseModel,
  type AutopilotErrorCode,
  type AutopilotWindowRef,
  type ThinkingLevel,
} from '../../shared/autopilot';
import type { DeliveryRequest, DeliveryResult, TargetAdapter } from './autopilot-engine';
import {
  ClipboardGuard,
  ROLE_MENU_ITEM,
  ROLE_PUSH_BUTTON,
  STATE_SYSTEM_CHECKED,
  STATE_SYSTEM_SELECTED,
  STATE_SYSTEM_UNAVAILABLE,
  GuiSession,
  nameContains,
  nodeCenter,
  stateHas,
  toAutopilotError,
  type GuiNode,
  type GuiWindow,
  type OcrResult,
} from './autopilot-gui';
import {
  findPopup,
  ocrInputRegion,
  ocrSendPoint,
  ocrTextIn,
  ocrTranscript,
  pickConversationNode,
  pickInputNode,
  pickModelTrigger,
  pickSendButton,
  pickTargetWindow,
  plausibleModelItems,
  popupItems,
  thinkingClickPoint,
  transcriptDigest,
  type Bounds,
  type OcrRegion,
  type WindowSpec,
} from './autopilot-heuristics';
import type { Logger } from './logger';

interface GenericOptions {
  session: GuiSession;
  log: Logger;
  tempDir: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  /** Below this many accessible nodes the window is treated as OCR-only. */
  treeThreshold?: number;
}

class StepFailure extends Error {
  constructor(
    readonly code: AutopilotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface OcrSnapshot {
  ocr: OcrResult;
  input: OcrRegion;
}

/**
 * Fallback adapter for chat windows we have no hard-coded map for. It probes
 * the MSAA tree first and switches to PrintWindow + OCR when the tree is thin,
 * then reuses the same physical-coordinate heuristics as the named adapters.
 * Model/capability switching is best-effort: unknown UIs must not be poked.
 */
export class GenericAdapter implements TargetAdapter {
  readonly id = 'generic';
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verifyTimeoutMs: number;
  private readonly treeThreshold: number;
  private captureSeq = 0;

  constructor(private readonly options: GenericOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 9_000;
    this.treeThreshold = options.treeThreshold ?? 20;
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const { session, log } = this.options;

    const spec = windowSpec(request.job.window);
    if (!spec) {
      request.onStep({
        step: 'locate',
        ok: false,
        ms: 0,
        code: 'TARGET_NOT_RUNNING',
        detail: 'generic target has no window selector',
      });
      return { ok: false, code: 'TARGET_NOT_RUNNING', message: 'choose a target window for the generic target' };
    }

    let window: GuiWindow;
    try {
      window = await this.locate(spec);
    } catch (error) {
      const mapped = toAutopilotError(error);
      request.onStep({ step: 'locate', ok: false, ms: 0, code: mapped.code, detail: mapped.message });
      return { ok: false, code: mapped.code, message: mapped.message };
    }

    const bounds: Bounds = { x: window.rect[0], y: window.rect[1], w: window.rect[2], h: window.rect[3] };
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

      const mode = await this.detectMode(window, request);
      request.onStep({ step: 'channel', ok: true, ms: 0, detail: mode === 'tree' ? 'MSAA' : 'PrintWindow+OCR' });

      if (mode === 'tree') {
        await this.deliverByTree(request, window, bounds);
      } else {
        await this.deliverByOcr(request, window);
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof StepFailure) return { ok: false, code: error.code, message: error.message };
      const mapped = toAutopilotError(error);
      return { ok: false, code: mapped.code, message: mapped.message };
    } finally {
      try {
        await session.keys('esc');
        await this.sleep(120);
        await guard.restore();
      } catch (error) {
        log.warn('generic cleanup failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (wasMinimized) {
        try {
          await session.show(window.hwnd, 'minimize');
        } catch {
          /* the window may already be gone */
        }
      }
    }
  }

  // -- channel selection ---------------------------------------------------

  private async locate(spec: WindowSpec): Promise<GuiWindow> {
    const windows = await this.options.session.listWindows({ includeInvisible: true });
    const window = pickTargetWindow(windows, spec);
    if (!window) throw new StepFailure('TARGET_NOT_RUNNING', 'the selected window is not open');
    return window;
  }

  private async detectMode(window: GuiWindow, request: DeliveryRequest): Promise<'tree' | 'ocr'> {
    try {
      const dump = await this.options.session.dump(window.hwnd, this.treeThreshold + 40);
      const bounds: Bounds = { x: window.rect[0], y: window.rect[1], w: window.rect[2], h: window.rect[3] };
      if (dump.nodes.length >= this.treeThreshold && pickInputNode(dump.nodes, bounds)) return 'tree';
    } catch (error) {
      this.options.log.debug('generic MSAA probe failed, falling back to OCR', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    request.onStep({ step: 'tree-thin', ok: true, ms: 0, detail: 'accessibility tree too small; using OCR' });
    return 'ocr';
  }

  // -- tree path -----------------------------------------------------------

  private async deliverByTree(request: DeliveryRequest, window: GuiWindow, bounds: Bounds): Promise<void> {
    const { session } = this.options;

    if (request.job.conversation && request.job.conversation.kind !== 'current') {
      await this.step(request, 'conversation', async () => {
        const conversation = request.job.conversation!;
        const dump = await session.dump(window.hwnd);
        if (conversation.kind === 'new') {
          await session.keys('ctrl+n');
          await this.sleep(900);
          return;
        }
        if (!conversation.name) throw new StepFailure('CONVERSATION_NOT_FOUND', 'conversation name is empty');
        const match = pickConversationNode(dump.nodes, conversation.name, bounds);
        if (!match.node) {
          throw new StepFailure('CONVERSATION_NOT_FOUND', `conversation not found: ${conversation.name}`);
        }
        if (match.ambiguous) {
          throw new StepFailure('CONVERSATION_AMBIGUOUS', `multiple conversations named ${conversation.name}`);
        }
        await this.clickNode(window.hwnd, match.node);
        await this.sleep(900);
        const after = await session.dump(window.hwnd);
        const selected = after.nodes.some(
          (node) =>
            node.name.trim().toLowerCase() === conversation.name!.trim().toLowerCase() &&
            (stateHas(node.state, STATE_SYSTEM_SELECTED) || stateHas(node.state, STATE_SYSTEM_CHECKED)),
        );
        if (!selected && transcriptDigest(after.nodes) === transcriptDigest(dump.nodes)) {
          throw new StepFailure('SESSION_DRIFT', `conversation did not switch to ${conversation.name}`);
        }
      });
    }

    if (request.job.model?.name) {
      await this.tryModelSwitch(request, window, bounds);
    } else if (request.job.model?.thinking || request.job.model?.params) {
      request.onStep({
        step: 'model-params',
        ok: true,
        ms: 0,
        detail: 'no model selected; per-request parameters were not applied',
      });
    }

    if (request.job.capabilities) {
      const capabilities = request.job.capabilities;
      const requested = [
        capabilities.mode,
        ...(capabilities.skills ?? []),
        ...(capabilities.mcp ?? []),
        ...(capabilities.plugins ?? []),
        ...(capabilities.experts ?? []),
      ].filter((value): value is string => Boolean(value));
      if (requested.length) {
        request.onStep({
          step: 'capabilities',
          ok: true,
          ms: 0,
          detail: `generic target: not toggled blindly (${requested.join(', ')})`,
        });
      }
    }

    const workspace = request.job.capabilities?.workspace ?? request.job.conversation?.workspace;
    if (workspace) {
      await this.step(request, 'workspace', async () => {
        const dump = await session.dump(window.hwnd);
        const node = dump.nodes.find(
          (candidate) =>
            candidate.name.trim().toLowerCase() === workspace.trim().toLowerCase() &&
            (candidate.role === ROLE_PUSH_BUTTON || candidate.role === ROLE_MENU_ITEM) &&
            !stateHas(candidate.state, STATE_SYSTEM_UNAVAILABLE),
        );
        if (!node) throw new StepFailure('WORKSPACE_MISSING', `workspace not found: ${workspace}`);
        const active = stateHas(node.state, STATE_SYSTEM_SELECTED) || stateHas(node.state, STATE_SYSTEM_CHECKED);
        if (!active) await this.clickNode(window.hwnd, node);
        await this.sleep(700);
      });
    }

    await this.step(request, 'paste', async () => {
      const dump = await session.dump(window.hwnd);
      const input = pickInputNode(dump.nodes, bounds);
      if (!input) throw new StepFailure('INPUT_NOT_FOUND', 'composer not found');

      const marker = promptMarker(request.prompt);
      if (marker.length >= 12 && (input.value ?? '').includes(marker)) return;

      await this.focusComposer(window.hwnd, input);
      await session.writeClipboardText(request.prompt);
      await session.keys('ctrl+v');
      await this.sleep(450);

      let accepted = await this.textAccepted(window.hwnd, bounds, request.prompt.length);
      if (!accepted) {
        await this.focusComposer(window.hwnd, input);
        await session.writeClipboardText(request.prompt);
        await session.keys('ctrl+v');
        await this.sleep(600);
        accepted = await this.textAccepted(window.hwnd, bounds, request.prompt.length);
      }
      if (!accepted) throw new StepFailure('PASTE_UNCONFIRMED', 'composer did not receive the paste');
    });

    const files = request.attachments.map((item) => item.usePath).filter((value): value is string => Boolean(value));
    if (files.length) {
      await this.step(request, 'attachments', async () => {
        try {
          const dump = await session.dump(window.hwnd);
          const input = pickInputNode(dump.nodes, bounds);
          if (input) await this.focusComposer(window.hwnd, input);
          await session.writeClipboardFiles(files);
          await session.keys('ctrl+v');
          await this.sleep(700);
        } catch (error) {
          const mapped = toAutopilotError(error);
          this.options.log.warn('generic attachment paste failed', { code: mapped.code, message: mapped.message });
          request.onStep({ step: 'attachments-skipped', ok: true, ms: 0, detail: mapped.code });
        }
      });
    }

    let digestBefore = '';
    await this.step(request, 'send', async () => {
      const dump = await session.dump(window.hwnd);
      digestBefore = transcriptDigest(dump.nodes);
      const button = pickSendButton(dump.nodes, bounds);
      if (button) {
        if (stateHas(button.state, STATE_SYSTEM_UNAVAILABLE)) {
          throw new StepFailure('SEND_DISABLED', 'send button is disabled');
        }
        const center = nodeCenter(button);
        await session.clickAt(window.hwnd, center.x, center.y);
        return;
      }
      request.onStep({ step: 'send-key', ok: true, ms: 0, detail: 'no send button; pressing Enter' });
      await session.keys('enter');
    });

    await this.step(request, 'verify', () => this.verifyTreeSent(request, window, bounds, digestBefore));
  }

  private async tryModelSwitch(request: DeliveryRequest, window: GuiWindow, bounds: Bounds): Promise<void> {
    const { session, log } = this.options;
    const spec = request.job.model!;
    if (!spec.name) return;
    const strict = request.settings.strictModelMatch;
    const started = this.now();
    try {
      const dump = await session.dump(window.hwnd);
      const trigger = pickModelTrigger(dump.nodes, bounds);
      if (!trigger) {
        request.onStep({
          step: 'model-skipped',
          ok: true,
          ms: this.now() - started,
          detail: 'no model dropdown recognized; keeping the current model',
        });
        if (strict) throw new StepFailure('MODEL_NOT_IN_CATALOG', 'model dropdown not found');
        return;
      }
      await this.clickNode(window.hwnd, trigger, { at: 'right', offsetX: -6 });
      await this.sleep(450);
      const open = await session.dump(window.hwnd);
      const popup = findPopup(open.nodes);
      const items = popup ? plausibleModelItems(popupItems(open.nodes, popup)) : [];
      if (!popup || !items.length) {
        await session.keys('esc');
        request.onStep({
          step: 'model-skipped',
          ok: true,
          ms: this.now() - started,
          detail: 'model list is empty; keeping the current model',
        });
        if (strict) throw new StepFailure('MODEL_NOT_IN_CATALOG', `model not offered: ${spec.name}`);
        return;
      }
      const choice = chooseModel(items, spec.name, (node) => node.name);
      if (!choice) {
        await session.keys('esc');
        request.onStep({
          step: 'model-skipped',
          ok: true,
          ms: this.now() - started,
          detail: `model not found in the open list: ${spec.name}`,
        });
        if (strict) throw new StepFailure('MODEL_NOT_IN_CATALOG', `model not offered: ${spec.name}`);
        return;
      }
      await this.clickNode(window.hwnd, choice.value);
      await this.sleep(450);
      const after = await session.dump(window.hwnd);
      const now = pickModelTrigger(after.nodes, bounds);
      const confirmed = now ? nameContains(now.name, choice.value.name) : true;
      request.onStep({
        step: 'model-switch',
        ok: true,
        ms: this.now() - started,
        detail: confirmed ? choice.value.name : `${choice.value.name} (unconfirmed)`,
      });

      if (spec.thinking) {
        try {
          const openNow = findPopup(after.nodes);
          const slider = openNow
            ? popupItems(after.nodes, openNow).find((node) => node.role === 51)
            : undefined;
          if (slider) {
            const point = thinkingClickPoint(slider, spec.thinking as ThinkingLevel);
            await session.clickAt(window.hwnd, point.x, point.y);
            await this.sleep(250);
          }
        } catch (error) {
          log.debug('generic thinking level not applied', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await session.keys('esc');
      await this.sleep(150);
    } catch (error) {
      await this.options.session.keys('esc').catch(() => undefined);
      if (error instanceof StepFailure) throw error;
      const mapped = toAutopilotError(error);
      if (strict) throw new StepFailure(mapped.code, mapped.message);
      request.onStep({
        step: 'model-skipped',
        ok: true,
        ms: this.now() - started,
        detail: `model switch skipped: ${mapped.code}`,
      });
      log.warn('generic model switch skipped', { code: mapped.code, message: mapped.message });
    }
  }

  private async verifyTreeSent(
    request: DeliveryRequest,
    window: GuiWindow,
    bounds: Bounds,
    digestBefore: string,
  ): Promise<void> {
    const { session } = this.options;
    const started = this.now();
    const marker = promptMarker(request.prompt);
    while (this.now() - started < this.verifyTimeoutMs) {
      if (request.shouldCancel()) throw new StepFailure('UNEXPECTED_EXCEPTION', 'cancelled');
      await this.sleep(400);
      const dump = await session.dump(window.hwnd);
      const input = pickInputNode(dump.nodes, bounds);
      const send = pickSendButton(dump.nodes, bounds);
      const inputEmpty = !input || (input.value ?? '').trim().length === 0;
      const sendDisabled = !send || stateHas(send.state, STATE_SYSTEM_UNAVAILABLE);
      const transcriptMoved = transcriptDigest(dump.nodes) !== digestBefore;
      const markerVisible = marker.length >= 12 && dump.nodes.some((node) => node.name.includes(marker));
      if ((inputEmpty && (sendDisabled || transcriptMoved)) || markerVisible) return;
    }
    throw new StepFailure('SEND_UNCONFIRMED', 'send was clicked but the transcript did not confirm it');
  }

  private async focusComposer(hwnd: number, input: GuiNode): Promise<void> {
    const { session } = this.options;
    try {
      await session.act(hwnd, { path: input.path, ci: input.ci, action: 'focus' });
    } catch {
      /* clicking below still focuses the composer */
    }
    await session.act(hwnd, { path: input.path, ci: input.ci, action: 'click', at: 'left', offsetX: 36 });
    await this.sleep(180);
  }

  private async textAccepted(hwnd: number, bounds: Bounds, expected: number): Promise<boolean> {
    const { session } = this.options;
    const dump = await session.dump(hwnd);
    const send = pickSendButton(dump.nodes, bounds);
    if (send && !stateHas(send.state, STATE_SYSTEM_UNAVAILABLE)) return true;
    const input = pickInputNode(dump.nodes, bounds);
    const value = input?.value ?? '';
    const minimum = Math.min(24, Math.max(4, Math.floor(expected / 5)));
    return value.trim().length >= minimum;
  }

  // -- OCR path ------------------------------------------------------------

  private async deliverByOcr(request: DeliveryRequest, window: GuiWindow): Promise<void> {
    const { session } = this.options;
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
      throw new StepFailure('WINDOW_OCCLUDED', 'another window covers the composer');
    });

    if (request.job.conversation && request.job.conversation.kind !== 'current') {
      request.onStep({
        step: 'conversation',
        ok: true,
        ms: 0,
        detail: 'OCR-only target: conversation selection left untouched',
      });
    }
    if (request.job.model?.name) {
      request.onStep({
        step: 'model-skipped',
        ok: true,
        ms: 0,
        detail: `no model picker recognized; requested=${request.job.model.name}`,
      });
    }

    await this.step(request, 'paste', async () => {
      await this.clickInput(window, snapshot);
      await session.writeClipboardText(request.prompt);
      await session.keys('ctrl+v');
      await this.sleep(550);
      let verified = await this.verifyPasted(window, request.prompt);
      if (!verified) {
        await this.clickInput(window, snapshot);
        await session.writeClipboardText(request.prompt);
        await session.keys('ctrl+v');
        await this.sleep(700);
        verified = await this.verifyPasted(window, request.prompt);
      }
      if (!verified) throw new StepFailure('PASTE_UNCONFIRMED', 'composer did not receive the paste');
    });

    const files = request.attachments.map((item) => item.usePath).filter((value): value is string => Boolean(value));
    if (files.length) {
      await this.step(request, 'attachments', async () => {
        try {
          await this.clickInput(window, snapshot);
          await session.writeClipboardFiles(files);
          await session.keys('ctrl+v');
          await this.sleep(800);
        } catch (error) {
          const mapped = toAutopilotError(error);
          this.options.log.warn('generic attachment paste failed', { code: mapped.code, message: mapped.message });
          request.onStep({ step: 'attachments-skipped', ok: true, ms: 0, detail: mapped.code });
        }
      });
    }

    await this.step(request, 'send', async () => {
      snapshot = await this.capture(window);
      const point = ocrSendPoint(snapshot.ocr, snapshot.input);
      const explicit = snapshot.ocr.lines.some((line) => /发送|send|^[↑➤→]$/i.test(line.text.trim()));
      if (point && explicit) {
        if (!(await session.probe(window.hwnd, point.x, point.y))) {
          throw new StepFailure('WINDOW_OCCLUDED', 'send control is covered by another window');
        }
        await session.clickAt(window.hwnd, point.x, point.y);
        return;
      }
      request.onStep({ step: 'send-key', ok: true, ms: 0, detail: 'no send control recognized; pressing Enter' });
      await session.keys('enter');
    });

    await this.step(request, 'verify', () => this.verifyOcrSent(request, window));
  }

  private async capture(window: GuiWindow): Promise<OcrSnapshot> {
    const { session } = this.options;
    const name = `generic-${this.now()}-${(this.captureSeq += 1)}.png`;
    const path = join(this.options.tempDir(), name);
    try {
      const capture = await session.capture(window.hwnd, path);
      if (!capture.printWindow) throw new StepFailure('WINDOW_OCCLUDED', 'PrintWindow returned a blank frame');
      const ocr = await session.ocr(path);
      if (!ocr.lines.length) throw new StepFailure('TREE_EMPTY', 'OCR found no text in the window');
      const region = ocrInputRegion(ocr);
      if (!region) throw new StepFailure('INPUT_NOT_FOUND', 'composer region not recognized');
      return { ocr, input: region };
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      const mapped = toAutopilotError(error);
      if (mapped.code === 'AUTO_HELPER_DEAD') throw error;
      throw new StepFailure(mapped.code === 'UNEXPECTED_EXCEPTION' ? 'OCR_ENGINE_MISSING' : mapped.code, mapped.message);
    } finally {
      try {
        rmSync(path, { force: true });
      } catch {
        /* the OCR engine may still hold the file briefly */
      }
    }
  }

  private async clickInput(window: GuiWindow, snapshot: OcrSnapshot): Promise<void> {
    const { session } = this.options;
    const center = {
      x: snapshot.input.x + Math.round(snapshot.input.w / 2),
      y: snapshot.input.y + Math.round(snapshot.input.h / 2),
    };
    await session.clickAt(window.hwnd, center.x, center.y);
    await this.sleep(150);
    await session.focus(window.hwnd, 80);
  }

  private async verifyPasted(window: GuiWindow, prompt: string): Promise<boolean> {
    const snapshot = await this.capture(window);
    const text = ocrTextIn(snapshot.ocr, snapshot.input);
    const marker = promptMarker(prompt);
    if (marker.length >= 6 && text.replace(/\s+/g, '').includes(marker.replace(/\s+/g, ''))) return true;
    return text.trim().length >= Math.min(40, prompt.trim().length / 3);
  }

  private async verifyOcrSent(request: DeliveryRequest, window: GuiWindow): Promise<void> {
    const started = this.now();
    const marker = promptMarker(request.prompt);
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
    throw new StepFailure('SEND_UNCONFIRMED', 'the prompt never appeared in the transcript');
  }

  // -- primitives ----------------------------------------------------------

  private async clickNode(
    hwnd: number,
    node: GuiNode,
    options: { at?: 'left' | 'center' | 'right'; offsetX?: number; offsetY?: number } = {},
  ): Promise<void> {
    await this.options.session.act(hwnd, {
      path: node.path,
      ci: node.ci,
      action: 'click',
      at: options.at ?? 'center',
      offsetX: options.offsetX,
      offsetY: options.offsetY,
    });
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

function windowSpec(ref: AutopilotWindowRef | undefined): WindowSpec | null {
  if (!ref) return null;
  const spec: WindowSpec = { processNames: ref.process ? [ref.process] : [] };
  if (ref.title) {
    if (ref.titleMatch === 'equals') spec.titleEquals = [ref.title];
    else spec.titleContains = [ref.title];
  }
  if (ref.className) spec.className = ref.className;
  if (!ref.process && !ref.title) spec.matchAny = true;
  return spec;
}

function promptMarker(prompt: string): string {
  return prompt.trim().slice(0, 24);
}
