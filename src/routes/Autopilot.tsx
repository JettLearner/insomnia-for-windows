import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AUTOPILOT_MAX_ATTEMPTS_BUDGET,
  AUTOPILOT_MAX_PROMPT_CHARS,
  type AutopilotAttachment,
  type AutopilotGuardState,
  type AutopilotJob,
  type AutopilotRun,
  type AutopilotSettings,
  type AutopilotTarget,
  type ModelCatalogEntry,
  type ThinkingLevel,
} from '../../shared/autopilot';
import type { MessageKey } from '../../shared/i18n';
import { Card, ChoiceGroup, SectionHead, StatusRow } from '../components/ui';
import { SettingRow } from '../components/SettingRow';
import { Toggle } from '../components/Toggle';
import { ToastViewport } from '../components/Toast';
import { useAutopilot } from '../lib/autopilot';
import { getApi } from '../lib/api';
import { useT } from '../lib/i18n';
import { useRuntime } from '../lib/runtime';
import './autopilot.css';

type Tab = 'jobs' | 'runs' | 'catalog' | 'conversations' | 'attachments' | 'settings';

const TABS: Array<{ id: Tab; label: MessageKey }> = [
  { id: 'jobs', label: 'autopilotNavJobs' },
  { id: 'runs', label: 'autopilotNavRuns' },
  { id: 'catalog', label: 'autopilotNavCatalog' },
  { id: 'conversations', label: 'autopilotNavConversations' },
  { id: 'attachments', label: 'autopilotNavAttachments' },
  { id: 'settings', label: 'autopilotNavSettings' },
];

const TARGETS: AutopilotTarget[] = ['zcode', 'workbuddy', 'workbuddy-ai', 'generic', 'fallback-only'];

const TARGET_LABELS: Record<AutopilotTarget, MessageKey> = {
  zcode: 'targetZCode',
  workbuddy: 'targetWorkBuddy',
  'workbuddy-ai': 'targetWorkBuddyAi',
  generic: 'targetGeneric',
  'fallback-only': 'targetFallback',
};

const THINKING: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

const THINKING_LABELS: Record<ThinkingLevel, MessageKey> = {
  off: 'thinkingOff',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  max: 'thinkingMax',
};

const SCHEDULES = ['manual', 'once', 'daily', 'weekly', 'interval'] as const;
const SCHEDULE_LABELS: Record<(typeof SCHEDULES)[number], MessageKey> = {
  manual: 'scheduleManual',
  once: 'scheduleOnce',
  daily: 'scheduleDaily',
  weekly: 'scheduleWeekly',
  interval: 'scheduleInterval',
};

const GUARD_LABELS: Record<Exclude<AutopilotGuardState, 'ok'>, MessageKey> = {
  capturing: 'guardCapturing',
  taken_over: 'guardTakenOver',
  hot: 'guardHot',
};

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

function newJob(attemptsBudget: number): AutopilotJob {
  const stamp = new Date().toISOString();
  return {
    id: '',
    schemaVersion: 1,
    title: '',
    target: 'zcode',
    prompt: '',
    attachments: [],
    schedule: { kind: 'daily', timeOfDay: '09:00', catchUp: 'run_once' },
    enabled: true,
    createdAt: stamp,
    updatedAt: stamp,
    attemptsBudget,
  };
}

