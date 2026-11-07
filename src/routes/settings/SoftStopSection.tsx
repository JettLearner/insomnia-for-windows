import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  profileFromPreview,
  profileFromRecording,
} from '../../../shared/gui';
import type { MessageKey } from '../../../shared/i18n';
import {
  SOFT_STOP_PROMPT_MAX,
  guiTargetAllowed,
  normalizeEndpoint,
  requestHasAiActivity,
  type AiActivitySnapshot,
  type GuiLabel,
  type GuiPreview,
  type GuiProfile,
  type GuiRecordEvent,
  type GuiRecordResult,
  type GuiRecordStatus,
  type SoftStopAdapterInfo,
  type SoftStopAuditAction,
  type SoftStopAuditEntry,
  type SoftStopPhase,
  type SoftStopSendResult,
} from '../../../shared/soft-stop';
import {
  Activity,
  Check,
  ChevronDown,
  Cpu,
  Globe,
  Monitor,
  Power,
  ShieldCheck,
  Sparkles,
  X,
} from '../../components/Icons';
import { SettingRow } from '../../components/SettingRow';
import { Toggle } from '../../components/Toggle';
import { Card, InlineNote, SectionHead } from '../../components/ui';
import { getApi } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useRuntime } from '../../lib/runtime';
import { useSettingsActions } from './context';

type ProfileLabel = Exclude<GuiLabel, 'ignore'>;

const PROFILE_LABELS: ProfileLabel[] = ['input', 'send', 'sidebar', 'conversation', 'busy'];
const ALL_LABELS: GuiLabel[] = [...PROFILE_LABELS, 'ignore'];
const MAX_RECORD_PREVIEW = 24;

const LABEL_KEYS: Record<GuiLabel, MessageKey> = {
  input: 'softStopCandidateInput',
  send: 'softStopCandidateSend',
  sidebar: 'softStopCandidateSidebar',
  conversation: 'softStopCandidateConversation',
  busy: 'softStopCandidateBusy',
  ignore: 'softStopCandidateIgnore',
};

const LABEL_TONES: Record<GuiLabel, string> = {
  input: 'input',
  send: 'send',
  sidebar: 'sidebar',
  conversation: 'conversation',
  busy: 'busy',
  ignore: 'ignore',
};

const PHASE_META: Record<SoftStopPhase, { key: MessageKey; tone: string }> = {
  off: { key: 'softStopPhaseOff', tone: 'is-off' },
  idle: { key: 'softStopPhaseIdle', tone: 'is-idle' },
  monitoring: { key: 'softStopPhaseMonitoring', tone: 'is-work' },
  detected: { key: 'softStopPhaseDetected', tone: 'is-work' },
  sending: { key: 'softStopPhaseSending', tone: 'is-work' },
  sent: { key: 'softStopPhaseSent', tone: 'is-good' },
  cooldown: { key: 'softStopPhaseCooldown', tone: 'is-warn' },
  sleeping: { key: 'softStopPhaseSleeping', tone: 'is-good' },
  error: { key: 'softStopPhaseError', tone: 'is-bad' },
};

const ACTION_KEYS: Record<SoftStopAuditAction, MessageKey> = {
  detect: 'softStopActionDetect',
  send: 'softStopActionSend',
  'dry-run': 'softStopActionDryRun',
  skip: 'softStopActionSkip',
  sleep: 'softStopActionSleep',
  error: 'softStopActionError',
  reset: 'softStopActionReset',
  profile: 'softStopActionProfile',
  record: 'softStopActionRecord',
};

