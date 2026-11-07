import {
  chooseModel,
  scoreModelName,
  type AutopilotErrorCode,
  type ModelCatalogEntry,
  type ThinkingLevel,
} from '../../shared/autopilot';
import { THINKING_RING, thinkingSteps } from '../../shared/autopilot-ui';
import type { DeliveryRequest, DeliveryResult, TargetAdapter } from './autopilot-engine';
import {
  ClipboardGuard,
  ROLE_MENU_ITEM,
  ROLE_LIST_ITEM,
  ROLE_PUSH_BUTTON,
  ROLE_SLIDER,
  STATE_SYSTEM_CHECKED,
  STATE_SYSTEM_OFFSCREEN,
  STATE_SYSTEM_SELECTED,
  STATE_SYSTEM_UNAVAILABLE,
  GuiSession,
  nameContains,
  nodeCenter,
  stateHas,
  toAutopilotError,
  type GuiNode,
  type GuiWindow,
  type MsaaDump,
} from './autopilot-gui';
import {
  capabilityNodes,
  findNamedNode,
  findPopup,
  leftOfAnchorPoint,
  looksLikeNoQuota,
  modelRowsInPopup,
  pickConversationNode,
  pickIconLeftOf,
  pickInputNode,
  pickModeTrigger,
  pickModelTrigger,
  pickSendButton,
  pickSupplierHeader,
  popupItems,
  readThinkingLevel,
  supplierItems,
  thinkingClickPoint,
  transcriptDigest,
  type Bounds,
} from './autopilot-heuristics';
import type { Logger } from './logger';

const KNOWN_SUPPLIERS = ['Start Plan', 'Z.ai', '阿里云百炼', '智谱'];

const CONVERSATION_EXCLUDES = [
  '新建任务',
  '自动化',
  '插件市场',
  '搜索',
  '任务列表',
  '任务',
  '项目',
  '设置',
  '移动端远程控制',
  '收起全部项目',
  '新项目',
  '查看文件',
  '更多',
];

interface ZCodeOptions {
  session: GuiSession;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds the send verification waits for the transcript to change. */
  verifyTimeoutMs?: number;
}

