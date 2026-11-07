# Soft Stop

> Applies to InsomniaZ for Windows 1.1.0 and later (current: 1.2.0).
> 中文版：[soft-stop.zh-CN.md](soft-stop.zh-CN.md)
> Source: `shared/soft-stop.ts`, `shared/gui.ts`, `electron/core/{ai-detect,soft-stop-engine,soft-stop-sender,gui-agent}.ts`, `resources/helper/InsomniaZHelper.cs`
> Settings UI: `src/routes/settings/SoftStopSection.tsx`

## 1. The problem it solves

Lid-close protection lets your PC run AI jobs overnight, but an unattended job can keep burning
battery. Soft Stop adds two battery thresholds:

| Threshold | Default | Behaviour |
|---|---:|---|
| **A — send a prompt** | 30% | Send one fixed prompt telling the running AI to stop, save its state and report briefly |
| **B — protective sleep** | 10% | End the session, restore the lid policy, then put Windows to sleep immediately |

Both thresholds only apply while **on battery** with an active session. Plugging in, or battery
recovering to 5 points above A, resets the current cycle automatically.

## 2. State machine

```
session active + on battery + Soft Stop enabled
        │
        ├── battery > A ───────────────► wait (monitoring)
        │
        ├── battery ≤ A ──► detect AI activity
        │                   ├── none ──────► do not send, keep watching
        │                   └── detected ──► send once (dry-run or real)
        │                                        │
        │                                        └── on success mark cycle triggered
        │
        └── battery ≤ B ───────────────► end session + restore lid + sleep
```

- **A only sends to an AI that is actually running.** If the last sample is unknown it detects
  first; with no AI activity the prompt is never fired into the void.
- **B protects unconditionally**, even when A found no activity.
- **At most 2 attempts per cycle**, at least 5 minutes apart; a successful send ends the cycle.
- Configuration blocks (app not whitelisted, confirmation required, helper offline) do not count
  as attempts, but still obey the 5-minute cooldown.
- Ending or restarting a session, plugging in, or battery recovery all reset the cycle. Cycle state
  is written to `soft-stop-cycle.json` and re-aligned with the current session after a crash.
- While Soft Stop is enabled, the original low-battery protection on the Battery page yields to it
  (the UI says so explicitly), so two subsystems never end the session at once.

## 3. AI activity detection

The state machine checks every 5 seconds and only re-samples at threshold A when the current sample
is older than 45 seconds; the detector itself caches for 12 seconds. It reads **process names,
listening ports, adapter types, connection hosts and throughput only** — never content:

1. **Remote streaming**: AI-service connections and throughput on wireless/cellular adapters.
   Connected with sustained traffic (≥15 KB/s) → `likely`; connected only → `suspected`.
2. **Local AI runtimes**: `tasklist` plus port probes identify runtimes from the built-in knowledge
   base (Ollama, LM Studio, vLLM, llama.cpp, Text Generation WebUI, …), then a read-only endpoint
   such as Ollama `/api/ps` decides whether the runtime is idle.
3. The verdict and its evidence (`process:`, `port:`, `api:`, `model:`, `remote:`, `throughput:`)
   go into the audit log. **Check AI activity** on the settings page samples on demand.

"Active" means: any local runtime is non-idle, **or** the remote streaming level is
`likely`/`suspected`.

## 4. Send targets

**Send through** has three choices:

| Option | Meaning |
|---|---|
| **Auto-detect** | Try in order: a running local runtime → the configured OpenAI-compatible endpoint → GUI fallback (if enabled) |
| **A specific adapter** | Pin a built-in runtime or endpoint: Ollama, LM Studio, OpenAI-compatible endpoint, agent webhook, Codex/Claude Code CLI |
| **generic-gui** | GUI recognition and clicking only |

The built-in knowledge base covers HTTP (OpenAI-compatible and native Ollama), webhooks, CLI
(`codex`, `claude`, `gemini`, `aider`, … as non-interactive new processes) and GUI. You can override
or extend it via `%APPDATA%\InsomniaZ\soft-stop\knowledge.json`.

### 4.1 Prompt template

The prompt is capped at 2000 characters and supports variables:

- `{percent}` — current battery
- `{threshold}` — threshold A
- `{sleepThreshold}` — threshold B
- `{model}` — model used for this send, when known

It is rendered before every send. An empty prompt is refused and reported in the UI. Prompt text is
never written to logs or the audit trail; the audit records only target, result and battery level.

### 4.2 HTTP / webhook

- The placeholder endpoint is `http://127.0.0.1:11434`; the API base you enter wins. The request path
  is adapter-defined, e.g. `/v1/chat/completions`.
- With an empty model field the adapter first discovers models via `/v1/models` (or the runtime's
  read-only equivalent). If discovery fails it returns `NO_MODEL` rather than sending a blank model.
- **Remote endpoints are blocked by default.** Non-loopback addresses are only contacted after you
  turn on **Allow remote endpoints**; the UI then states that requests leave this machine.
- The API key is stored encrypted with Windows DPAPI (`safeStorage`) in the user-data directory.
  Logs record only whether a key is stored, never its value. Headers and auth scheme are declared by
  the adapter.
- **Dry run is on by default**: it assembles, renders and audits the request without sending it.
  Turn it off to actually deliver.

### 4.3 CLI

CLI adapters run as a **new process** (`codex exec …`, `claude -p …`); they never inject keystrokes
into an existing terminal. Some CLIs only support new sessions — the adapter description marks them
`spawnOnly`.

## 5. GUI fallback (chat apps without an API)

The GUI fallback uses Windows UI Automation (UIA) plus an MSAA bridge, not screenshot OCR:

