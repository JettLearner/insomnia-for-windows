import { describe, expect, it } from 'vitest';
import {
  buildGuiPreview,
  buildGuiSendPlan,
  fingerprintFor,
  mapRecordResult,
  mapScan,
  matchGuiProfile,
  normalizeGuiProfile,
  profileFromPreview,
  profileFromRecording,
  suggestGuiLabel,
  type RawGuiElement,
  type RawGuiScan,
  type RawGuiWindow,
} from '../shared/gui';
import type { GuiProfile, GuiRecordEvent } from '../shared/soft-stop';

const WINDOW: RawGuiWindow = {
  hwnd: 1001,
  ref: 'w1',
  pid: 4321,
  process: 'Qoder.exe',
  title: 'Qoder - project',
  className: 'Chrome_WidgetWin_1',
  rect: { x: 0, y: 0, w: 1440, h: 900 },
  foreground: true,
};

function element(partial: Partial<RawGuiElement>): RawGuiElement {
  return {
    ref: 'e1',
    name: '',
    automationId: '',
    className: '',
    controlType: 'Pane',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    enabled: true,
    keyboardFocusable: false,
    editable: false,
    invokable: false,
    selectable: false,
    selected: false,
    expandable: false,
    ...partial,
  };
}

function scan(elements: RawGuiElement[], window: Partial<RawGuiWindow> = {}): RawGuiScan {
  return {
    scannedAt: new Date().toISOString(),
    windowCount: 1,
    windows: [{ ...WINDOW, ...window, candidates: elements }],
  };
}

function baseElements(): RawGuiElement[] {
  return [
    element({
      ref: 'e-input',
      name: 'Chat input',
      automationId: 'chat-input',
      className: 'ProseMirror',
      controlType: 'Document',
      rect: { x: 280, y: 760, w: 900, h: 90 },
      editable: true,
      keyboardFocusable: true,
    }),
    element({
      ref: 'e-send',
      name: 'Send',
      automationId: 'send-button',
      controlType: 'Button',
      rect: { x: 1200, y: 775, w: 48, h: 48 },
      invokable: true,
    }),
    element({
      ref: 'e-close',
      name: 'Close',
      automationId: 'close',
      controlType: 'Button',
      rect: { x: 1400, y: 0, w: 40, h: 30 },
      invokable: true,
    }),
    element({
      ref: 'e-sidebar',
      name: 'Toggle sidebar',
      automationId: 'sidebar-toggle',
      controlType: 'Button',
      rect: { x: 8, y: 60, w: 32, h: 32 },
      invokable: true,
      expandable: true,
    }),
    element({
      ref: 'e-conv-a',
      name: 'Conversation A',
      controlType: 'ListItem',
      rect: { x: 20, y: 120, w: 220, h: 40 },
      selectable: true,
      selected: true,
    }),
    element({
      ref: 'e-conv-b',
      name: 'Generating answer',
      controlType: 'ListItem',
      rect: { x: 20, y: 180, w: 220, h: 40 },
      selectable: true,
      selected: false,
    }),
    element({
      ref: 'e-stop',
      name: 'Stop generating',
      controlType: 'Button',
      rect: { x: 1180, y: 700, w: 120, h: 30 },
      invokable: true,
    }),
  ];
}