function when(value: string | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function dayWhen(value: string | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(
    date,
  );
}

export function Autopilot() {
  const { snapshot, error, act, refresh } = useAutopilot();
  const { state, notify } = useRuntime();
  const t = useT();
  const api = getApi();
  const [tab, setTab] = useState<Tab>('jobs');
  const [draft, setDraft] = useState<AutopilotJob | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const locale = state.locale;

  const save = useCallback(
    async (job: AutopilotJob) => {
      if (!job.title.trim() || !job.prompt.trim()) {
        notify(t('jobInvalid'), 'error');
        return;
      }
      const result = await act((actions) => actions.saveJob(job));
      if (result?.ok) {
        setDraft(null);
        notify(t('saved'), 'success');
      } else {
        notify(result?.error ?? t('jobInvalid'), 'error');
      }
    },
    [act, notify, t],
  );

  const sync = useCallback(
    async (target: AutopilotTarget) => {
      setSyncing(true);
      const result = await act((actions) => actions.sync(target));
      setSyncing(false);
      if (result?.ok) notify(`${t('catalogSync')}: ${result.models} / ${result.conversations}`, 'success');
      else notify(result?.error ?? t('catalogSync'), 'error');
    },
    [act, notify, t],
  );

  const patchSettings = useCallback(
    (patch: Partial<AutopilotSettings>) => {
      void act((actions) => actions.updateSettings(patch));
    },
    [act],
  );

  const conversations = useMemo(() => {
    const map = snapshot?.conversations ?? {};
    return Object.entries(map) as Array<[string, string[]]>;
  }, [snapshot]);

  if (!snapshot) {
    return (
      <div className="autopilot-boot">
        <span>{t('autopilotTitle')}</span>
      </div>
    );
  }

  const body = (() => {
    switch (tab) {
      case 'runs':
        return (
          <RunsPanel
            runs={snapshot.runs}
            jobs={snapshot.jobs}
            open={openRun}
            onOpen={setOpenRun}
            onCancel={(runId) => void act((actions) => actions.cancelRun(runId))}
            onClear={() => void act((actions) => actions.clearRuns())}
            locale={locale}
          />
        );
      case 'catalog':
        return (
          <CatalogPanel
            catalog={snapshot.catalog}
            onSync={sync}
            syncing={syncing}
          />
        );
      case 'conversations':
        return <ConversationsPanel conversations={conversations} onSync={sync} />;
      case 'attachments':
        return (
          <AttachmentsPanel
            snapshot={snapshot}
            onAction={(type, attachmentId, jobId) =>
              void act((actions) => actions.attachmentAction({ type, attachmentId, jobId }))
            }
          />
        );
      case 'settings':
        return <SettingsPanel settings={snapshot.settings} onPatch={patchSettings} />;
      default:
        return (
          <JobsPanel
            jobs={snapshot.jobs}
            catalog={snapshot.catalog}
            conversations={snapshot.conversations}
            draft={draft}
            onEdit={setDraft}
            onClose={() => setDraft(null)}
            onSave={save}
            onDelete={async (id) => {
              if (!window.confirm(t('confirmDeleteJob'))) return;
              await act((actions) => actions.deleteJob(id));
            }}
            onToggle={(id, enabled) => void act((actions) => actions.setEnabled(id, enabled))}
            onRunNow={(id) => void act((actions) => actions.runNow(id))}
            locale={locale}
          />
        );
    }
  })();

  return (
    <div className="autopilot-root">
      <header className="autopilot-bar">
        <div className="autopilot-bar-title">
          <strong>{t('autopilotTitle')}</strong>
          <span className="autopilot-sub">v{state.version}</span>
        </div>
        <div className="autopilot-chips">
          <span className={`ap-chip${snapshot.paused ? ' is-warn' : ' is-good'}`}>
            {snapshot.paused ? t('autopilotPaused') : t('autopilotArmed')}
          </span>
          <span className={`ap-chip${snapshot.helperAlive ? ' is-good' : ''}`}>
            {t('autopilotHelper')}
          </span>
          {snapshot.activeRunId ? (
            <span className="ap-chip is-active">{t('autopilotActiveRun')}</span>
          ) : null}
          {snapshot.guard !== 'ok' ? (
            <span className="ap-chip is-warn">{t(GUARD_LABELS[snapshot.guard])}</span>
          ) : null}
        </div>
        <div className="autopilot-bar-actions">
          <button type="button" className="ap-btn" onClick={() => void refresh()}>
            {t('catalogSync')}
          </button>
          <button
            type="button"
            className="ap-btn"
            onClick={() => patchSettings({ enabled: !snapshot.settings.enabled })}
          >
            {snapshot.settings.enabled ? t('autopilotPause') : t('autopilotResume')}
          </button>
          <button
            type="button"
            className="ap-btn ap-btn-primary"
            onClick={() => {
              setTab('jobs');
              setDraft(newJob(snapshot.settings.attemptsBudget));
            }}
          >
            {t('jobNew')}
          </button>
        </div>
      </header>

      <div className="autopilot-body">
        <nav className="autopilot-nav" aria-label={t('autopilotTitle')}>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`nav-item${tab === entry.id ? ' is-active' : ''}`}
              aria-current={tab === entry.id ? 'page' : undefined}
              onClick={() => setTab(entry.id)}
            >
              <span>{t(entry.label)}</span>
              <span className="nav-indicator" aria-hidden="true" />
            </button>
          ))}
          <div className="nav-footer">
            <button type="button" className="ap-link" onClick={() => void api?.showPanel()}>
              {t('trayPanel')}
            </button>
          </div>
        </nav>
        <main className="autopilot-main">
          {error ? <div className="ap-error">{error}</div> : null}
          {body}
        </main>
      </div>
      <ToastViewport />
    </div>
  );
}

