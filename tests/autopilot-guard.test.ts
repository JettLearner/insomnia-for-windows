import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOPILOT_SETTINGS, type AutopilotSettings } from '../shared/autopilot';
import { ProtectionGate, type GuardWindow } from '../electron/core/autopilot-guard';

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

function gate(options: {
  windows?: GuardWindow[];
  cpu?: number;
  desktopBusy?: boolean;
  active?: boolean;
  settings?: AutopilotSettings;
  coolDownMs?: number;
}) {
  let clock = 1_000;
  const probes: number[] = [];
  const instance = new ProtectionGate({
    settings: () => options.settings ?? DEFAULT_AUTOPILOT_SETTINGS,
    listWindows: async () => {
      probes.push(clock);
      return options.windows ?? [];
    },
    cpuBusy: async () => options.cpu ?? 0,
    desktopBusy: () => options.desktopBusy ?? false,
    active: () => options.active ?? true,
    log: silent,
    now: () => clock,
    coolDownMs: options.coolDownMs ?? 20_000,
  });
  return { instance, advance: (ms: number) => (clock += ms), probes };
}

describe('protection gate', () => {
  it('defers while a scan or recording owns the desktop', async () => {
    const { instance } = gate({ desktopBusy: true });
    expect(await instance.sample()).toBe('capturing');
  });

  it('reads a remote-control session as a takeover', async () => {
    const { instance } = gate({ windows: [{ title: 'ToDesk 远程协助', process: 'ToDesk' }] });
    expect(await instance.sample()).toBe('taken_over');
  });

  it('reads a screen recorder as capture', async () => {
    const { instance } = gate({ windows: [{ title: 'OBS 3', process: 'obs64.exe' }] });
    expect(await instance.sample()).toBe('capturing');
  });

  it('reports a loaded machine as hot', async () => {
    const { instance } = gate({ cpu: 0.95 });
    expect(await instance.sample()).toBe('hot');
  });

  it('holds the verdict through the cool-down so flapping cannot start a run', async () => {
    let clock = 1_000;
    let cpu = 0.95;
    const instance = new ProtectionGate({
      settings: () => DEFAULT_AUTOPILOT_SETTINGS,
      listWindows: async () => [],
      cpuBusy: async () => cpu,
      desktopBusy: () => false,
      log: silent,
      now: () => clock,
      coolDownMs: 20_000,
    });
    expect(await instance.sample()).toBe('hot');
    cpu = 0.02;
    clock += 5_000;
    expect(await instance.sample()).toBe('hot');
    clock += 20_000;
    expect(await instance.sample()).toBe('ok');
  });

  it('never probes the desktop when nothing is scheduled', async () => {
    const { instance, probes } = gate({ active: false, windows: [{ title: 'ToDesk', process: 'ToDesk' }] });
    expect(await instance.sample()).toBe('ok');
    expect(probes).toHaveLength(0);
  });

  it('respects the operator toggles', async () => {
    const settings: AutopilotSettings = {
      ...DEFAULT_AUTOPILOT_SETTINGS,
      protection: {
        ...DEFAULT_AUTOPILOT_SETTINGS.protection,
        hideOnRemoteControl: false,
        throttleOnLoad: false,
      },
    };
    const { instance } = gate({ windows: [{ title: 'ToDesk', process: 'ToDesk' }], cpu: 1, settings });
    expect(await instance.sample()).toBe('ok');
  });
});