class StepFailure extends Error {
  constructor(
    readonly code: AutopilotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * ZCode speaks MSAA, so the whole delivery runs on the accessibility tree.
 * Coordinates are physical pixels from the helper end to end.
 */
export class ZCodeAdapter implements TargetAdapter {
  readonly id = 'zcode';
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verifyTimeoutMs: number;

  constructor(private readonly options: ZCodeOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 8_000;
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const { session, log } = this.options;
    let win: GuiWindow;
    try {
      win = await this.locate();
    } catch (error) {
      const mapped = toAutopilotError(error);
      request.onStep({ step: 'locate', ok: false, ms: 0, code: mapped.code, detail: mapped.message });
      return { ok: false, code: mapped.code, message: mapped.message };
    }

    const bounds: Bounds = { x: win.rect[0], y: win.rect[1], w: win.rect[2], h: win.rect[3] };
    const guard = new ClipboardGuard(session);
    const wasMinimized = win.minimized;
    await guard.save();

    try {
      await this.step(request, 'locate', async () => {
        if (wasMinimized) {
          await session.show(win.hwnd, 'restore');
          await this.sleep(350);
        }
        const focused = await session.focus(win.hwnd);
        if (!focused) log.warn('zcode could not take the foreground; clicking will focus it');
      });

      if (request.job.conversation && request.job.conversation.kind !== 'current') {
        await this.step(request, 'conversation', () => this.applyConversation(request, win, bounds));
      }

      if (request.job.model?.name) {
        await this.ensureModel(request, win, bounds);
      }

      if (request.job.capabilities) {
        await this.applyCapabilities(request, win, bounds);
      }

      const workspace = request.job.capabilities?.workspace ?? request.job.conversation?.workspace;
      if (workspace) {
        await this.step(request, 'workspace', async () => {
          const dump = await session.dump(win.hwnd);
          const node = findNamedNode(dump.nodes, [workspace], { roles: [ROLE_PUSH_BUTTON, ROLE_MENU_ITEM] });
          if (!node) throw new StepFailure('WORKSPACE_MISSING', `workspace not found: ${workspace}`);
          const current = stateHas(node.state, STATE_SYSTEM_SELECTED) || stateHas(node.state, STATE_SYSTEM_CHECKED);
          if (!current) await this.clickNode(win.hwnd, node);
          await this.sleep(700);
        });
      }

      await this.step(request, 'paste', () => this.pastePrompt(request, win, bounds));

      const files = request.attachments
        .map((attachment) => attachment.usePath)
        .filter((value): value is string => Boolean(value));
      if (files.length) {
        await this.step(request, 'attachments', () => this.pasteAttachments(request, win, files));
      }

      const sendNode = await this.step(request, 'send-check', async () => {
        const dump = await session.dump(win.hwnd);
        const node = pickSendButton(dump.nodes, bounds);
        if (!node) throw new StepFailure('SEND_DISABLED', 'send button not found');
        if (stateHas(node.state, STATE_SYSTEM_UNAVAILABLE)) {
          throw new StepFailure('SEND_DISABLED', 'send button is disabled; the composer did not accept the text');
        }
        return node;
      });

      let digestBefore = '';
      await this.step(request, 'send', async () => {
        const dump = await session.dump(win.hwnd);
        digestBefore = transcriptDigest(dump.nodes);
        const center = nodeCenter(sendNode);
        await session.clickAt(win.hwnd, center.x, center.y);
      });

      await this.step(request, 'verify', () => this.verifySent(request, win, bounds, digestBefore));
      return { ok: true };
    } catch (error) {
      if (error instanceof StepFailure) {
        return { ok: false, code: error.code, message: error.message };
      }
      const mapped = toAutopilotError(error);
      return { ok: false, code: mapped.code, message: mapped.message };
    } finally {
      try {
        await this.dismissPopup(win);
        await session.keys('esc');
        await this.sleep(120);
        await guard.restore();
      } catch (error) {
        log.warn('zcode cleanup failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (wasMinimized) {
        try {
          await session.show(win.hwnd, 'minimize');
        } catch {
          /* the window may already be gone */
        }
      }
    }
  }

  /** Opens the model popup and returns every entry the UI exposes. */
  async snapshotModels(): Promise<ModelCatalogEntry[]> {
    const win = await this.locate();
    const bounds: Bounds = { x: win.rect[0], y: win.rect[1], w: win.rect[2], h: win.rect[3] };
    await this.options.session.focus(win.hwnd);
    const popup = await this.openModelPopup(win, bounds);
    const observedAt = new Date(this.now()).toISOString();
    const items = modelRowsInPopup(popup.items, popup.popup);
    const entries = items.map((node) => ({
      provider: this.guessProvider(popup.items, node),
      name: node.name.trim(),
      source: 'observed' as const,
      observedAt,
    }));
    await this.dismissPopup(win);
    return entries;
  }

  /** Reads the left outline; used to populate the conversation picker. */
  async snapshotConversations(): Promise<string[]> {
    const win = await this.locate();
    const bounds: Bounds = { x: win.rect[0], y: win.rect[1], w: win.rect[2], h: win.rect[3] };
    const initial = await this.options.session.dump(win.hwnd);
    if (findPopup(initial.nodes)) await this.dismissPopup(win);
    const dump = await this.options.session.dump(win.hwnd);
    const names = new Set<string>();
    const top = bounds.y + bounds.h * 0.12;
    const bottom = bounds.y + bounds.h * 0.9;
    for (const node of dump.nodes) {
      if (node.rect[0] > bounds.x + bounds.w * 0.28) continue;
      if (node.role !== ROLE_PUSH_BUTTON) continue;
      // Conversation rows fill the sidebar; message actions are ~36 px icons.
      if (node.rect[2] < 80) continue;
      if (node.rect[3] < 30 || node.rect[3] > 80) continue;
      if (node.rect[1] < top || node.rect[1] > bottom) continue;
      if (stateHas(node.state, STATE_SYSTEM_OFFSCREEN)) continue;
      const name = node.name.trim();
      if (!name || name.length > 80) continue;
      if (CONVERSATION_EXCLUDES.some((skip) => name.includes(skip))) continue;
      if (KNOWN_SUPPLIERS.some((supplier) => name.includes(supplier))) continue;
      names.add(name);
    }
    return [...names];
  }

  // -- steps ---------------------------------------------------------------

  private async locate(): Promise<GuiWindow> {
    const windows = await this.options.session.listWindows({ includeInvisible: true });
    const win = pickZCodeWindow(windows);
    if (!win) throw new StepFailure('TARGET_NOT_RUNNING', 'ZCode window not found');
    if (!win.visible) {
      await this.options.session.show(win.hwnd, 'restore');
      await this.sleep(300);
    }
    return win;
  }

  private async applyConversation(request: DeliveryRequest, win: GuiWindow, bounds: Bounds): Promise<void> {
    const conversation = request.job.conversation;
    if (!conversation) return;
    const { session } = this.options;
    if (conversation.kind === 'new') {
      const dump = await session.dump(win.hwnd);
      const create = findNamedNode(dump.nodes, ['新建任务', '新任务', '新建会话', 'New task'], {
        roles: [ROLE_PUSH_BUTTON],
      });
      if (create) await this.clickNode(win.hwnd, create);
      else await session.keys('ctrl+n');
      await this.sleep(900);
      return;
    }
    if (!conversation.name) throw new StepFailure('CONVERSATION_NOT_FOUND', 'conversation name is empty');

    const before = await session.dump(win.hwnd);
    const match = pickConversationNode(before.nodes, conversation.name, bounds);
    if (!match.node) throw new StepFailure('CONVERSATION_NOT_FOUND', `conversation not found: ${conversation.name}`);
    if (match.ambiguous) {
      throw new StepFailure('CONVERSATION_AMBIGUOUS', `multiple conversations named ${conversation.name}`);
    }
    await this.clickNode(win.hwnd, match.node);
    await this.sleep(900);

    const after = await session.dump(win.hwnd);
    const selected = after.nodes.some(
      (node) =>
        node.name.trim().toLowerCase() === conversation.name!.trim().toLowerCase() &&
        (stateHas(node.state, STATE_SYSTEM_SELECTED) || stateHas(node.state, STATE_SYSTEM_CHECKED)),
    );
    if (!selected && transcriptDigest(after.nodes) === transcriptDigest(before.nodes)) {
      throw new StepFailure('SESSION_DRIFT', `conversation did not switch to ${conversation.name}`);
    }
  }

  private async ensureModel(request: DeliveryRequest, win: GuiWindow, bounds: Bounds): Promise<void> {
    const spec = request.job.model;
    if (!spec?.name) return;
    const requestedName = spec.name;
    const { session } = this.options;

    let popup = await this.step(request, 'model-open', () => this.openModelPopup(win, bounds));

    if (looksLikeNoQuota(popup.items, popup.popup)) {
      await this.step(request, 'model-refresh', () => this.refreshModels(win));
      popup = await this.step(request, 'model-open', () => this.openModelPopup(win, bounds));
      if (looksLikeNoQuota(popup.items, popup.popup)) {
        throw new StepFailure(
          'MODEL_UNAVAILABLE_NO_QUOTA',
          'model list is empty after refreshing the provider settings',
        );
      }
    }

    const candidates = modelRowsInPopup(popup.items, popup.popup);
    if (!candidates.length) {
      throw new StepFailure('MODEL_UNAVAILABLE_NO_QUOTA', 'model list is empty');
    }

    const choice = chooseModel(candidates, requestedName, (node) => node.name);
    if (!choice) throw new StepFailure('MODEL_NOT_IN_CATALOG', `model not offered by ZCode: ${requestedName}`);
    if (choice.needsConfirmation) {
      this.options.log.debug('zcode model match needs confirmation', {
        query: requestedName,
        chosen: choice.value.name,
        score: choice.score,
      });
    }

    const alreadyChecked =
      stateHas(choice.value.state, STATE_SYSTEM_CHECKED) || stateHas(choice.value.state, STATE_SYSTEM_SELECTED);

    await this.step(request, 'model-switch', async () => {
      if (!alreadyChecked) {
        await this.clickNode(win.hwnd, choice.value);
        await this.sleep(450);
      }
      const after = await session.dump(win.hwnd);
      const trigger = pickModelTrigger(after.nodes, bounds);
      const checked =
        after.nodes.some(
          (node) =>
            node.name.trim() === choice.value.name.trim() &&
            (stateHas(node.state, STATE_SYSTEM_CHECKED) || stateHas(node.state, STATE_SYSTEM_SELECTED)),
        );
      const triggerMatches =
        (trigger && scoreModelName(trigger.name, choice.value.name) >= 80) ||
        (trigger !== null && scoreModelName(trigger.name, requestedName) >= 80);
      if (!alreadyChecked && !checked && !triggerMatches) {
        throw new StepFailure('MODEL_SWITCH_UNCONFIRMED', `model did not switch to ${choice.value.name}`);
      }
    });

    if (spec.thinking) {
      const wanted = spec.thinking;
      try {
        await this.step(request, 'thinking', () => this.ensureThinkingLevel(win, wanted));
      } catch (error) {
        // Thinking strength is advisory: the model still works at its default.
        this.options.log.debug('zcode thinking level not applied', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (spec.params && Object.keys(spec.params).length > 0) {
      request.onStep({
        step: 'model-params',
        ok: true,
        ms: 0,
        detail: 'ZCode has no per-request parameter UI; parameters stored for fallback routes only',
      });
    }
    await this.dismissPopup(win);
  }

  /**
   * One Ctrl+T press moves ZCode to the next stop of a five-stop ring, so the
   * level is reached by stepping from whatever the popup shows now. Dragging
   * the slider is only used when the label cannot be read at all.
   */
  private async ensureThinkingLevel(win: GuiWindow, level: ThinkingLevel): Promise<void> {
    const { session } = this.options;
    const dump = await session.dump(win.hwnd);
    const popup = findPopup(dump.nodes);
    if (!popup) throw new StepFailure('THINKING_LEVEL_NOT_SET', 'model popup is not open');
    const items = popupItems(dump.nodes, popup);
    let current = readThinkingLevel(items);
    if (current === level) return;
    if (current === null) {
      const slider = items.find((node) => node.role === ROLE_SLIDER);
      if (!slider) throw new StepFailure('THINKING_LEVEL_NOT_SET', 'thinking control is not exposed');
      const point = thinkingClickPoint(slider, level);
      await session.clickAt(win.hwnd, point.x, point.y);
      await this.sleep(250);
      return;
    }
    const expected = thinkingSteps(current, level);
    const presses = expected > 0 ? expected : THINKING_RING.length - 1;
    for (let press = 0; press < presses; press += 1) {
      await session.keys('ctrl+t');
      await this.sleep(300);
      const after = await session.dump(win.hwnd);
      const afterPopup = findPopup(after.nodes);
      current = afterPopup ? readThinkingLevel(popupItems(after.nodes, afterPopup)) : current;
      if (current === level) return;
    }
    throw new StepFailure(
      'THINKING_LEVEL_NOT_SET',
      `thinking level ${level} is not offered by this model (stuck on ${current ?? 'unknown'})`,
    );
  }

  private async applyCapabilities(request: DeliveryRequest, win: GuiWindow, bounds: Bounds): Promise<void> {
    const capabilities = request.job.capabilities;
    if (!capabilities) return;
    const { session } = this.options;

    if (capabilities.mode) {
      await this.step(request, 'mode', async () => {
        const dump = await session.dump(win.hwnd);
        const trigger = pickModeTrigger(dump.nodes, bounds);
        if (!trigger) throw new StepFailure('UNEXPECTED_EXCEPTION', 'mode switch is not available');
        await this.clickNode(win.hwnd, trigger);
        await this.sleep(450);
        const open = await session.dump(win.hwnd);
        const popup = findPopup(open.nodes);
        const item = popup
          ? popupItems(open.nodes, popup).find(
              (node) => node.role === ROLE_MENU_ITEM && nameContains(node.name, capabilities.mode!),
            )
          : undefined;
        if (!item) throw new StepFailure('UNEXPECTED_EXCEPTION', `mode not found: ${capabilities.mode}`);
        await this.clickNode(win.hwnd, item);
        await this.sleep(350);
      });
    }

    const groups: Array<[string, string[] | undefined]> = [
      ['skill', capabilities.skills],
      ['mcp', capabilities.mcp],
      ['plugin', capabilities.plugins],
      ['expert', capabilities.experts],
    ];
    for (const [group, names] of groups) {
      if (!names || names.length === 0) continue;
      await this.step(request, group, async () => {
        const dump = await session.dump(win.hwnd);
        let applied = 0;
        for (const name of names) {
          for (const node of capabilityNodes(dump.nodes, name)) {
            if (stateHas(node.state, STATE_SYSTEM_CHECKED)) {
              applied += 1;
              continue;
            }
            await this.clickNode(win.hwnd, node);
            await this.sleep(200);
            applied += 1;
            break;
          }
        }
        if (applied < names.length) {
          request.onStep({
            step: `${group}-partial`,
            ok: true,
            ms: 0,
            detail: `${applied}/${names.length} toggles visible on the current screen`,
          });
        }
      });
    }
  }

  private async pastePrompt(request: DeliveryRequest, win: GuiWindow, bounds: Bounds): Promise<void> {
    const { session } = this.options;
    const dump = await session.dump(win.hwnd);
    const input = pickInputNode(dump.nodes, bounds);
    if (!input) throw new StepFailure('INPUT_NOT_FOUND', 'composer not found');
    await this.focusComposer(win.hwnd, input);
    await session.writeClipboardText(request.prompt);
    await session.keys('ctrl+v');
    await this.sleep(400);

    let accepted = await this.textAccepted(win.hwnd, bounds, request.prompt.length);
    if (!accepted) {
      await this.focusComposer(win.hwnd, input);
      await session.writeClipboardText(request.prompt);
      await session.keys('ctrl+v');
      await this.sleep(500);
      accepted = await this.textAccepted(win.hwnd, bounds, request.prompt.length);
    }
    if (!accepted) throw new StepFailure('PASTE_UNCONFIRMED', 'composer did not receive the paste');
  }

  private async pasteAttachments(request: DeliveryRequest, win: GuiWindow, files: string[]): Promise<void> {
    const { session } = this.options;
    const dump = await session.dump(win.hwnd);
    const input = pickInputNode(dump.nodes, windowBounds(win));
    if (input) await this.focusComposer(win.hwnd, input);
    try {
      await session.writeClipboardFiles(files);
      await session.keys('ctrl+v');
      await this.sleep(600);
    } catch (error) {
      // Attachments are an enhancement: the prompt already carries a note about
      // missing files, so a rejected drop must not abort the delivery.
      const mapped = toAutopilotError(error);
      this.options.log.warn('zcode attachment paste failed', { code: mapped.code, message: mapped.message });
      request.onStep({ step: 'attachments-skipped', ok: true, ms: 0, detail: mapped.code });
    }
  }

  private async verifySent(
    request: DeliveryRequest,
    win: GuiWindow,
    bounds: Bounds,
    digestBefore: string,
  ): Promise<void> {
    const { session } = this.options;
    const started = this.now();
    const promptMarker = request.prompt.trim().slice(0, 24);
    while (this.now() - started < this.verifyTimeoutMs) {
      if (request.shouldCancel()) throw new StepFailure('UNEXPECTED_EXCEPTION', 'cancelled');
      await this.sleep(400);
      const dump = await session.dump(win.hwnd);
      const input = pickInputNode(dump.nodes, bounds);
      const send = pickSendButton(dump.nodes, bounds);
      const inputEmpty = !input || (input.value ?? '').trim().length === 0;
      const sendDisabled = !send || stateHas(send.state, STATE_SYSTEM_UNAVAILABLE);
      const transcriptMoved = transcriptDigest(dump.nodes) !== digestBefore;
      const markerVisible =
        promptMarker.length >= 12 &&
        dump.nodes.some((node) => node.name.includes(promptMarker));
      if ((inputEmpty && (sendDisabled || transcriptMoved)) || markerVisible) return;
    }
    throw new StepFailure('SEND_UNCONFIRMED', 'send was clicked but the composer and transcript did not confirm it');
  }

  // -- model helpers -------------------------------------------------------

  private async openModelPopup(win: GuiWindow, bounds: Bounds): Promise<{
    trigger: GuiNode;
    popup: GuiNode;
    items: GuiNode[];
    dump: MsaaDump;
  }> {
    const { session } = this.options;
    let dump = await session.dump(win.hwnd);
    const existing = findPopup(dump.nodes);
    const initialTrigger = pickModelTrigger(dump.nodes, bounds);
    if (existing) {
      if (!initialTrigger) throw new StepFailure('MODEL_POPUP_NOT_OPENED', 'model trigger is not exposed');
      return {
        trigger: initialTrigger,
        popup: existing,
        items: popupItems(dump.nodes, existing),
        dump,
      };
    }
    if (!initialTrigger) throw new StepFailure('MODEL_POPUP_NOT_OPENED', 'model trigger not found');
    let trigger = initialTrigger;

    // The trigger toggles the popup, so retries alternate between open and
    // closed. Always re-read the tree and stop as soon as role 11 appears.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.clickNode(win.hwnd, trigger, { at: 'center' });
      } catch {
        /* the tree changed between the dump and the click; retry below */
      }
      await this.sleep(450 + attempt * 150);
      dump = await session.dump(win.hwnd);
      const popup = findPopup(dump.nodes);
      if (popup) return { trigger, popup, items: popupItems(dump.nodes, popup), dump };
      trigger = pickModelTrigger(dump.nodes, bounds) ?? trigger;
    }
    throw new StepFailure('MODEL_POPUP_NOT_OPENED', 'model popup did not open');
  }

  /**
   * ZCode ignores Esc for the model popup; clicking the composer is the
   * reliable dismissal and is harmless when nothing is open.
   */
  private async dismissPopup(win: GuiWindow): Promise<void> {
    const { session } = this.options;
    const dump = await session.dump(win.hwnd);
    if (!findPopup(dump.nodes)) return;
    if (win.minimized) await session.show(win.hwnd, 'restore');
    // A dismissal click must land on ZCode, never on whatever is in front.
    await session.focus(win.hwnd);
    const bounds: Bounds = { x: win.rect[0], y: win.rect[1], w: win.rect[2], h: win.rect[3] };
    const input = pickInputNode(dump.nodes, bounds);
    const point = input
      ? { x: input.rect[0] + 40, y: input.rect[1] + Math.floor(input.rect[3] / 2) }
      : {
          x: bounds.x + Math.round(bounds.w * 0.4),
          y: bounds.y + Math.round(bounds.h * 0.85),
        };
    await session.clickAt(win.hwnd, point.x, point.y);
    await this.sleep(350);
  }

  /**
   * ZCode hides the model list when the account has no quota, so the catalog is
   * rebuilt by walking into 模型设置 and pressing refresh. `管理模型` only
   * exists once the popup's supplier column has been revealed, and the refresh
   * control itself is an unnamed icon next to `添加供应商`.
   */
  private async refreshModels(win: GuiWindow): Promise<void> {
    const { session } = this.options;
    let manage: GuiNode | null = null;
    for (let attempt = 0; attempt < 3 && !manage; attempt += 1) {
      const dump = await session.dump(win.hwnd);
      manage = findNamedNode(dump.nodes, ['管理模型'], {
        roles: [ROLE_MENU_ITEM, ROLE_LIST_ITEM, ROLE_PUSH_BUTTON],
        exact: false,
      });
      if (manage) break;
      const popup = findPopup(dump.nodes);
      const header = popup ? pickSupplierHeader(popupItems(dump.nodes, popup), popup) : null;
      if (!header) break;
      await this.clickNode(win.hwnd, header, { at: 'center' });
      await this.sleep(500);
    }
    if (!manage) {
      throw new StepFailure('MODEL_UNAVAILABLE_NO_QUOTA', 'manage-models entry is not available');
    }
    await this.clickNode(win.hwnd, manage);
    await this.sleep(900);

    let refreshed = false;
    const deadline = this.now() + 15_000;
    while (this.now() < deadline) {
      const dump = await session.dump(win.hwnd);
      const texts = dump.nodes.map((node) => node.name).join('\n');
      if (/已过期|已失效|expired/i.test(texts)) {
        throw new StepFailure('QUOTA_EXPIRED', 'model provider credentials have expired');
      }
      const loading = /加载中|loading/i.test(texts);
      const refresh =
        findNamedNode(dump.nodes, ['刷新', 'Refresh'], { roles: [ROLE_PUSH_BUTTON], exact: false }) ??
        pickIconLeftOf(dump.nodes, '添加供应商');
      if (refresh) {
        if (loading) {
          await this.sleep(700);
          continue;
        }
        await this.clickNode(win.hwnd, refresh, { at: 'center' });
        refreshed = true;
        break;
      }
      const addProvider = findNamedNode(dump.nodes, ['添加供应商'], { roles: [ROLE_PUSH_BUTTON], exact: false });
      if (addProvider) {
        // Same layout, icon without an accessible name: aim left of the label.
        const point = leftOfAnchorPoint(addProvider);
        await session.clickAt(win.hwnd, point.x, point.y);
        refreshed = true;
        break;
      }
      await this.sleep(700);
    }
    if (!refreshed) throw new StepFailure('MODEL_REFRESH_FAILED', 'refresh button never became available');
    await this.sleep(1_200);
    const after = await session.dump(win.hwnd);
    if (/未就绪|not ready/i.test(after.nodes.map((node) => node.name).join('\n'))) {
      throw new StepFailure('PROVIDER_NOT_READY', 'provider is not ready after refresh');
    }

    const back = findNamedNode(after.nodes, ['返回工作区', 'Back to workspace'], {
      roles: [ROLE_PUSH_BUTTON, ROLE_MENU_ITEM, ROLE_LIST_ITEM],
      exact: false,
    });
    if (back) await this.clickNode(win.hwnd, back);
    else await session.keys('esc');
    await this.sleep(800);
  }

  private guessProvider(items: readonly GuiNode[], model: GuiNode): string {
    const suppliers = supplierItems(items);
    if (!suppliers.length) return 'ZCode';
    const above = suppliers.filter((node) => node.rect[1] <= model.rect[1]);
    const best = above.sort((a, b) => b.rect[1] - a.rect[1])[0] ?? suppliers[0];
    const name = best.name.trim();
    const known = KNOWN_SUPPLIERS.find((supplier) => name.toLowerCase().includes(supplier.toLowerCase()));
    return known ?? (name.replace(/\s*API$/i, '').trim() || 'ZCode');
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

  private async focusComposer(hwnd: number, input: GuiNode): Promise<void> {
    const { session } = this.options;
    try {
      await session.act(hwnd, { path: input.path, ci: input.ci, action: 'focus' });
    } catch {
      /* clicking below still focuses the composer */
    }
    await session.act(hwnd, {
      path: input.path,
      ci: input.ci,
      action: 'click',
      at: 'left',
      offsetX: 36,
    });
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

export function pickZCodeWindow(windows: readonly GuiWindow[]): GuiWindow | null {
  const matches = windows.filter((win) => {
    if (win.process.toLowerCase() !== 'zcode' && !win.title.toLowerCase().includes('zcode')) return false;
    if (win.class !== 'Chrome_WidgetWin_1') return false;
    return win.rect[2] > 400 && win.rect[3] > 300;
  });
  if (!matches.length) return null;
  const score = (win: GuiWindow): number => {
    let value = win.rect[2] * win.rect[3];
    if (win.visible) value += 10_000_000;
    if (!win.minimized) value += 20_000_000;
    if (win.title.toLowerCase() === 'zcode') value += 30_000_000;
    return value;
  };
  return [...matches].sort((a, b) => score(b) - score(a))[0];
}

function windowBounds(win: GuiWindow): Bounds {
  return { x: win.rect[0], y: win.rect[1], w: win.rect[2], h: win.rect[3] };
}