interface JobsProps {
  jobs: AutopilotJob[];
  catalog: ModelCatalogEntry[];
  conversations: Record<string, string[]>;
  draft: AutopilotJob | null;
  onEdit: (job: AutopilotJob) => void;
  onClose: () => void;
  onSave: (job: AutopilotJob) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  locale: string;
}

function JobsPanel(props: JobsProps) {
  const t = useT();
  const { jobs, draft } = props;

  if (draft) {
    return <JobEditor job={draft} catalog={props.catalog} conversations={props.conversations} onCancel={props.onClose} onSave={props.onSave} locale={props.locale} />;
  }

  return (
    <div className="ap-stack">
      {jobs.length === 0 ? <p className="ap-empty">{t('jobNone')}</p> : null}
      {jobs.map((job) => (
        <Card key={job.id} title={job.title || t('jobNew')} footer={`${t('jobLastStatus')}: ${job.lastStatus ?? '—'}`}>
          <div className="ap-job-meta">
            <span>{t(TARGET_LABELS[job.target])}</span>
            <span>{t(SCHEDULE_LABELS[job.schedule.kind])}</span>
            <span>
              {t('jobNextDue')}: {when(job.nextDueAt, props.locale)}
            </span>
          </div>
          <p className="ap-job-prompt">{job.prompt.slice(0, 160)}</p>
          <div className="ap-actions">
            <Toggle
              checked={job.enabled}
              onChange={(next) => props.onToggle(job.id, next)}
              label={t('jobEnabled')}
            />
            <button type="button" className="ap-btn" onClick={() => props.onEdit(job)}>
              {t('jobEdit')}
            </button>
            <button type="button" className="ap-btn" onClick={() => props.onRunNow(job.id)}>
              {t('jobRunNow')}
            </button>
            <button type="button" className="ap-btn ap-btn-danger" onClick={() => void props.onDelete(job.id)}>
              {t('jobDelete')}
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function JobEditor({
  job,
  catalog,
  conversations,
  onCancel,
  onSave,
  locale,
}: {
  job: AutopilotJob;
  catalog: ModelCatalogEntry[];
  conversations: Record<string, string[]>;
  onCancel: () => void;
  onSave: (job: AutopilotJob) => Promise<void>;
  locale: string;
}) {
  const t = useT();
  const api = getApi();
  const [draft, setDraft] = useState<AutopilotJob>(job);
  const patch = (next: Partial<AutopilotJob>) => setDraft((current) => ({ ...current, ...next }));
  const listValue = (list?: string[]) => (list ?? []).join(', ');
  const parseList = (value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 20);
  const names = conversations[draft.target] ?? [];
  const modelNames = catalog.filter((entry) => !draft.model?.provider || entry.provider === draft.model.provider);

  return (
    <div className="ap-stack">
      <SectionHead title={t('jobEdit')} subtitle={t('autopilotTitle')} />
      <Card title={t('jobTitle')}>
        <input
          className="ap-input"
          value={draft.title}
          onChange={(event) => patch({ title: event.target.value.slice(0, 200) })}
          placeholder={t('jobTitle')}
        />
        <label className="ap-field">
          <span>{t('jobTarget')}</span>
          <select
            className="ap-input"
            value={draft.target}
            onChange={(event) => patch({ target: event.target.value as AutopilotTarget })}
          >
            {TARGETS.map((target) => (
              <option key={target} value={target}>
                {t(TARGET_LABELS[target])}
              </option>
            ))}
          </select>
        </label>
        <label className="ap-field">
          <span>{t('jobConversation')}</span>
          <select
            className="ap-input"
            value={draft.conversation?.kind ?? 'current'}
            onChange={(event) =>
              patch({
                conversation: {
                  kind: event.target.value as 'named' | 'current' | 'new',
                  name: draft.conversation?.name,
                  workspace: draft.conversation?.workspace,
                },
              })
            }
          >
            <option value="current">—</option>
            <option value="new">+</option>
            <option value="named">named</option>
          </select>
        </label>
        {draft.conversation?.kind === 'named' ? (
          <>
            <input
              className="ap-input"
              list="ap-conversation-names"
              value={draft.conversation.name ?? ''}
              onChange={(event) =>
                patch({ conversation: { ...draft.conversation, kind: 'named', name: event.target.value } })
              }
              placeholder={t('jobConversation')}
            />
            <datalist id="ap-conversation-names">
              {names.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        ) : null}
        <label className="ap-field">
          <span>{t('jobWindow')}</span>
          <input
            className="ap-input"
            value={draft.window?.process ?? draft.window?.title ?? ''}
            onChange={(event) =>
              patch({
                window: {
                  process: /^[a-z0-9_.-]+$/i.test(event.target.value) ? event.target.value : undefined,
                  title: /^[a-z0-9_.-]+$/i.test(event.target.value) ? undefined : event.target.value,
                },
              })
            }
            placeholder={t('jobWindowHint')}
          />
        </label>
      </Card>

      <Card title={t('jobSchedule')}>
        <div className="ap-schedule">
          <ChoiceGroup
            label={t('jobSchedule')}
            value={draft.schedule.kind}
            options={SCHEDULES.map((kind) => ({ value: kind, label: t(SCHEDULE_LABELS[kind]) }))}
            onChange={(value) => {
              const kind = value as AutopilotJob['schedule']['kind'];
              patch({
                schedule: {
                  ...draft.schedule,
                  kind,
                  timeOfDay: draft.schedule.timeOfDay ?? '09:00',
                  everyMinutes: draft.schedule.everyMinutes ?? 60,
                  weekdays:
                    kind === 'weekly' && !draft.schedule.weekdays?.length
                      ? [new Date().getDay()]
                      : draft.schedule.weekdays,
                },
              });
            }}
          />
          {draft.schedule.kind === 'daily' || draft.schedule.kind === 'weekly' ? (
            <input
              type="time"
              className="ap-input ap-input-narrow"
              value={draft.schedule.timeOfDay ?? '09:00'}
              onChange={(event) => patch({ schedule: { ...draft.schedule, timeOfDay: event.target.value } })}
            />
          ) : null}
          {draft.schedule.kind === 'once' ? (
            <input
              type="datetime-local"
              className="ap-input"
              value={(draft.schedule.at ?? '').slice(0, 16)}
              onChange={(event) =>
                patch({
                  schedule: {
                    ...draft.schedule,
                    at: event.target.value ? new Date(event.target.value).toISOString() : undefined,
                  },
                })
              }
            />
          ) : null}
          {draft.schedule.kind === 'interval' ? (
            <input
              type="number"
              min={1}
              className="ap-input ap-input-narrow"
              value={draft.schedule.everyMinutes ?? 60}
              onChange={(event) =>
                patch({ schedule: { ...draft.schedule, everyMinutes: Number(event.target.value) || 60 } })
              }
            />
          ) : null}
          {draft.schedule.kind === 'weekly' ? (
            <div className="ap-thinking" role="group" aria-label={t('scheduleWeekdays')}>
              {WEEKDAYS.map((day, index) => {
                const selected = draft.schedule.weekdays?.length ? draft.schedule.weekdays : [...WEEKDAYS];
                const active = selected.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`ap-chip${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    onClick={() => {
                      const next = active ? selected.filter((entry) => entry !== day) : [...selected, day];
                      patch({ schedule: { ...draft.schedule, weekdays: next.length ? next : [day] } });
                    }}
                  >
                    {new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2024, 0, 1 + index))}
                  </button>
                );
              })}
            </div>
          ) : null}
          <ChoiceGroup
            label={t('scheduleCatchUp')}
            value={draft.schedule.catchUp === 'skip' ? 'skip' : 'run_once'}
            options={[
              { value: 'run_once', label: t('catchUpRunOnce') },
              { value: 'skip', label: t('catchUpSkip') },
            ]}
            onChange={(value) =>
              patch({ schedule: { ...draft.schedule, catchUp: value as 'run_once' | 'skip' } })
            }
          />
        </div>
      </Card>

      <Card title={t('jobModel')}>
        <input
          className="ap-input"
          list="ap-model-names"
          value={draft.model?.name ?? ''}
          onChange={(event) =>
            patch({ model: { ...draft.model, name: event.target.value.slice(0, 120) || undefined } })
          }
          placeholder={t('catalogModel')}
        />
        <datalist id="ap-model-names">
          {modelNames.map((entry) => (
            <option key={`${entry.provider}/${entry.name}`} value={entry.name} />
          ))}
        </datalist>
        <input
          className="ap-input"
          value={draft.model?.provider ?? ''}
          onChange={(event) =>
            patch({ model: { ...draft.model, provider: event.target.value.slice(0, 80) || undefined } })
          }
          placeholder={t('catalogProvider')}
        />
        <div className="ap-thinking">
          {THINKING.map((level) => (
            <button
              key={level}
              type="button"
              className={`ap-chip${draft.model?.thinking === level ? ' is-active' : ''}`}
              onClick={() =>
                patch({
                  model: {
                    ...draft.model,
                    thinking: draft.model?.thinking === level ? undefined : level,
                  },
                })
              }
            >
              {t(THINKING_LABELS[level])}
            </button>
          ))}
        </div>
        <div className="ap-params">
          {(['temperature', 'topP', 'maxTokens'] as const).map((field) => (
            <label className="ap-field" key={field}>
              <span>{field}</span>
              <input
                type="number"
                step={field === 'maxTokens' ? 1 : 0.1}
                min={0}
                className="ap-input ap-input-narrow"
                value={
                  typeof draft.model?.params?.[field] === 'number'
                    ? String(draft.model?.params?.[field])
                    : ''
                }
                onChange={(event) => {
                  const raw = event.target.value;
                  const params = { ...draft.model?.params };
                  if (raw === '') delete params[field];
                  else params[field] = Number(raw);
                  patch({ model: { ...draft.model, params } });
                }}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card title={t('jobCapabilities')}>
        <label className="ap-field">
          <span>{t('capMode')}</span>
          <input
            className="ap-input"
            value={draft.capabilities?.mode ?? ''}
            onChange={(event) =>
              patch({
                capabilities: { ...draft.capabilities, mode: event.target.value.slice(0, 60) || undefined },
              })
            }
          />
        </label>
        <label className="ap-field">
          <span>{t('capWorkspace')}</span>
          <input
            className="ap-input"
            value={draft.capabilities?.workspace ?? ''}
            onChange={(event) =>
              patch({
                capabilities: {
                  ...draft.capabilities,
                  workspace: event.target.value.slice(0, 200) || undefined,
                },
              })
            }
          />
        </label>
        {(
          [
            ['skills', 'capSkills'],
            ['mcp', 'capMcp'],
            ['plugins', 'capPlugins'],
            ['experts', 'capExperts'],
          ] as const
        ).map(([field, label]) => (
          <label className="ap-field" key={field}>
            <span>{t(label)}</span>
            <input
              className="ap-input"
              value={listValue(draft.capabilities?.[field])}
              placeholder="a, b"
              onChange={(event) =>
                patch({
                  capabilities: {
                    ...draft.capabilities,
                    [field]: parseList(event.target.value),
                  },
                })
              }
            />
          </label>
        ))}
      </Card>

      <Card title={t('jobPrompt')}>
        <textarea
          className="ap-input ap-prompt"
          rows={8}
          value={draft.prompt}
          onChange={(event) => patch({ prompt: event.target.value.slice(0, AUTOPILOT_MAX_PROMPT_CHARS) })}
        />
      </Card>

      <Card
        title={t('jobAttachments')}
        footer={
          <div className="ap-actions">
            <button
              type="button"
              className="ap-btn"
              onClick={async () => {
                const paths = (await api?.autopilot.pickFiles()) ?? [];
                if (!paths.length) return;
                patch({
                  attachments: [
                    ...draft.attachments,
                    ...paths.map((path) => ({
                      id: `att-${Math.random().toString(36).slice(2, 10)}`,
                      originalPath: path,
                      displayName: path.split(/[\\/]/).pop() ?? path,
                      backup: true,
                      retention: 'keep' as const,
                    })),
                  ],
                });
              }}
            >
              {t('jobAttachments')}
            </button>
            <button
              type="button"
              className="ap-btn"
              onClick={() => {
                const entry: AutopilotAttachment = {
                  id: `att-${Math.random().toString(36).slice(2, 10)}`,
                  originalPath: '',
                  displayName: 'file',
                  backup: true,
                  retention: 'keep',
                };
                patch({ attachments: [...draft.attachments, entry] });
              }}
            >
              +
            </button>
          </div>
        }
      >
        {draft.attachments.map((attachment, index) => (
          <div className="ap-attachment" key={attachment.id}>
            <input
              className="ap-input"
              value={attachment.originalPath}
              placeholder="C:\\path\\file.ext"
              onChange={(event) => {
                const value = event.target.value;
                const next = { ...draft.attachments };
                next[index] = {
                  ...attachment,
                  originalPath: value,
                  displayName: value.split(/[\\/]/).pop() ?? attachment.displayName,
                };
                patch({ attachments: next });
              }}
            />
            <button
              type="button"
              className="ap-btn ap-btn-danger"
              onClick={() => patch({ attachments: draft.attachments.filter((_, i) => i !== index) })}
            >
              {t('jobDelete')}
            </button>
          </div>
        ))}
      </Card>

      <div className="ap-actions">
        <button type="button" className="ap-btn ap-btn-primary" onClick={() => void onSave(draft)}>
          {t('jobSave')}
        </button>
        <button type="button" className="ap-btn" onClick={onCancel}>
          {t('cancel')}
        </button>
        <span className="ap-hint">{when(draft.updatedAt, locale)}</span>
      </div>
    </div>
  );
}

function RunsPanel({
  runs,
  jobs,
  open,
  onOpen,
  onCancel,
  onClear,
  locale,
}: {
  runs: AutopilotRun[];
  jobs: AutopilotJob[];
  open: string | null;
  onOpen: (id: string | null) => void;
  onCancel: (runId: string) => void;
  onClear: () => void;
  locale: string;
}) {
  const t = useT();
  const titleFor = (jobId: string) => jobs.find((job) => job.id === jobId)?.title ?? jobId.slice(0, 8);
  return (
    <div className="ap-stack">
      {runs.length === 0 ? <p className="ap-empty">{t('runsNone')}</p> : null}
      {runs.map((run) => (
        <Card key={run.id} title={titleFor(run.jobId)} footer={`${t('runAttempts')}: ${run.attempts}`}>
          <div className="ap-job-meta">
            <span data-state={run.state}>{run.state}</span>
            <span>{t('runRoute')}: {run.route}</span>
            <span>{dayWhen(run.startedAt, locale)}</span>
            {run.error ? <span className="ap-code">{run.error.code}</span> : null}
          </div>
          <div className="ap-actions">
            <button
              type="button"
              className="ap-btn"
              onClick={() => onOpen(open === run.id ? null : run.id)}
            >
              {t('runSteps')} ({run.steps.length})
            </button>
            {run.state === 'running' ? (
              <button type="button" className="ap-btn ap-btn-danger" onClick={() => onCancel(run.id)}>
                {t('cancel')}
              </button>
            ) : null}
          </div>
          {open === run.id ? (
            <ol className="ap-steps">
              {run.steps.map((step, index) => (
                <li key={`${step.step}-${index}`} data-ok={step.ok ? 'yes' : 'no'}>
                  <code>{step.step}</code>
                  <span>{step.code ?? ''}</span>
                  <span className="ap-hint">{step.ms}ms</span>
                </li>
              ))}
            </ol>
          ) : null}
        </Card>
      ))}
      {runs.length > 0 ? (
        <button type="button" className="ap-btn" onClick={onClear}>
          {t('jobDelete')}
        </button>
      ) : null}
    </div>
  );
}

function CatalogPanel({
  catalog,
  onSync,
  syncing,
}: {
  catalog: ModelCatalogEntry[];
  onSync: (target: AutopilotTarget) => void;
  syncing: boolean;
}) {
  const t = useT();
  const groups = useMemo(() => {
    const map = new Map<string, ModelCatalogEntry[]>();
    for (const entry of catalog) {
      const list = map.get(entry.provider) ?? [];
      list.push(entry);
      map.set(entry.provider, list);
    }
    return [...map.entries()];
  }, [catalog]);
  return (
    <div className="ap-stack">
      <div className="ap-actions">
        {(['zcode', 'workbuddy'] as AutopilotTarget[]).map((target) => (
          <button
            key={target}
            type="button"
            className="ap-btn"
            disabled={syncing}
            onClick={() => onSync(target)}
          >
            {t('catalogSync')} · {t(TARGET_LABELS[target])}
          </button>
        ))}
      </div>
      {groups.map(([provider, entries]) => (
        <Card key={provider} title={provider} footer={`${entries.length} · ${t('catalogModel')}`}>
          {entries.map((entry) => (
            <StatusRow
              key={`${entry.provider}/${entry.name}`}
              label={entry.name}
              value={`${t(entry.source === 'seed' ? 'catalogSource' : 'catalogObserved')}: ${
                entry.source === 'seed' ? 'seed' : dayWhen(entry.observedAt, 'zh-CN')
              }`}
            />
          ))}
        </Card>
      ))}
    </div>
  );
}

function ConversationsPanel({
  conversations,
  onSync,
}: {
  conversations: Array<[string, string[]]>;
  onSync: (target: AutopilotTarget) => void;
}) {
  const t = useT();
  if (!conversations.length) return <p className="ap-empty">{t('conversationsNone')}</p>;
  return (
    <div className="ap-stack">
      {conversations.map(([target, names]) => (
        <Card
          key={target}
          title={TARGET_LABELS[target as AutopilotTarget] ? t(TARGET_LABELS[target as AutopilotTarget]) : target}
          footer={
            <button
              type="button"
              className="ap-btn"
              onClick={() => onSync(target as AutopilotTarget)}
            >
              {t('catalogSync')}
            </button>
          }
        >
          <ul className="ap-list">
            {names.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function AttachmentsPanel({
  snapshot,
  onAction,
}: {
  snapshot: ReturnType<typeof useAutopilot>['snapshot'];
  onAction: (type: 'delete' | 'restore' | 'backup', attachmentId: string, jobId: string) => void;
}) {
  const t = useT();
  if (!snapshot || snapshot.attachments.length === 0) return <p className="ap-empty">{t('attachmentsNone')}</p>;
  return (
    <div className="ap-stack">
      {snapshot.attachments.map((entry) => (
        <Card key={`${entry.jobId}/${entry.attachmentId}`} title={entry.displayName}>
          <div className="ap-job-meta">
            <span>{t('attachmentOriginal')}: {entry.originalPath}</span>
            <span data-state={entry.originalExists ? 'succeeded' : 'failed'}>
              {entry.originalExists ? t('attachmentOriginal') : t('attachmentMissing')}
            </span>
            <span>{(entry.size / 1024).toFixed(1)} KB</span>
          </div>
          <div className="ap-actions">
            <button type="button" className="ap-btn" onClick={() => onAction('backup', entry.attachmentId, entry.jobId)}>
              {t('attachmentMakeBackup')}
            </button>
            <button
              type="button"
              className="ap-btn"
              disabled={entry.originalExists || !entry.backupPath}
              onClick={() => onAction('restore', entry.attachmentId, entry.jobId)}
            >
              {t('attachmentRestore')}
            </button>
            <button
              type="button"
              className="ap-btn ap-btn-danger"
              disabled={!entry.backupPath}
              onClick={() => onAction('delete', entry.attachmentId, entry.jobId)}
            >
              {t('attachmentDeleteBackup')}
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function SettingsPanel({
  settings,
  onPatch,
}: {
  settings: AutopilotSettings;
  onPatch: (patch: Partial<AutopilotSettings>) => void;
}) {
  const t = useT();
  const api = getApi();
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  useEffect(() => {
    let alive = true;
    void api?.autopilot.hasApiKey().then((value) => {
      if (alive) setHasKey(value === true);
    });
    return () => {
      alive = false;
    };
  }, [api]);
  return (
    <div className="ap-stack">
      <Card title={t('fallbackTitle')}>
        <SettingRow
          title={t('fallbackOllama')}
          control={
            <Toggle
              checked={settings.fallback.ollamaEnabled}
              onChange={(v) => onPatch({ fallback: { ...settings.fallback, ollamaEnabled: v } })}
              label={t('fallbackOllama')}
            />
          }
        />
        <label className="ap-field">
          <span>{t('fallbackOllamaUrl')}</span>
          <input
            className="ap-input"
            value={settings.fallback.ollamaBaseUrl}
            onChange={(event) =>
              onPatch({ fallback: { ...settings.fallback, ollamaBaseUrl: event.target.value.slice(0, 200) } })
            }
          />
        </label>
        <label className="ap-field">
          <span>{t('fallbackModel')}</span>
          <input
            className="ap-input"
            value={settings.fallback.ollamaModel}
            onChange={(event) =>
              onPatch({ fallback: { ...settings.fallback, ollamaModel: event.target.value.slice(0, 120) } })
            }
          />
        </label>
        <SettingRow
          title={t('fallbackRemote')}
          description={hasKey ? t('fallbackHasKey') : t('fallbackNoKey')}
          control={
            <Toggle
              checked={settings.fallback.remoteEnabled}
              onChange={(v) => onPatch({ fallback: { ...settings.fallback, remoteEnabled: v } })}
              label={t('fallbackRemote')}
            />
          }
        />
        <label className="ap-field">
          <span>{t('fallbackBaseUrl')}</span>
          <input
            className="ap-input"
            value={settings.fallback.baseUrl}
            onChange={(event) =>
              onPatch({ fallback: { ...settings.fallback, baseUrl: event.target.value.slice(0, 200) } })
            }
          />
        </label>
        <label className="ap-field">
          <span>{t('fallbackModel')}</span>
          <input
            className="ap-input"
            value={settings.fallback.model}
            onChange={(event) =>
              onPatch({ fallback: { ...settings.fallback, model: event.target.value.slice(0, 120) } })
            }
          />
        </label>
        <div className="ap-attachment">
          <input
            className="ap-input"
            type="password"
            value={keyDraft}
            placeholder={t('fallbackKeyPlaceholder')}
            onChange={(event) => setKeyDraft(event.target.value)}
          />
          <button
            type="button"
            className="ap-btn"
            onClick={async () => {
              const result = await api?.autopilot.setApiKey(keyDraft.trim() || null);
              if (result?.ok) {
                setKeyDraft('');
                setHasKey(keyDraft.trim().length > 0);
              }
            }}
          >
            {t('fallbackSaveKey')}
          </button>
        </div>
      </Card>

      <Card title={t('protectionTitle')}>
        <SettingRow
          title={t('protectionCapture')}
          control={
            <Toggle
              checked={settings.protection.hideOnCapture}
              onChange={(v) => onPatch({ protection: { ...settings.protection, hideOnCapture: v } })}
              label={t('protectionCapture')}
            />
          }
        />
        <SettingRow
          title={t('protectionRemote')}
          control={
            <Toggle
              checked={settings.protection.hideOnRemoteControl}
              onChange={(v) => onPatch({ protection: { ...settings.protection, hideOnRemoteControl: v } })}
              label={t('protectionRemote')}
            />
          }
        />
        <SettingRow
          title={t('protectionLoad')}
          control={
            <input
              type="number"
              min={0.3}
              max={0.99}
              step={0.05}
              className="ap-input ap-input-narrow"
              value={settings.protection.cpuBusyThreshold}
              onChange={(event) =>
                onPatch({
                  protection: {
                    ...settings.protection,
                    throttleOnLoad: Number(event.target.value) > 0,
                    cpuBusyThreshold: Math.min(0.99, Math.max(0.3, Number(event.target.value) || 0.75)),
                  },
                })
              }
            />
          }
        />
      </Card>

      <Card title={t('autopilotNavSettings')}>
        <SettingRow
          title={t('settingsMaster')}
          control={<Toggle checked={settings.enabled} onChange={(v) => onPatch({ enabled: v })} label={t('settingsMaster')} />}
        />
        <SettingRow
          title={t('settingsStrictModel')}
          control={
            <Toggle
              checked={settings.strictModelMatch}
              onChange={(v) => onPatch({ strictModelMatch: v })}
              label={t('settingsStrictModel')}
            />
          }
        />
        <SettingRow
          title={t('settingsBackup')}
          control={
            <Toggle
              checked={settings.backupEnabled}
              onChange={(v) => onPatch({ backupEnabled: v })}
              label={t('settingsBackup')}
            />
          }
        />
        <SettingRow
          title={t('settingsCatalog')}
          control={
            <Toggle
              checked={settings.catalogRefresh}
              onChange={(v) => onPatch({ catalogRefresh: v })}
              label={t('settingsCatalog')}
            />
          }
        />
        <SettingRow
          title={t('settingsRetention')}
          control={
            <input
              type="number"
              min={1}
              className="ap-input ap-input-narrow"
              value={settings.backupRetentionDays}
              onChange={(event) => onPatch({ backupRetentionDays: Number(event.target.value) || 1 })}
            />
          }
        />
        <SettingRow
          title={t('settingsAttempts')}
          control={
            <input
              type="number"
              min={1}
              max={AUTOPILOT_MAX_ATTEMPTS_BUDGET}
              className="ap-input ap-input-narrow"
              value={settings.attemptsBudget}
              onChange={(event) => onPatch({ attemptsBudget: Number(event.target.value) || 1 })}
            />
          }
        />
        <SettingRow
          title={t('settingsBacklog')}
          control={
            <input
              type="number"
              min={0}
              className="ap-input ap-input-narrow"
              value={Math.round(settings.backlogMs / 60_000)}
              onChange={(event) => onPatch({ backlogMs: (Number(event.target.value) || 0) * 60_000 })}
            />
          }
        />
      </Card>
    </div>
  );
}