describe('GUI scan mapping and classification', () => {
  it('classifies input, send, sidebar, conversations and busy controls', () => {
    const mapped = mapScan(scan(baseElements()));
    expect(mapped).toHaveLength(1);
    const windows = buildGuiPreview(mapped, [], {
      allowlist: ['qoder'],
      dryRun: true,
      autoSend: false,
      confirmed: false,
    }).windows;
    const candidates = windows[0]?.candidates ?? [];
    const byRef = (ref: string) => candidates.find((candidate) => candidate.ref === ref);

    expect(byRef('e-input')?.label).toBe('input');
    expect(byRef('e-send')?.label).toBe('send');
    expect(byRef('e-sidebar')?.label).toBe('sidebar');
    expect(byRef('e-conv-a')?.label).toBe('conversation');
    expect(byRef('e-conv-b')?.label).toBe('conversation');
    expect(byRef('e-stop')?.label).toBe('busy');
    expect(byRef('e-close')?.label).toBe('ignore');
  });

  it('does not confuse input toolbar buttons with the send control', () => {
    const elements = [
      ...baseElements(),
      element({
        ref: 'e-attach',
        name: '添加附件或技能',
        controlType: 'Button',
        rect: { x: 300, y: 850, w: 46, h: 45 },
        invokable: true,
      }),
      element({
        ref: 'e-model',
        name: '选择模型 · M3.1',
        controlType: 'Button',
        rect: { x: 1050, y: 850, w: 188, h: 45 },
        invokable: true,
      }),
      element({
        ref: 'e-arrow',
        name: '↑',
        controlType: 'Button',
        rect: { x: 1150, y: 830, w: 40, h: 40 },
        invokable: true,
      }),
    ];
    const candidates = buildGuiPreview(mapScan(scan(elements)), [], {
      allowlist: ['qoder'],
      dryRun: true,
      autoSend: true,
      confirmed: true,
    }).candidates;
    const byRef = (ref: string) => candidates.find((candidate) => candidate.ref === ref);
    expect(byRef('e-attach')?.label).toBe('ignore');
    expect(byRef('e-model')?.label).toBe('ignore');
    expect(byRef('e-arrow')?.label).toBe('send');
  });

  it('normalises the helper JSON shape', () => {
    const mapped = mapScan(scan(baseElements(), { hwnd: '42' }));
    expect(mapped[0]?.window.handle).toBe(42);
    expect(mapped[0]?.window.rect).toEqual({ x: 0, y: 0, w: 1440, h: 900 });
    expect(mapped[0]?.elements[0]?.rect).toEqual({ x: 280, y: 760, w: 900, h: 90 });
    expect(mapped[0]?.elements[0]?.selected).toBe(false);
    expect(mapScan(null)).toEqual([]);
    expect(mapScan({ windows: 'nope' })).toEqual([]);
  });

  it('prefers an allowlisted window over a foreground one', () => {
    const qoder = scan(baseElements(), { hwnd: 1001, process: 'Qoder.exe', foreground: false });
    const other = scan(baseElements(), {
      hwnd: 2002,
      pid: 5555,
      process: 'notepad.exe',
      title: 'Notes',
      foreground: true,
      rect: { x: 0, y: 0, w: 1200, h: 800 },
    });
    const preview = buildGuiPreview(
      mapScan({ windows: [other.windows?.[0], qoder.windows?.[0]] }),
      [],
      { allowlist: ['qoder'], dryRun: false, autoSend: true, confirmed: true },
    );
    expect(preview.target?.process).toBe('Qoder.exe');
    expect(preview.allowlisted).toBe(true);
    expect(preview.blocked).toBeNull();
  });

  it('blocks unlisted windows unless it is a dry run', () => {
    const mapped = mapScan(scan(baseElements()));
    const blocked = buildGuiPreview(mapped, [], {
      allowlist: [],
      dryRun: false,
      autoSend: true,
      confirmed: true,
    });
    expect(blocked.target).not.toBeNull();
    expect(blocked.allowlisted).toBe(false);
    expect(blocked.blocked).toBe('NOT_ALLOWLISTED');

    const dry = buildGuiPreview(mapped, [], {
      allowlist: [],
      dryRun: true,
      autoSend: false,
      confirmed: false,
    });
    expect(dry.blocked).toBeNull();

    const needs = buildGuiPreview(mapped, [], {
      allowlist: ['qoder'],
      dryRun: false,
      autoSend: false,
      confirmed: false,
    });
    expect(needs.needsConfirmation).toBe(true);
    expect(needs.blocked).toBe('NEEDS_CONFIRMATION');
  });

  it('builds a busy-only send plan when conversations report generation', () => {
    const preview = buildGuiPreview(mapScan(scan(baseElements())), [], {
      allowlist: ['qoder'],
      dryRun: true,
      autoSend: true,
      confirmed: true,
    });
    const plan = buildGuiSendPlan(preview);
    expect(plan).not.toBeNull();
    expect(plan?.mode).toBe('busy');
    expect(plan?.conversations).toHaveLength(2);
    expect(plan?.conversations.find((conversation) => conversation.name === 'Generating answer')?.busy).toBe(true);
    expect(plan?.steps.map((step) => step.action)).toEqual(['select', 'input', 'send']);
  });
});