1. Scan visible windows and score them by process, title, focus and candidate controls.
2. Inside the window, identify the input box, send button, sidebar/collapse toggle, conversation
   list items and busy markers such as "Generating". Classification combines a multilingual
   dictionary, geometry and control type (`shared/gui.ts`).
3. Prefer a conversation marked busy, click it, then write the prompt and click send.
4. Re-scan and refresh control references before every step, so window reflow cannot cause a
   mis-click.

Safety gates:

- **Whitelist** — only windows whose process name or title matches **Allowed apps** are touched.
- **First-run confirmation** — a preview must be confirmed unless **Send without confirmation** is
  explicitly enabled.
- **Dry run** — by default only the recognition result and planned steps are shown; nothing is
  clicked.
- Rich-text editors exposed as a UIA `Group` without `ValuePattern` (ProseMirror/TipTap and similar)
  are treated as editable; the written text is read back to verify that CJK prompts were not
  truncated.
- Recognition only reads the control tree. A screenshot is taken **only** when you tick **Capture
  the selected window**, and only of that window, for preview purposes.

**Known boundaries**: apps drawn purely on canvas with no UIA/MSAA exposure cannot be recognised;
minimised windows must be restored first; some apps need elevation to be automated; a UIA tree can
go stale after ~3 minutes, so the app re-scans before each action. Real-world results depend on the
target app's accessibility implementation — always dry-run first.

## 6. Teaching by demonstration

When the built-in dictionary misreads an app, demonstrate once with the mouse:

1. Click **Start recording** (max 5 minutes, stop any time).
2. In the target app, click the chat input box, then hover the mouse over the send button. No typing
   is needed, and you do not mark order or duration.
3. Only **left clicks and hovers** are recorded. The renderer receives hit coordinates and control
   info, but the saved profile keeps only control fingerprints and labels — no coordinates,
   durations or ordering.
4. On stop, an event list appears with a suggested label per event
   (input / send / sidebar / conversation / busy / ignore); each can be edited.
5. Enter a profile name and a window-title match string, then save the GUI profile.

Privacy guarantees:

- Recording uses a low-level **mouse** hook. There is **no keyboard hook**: no typed content,
  clipboard or screen text is captured.
- Events carry no ordering constraint and no hover-duration semantics; the recording exists only to
  extract which controls are input/send.
- A saved profile contains only process name, title match and control fingerprints/labels, and can
  be deleted from settings at any time.

GUI profiles match automatically by process and window title and are stored in
`%APPDATA%\InsomniaZ\soft-stop\gui-profiles.json`. They do not override the **Send through** adapter
choice.

## 7. Verification and notifications

The settings page provides:

- **Send a test prompt** — runs the current target's send path (honouring dry run) without affecting
  the battery cycle.
- **Check AI activity** — samples the detector immediately.
- **Recent decisions** — the last 50 audit entries (detect, send, dry-run, skip, sleep, error, reset,
  profile, recording), without prompt text.
- **Sleep now** — ends the session and sleeps after a two-step confirmation, for verifying the
  protection path.

System notifications are sent for A-point success/failure and B-point sleep (notifications can be
turned off in General). They contain only target and battery level.

## 8. Acceptance record (v1.1.0 baseline, 2026-10-31)

Historical evidence for the Soft Stop subsystem; current totals are in the
[release notes](release-notes-v1.2.0.md).

| Item | Result |
|---|---|
| Type check | Pass |
| Vitest | **149 tests in 12 files pass**, including OpenAI-compatible sending over a real HTTP socket, auth headers, prompt rendering, HTTP 500 handling and dry-run sending no packet |
| Electron smoke | **44/44 pass**, including the Soft Stop page, its 5 cards, both thresholds, switch state, phase chip and real AI activity detection |
| Native test-window scan | input 0.95, send 0.97, sidebar 0.75, busy conversation 0.75 |
| Real GUI send | Selected "Generating answer" → wrote the full Chinese prompt → clicked send; the persisted payload matched the prompt **exactly** |
| Teaching recording | 3 mouse events (click input, hover input, hover send), correct suggested labels, `leakedPrompt=false` |
| Profile application | After saving `input`/`send`, a re-scan hit `profile-uia-test-window` and recognition stayed correct |
| Protective sleep | Code path and helper `suspend` implemented; **not executed on the real machine**, to avoid interrupting the running session |

Still unverified: B-point sleep with the lid physically closed, OEM power schemes, automation of
elevated apps, pure-canvas UIs. On first use, verify the local path with **Sleep now** while someone
is attending the machine.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Phase stays Monitoring | Not on battery, or battery above A | Normal; plugging in never triggers |
| Nothing sent at A, audit says `no AI activity` | Detection found no running AI | Use **Check AI activity**; local runtimes must be recognised by the knowledge base |
| `NO_TARGET` | Auto mode found no target and GUI fallback is off | Pin an adapter, fill in the endpoint, or enable GUI fallback and whitelist the app |
| `REMOTE_NOT_ALLOWED` | Non-loopback endpoint without remote permission | Use a local endpoint, or explicitly enable **Allow remote endpoints** |
| `NEEDS_CONFIRMATION` | GUI fallback still requires confirmation | Dry-run first, then enable **Send without confirmation** |
| `NO_MODEL` | Endpoint returned no models and none was entered | Enter a model name, or check that the endpoint supports discovery |
| `HELPER_OFFLINE` | Protective sleep needs the power helper | Enable lid protection once and accept UAC, or run the compatibility check |
| `SUSPEND_FAILED` | Windows refused the sleep request | Check power policy/drivers; read the audit trail and helper log |