import type {
  AiActivitySnapshot,
  GuiPreview,
  GuiProfile,
  GuiRecordResult,
  GuiRecordStartResult,
  GuiRecordStatus,
  SoftStopAdapterInfo,
  SoftStopAuditEntry,
  SoftStopSendResult,
  SoftStopStatus,
} from './soft-stop';
import type { AutopilotApi } from './autopilot';

export type DisplayMode = 'on' | 'auto';
export type ThemeMode = 'dark' | 'light' | 'system';
export type LanguageSetting = 'system' | 'en-US' | 'zh-CN';
export type EffectiveLocale = 'en-US' | 'zh-CN';

export const APP_VERSION = '1.2.0';
export const REPO_URL = 'https://github.com/JettLearner/insomnia-for-windows';
export const DEFAULT_SOFT_STOP_PROMPT =
  'Please stop starting new work, finish the current step, save your state and report briefly. 请停止开始新任务，完成当前步骤、保存状态并简短汇报后结束。';
export const PRESET_DURATIONS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000, 8 * 60 * 60_000] as const;
export type PresetDuration = (typeof PRESET_DURATIONS)[number];

export interface Settings {
  schemaVersion: 1;
  language: LanguageSetting;
  theme: ThemeMode;
  launchAtLogin: boolean;
  startActiveOnLaunch: boolean;
  restoreSession: boolean;
  shortcut: string;
  defaultDisplayMode: DisplayMode;
  lastDurationMs: number | null;
  lidGuardPreferred: boolean;
  advancedDefault: boolean;
  batteryGuardEnabled: boolean;
  batteryThreshold: number;
  stopOnBattery: boolean;
  softStopEnabled: boolean;
  softStopPrompt: string;
  softStopThreshold: number;
  softStopSleepThreshold: number;
  softStopAllowRemote: boolean;
  softStopDryRun: boolean;
  softStopAutoSend: boolean;
  softStopGuiEnabled: boolean;
  softStopGuiAllowlist: string[];
  softStopProfileId: string | null;
  softStopHttpBase: string;
  softStopHttpModel: string;
  activityIntervalSec: number;
  showNotifications: boolean;
  closePanelOnBlur: boolean;
  leftClickOpensPanel: boolean;
  animations: boolean;
  onboardingComplete: boolean;
  compactDensity: boolean;
}

export interface SessionState {
  active: boolean;
  startedAt: number | null;
  endsAt: number | null;
  durationMs: number | null;
  displayMode: DisplayMode;
  advanced: boolean;
  lid: boolean;
}

export interface PowerInfo {
  ac: boolean;
  batteryPercent: number | null;
  charging: boolean;
  batteryPresent: boolean;
}

export interface Capabilities {
  helperConnected: boolean;
  elevated: boolean;
  lidPolicySupported: boolean | null;
  lidActive: boolean;
  lidError: string | null;
  recoveryPending: boolean;
  helperVersion: string | null;
}

export interface DisplayInfo {
  count: number;
  external: boolean;
}

export interface RuntimeState {
  session: SessionState;
  settings: Settings;
  power: PowerInfo;
  capabilities: Capabilities;
  displays: DisplayInfo;
  softStop: SoftStopStatus;
  now: number;
  busy: boolean;
  locale: EffectiveLocale;
  version: string;
}

export interface Bootstrap {
  state: RuntimeState;
  isDev: boolean;
  notificationSupported: boolean;
  loginItemSupported: boolean;
  dataDir: string;
  versions: { electron: string; chrome: string; node: string };
  platform: 'win32';
  autopilotEnabled: boolean;
}

export interface CommandResult {
  ok: boolean;
  state?: RuntimeState;
  error?: string;
  detail?: string;
  path?: string;
}

export type SettingsPatch = Partial<Omit<Settings, 'schemaVersion'>>;

export type WindowName = 'panel' | 'settings' | 'onboarding' | 'autopilot';

export type Command =
  | { type: 'toggle' }
  | { type: 'activate'; durationMs: number | null }
  | { type: 'test' }
  | { type: 'deactivate' }
  | { type: 'set-display'; mode: DisplayMode }
  | { type: 'set-advanced'; enabled: boolean }
  | { type: 'set-lid'; enabled: boolean }
  | { type: 'update-settings'; patch: SettingsPatch }
  | { type: 'reset-settings' }
  | { type: 'check-system' }
  | { type: 'recover-lid' }
  | { type: 'export-diagnostics' }
  | { type: 'open-external'; url: string };

export interface SoftStopApi {
  detect: () => Promise<AiActivitySnapshot>;
  testSend: () => Promise<SoftStopSendResult>;
  getAudit: () => Promise<SoftStopAuditEntry[]>;
  scan: (options?: { capture?: boolean }) => Promise<GuiPreview>;
  recordStart: () => Promise<GuiRecordStartResult>;
  recordStop: () => Promise<GuiRecordResult>;
  recordStatus: () => Promise<GuiRecordStatus>;
  listProfiles: () => Promise<GuiProfile[]>;
  saveProfile: (profile: GuiProfile) => Promise<CommandResult>;
  deleteProfile: (id: string) => Promise<CommandResult>;
  adapters: () => Promise<SoftStopAdapterInfo[]>;
  setHttpKey: (key: string | null) => Promise<CommandResult>;
  suspendNow: () => Promise<CommandResult>;
}

export interface InsomniazApi {
  bootstrap: () => Promise<Bootstrap>;
  subscribe: (listener: (state: RuntimeState) => void) => () => void;
  command: (command: Command) => Promise<CommandResult>;
  softStop: SoftStopApi;
  autopilot: AutopilotApi;
  showPanel: () => Promise<void>;
  showAutopilot: () => Promise<void>;
  hidePanel: () => Promise<void>;
  openSettings: (section?: string) => Promise<void>;
  showOnboarding: () => Promise<void>;
  closeWindow: (name: WindowName) => Promise<void>;
  minimizeWindow: (name: WindowName) => Promise<void>;
  openDataFolder: () => Promise<void>;
  onNavigateSection: (listener: (section: string) => void) => () => void;
  quit: () => Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  language: 'system',
  theme: 'dark',
  launchAtLogin: false,
  startActiveOnLaunch: false,
  restoreSession: true,
  shortcut: 'Ctrl+Alt+I',
  defaultDisplayMode: 'auto',
  lastDurationMs: 15 * 60_000,
  lidGuardPreferred: false,
  advancedDefault: false,
  batteryGuardEnabled: true,
  batteryThreshold: 20,
  stopOnBattery: false,
  softStopEnabled: false,
  softStopPrompt: DEFAULT_SOFT_STOP_PROMPT,
  softStopThreshold: 30,
  softStopSleepThreshold: 10,
  softStopAllowRemote: false,
  softStopDryRun: true,
  softStopAutoSend: false,
  softStopGuiEnabled: false,
  softStopGuiAllowlist: [],
  softStopProfileId: null,
  softStopHttpBase: '',
  softStopHttpModel: '',
  activityIntervalSec: 60,
  showNotifications: true,
  closePanelOnBlur: true,
  leftClickOpensPanel: true,
  animations: true,
  onboardingComplete: false,
  compactDensity: false,
};

export const INACTIVE_SESSION: SessionState = {
  active: false,
  startedAt: null,
  endsAt: null,
  durationMs: null,
  displayMode: 'auto',
  advanced: false,
  lid: false,
};