describe('GUI profiles', () => {
  it('matches a saved profile by automation id even when the visible name changes', () => {
    const profile = normalizeGuiProfile({
      id: 'qoder-test',
      app: 'Qoder',
      process: 'Qoder.exe',
      titlePattern: '',
      createdAt: 1,
      updatedAt: 1,
      source: 'recording',
      confirmed: true,
      sampleCount: 3,
      labels: {
        input: {
          automationId: 'proxy-input',
          className: '',
          controlType: 'Pane',
          name: '',
          ancestorPath: '',
          relRect: { x: 0.2, y: 0.85, w: 0.6, h: 0.1 },
        },
      },
    });
    expect(profile).not.toBeNull();
    const proxy = element({
      ref: 'e-proxy',
      automationId: 'proxy-input',
      name: 'Totally different label',
      controlType: 'Pane',
      rect: { x: 288, y: 765, w: 864, h: 90 },
      editable: false,
    });
    const elements = [...baseElements(), proxy];
    const mapped = mapScan(scan(elements));
    const windows = buildGuiPreview(mapped, profile ? [profile] : [], {
      allowlist: ['qoder'],
      dryRun: true,
      autoSend: true,
      confirmed: true,
    }).windows;
    const candidate = windows[0]?.candidates.find((entry) => entry.ref === 'e-proxy');
    expect(candidate?.label).toBe('input');
    expect(candidate?.reasons).toContain('profile-match');
    expect(matchGuiProfile([profile as GuiProfile], 'qoder', 'Qoder - project')?.id).toBe('qoder-test');
    expect(matchGuiProfile([profile as GuiProfile], 'notepad', 'Notes')).toBeNull();
  });

  it('derives profiles from a preview and from recording events', () => {
    const preview = buildGuiPreview(mapScan(scan(baseElements())), [], {
      allowlist: ['qoder'],
      dryRun: true,
      autoSend: true,
      confirmed: false,
    });
    const profile = profileFromPreview(preview, { id: 'scan-profile' });
    expect(profile?.process).toBe('Qoder.exe');
    expect(profile?.labels.input?.automationId).toBe('chat-input');
    expect(profile?.labels.send?.automationId).toBe('send-button');
    expect(profile?.confirmed).toBe(false);

    const mapped = mapScan(scan(baseElements()));
    const baseWindow = mapped[0]!.window;
    const input = mapped[0]!.elements.find((entry) => entry.ref === 'e-input')!;
    const send = mapped[0]!.elements.find((entry) => entry.ref === 'e-send')!;
    const events: GuiRecordEvent[] = [
      {
        ts: 1,
        offsetMs: 10,
        kind: 'click',
        x: 300,
        y: 800,
        window: {
          handle: baseWindow.handle,
          pid: baseWindow.pid,
          process: baseWindow.process,
          title: baseWindow.title,
          className: baseWindow.className,
          rect: baseWindow.rect,
          foreground: true,
        },
        element: input,
        suggested: 'input',
        confidence: 0.9,
        reasons: ['editable'],
      },
      {
        ts: 2,
        offsetMs: 20,
        kind: 'hover',
        x: 1220,
        y: 790,
        window: {
          handle: baseWindow.handle,
          pid: baseWindow.pid,
          process: baseWindow.process,
          title: baseWindow.title,
          className: baseWindow.className,
          rect: baseWindow.rect,
          foreground: true,
        },
        element: send,
        suggested: 'send',
        confidence: 0.85,
        reasons: ['send-name'],
      },
    ];
    const recorded = profileFromRecording(events, { id: 'recorded-profile' });
    expect(recorded?.source).toBe('recording');
    expect(recorded?.sampleCount).toBe(2);
    expect(recorded?.labels.input?.automationId).toBe('chat-input');
    expect(recorded?.labels.send?.automationId).toBe('send-button');
  });

  it('rejects malformed profiles and sanitizes text fields', () => {
    expect(normalizeGuiProfile(null)).toBeNull();
    expect(normalizeGuiProfile({ process: '   ' })).toBeNull();
    const profile = normalizeGuiProfile({
      id: 'bad id!',
      process: 'Qoder.exe',
      titlePattern: '  Project  ',
      labels: {
        send: {
          automationId: 'x\u0000y',
          className: 42,
          controlType: 'Button',
          name: 'Send\u0000',
          relRect: { x: 2, y: -3, w: 0.2, h: 0.1 },
        },
        bogus: { automationId: 'nope' },
      },
    });
    expect(profile?.id).toMatch(/^gui-qoder-exe-/);
    expect(profile?.titlePattern).toBe('Project');
    expect(profile?.labels.send?.automationId).toBe('xy');
    expect(profile?.labels.send?.name).toBe('Send');
    expect(profile?.labels.send?.relRect.x).toBe(2);
    expect(profile?.labels.send?.relRect.y).toBe(-1);
    expect((profile?.labels as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe('GUI suggestions and recording mapping', () => {
  it('suggests labels from a single element', () => {
    const mapped = mapScan(scan(baseElements()));
    const window = mapped[0]!.window.rect;
    const elements = mapped[0]!.elements;
    const input = elements.find((entry) => entry.ref === 'e-input')!;
    const send = elements.find((entry) => entry.ref === 'e-send')!;
    const stop = elements.find((entry) => entry.ref === 'e-stop')!;
    const sidebar = elements.find((entry) => entry.ref === 'e-sidebar')!;
    const conversation = elements.find((entry) => entry.ref === 'e-conv-a')!;
    const close = elements.find((entry) => entry.ref === 'e-close')!;

    expect(suggestGuiLabel(input, window).label).toBe('input');
    expect(suggestGuiLabel(send, window).label).toBe('send');
    expect(suggestGuiLabel(stop, window).label).toBe('busy');
    expect(suggestGuiLabel(sidebar, window).label).toBe('sidebar');
    expect(suggestGuiLabel(conversation, window).label).toBe('conversation');
    expect(suggestGuiLabel(close, window).label).toBe('ignore');
  });

  it('maps helper recording events without capturing text', () => {
    const result = mapRecordResult({
      recording: false,
      startedAt: new Date(1_700_000_000_000).toISOString(),
      durationMs: 1500,
      autoStopped: false,
      count: 2,
      events: [
        {
          kind: 'click',
          offsetMs: 200,
          x: 300,
          y: 800,
          window: { hwnd: 1001, pid: 4321, process: 'Qoder.exe', title: 'Qoder', rect: WINDOW.rect, foreground: true },
          element: baseElements()[0],
        },
        {
          kind: 'hover',
          offsetMs: 900,
          x: 1220,
          y: 790,
          window: { hwnd: 1001, pid: 4321, process: 'Qoder.exe', title: 'Qoder', rect: WINDOW.rect, foreground: true },
          element: baseElements()[1],
        },
      ],
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.suggested).toBe('input');
    expect(result.events[1]?.suggested).toBe('send');
    expect(result.events[0]?.ts).toBe(1_700_000_000_200);
    expect(result.events[0]?.window.handle).toBe(1001);
    expect(JSON.stringify(result)).not.toContain('prompt');
  });

  it('ignores malformed recording events', () => {
    const result = mapRecordResult({
      events: [
        { kind: 'key', x: 1, y: 1, window: { hwnd: 1 } },
        { kind: 'click', x: 1, y: 1, window: { hwnd: 0 } },
        { kind: 'hover', x: 1, y: 1, window: { hwnd: 2 }, element: null },
      ],
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.suggested).toBe('ignore');
  });

  it('fingerprints relative rectangles consistently', () => {
    const mapped = mapScan(scan(baseElements()));
    const input = mapped[0]!.elements.find((entry) => entry.ref === 'e-input')!;
    const fingerprint = fingerprintFor(input, mapped[0]!.window.rect);
    expect(fingerprint.relRect).toEqual({ x: 0.194, y: 0.844, w: 0.625, h: 0.1 });
  });
});
