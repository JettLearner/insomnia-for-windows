import { desktopCapturer } from 'electron';
import {
  buildGuiPreview,
  buildGuiSendPlan,
  buildGuiWindows,
  mapRecordResult,
  mapRecordStatus,
  mapScan,
  type BuildGuiPreviewOptions,
} from '../../shared/gui';
import { normalizeSoftStopPrompt, guiTargetAllowed } from '../../shared/soft-stop';
import type {
  GuiPreview,
  GuiPreviewTarget,
  GuiRecordResult,
  GuiRecordStartResult,
  GuiRecordStatus,
  GuiSendResult,
  GuiSendStepResult,
  GuiWindowInfo,
} from '../../shared/soft-stop';
import type { Settings } from '../../shared/types';
import { HelperError, type HelperClient } from './helper-client';
import type { GuiProfileStore } from './gui-profile-store';
import type { Logger } from './logger';

interface GuiAgentOptions {
  helper: HelperClient;
  profiles: GuiProfileStore;
  getSettings: () => Settings;
  logger: Logger;
}

export interface GuiScanOptions {
  processName?: string;
  windowTitle?: string;
  maxWindows?: number;
  maxElements?: number;
  capture?: boolean;
  allowlist?: readonly string[];
  dryRun?: boolean;
  autoSend?: boolean;
}

export interface GuiSendOptions {
  prompt: string;
  autoSend?: boolean;
  confirmed?: boolean;
  dryRun?: boolean;
  maxConversations?: number;
  processName?: string;
  windowTitle?: string;
}