const STREAMING_KEYS: Record<AiActivitySnapshot['streaming'], MessageKey> = {
  none: 'softStopStreamingNone',
  suspected: 'softStopStreamingSuspected',
  likely: 'softStopStreamingLikely',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatOffset(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function formatClock(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function displayName(element: GuiRecordEvent['element']): string {
  if (!element) return '';
  return element.name || element.automationId || element.controlType;
}

function candidateName(candidate: { name: string; automationId: string; controlType: string }): string {
  return candidate.name || candidate.automationId || candidate.controlType;
}

function makeProfileId(process: string, titlePattern: string, profiles: GuiProfile[]): string {
  const existing = profiles.find(
    (profile) =>
      profile.process.toLowerCase() === process.toLowerCase() &&
      (profile.titlePattern || '').toLowerCase() === titlePattern.toLowerCase(),
  );
  if (existing) return existing.id;
  const slug =
    process
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'app';
  const base = `gui-${slug}`;
  let id = base;
  let counter = 2;
  while (profiles.some((profile) => profile.id === id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  return id;
}

function normalizeTargetValue(value: string | null): string {
  return value ?? '';
}

export function SoftStopSection() {
  const { state, notify } = useRuntime();
  const { save } = useSettingsActions();
  const t = useT();
  const api = getApi();
  const { settings, softStop } = state;

  const [prompt, setPrompt] = useState(settings.softStopPrompt);
  const [thresholdA, setThresholdA] = useState(settings.softStopThreshold);
  const [thresholdB, setThresholdB] = useState(settings.softStopSleepThreshold);
  const [endpoint, setEndpoint] = useState(settings.softStopHttpBase);
  const [model, setModel] = useState(settings.softStopHttpModel);
  const [allowlist, setAllowlist] = useState(settings.softStopGuiAllowlist.join('\n'));
  const [keyDraft, setKeyDraft] = useState('');
  const [adapters, setAdapters] = useState<SoftStopAdapterInfo[]>([]);
  const [preview, setPreview] = useState<GuiPreview | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanCapture, setScanCapture] = useState(false);
  const [profiles, setProfiles] = useState<GuiProfile[]>([]);
  const [audit, setAudit] = useState<SoftStopAuditEntry[]>([]);
  const [auditBusy, setAuditBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<SoftStopSendResult | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [activity, setActivity] = useState<AiActivitySnapshot | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [recordStatus, setRecordStatus] = useState<GuiRecordStatus | null>(null);
  const [recordResult, setRecordResult] = useState<GuiRecordResult | null>(null);
  const [labels, setLabels] = useState<Record<number, GuiLabel>>({});
  const [profileName, setProfileName] = useState('');
  const [profileTitle, setProfileTitle] = useState('');
  const [recordError, setRecordError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [sleepConfirm, setSleepConfirm] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const wasRecording = useRef(false);
  const manualStop = useRef(false);
  const stopping = useRef(false);

  const allowlistText = settings.softStopGuiAllowlist.join('\n');

  useEffect(() => {
    setPrompt(settings.softStopPrompt);
  }, [settings.softStopPrompt]);
  useEffect(() => {
    setThresholdA(settings.softStopThreshold);
  }, [settings.softStopThreshold]);
  useEffect(() => {
    setThresholdB(settings.softStopSleepThreshold);
  }, [settings.softStopSleepThreshold]);
  useEffect(() => {
    setEndpoint(settings.softStopHttpBase);
  }, [settings.softStopHttpBase]);
  useEffect(() => {
    setModel(settings.softStopHttpModel);
  }, [settings.softStopHttpModel]);
  useEffect(() => {
    setAllowlist(allowlistText);
  }, [allowlistText]);

  const refreshProfiles = useCallback(async () => {
    if (!api) return;
    try {
      setProfiles(await api.softStop.listProfiles());
    } catch {
      /* the helper may be offline; the list keeps its last known value */
    }
  }, [api]);

  const refreshAudit = useCallback(async () => {
    if (!api) return;
    setAuditBusy(true);
    try {
      setAudit(await api.softStop.getAudit());
    } catch {
      /* keep the last snapshot */
    } finally {
      setAuditBusy(false);
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.softStop
      .adapters()
      .then((list) => {
        if (alive) setAdapters(list);
      })
      .catch(() => {
        if (alive) setAdapters([]);
      });
    void refreshProfiles();
    void refreshAudit();
    return () => {
      alive = false;
    };
  }, [api, refreshProfiles, refreshAudit]);

  const lastActionAt = softStop.lastActionAt;
  useEffect(() => {
    if (lastActionAt !== null) void refreshAudit();
  }, [lastActionAt, refreshAudit]);

  useEffect(() => {
    if (!sleepConfirm) return undefined;
    const timer = window.setTimeout(() => setSleepConfirm(false), 5000);
    return () => window.clearTimeout(timer);
  }, [sleepConfirm]);

  const finishRecording = useCallback(async () => {
    if (!api || stopping.current) return;
    stopping.current = true;
    wasRecording.current = false;
    try {
      const result = await api.softStop.recordStop();
      setRecordResult(result);
      setLabels({});
    } catch (error) {
      setRecordError(errorText(error));
    } finally {
      stopping.current = false;
    }
  }, [api]);

  const recording = recordStatus?.recording === true;

  useEffect(() => {
    if (!api || !recording) return undefined;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const status = await api.softStop.recordStatus();
        if (!alive || manualStop.current) return;
        setRecordStatus(status);
        if (!status.recording) {
          if (wasRecording.current) {
            wasRecording.current = false;
            await finishRecording();
          }
          return;
        }
        wasRecording.current = true;
      } catch {
        /* helper offline; keep the current state */
      }
      if (alive) timer = window.setTimeout(tick, 1500);
    };
    timer = window.setTimeout(tick, 1200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, recording, finishRecording]);

  useEffect(
    () => () => {
      if (wasRecording.current) {
        wasRecording.current = false;
        void api?.softStop.recordStop().catch(() => undefined);
      }
    },
    [api],
  );

  const endpointInfo = useMemo(() => normalizeEndpoint(endpoint), [endpoint]);
  const endpointInvalid = endpoint.trim() !== '' && endpointInfo.base === null;
  const endpointRemote = endpointInfo.remote && !settings.softStopAllowRemote;
  const targetValue = normalizeTargetValue(settings.softStopProfileId);
  const targetKnown =
    targetValue === '' ||
    targetValue === 'generic-gui' ||
    adapters.some((adapter) => adapter.id === targetValue);

  const commitPrompt = (): void => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (trimmed !== settings.softStopPrompt) void save({ softStopPrompt: trimmed });
  };

  const commitThresholds = (): void => {
    const a = Math.min(95, Math.max(10, Math.round(thresholdA / 5) * 5));
    const b = Math.min(a - 5, Math.max(5, Math.round(thresholdB / 5) * 5));
    if (a !== thresholdA) setThresholdA(a);
    if (b !== thresholdB) setThresholdB(b);
    if (a !== settings.softStopThreshold || b !== settings.softStopSleepThreshold) {
      void save({ softStopThreshold: a, softStopSleepThreshold: b });
    }
  };

  const changeA = (value: number): void => {
    setThresholdA(value);
    if (thresholdB > value - 5) setThresholdB(value - 5);
  };

  const commitEndpoint = (): void => {
    if (endpointInvalid) return;
    const base = endpointInfo.base ?? '';
    if (base !== settings.softStopHttpBase) void save({ softStopHttpBase: base });
  };

  const commitModel = (): void => {
    const next = model.trim();
    if (next !== settings.softStopHttpModel) void save({ softStopHttpModel: next });
  };

  const commitAllowlist = (): void => {
    const entries: string[] = [];
    const seen = new Set<string>();
    for (const line of allowlist.split(/\r?\n/)) {
      const entry = line.trim().slice(0, 100);
      if (!entry) continue;
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
      if (entries.length >= 32) break;
    }
    if (JSON.stringify(entries) !== JSON.stringify(settings.softStopGuiAllowlist)) {
      void save({ softStopGuiAllowlist: entries });
    }
  };

  const storeKey = async (): Promise<void> => {
    if (!api) return;
    const key = keyDraft.trim();
    if (!key) return;
    const result = await api.softStop.setHttpKey(key);
    if (result.ok) {
      setKeyDraft('');
      notify(t('softStopKeySaved'), 'success');
    } else {
      notify(result.error ?? t('errGeneric'), 'error');
    }
  };

  const clearKey = async (): Promise<void> => {
    if (!api) return;
    const result = await api.softStop.setHttpKey(null);
    if (result.ok) notify(t('softStopKeyCleared'), 'success');
    else notify(result.error ?? t('errGeneric'), 'error');
  };

  const runScan = async (): Promise<void> => {
    if (!api) return;
    setScanBusy(true);
    try {
      setPreview(await api.softStop.scan({ capture: scanCapture }));
    } catch (error) {
      setPreview(null);
      notify(t('softStopScanFail', { detail: errorText(error) }), 'error');
    } finally {
      setScanBusy(false);
    }
  };

  const targetAllowed = preview?.target
    ? guiTargetAllowed(settings.softStopGuiAllowlist, preview.target.process, preview.target.title)
    : false;

  const allowTarget = (): void => {
    const process = preview?.target?.process.trim();
    if (!process || targetAllowed) return;
    const next = [...settings.softStopGuiAllowlist];
    if (!next.some((entry) => entry.toLowerCase() === process.toLowerCase())) next.push(process);
    void save({ softStopGuiAllowlist: next.slice(0, 32) });
  };

  const saveScanProfile = async (): Promise<void> => {
    if (!api || !preview?.target) return;
    const profile = profileFromPreview(preview, {
      id: makeProfileId(preview.target.process, '', profiles),
      confirmed: true,
    });
    if (!profile) {
      notify(t('softStopProfileFailed'), 'error');
      return;
    }
    setSavingProfile(true);
    try {
      const result = await api.softStop.saveProfile(profile);
      if (!result.ok) {
        notify(result.error ?? t('errGeneric'), 'error');
        return;
      }
      notify(t('softStopProfileSaved'), 'success');
      await refreshProfiles();
    } finally {
      setSavingProfile(false);
    }
  };

  const relevantCandidates = useMemo(() => {
    if (!preview) return [];
    return preview.candidates
      .filter((candidate) => candidate.label !== 'ignore')
      .sort(
        (a, b) =>
          PROFILE_LABELS.indexOf(a.label as ProfileLabel) -
            PROFILE_LABELS.indexOf(b.label as ProfileLabel) || b.confidence - a.confidence,
      )
      .slice(0, 12);
  }, [preview]);

  const startRecording = async (): Promise<void> => {
    if (!api) return;
    setRecordError(null);
    setRecordResult(null);
    setLabels({});
    manualStop.current = false;
    try {
      const result = await api.softStop.recordStart();
      if (!result.ok) {
        setRecordError(result.error ?? t('errGeneric'));
        return;
      }
      wasRecording.current = true;
      setRecordStatus({
        recording: true,
        startedAt: result.startedAt,
        maxSeconds: 300,
        remainingMs: 300_000,
        autoStopped: false,
        eventCount: 0,
      });
    } catch (error) {
      setRecordError(errorText(error));
    }
  };

  const stopRecording = async (): Promise<void> => {
    manualStop.current = true;
    wasRecording.current = false;
    setRecordStatus((current) =>
      current ? { ...current, recording: false, remainingMs: 0 } : current,
    );
    await finishRecording();
    manualStop.current = false;
  };

  const eventLabel = (event: GuiRecordEvent, index: number): GuiLabel =>
    labels[index] ?? event.suggested;

  const visibleEvents = recordResult?.events.slice(0, MAX_RECORD_PREVIEW) ?? [];
  const usableEvents = recordResult
    ? recordResult.events.filter((event, index) => event.element && eventLabel(event, index) !== 'ignore')
    : [];

  const saveRecordingProfile = async (): Promise<void> => {
    if (!api || !recordResult) return;
    const adjusted = recordResult.events.map((event, index) => ({
      ...event,
      suggested: eventLabel(event, index),
    }));
    const process = adjusted.find((event) => event.element)?.window.process ?? '';
    const titlePattern = profileTitle.trim();
    const profile = profileFromRecording(adjusted, {
      id: makeProfileId(process, titlePattern, profiles),
      titlePattern,
      confirmed: true,
    });
    if (!profile || Object.keys(profile.labels).length === 0) {
      notify(t('softStopProfileFailed'), 'error');
      return;
    }
    const name = profileName.trim();
    setSavingProfile(true);
    try {
      const result = await api.softStop.saveProfile({ ...profile, app: name || profile.app });
      if (!result.ok) {
        notify(result.error ?? t('errGeneric'), 'error');
        return;
      }
      notify(t('softStopProfileSaved'), 'success');
      setRecordResult(null);
      setLabels({});
      await refreshProfiles();
    } finally {
      setSavingProfile(false);
    }
  };

  const removeProfile = async (id: string): Promise<void> => {
    if (!api) return;
    const result = await api.softStop.deleteProfile(id);
    if (!result.ok) {
      notify(result.error ?? t('errGeneric'), 'error');
      return;
    }
    setDeleteConfirm(null);
    notify(t('softStopProfileDeleted'), 'success');
    await refreshProfiles();
  };

  const runTestSend = async (): Promise<void> => {
    if (!api) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      setTestResult(await api.softStop.testSend());
      await refreshAudit();
    } catch (error) {
      setTestResult({
        ok: false,
        dryRun: settings.softStopDryRun,
        adapterId: null,
        target: null,
        model: null,
        detail: errorText(error),
        error: 'IPC_FAILED',
      });
    } finally {
      setTestBusy(false);
    }
  };

  const runDetect = async (): Promise<void> => {
    if (!api) return;
    setDetectBusy(true);
    setDetectError(null);
    try {
      setActivity(await api.softStop.detect());
    } catch (error) {
      setDetectError(errorText(error));
    } finally {
      setDetectBusy(false);
    }
  };

  const runSleep = async (): Promise<void> => {
    if (!api) return;
    if (!sleepConfirm) {
      setSleepConfirm(true);
      return;
    }
    setSleepConfirm(false);
    const result = await api.softStop.suspendNow();
    if (result.ok) notify(t('softStopSleepRequested'), 'success');
    else notify(t('softStopSleepFailed', { detail: result.error ?? t('errGeneric') }), 'error');
  };

  const phase = PHASE_META[softStop.phase];
  const activityActive = requestHasAiActivity(activity);
  const localLabel =
    activity && activity.local.length > 0
      ? activity.local.map((runtime) => runtime.label).join(', ')
      : t('softStopLocalNone');
  const thresholdAFill = ((thresholdA - 10) / 85) * 100;
  const thresholdBFill = ((thresholdB - 5) / Math.max(5, thresholdA - 5)) * 100;

  return (
    <>
      <SectionHead
        title={t('softStopTitle')}
        subtitle={t('softStopSubtitle')}
        aside={<span className={`softstop-phase ${phase.tone}`}>{t(phase.key)}</span>}
      />

      <div className="settings-stack">
        <Card title={t('softStopCardEssentials')}>
          <SettingRow
            icon={<Sparkles size={15} />}
            title={t('softStopEnable')}
            description={t('softStopEnableHint')}
            control={
              <Toggle
                checked={settings.softStopEnabled}
                onChange={(next) => void save({ softStopEnabled: next })}
                label={t('softStopEnable')}
              />
            }
          />
          <div className="softstop-block">
            <div className="softstop-block-head">
              <span className="softstop-field-title">{t('softStopPrompt')}</span>
              <span className="softstop-counter tnum">
                {t('softStopPromptCount', { count: prompt.length, max: SOFT_STOP_PROMPT_MAX })}
              </span>
            </div>
            <textarea
              className="softstop-textarea"
              rows={4}
              maxLength={SOFT_STOP_PROMPT_MAX}
              value={prompt}
              placeholder={t('softStopPromptPlaceholder')}
              aria-label={t('softStopPrompt')}
              onChange={(event) => setPrompt(event.target.value)}
              onBlur={commitPrompt}
            />
            <span className={`softstop-field-hint${prompt.trim() ? '' : ' is-bad'}`}>
              {prompt.trim() ? t('softStopPromptHint') : t('softStopPromptEmpty')}
            </span>
          </div>
          <div className="softstop-block">
            <div className="threshold-head">
              <span>{t('softStopThresholdA')}</span>
              <output className="threshold-value tnum">{thresholdA}%</output>
            </div>
            <div className="threshold-range">
              <span className="range-edge">10%</span>
              <input
                type="range"
                min={10}
                max={95}
                step={5}
                value={thresholdA}
                aria-label={t('softStopThresholdA')}
                style={{ '--fill': `${thresholdAFill}%` } as CSSProperties}
                onChange={(event) => changeA(Number(event.target.value))}
                onPointerUp={commitThresholds}
                onKeyUp={commitThresholds}
                onBlur={commitThresholds}
              />
              <span className="range-edge">95%</span>
            </div>
          </div>
          <div className="softstop-block">
            <div className="threshold-head">
              <span>{t('softStopThresholdB')}</span>
              <output className="threshold-value tnum">{thresholdB}%</output>
            </div>
            <div className="threshold-range">
              <span className="range-edge">5%</span>
              <input
                type="range"
                min={5}
                max={Math.max(5, thresholdA - 5)}
                step={5}
                value={thresholdB}
                aria-label={t('softStopThresholdB')}
                style={{ '--fill': `${thresholdBFill}%` } as CSSProperties}
                onChange={(event) => setThresholdB(Number(event.target.value))}
                onPointerUp={commitThresholds}
                onKeyUp={commitThresholds}
                onBlur={commitThresholds}
              />
              <span className="range-edge">{thresholdA - 5}%</span>
            </div>
            <span className="softstop-field-hint">{t('softStopThresholdsHint')}</span>
          </div>
          <p className="card-note">{t('softStopLegacyNote')}</p>
        </Card>

        <Card title={t('softStopCardTarget')}>
          <SettingRow
            icon={<Cpu size={15} />}
            title={t('softStopTarget')}
            description={t('softStopTargetHint')}
            control={
              <div className="select-wrap">
                <select
                  className="select"
                  value={targetKnown ? targetValue : ''}
                  onChange={(event) =>
                    void save({ softStopProfileId: event.target.value || null })
                  }
                  aria-label={t('softStopTarget')}
                >
                  <option value="">{t('softStopTargetAuto')}</option>
                  <option value="generic-gui">{t('softStopTargetGui')}</option>
                  {adapters.map((adapter) => (
                    <option key={adapter.id} value={adapter.id}>
                      {adapter.label}
                      {adapter.kind === 'cli' ? ' · CLI' : adapter.kind === 'webhook' ? ' · Webhook' : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
            }
          />
          <div className="softstop-block">
            <div className="softstop-field-head">
              <span className="softstop-field-title">{t('softStopEndpoint')}</span>
            </div>
            <input
              className="softstop-input"
              value={endpoint}
              placeholder="http://127.0.0.1:11434"
              spellCheck={false}
              aria-label={t('softStopEndpoint')}
              onChange={(event) => setEndpoint(event.target.value)}
              onBlur={commitEndpoint}
            />
            <span className={`softstop-field-hint${endpointInvalid ? ' is-bad' : ''}`}>
              {endpointInvalid ? t('softStopEndpointInvalid') : t('softStopEndpointHint')}
            </span>
          </div>
          {endpointRemote && <InlineNote tone="warn">{t('softStopEndpointRemote')}</InlineNote>}
          <div className="softstop-block">
            <div className="softstop-field-head">
              <span className="softstop-field-title">{t('softStopModel')}</span>
            </div>
            <input
              className="softstop-input"
              value={model}
              placeholder="qwen2.5:7b"
              spellCheck={false}
              aria-label={t('softStopModel')}
              onChange={(event) => setModel(event.target.value)}
              onBlur={commitModel}
            />
            <span className="softstop-field-hint">{t('softStopModelHint')}</span>
          </div>
          <div className="softstop-block">
            <div className="softstop-field-head">
              <span className="softstop-field-title">{t('softStopApiKey')}</span>
              <span className={`softstop-key-state${softStop.hasHttpKey ? ' is-set' : ''}`}>
                {softStop.hasHttpKey ? t('softStopKeyStored') : t('softStopKeyMissing')}
              </span>
            </div>
            <div className="softstop-key-row">
              <input
                className="softstop-input"
                type="password"
                value={keyDraft}
                placeholder={t('softStopKeyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('softStopApiKey')}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={!keyDraft.trim()}
                onClick={() => void storeKey()}
              >
                {t('softStopKeySave')}
              </button>
              <button
                type="button"
                className="ghost-button compact-button"
                disabled={!softStop.hasHttpKey}
                onClick={() => void clearKey()}
              >
                {t('softStopKeyClear')}
              </button>
            </div>
            <span className="softstop-field-hint">{t('softStopApiKeyHint')}</span>
          </div>
          <SettingRow
            icon={<Globe size={15} />}
            title={t('softStopAllowRemote')}
            description={t('softStopAllowRemoteHint')}
            control={
              <Toggle
                checked={settings.softStopAllowRemote}
                onChange={(next) => void save({ softStopAllowRemote: next })}
                label={t('softStopAllowRemote')}
              />
            }
          />
          <SettingRow
            icon={<Check size={15} />}
            title={t('softStopDryRun')}
            description={t('softStopDryRunHint')}
            control={
              <Toggle
                checked={settings.softStopDryRun}
                onChange={(next) => void save({ softStopDryRun: next })}
                label={t('softStopDryRun')}
              />
            }
          />
          <SettingRow
            icon={<ShieldCheck size={15} />}
            title={t('softStopAutoSend')}
            description={t('softStopAutoSendHint')}
            control={
              <Toggle
                checked={settings.softStopAutoSend}
                onChange={(next) => void save({ softStopAutoSend: next })}
                label={t('softStopAutoSend')}
              />
            }
          />
        </Card>

        <Card title={t('softStopCardGui')}>
          <SettingRow
            icon={<Monitor size={15} />}
            title={t('softStopGuiEnable')}
            description={t('softStopGuiEnableHint')}
            control={
              <Toggle
                checked={settings.softStopGuiEnabled}
                onChange={(next) => void save({ softStopGuiEnabled: next })}
                label={t('softStopGuiEnable')}
              />
            }
          />
          <div className="softstop-block">
            <div className="softstop-block-head">
              <span className="softstop-field-title">{t('softStopGuiAllowlist')}</span>
              <span className="softstop-counter tnum">
                {t('softStopGuiAllowlistCount', { count: settings.softStopGuiAllowlist.length })}
              </span>
            </div>
            <textarea
              className="softstop-textarea softstop-textarea-small"
              rows={3}
              value={allowlist}
              placeholder={'ChatGPT.exe\nClaude'}
              spellCheck={false}
              aria-label={t('softStopGuiAllowlist')}
              onChange={(event) => setAllowlist(event.target.value)}
              onBlur={commitAllowlist}
            />
            <span className="softstop-field-hint">
              {settings.softStopGuiAllowlist.length === 0
                ? t('softStopGuiAllowlistEmpty')
                : t('softStopGuiAllowlistHint')}
            </span>
          </div>
          <div className="softstop-block">
            <div className="softstop-block-head">
              <span className="softstop-field-title">{t('softStopScan')}</span>
              <span className="softstop-counter">{scanCapture ? t('softStopScanCapture') : ''}</span>
            </div>
            <div className="softstop-actions">
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={scanBusy}
                onClick={() => void runScan()}
              >
                {scanBusy ? t('softStopScanBusy') : t('softStopScan')}
              </button>
              <label className="softstop-check">
                <input
                  type="checkbox"
                  checked={scanCapture}
                  onChange={(event) => setScanCapture(event.target.checked)}
                />
                <span>{t('softStopScanCapture')}</span>
              </label>
            </div>
            <span className="softstop-field-hint">{t('softStopScanHint')}</span>
            {preview && (
              <div className="softstop-preview">
                {preview.target ? (
                  <>
                    <div className="softstop-preview-head">
                      <span className="softstop-preview-target">
                        {t('softStopScanTarget', {
                          process: preview.target.process,
                          title: preview.target.title || preview.target.process,
                        })}
                      </span>
                      <span className="softstop-chip tone-send">
                        {Math.round(preview.target.confidence * 100)}%
                      </span>
                    </div>
                    <span className="softstop-preview-meta">
                      {t('softStopScanMeta', {
                        count: preview.windows
                          .find((window) => window.handle === preview.target?.handle)
                          ?.candidates.filter((candidate) => candidate.label !== 'ignore').length ?? 0,
                        confidence: Math.round(preview.target.confidence * 100),
                      })}
                    </span>
                    {preview.blocked && (
                      <span className="softstop-preview-blocked">
                        {t('softStopScanBlocked', { code: preview.blocked })}
                      </span>
                    )}
                    {preview.screenshot && (
                      <img
                        className="softstop-shot"
                        src={preview.screenshot}
                        alt={t('softStopScanScreenshot')}
                      />
                    )}
                    <div className="softstop-actions">
                      <button
                        type="button"
                        className="ghost-button compact-button"
                        disabled={targetAllowed}
                        onClick={allowTarget}
                      >
                        {t('softStopGuiAllowTarget')}
                      </button>
                      <button
                        type="button"
                        className="ghost-button compact-button"
                        disabled={savingProfile}
                        onClick={() => void saveScanProfile()}
                      >
                        {t('softStopScanSave')}
                      </button>
                    </div>
                    {relevantCandidates.length > 0 && (
                      <ul className="softstop-candidates">
                        {relevantCandidates.map((candidate) => (
                          <li key={`${candidate.windowRef}-${candidate.ref}`} className="softstop-candidate">
                            <span className={`softstop-chip tone-${LABEL_TONES[candidate.label]}`}>
                              {t(LABEL_KEYS[candidate.label])}
                            </span>
                            <span className="softstop-candidate-name">{candidateName(candidate)}</span>
                            <span className="softstop-candidate-meta tnum">
                              {Math.round(candidate.confidence * 100)}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <span className="softstop-preview-empty">{t('softStopScanEmpty')}</span>
                )}
              </div>
            )}
          </div>
        </Card>

        <Card title={t('softStopCardTeaching')}>
          <p className="softstop-intro">{t('softStopTeachIntro')}</p>
          <div className="softstop-block">
            <div className="softstop-record-bar">
              {recording ? (
                <button
                  type="button"
                  className="danger-button compact-button"
                  onClick={() => void stopRecording()}
                >
                  {t('softStopRecordStop')}
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => void startRecording()}
                >
                  {t('softStopRecordStart')}
                </button>
              )}
              {recording ? (
                <span className="softstop-recording">
                  <span className="softstop-recording-dot" aria-hidden="true" />
                  {t('softStopRecordActive', {
                    time: formatCountdown(recordStatus?.remainingMs ?? 0),
                  })}
                </span>
              ) : (
                <span className="softstop-record-idle">{t('softStopRecordHint')}</span>
              )}
            </div>
            {recordError && <InlineNote>{recordError}</InlineNote>}
            {recordResult && (
              <div className="softstop-events">
                <div className="softstop-events-head">
                  <span>{t('softStopEvents')}</span>
                  <span className="tnum">{recordResult.events.length}</span>
                </div>
                {recordResult.autoStopped && (
                  <span className="softstop-event-note">{t('softStopRecordAutoStopped')}</span>
                )}
                {recordResult.events.length === 0 ? (
                  <span className="softstop-preview-empty">{t('softStopRecordEmpty')}</span>
                ) : (
                  <ul className="softstop-event-list">
                    {visibleEvents.map((event, index) => {
                      const label = eventLabel(event, index);
                      return (
                        <li key={`${event.ts}-${index}`} className="softstop-event">
                          <span className={`softstop-event-kind ${event.kind}`}>
                            {event.kind === 'click'
                              ? t('softStopEventClick')
                              : t('softStopEventHover')}
                          </span>
                          <span className="softstop-event-copy">
                            <span className="softstop-event-name">
                              {event.element
                                ? displayName(event.element)
                                : t('softStopEventUnknown')}
                            </span>
                            <span className="softstop-event-meta tnum">
                              {formatOffset(event.offsetMs)} · {event.window.process}
                            </span>
                          </span>
                          <span className={`softstop-chip tone-${LABEL_TONES[event.suggested]}`}>
                            {t(LABEL_KEYS[event.suggested])}
                          </span>
                          <select
                            className="select softstop-select"
                            value={label}
                            disabled={!event.element}
                            aria-label={t('softStopLabel')}
                            onChange={(changeEvent) =>
                              setLabels((current) => ({
                                ...current,
                                [index]: changeEvent.target.value as GuiLabel,
                              }))
                            }
                          >
                            {ALL_LABELS.map((option) => (
                              <option key={option} value={option}>
                                {t(LABEL_KEYS[option])}
                              </option>
                            ))}
                          </select>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {recordResult.events.length > MAX_RECORD_PREVIEW && (
                  <span className="softstop-event-note">
                    {t('softStopEventsLimited', { count: MAX_RECORD_PREVIEW })}
                  </span>
                )}
                {recordResult.events.length > 0 && (
                  <>
                    <div className="softstop-field-grid">
                      <div className="softstop-field">
                        <span className="softstop-field-title">{t('softStopProfileName')}</span>
                        <input
                          className="softstop-input"
                          value={profileName}
                          maxLength={80}
                          placeholder={t('softStopProfileNamePlaceholder')}
                          aria-label={t('softStopProfileName')}
                          onChange={(event) => setProfileName(event.target.value)}
                        />
                        <span className="softstop-field-hint">{t('softStopProfileNameHint')}</span>
                      </div>
                      <div className="softstop-field">
                        <span className="softstop-field-title">{t('softStopProfileTitle')}</span>
                        <input
                          className="softstop-input"
                          value={profileTitle}
                          maxLength={200}
                          placeholder={t('softStopProfileTitlePlaceholder')}
                          aria-label={t('softStopProfileTitle')}
                          onChange={(event) => setProfileTitle(event.target.value)}
                        />
                        <span className="softstop-field-hint">{t('softStopProfileTitleHint')}</span>
                      </div>
                    </div>
                    <div className="softstop-actions">
                      <button
                        type="button"
                        className="primary-button compact-button"
                        disabled={savingProfile || usableEvents.length === 0}
                        onClick={() => void saveRecordingProfile()}
                      >
                        <Check size={13} />
                        {t('softStopSaveProfile')}
                      </button>
                      <span className="softstop-field-hint">
                        {usableEvents.length === 0 ? t('softStopProfileFailed') : ''}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="softstop-block">
            <div className="softstop-block-head">
              <span className="softstop-field-title">{t('softStopProfiles')}</span>
              <span className="softstop-counter tnum">{profiles.length}</span>
            </div>
            {profiles.length === 0 ? (
              <span className="softstop-preview-empty">{t('softStopProfilesEmpty')}</span>
            ) : (
              <ul className="softstop-profiles">
                {profiles.map((profile) => {
                  const labelList = Object.keys(profile.labels)
                    .map((label) => t(LABEL_KEYS[label as GuiLabel]))
                    .join(', ');
                  return (
                    <li key={profile.id} className="softstop-profile">
                      <span className="softstop-profile-main">
                        <span className="softstop-profile-name">{profile.app}</span>
                        <span className="softstop-profile-meta">
                          {profile.process}
                          {profile.titlePattern ? ` · ${profile.titlePattern}` : ''}
                        </span>
                        <span className="softstop-profile-meta">
                          {t('softStopProfileMeta', {
                            labels: labelList || '—',
                            count: profile.sampleCount,
                          })}
                        </span>
                      </span>
                      <span className="softstop-profile-side">
                        <span className="softstop-chip">
                          {profile.confirmed
                            ? t('softStopProfileConfirmed')
                            : profile.source === 'recording'
                              ? t('softStopProfileRecording')
                              : t('softStopProfileScan')}
                        </span>
                        {deleteConfirm === profile.id ? (
                          <>
                            <button
                              type="button"
                              className="danger-button compact-button"
                              title={t('softStopProfileDeleteConfirm')}
                              onClick={() => void removeProfile(profile.id)}
                            >
                              {t('confirm')}
                            </button>
                            <button
                              type="button"
                              className="ghost-button compact-button"
                              onClick={() => setDeleteConfirm(null)}
                            >
                              {t('cancel')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="ghost-button compact-button"
                            onClick={() => setDeleteConfirm(profile.id)}
                          >
                            <X size={12} />
                            {t('softStopProfileDelete')}
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <span className="softstop-field-hint">{t('softStopProfileApplyHint')}</span>
          </div>
        </Card>

        <Card title={t('softStopCardVerify')}>
          <SettingRow
            icon={<Activity size={15} />}
            title={t('softStopTestSend')}
            description={t('softStopTestSendHint')}
            control={
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={testBusy}
                onClick={() => void runTestSend()}
              >
                {testBusy ? t('softStopTesting') : t('softStopTestSend')}
              </button>
            }
          />
          {testResult && (
            <div className="softstop-fold">
              <InlineNote tone={testResult.ok ? 'success' : 'error'}>
                {testResult.ok
                  ? testResult.dryRun
                    ? t('softStopTestOk', { target: testResult.target ?? '—' })
                    : t('softStopTestSent', { target: testResult.target ?? '—' })
                  : t('softStopTestFail', { detail: testResult.detail || testResult.error || '—' })}
              </InlineNote>
            </div>
          )}
          <SettingRow
            icon={<Cpu size={15} />}
            title={t('softStopDetect')}
            description={t('softStopDetectHint')}
            control={
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={detectBusy}
                onClick={() => void runDetect()}
              >
                {detectBusy ? t('softStopDetecting') : t('softStopDetect')}
              </button>
            }
          />
          {detectError && (
            <div className="softstop-fold">
              <InlineNote>{t('softStopDetectError', { detail: detectError })}</InlineNote>
            </div>
          )}
          {activity && !detectError && (
            <div className="softstop-fold">
              <span className={`softstop-sample${activityActive ? ' is-active' : ''}`}>
                {activityActive
                  ? t('softStopDetectSummary', {
                      streaming: t(STREAMING_KEYS[activity.streaming]),
                      local: localLabel,
                      rate: formatRate(activity.network.throughputBps),
                    })
                  : t('softStopDetectIdle')}
              </span>
            </div>
          )}
          <div className="softstop-block">
            <div className="softstop-block-head">
              <span className="softstop-field-title">{t('softStopAudit')}</span>
              <button
                type="button"
                className="ghost-button compact-button"
                disabled={auditBusy}
                onClick={() => void refreshAudit()}
              >
                {t('softStopAuditRefresh')}
              </button>
            </div>
            {audit.length === 0 ? (
              <span className="softstop-preview-empty">{t('softStopAuditEmpty')}</span>
            ) : (
              <ul className="softstop-audit">
                {audit.slice(0, 12).map((entry, index) => (
                  <li key={`${entry.ts}-${index}`} className="softstop-audit-row">
                    <span className={`softstop-audit-dot ${entry.result}`} aria-hidden="true" />
                    <span className="softstop-audit-time tnum">
                      {formatClock(entry.ts, state.locale)}
                    </span>
                    <span className="softstop-audit-action">{t(ACTION_KEYS[entry.action])}</span>
                    <span className="softstop-audit-detail">
                      {entry.target}
                      {entry.detail ? ` · ${entry.detail}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <SettingRow
            icon={<Power size={15} />}
            title={t('softStopSleepNow')}
            description={t('softStopSleepHint')}
            control={
              <button
                type="button"
                className="danger-button compact-button"
                onClick={() => void runSleep()}
              >
                {sleepConfirm ? t('softStopSleepConfirm') : t('softStopSleepNow')}
              </button>
            }
          />
        </Card>
      </div>
    </>
  );
}