const MAX_CONVERSATIONS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GuiAgent {
  private readonly options: GuiAgentOptions;

  constructor(options: GuiAgentOptions) {
    this.options = options;
  }

  private settings(): Settings {
    return this.options.getSettings();
  }

  private async ensureHelper(): Promise<void> {
    if (this.options.helper.connected) return;
    const ok = await this.options.helper.ensure();
    if (!ok) {
      throw new HelperError('HELPER_OFFLINE', 'The power helper is offline.');
    }
  }

  private previewOptions(overrides: {
    allowlist?: readonly string[];
    dryRun?: boolean;
    autoSend?: boolean;
    screenshot?: string | null;
  }): BuildGuiPreviewOptions {
    const settings = this.settings();
    return {
      allowlist: overrides.allowlist ?? settings.softStopGuiAllowlist,
      dryRun: overrides.dryRun ?? settings.softStopDryRun,
      autoSend: overrides.autoSend ?? settings.softStopAutoSend,
      confirmed: (target) =>
        target !== null && this.options.profiles.isConfirmed(target.process, target.title),
      screenshot: overrides.screenshot ?? null,
    };
  }

  private async readPreview(raw: unknown, options: BuildGuiPreviewOptions): Promise<GuiPreview> {
    const mapped = mapScan(raw);
    return buildGuiPreview(mapped, this.options.profiles.list(), options);
  }

  async scan(options: GuiScanOptions = {}): Promise<GuiPreview> {
    await this.ensureHelper();
    const settings = this.settings();
    const allowlist = options.allowlist ?? settings.softStopGuiAllowlist;
    const dryRun = options.dryRun ?? settings.softStopDryRun;
    const autoSend = options.autoSend ?? settings.softStopAutoSend;
    const raw = await this.options.helper.guiScan({
      ...(options.processName ? { processName: options.processName } : {}),
      ...(options.windowTitle ? { windowTitle: options.windowTitle } : {}),
      maxWindows: options.maxWindows ?? 8,
      maxElements: options.maxElements ?? 260,
    });
    let preview = await this.readPreview(
      raw,
      this.previewOptions({ allowlist, dryRun, autoSend, screenshot: null }),
    );
    if (options.capture && preview.target) {
      const screenshot = await this.captureWindow(preview.target.title);
      preview = { ...preview, screenshot };
    }
    this.options.logger.log('info', '[gui] scan complete', {
      windows: preview.windows.length,
      candidates: preview.candidates.length,
      target: preview.target?.process ?? null,
      blocked: preview.blocked,
    });
    return preview;
  }

  private targetAllowlisted(target: GuiPreviewTarget | null, allowlist: readonly string[]): boolean {
    if (!target) return false;
    return guiTargetAllowed(allowlist, target.process, target.title);
  }

  async captureWindow(title: string): Promise<string | null> {
    if (!title) return null;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1600, height: 1000 },
        fetchWindowIcons: false,
      });
      const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
      const target = normalize(title);
      const match =
        sources.find((source) => normalize(source.name) === target) ??
        sources.find((source) => normalize(source.name).includes(target)) ??
        sources.find((source) => target.includes(normalize(source.name)));
      if (!match || match.thumbnail.isEmpty()) return null;
      return match.thumbnail.toDataURL();
    } catch (error) {
      this.options.logger.log('warn', '[gui] window capture failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async rescanWindow(target: GuiPreviewTarget): Promise<GuiWindowInfo | null> {
    const raw = await this.options.helper.guiScan({
      ...(target.process ? { processName: target.process } : {}),
      maxWindows: 6,
      maxElements: 260,
    });
    const windows = buildGuiWindows(mapScan(raw), this.options.profiles.list());
    return windows.find((window) => window.handle === target.handle) ?? null;
  }

  private pickRefs(window: GuiWindowInfo | null): { inputRef: string | null; sendRef: string | null } {
    if (!window) return { inputRef: null, sendRef: null };
    const inputs = window.candidates
      .filter((candidate) => candidate.label === 'input' && candidate.ref)
      .sort((a, b) => b.confidence - a.confidence);
    const sends = window.candidates
      .filter((candidate) => candidate.label === 'send' && candidate.ref)
      .sort((a, b) => b.confidence - a.confidence);
    return { inputRef: inputs[0]?.ref ?? null, sendRef: sends[0]?.ref ?? null };
  }

  private async act(
    action: string,
    ref: string,
    target: GuiPreviewTarget,
    text?: string,
  ): Promise<string> {
    const result = (await this.options.helper.guiAct({
      action,
      ref,
      hwnd: target.handle,
      ...(text === undefined ? {} : { text }),
    })) as { method?: string } | null;
    return typeof result?.method === 'string' ? result.method : action;
  }

  async sendPrompt(options: GuiSendOptions): Promise<GuiSendResult> {
    const prompt = normalizeSoftStopPrompt(options.prompt);
    const settings = this.settings();
    const base: GuiSendResult = {
      ok: false,
      dryRun: settings.softStopDryRun,
      blocked: null,
      needsConfirmation: false,
      target: null,
      attempts: 0,
      sent: 0,
      steps: [],
      detail: '',
      preview: null,
    };
    if (!prompt) return { ...base, detail: 'EMPTY_PROMPT' };
    if (!settings.softStopGuiEnabled) return { ...base, blocked: 'GUI_DISABLED', detail: 'GUI_DISABLED' };

    let preview: GuiPreview;
    try {
      preview = await this.scan({
        processName: options.processName,
        windowTitle: options.windowTitle,
        capture: false,
        allowlist: settings.softStopGuiAllowlist,
        dryRun: options.dryRun ?? settings.softStopDryRun,
        autoSend: options.autoSend ?? settings.softStopAutoSend,
      });
    } catch (error) {
      return { ...base, blocked: 'HELPER_OFFLINE', detail: (error as Error).message };
    }

    const dryRun = options.dryRun ?? settings.softStopDryRun;
    const autoSend = options.autoSend ?? settings.softStopAutoSend;
    const confirmed = options.confirmed === true;
    const allowlisted = this.targetAllowlisted(preview.target, settings.softStopGuiAllowlist);
    const needsConfirmation =
      preview.target !== null &&
      !dryRun &&
      !autoSend &&
      !confirmed &&
      !this.options.profiles.isConfirmed(preview.target.process, preview.target.title);
    let blocked: string | null;
    if (!preview.target) blocked = 'NO_TARGET';
    else if (dryRun) blocked = null;
    else if (!allowlisted) blocked = 'NOT_ALLOWLISTED';
    else if (needsConfirmation) blocked = 'NEEDS_CONFIRMATION';
    else blocked = null;

    const result: GuiSendResult = {
      ...base,
      dryRun,
      blocked,
      needsConfirmation,
      target: preview.target,
      preview,
    };
    if (!preview.target) return { ...result, detail: 'NO_TARGET' };
    if (blocked === 'NOT_ALLOWLISTED') return { ...result, detail: 'NOT_ALLOWLISTED' };
    if (blocked === 'NEEDS_CONFIRMATION') return { ...result, detail: 'NEEDS_CONFIRMATION' };
    if (dryRun) {
      const plan = buildGuiSendPlan(preview);
      return {
        ...result,
        ok: true,
        detail: plan
          ? `DRY_RUN target=${preview.target.process} conversations=${plan.conversations.length} steps=${plan.steps.length}`
          : 'DRY_RUN no plan',
      };
    }

    const target = preview.target;
    let window = preview.windows.find((entry) => entry.handle === target.handle) ?? null;
    let plan = buildGuiSendPlan(preview);
    if (!plan) return { ...result, detail: 'NO_TARGET_CONTROLS' };

    if (plan.conversations.length === 0 && window) {
      const sidebar = window.candidates.find((candidate) => candidate.label === 'sidebar' && candidate.ref);
      if (sidebar) {
        try {
          await this.act('click', sidebar.ref, target);
          await sleep(450);
          window = await this.rescanWindow(target);
          const refreshedWindow = window;
          if (refreshedWindow) {
            preview = {
              ...preview,
              windows: preview.windows.map((entry) =>
                entry.handle === refreshedWindow.handle ? refreshedWindow : entry,
              ),
              candidates: refreshedWindow.candidates,
              target: {
                ...target,
                foreground: refreshedWindow.foreground,
                busy: refreshedWindow.candidates.some((candidate) => candidate.label === 'busy'),
              },
            };
            plan = buildGuiSendPlan(preview) ?? plan;
          }
        } catch (error) {
          this.options.logger.log('warn', '[gui] sidebar expand failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const busy = plan.conversations.filter((conversation) => conversation.busy);
    const selected = plan.conversations.filter((conversation) => conversation.selected);
    const chosen =
      plan.mode === 'busy'
        ? busy
        : selected.length > 0
          ? selected
          : plan.conversations.slice(0, 1);
    const limit = Math.max(1, Math.min(MAX_CONVERSATIONS, options.maxConversations ?? MAX_CONVERSATIONS));
    const conversationTargets = chosen.slice(0, limit);
    const steps: GuiSendStepResult[] = [];
    let sent = 0;
    let failed = false;

    const initialRefs = this.pickRefs(window);

    const runConversation = async (
      conversation: (typeof conversationTargets)[number] | null,
      refs: { inputRef: string | null; sendRef: string | null },
    ): Promise<void> => {
      let currentInput = refs.inputRef;
      let currentSend = refs.sendRef;
      const label = conversation?.name ?? null;
      if (conversation) {
        try {
          const fresh = await this.rescanWindow(target);
          if (!fresh) {
            steps.push({
              action: 'select',
              conversation: label,
              ok: false,
              error: 'WINDOW_GONE',
            });
            failed = true;
            return;
          }
          const freshConversations = fresh.candidates.filter(
            (candidate) => candidate.label === 'conversation' && candidate.ref,
          );
          const match =
            freshConversations.find(
              (candidate) => conversation.name.length > 0 && candidate.name === conversation.name,
            ) ??
            freshConversations.find(
              (candidate) =>
                Math.abs(candidate.rect.x - conversation.rect.x) <= 8 &&
                Math.abs(candidate.rect.y - conversation.rect.y) <= 8,
            );
          if (!match) {
            steps.push({
              action: 'select',
              conversation: label,
              ok: false,
              error: 'CONVERSATION_GONE',
            });
            failed = true;
            return;
          }
          const freshRefs = this.pickRefs(fresh);
          currentInput = freshRefs.inputRef;
          currentSend = freshRefs.sendRef;
          if (!match.selected) {
            const method = await this.act('select', match.ref, target);
            steps.push({ action: 'select', conversation: label, ok: true, method });
            await sleep(500);
            const refreshed = await this.rescanWindow(target);
            const nextRefs = this.pickRefs(refreshed);
            if (nextRefs.inputRef && nextRefs.sendRef) {
              currentInput = nextRefs.inputRef;
              currentSend = nextRefs.sendRef;
            }
          }
        } catch (error) {
          steps.push({
            action: 'select',
            conversation: label,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          failed = true;
          return;
        }
      }
      if (!currentInput || !currentSend) {
        steps.push({ action: 'input', conversation: label, ok: false, error: 'NO_TARGET_CONTROLS' });
        failed = true;
        return;
      }
      try {
        const method = await this.act('setvalue', currentInput, target, prompt);
        steps.push({ action: 'input', conversation: label, ok: true, method });
      } catch (error) {
        steps.push({
          action: 'input',
          conversation: label,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        failed = true;
        return;
      }
      try {
        let method: string;
        try {
          method = await this.act('invoke', currentSend, target);
        } catch (invokeError) {
          if (invokeError instanceof HelperError && invokeError.code === 'ELEMENT_NOT_VISIBLE') throw invokeError;
          method = await this.act('click', currentSend, target);
        }
        steps.push({ action: 'send', conversation: label, ok: true, method });
        sent += 1;
      } catch (error) {
        steps.push({
          action: 'send',
          conversation: label,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        failed = true;
        return;
      }
      await sleep(700);
      try {
        const verification = await this.rescanWindow(target);
        if (verification && verification.candidates.some((candidate) => candidate.label === 'busy')) {
          this.options.logger.log('info', '[gui] send verified by busy indicator', {
            target: target.process,
          });
        }
      } catch {
        /* verification is best-effort */
      }
    };

    if (conversationTargets.length === 0) {
      await runConversation(null, initialRefs);
      result.attempts = 1;
    } else {
      for (const conversation of conversationTargets) {
        if (failed) break;
        await runConversation(conversation, initialRefs);
        result.attempts += 1;
        if (conversationTargets.length > 1) await sleep(800);
      }
    }

    this.options.logger.log('info', '[gui] soft stop prompt dispatched', {
      target: target.process,
      attempts: result.attempts,
      sent,
      failed,
    });

    return {
      ...result,
      ok: !failed && sent > 0,
      sent,
      steps,
      preview,
      detail: `${sent}/${result.attempts} conversation(s) sent`,
    };
  }

  async recordStart(maxSeconds = 300): Promise<GuiRecordStartResult> {
    try {
      await this.ensureHelper();
      const raw = await this.options.helper.guiRecordStart(maxSeconds);
      const status = mapRecordStatus(raw);
      return { ok: status.recording || status.startedAt !== null, startedAt: status.startedAt };
    } catch (error) {
      return {
        ok: false,
        startedAt: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async recordStop(): Promise<GuiRecordResult> {
    await this.ensureHelper();
    const raw = await this.options.helper.guiRecordStop();
    return mapRecordResult(raw);
  }

  async recordStatus(): Promise<GuiRecordStatus> {
    await this.ensureHelper();
    const raw = await this.options.helper.guiRecordStatus();
    return mapRecordStatus(raw);
  }

  async suspend(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.ensureHelper();
      await this.options.helper.suspend();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
