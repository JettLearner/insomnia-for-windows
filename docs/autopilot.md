# Autopilot — scheduled prompt delivery

> InsomniaZ for Windows 1.2.0 · 中文版：[autopilot.zh-CN.md](autopilot.zh-CN.md)
> Source: `shared/autopilot.ts`, `shared/autopilot-ui.ts`, `electron/core/autopilot-*.ts`, `src/routes/Autopilot.tsx`

Autopilot is a background scheduler that delivers a complete prompt — with attachments, model,
thinking level, parameters and target conversation — into a desktop AI chat app at the time you
choose. The target app does **not** need to be in the foreground, and Autopilot does not preselect a
model or conversation for you unless the task says so.

> **Read this first.** Unlike Soft Stop's GUI fallback, Autopilot has **no dry-run, no whitelist and
> no confirmation gate**. When a task fires it really types your prompt and really clicks send.
> The first time you use a target, press **Run now** while watching the screen.

## 1. Opening it

- Panel footer → the clock button, or
- Tray menu → **Autopilot**.

It opens as a **normal resizable native window** (minimise, maximise, fullscreen, taskbar entry),
not as a tray popover. Closing or minimising it only hides it; the scheduler keeps running.
Closing the Settings window brings the main control panel back.

## 2. Before the first delivery

1. **Start the target app yourself** and log in. Autopilot never launches it; a missing window
   fails with `TARGET_NOT_RUNNING`.
2. Leave the target window **visible** (not minimised). Minimised windows are restored or deferred,
   never clicked blind.
3. Open the **Models** tab and press **Sync** for ZCode / WorkBuddy so the catalog reflects what your
   account can actually use. Without a sync you only get the built-in seed catalog.
4. Create the task, then use **Run now** and watch the first delivery end to end.
5. Only then leave it unattended.

The automation helper `InsomniaZAuto.exe` starts lazily from the app's resources and does **not**
require elevation. Apps running as administrator can only be automated from an equally elevated
InsomniaZ.

## 3. Tabs

| Tab | What it shows |
|---|---|
| **Tasks** | Every task, its next run, last result, and the editor |
| **Runs** | The last 60 runs with route, attempts and per-step detail (500 kept on disk) |
| **Models** | The merged model catalog: provider, name, context window, source |
| **Conversations** | Conversations discovered in the target apps |
| **Attachments** | The backup ledger: original path, backup, size, restore and delete actions |
| **Settings** | Emergency channels, privacy protection, scheduler defaults |

## 4. Creating a task

The editor has six cards, in this order.

### Name and target

`Target app` is one of **ZCode**, **WorkBuddy**, **WorkBuddy AI**, **Any window** (generic matcher)
or **Fallback route only** (never touches the GUI). `Conversation` can be the **current** one, a
**named** one, or a **new** one. For **Any window**, the window matcher takes a process name or
title with `contains` / `equals`; empty matches any AI window.

### Schedule

| Kind | Fields | Behaviour |
|---|---|---|
| Manual only | — | Fires only on **Run now** |
| Once at | date + time | One delivery, then the task goes idle |
| Daily at | time | Every day at that local time |
| Weekly | time + weekday chips | Only the selected weekdays (Mon…Sun) |
| Every (minutes) | 1…10080 | Repeating interval |

**If a run was missed** (app closed, PC asleep) chooses `Run it once` (default) or `Skip it`,
bounded by the catch-up window in Settings (default 10 minutes, max 24 hours).

### Model

- `name` and `provider` are free text with catalog suggestions. Leave them empty to keep whatever
  the target app currently uses.
- **Thinking** is a five-position ring: `Off → Low → Medium → High → Max`. In ZCode this is driven
  with `Ctrl+T` one step at a time and read back to confirm; the slider is only clicked when the
  label cannot be read.
- `temperature`, `topP`, `maxTokens` are passed through when the target exposes them.

When a model is unavailable because the account has no quota, Autopilot refreshes the model list
first and then picks the next candidate — it never sends with an empty model field.

### Skills and context

Free-form `mode` plus workspace, skills, MCP servers, plugins and experts. These are written into
the prompt context for the target app; Autopilot does not verify that the app applied them.

### Prompt

Up to **200 000 characters**. An empty prompt cannot be saved. If attachments are missing or
oversized, a note is appended to the prompt automatically (section 5).

### Attachments

Pick files with the file dialog (up to **40** per task). Each attachment can be backed up and has a
retention policy (`delete_now`, `keep`, `expire` after N days). Files added from the UI default to
`backup: true` and `keep` — but **no copy is made until you enable "Back up attachments before
delivery" in Settings**, which is off by default.

## 5. Attachments and the original-path rule

The path handed to the target app is **always your original path**, never the backup directory.
Four cases:

| Original file | Backup | What happens |
|---|---|---|
| Present | any | Read the original; refresh the backup if enabled |
| Moved | any | Search by name **plus size or hash**, use the found path, remember it |
| Gone | present | **Restore the backup into the original directory first**, then deliver the original path |
| Gone | none | Skip it and append `【附件缺失说明】…` to the prompt |

Restoring is preferred over searching, so a same-name file elsewhere can never replace your file.
Once a file is known, a namesake only counts as a match when its size or SHA-256 (first 64 KiB)
agrees. If the original directory cannot be written, the attachment is skipped with
`restore_target_unavailable` rather than being delivered from somewhere else.

Search covers the original directory, its parent, previously seen paths, your configured roots and
Desktop/Documents/Downloads, at most 3 levels deep, 50 000 entries, with a 3-second budget.
Missing or oversized attachments **do not fail the run** — the note explains what was skipped.

Backup deletion is confined to the managed backup root and never touches your original file.

## 6. Models and conversations

The catalog merges three sources: built-in seeds, live sync from the target app, and manual edits.

- **ZCode**: the model popup's right column header is the current provider; clicking it expands the
  provider list and `管理模型`. Sync opens model settings and presses the icon-only refresh button
  left of `添加供应商`, then reads the list.
- **WorkBuddy**: MSAA is nearly empty, so the window is captured with `PrintWindow` and read with
  WinRT OCR. Model rows carry a rate suffix such as `0.29x`, which is how they are recognised.

If ZCode shows no models because the account is out of quota, the refresh happens **before** model
selection, so a scheduled task can recover on its own. Conversations are stored alongside the
catalog and are never created or renamed on your behalf.

## 7. Runs, routes and errors

A run records `route` (`zcode`, `workbuddy`, `generic`, `fallback-ollama`, `fallback-api`),
attempt count and up to 200 steps. Job statuses are
`idle · queued · running · sent · failed · skipped · deferred · blocked`.

Retries follow a built-in error catalog: each code has its own attempt limit, backoff and terminal
action (`fallback`, `deferred`, `next-candidate`, `continue`, `failed`, `blocked`). Examples:

| Code | Meaning | What Autopilot does |
|---|---|---|
| `TARGET_NOT_RUNNING` | Target app has no window | 2 attempts (5 s, 15 s), then fallback |
| `WINDOW_MINIMIZED` | Window is minimised | Defer |
| `MODEL_UNAVAILABLE_NO_QUOTA` | Model not usable on this account | Refresh, try the next candidate, then fallback |
| `RATE_LIMITED` | Provider throttled you | 4 attempts (30 s → 5 min), then fallback |
| `SEND_DISABLED` | Send button stayed disabled | 3 attempts, then fallback |
| `SEND_UNCONFIRMED` | Send clicked twice with no confirmation | Fail as `DUPLICATE_RISK` and **block the task** |
| `PROTECTION_DEFERRED` | Protection gate is busy | Defer, hold the task 5 minutes |
| `SOFT_STOP_INTERCEPT` | Soft Stop owns the desktop | Defer |
| `ATTACHMENT_MISSING` | File unreadable | Continue with the missing-note appended |
| `FALLBACK_NO_KEY` | Remote fallback enabled but no key stored | Fail without calling a paid API |

**At most two send clicks per run.** This is deliberate: a third click could double-post your
prompt. When confirmation is still missing after two, the run fails and the task is blocked so a
human can look at it.

## 8. Emergency fallback chain

Used only after GUI retries are exhausted (or immediately for `Fallback route only`):

1. **Local Ollama** — `POST {base}/api/chat`, default `http://127.0.0.1:11434`,
   default model `qwen2.5-coder:7b`. No `Authorization` header is ever sent here.
2. **OpenAI-compatible endpoint** — `POST {base}/chat/completions`, default
   `https://open.bigmodel.cn/api/paas/v4`, default model `glm-5.3-flash`.
   **Off by default**; used only when remote access is explicitly enabled and a key is stored.

Each channel gets 3 attempts with quadratic backoff (500 ms, 2 s) and a 60-second timeout.
`stream:false`; temperature/top-p/max-tokens come from the task. Text attachments are inlined as
`--- name ---` blocks up to 200 000 bytes; **images are base64-inlined for Ollama only and dropped
on the API channel**.

The reply is **not stored and not forwarded** to the target app — the fallback guarantees your
prompt reached *a* model, not that the answer appears in your chat window. The run's route shows
which channel answered. Keys are DPAPI-encrypted; logs keep status codes only.

## 9. Privacy protection gate

While any enabled GUI task exists, the gate samples every 5 seconds:

| Reading | Trigger | Effect |
|---|---|---|
| `capturing` | Soft Stop owns the desktop, or a recorder is running (`obs64`, `obs studio`, `screen rec`, `屏幕录制`, `bandicam`, `camtasia`, `snipping`) | Hide the Autopilot window, defer GUI delivery |
| `taken_over` | Remote control (`todesk`, `sunlogin`, `向日葵`, `teamviewer`, `rustdesk`, `anydesk`, `parsec`, `mstsc`, `remote desktop`, `远程桌面`, `leoworkspace`) | Same |
| `hot` | CPU above the threshold (default 0.75, range 0.3…0.99) | Same |

Matching is a case-insensitive substring of process name + window title. A busy reading keeps
deferring for **20 seconds** after it clears, so automation does not flicker back mid-recording.
Deferred runs are held for 5 minutes. With no enabled GUI task the gate does not probe at all.
The scheduler and engine keep running while the window is hidden.

## 10. Files on disk

Everything lives under `%APPDATA%\InsomniaZ\autopilot\`:

| File | Contents |
|---|---|
| `autopilot-jobs.json` | Tasks and their schedules |
| `autopilot-settings.json` | Scheduler, fallback and protection settings |
| `autopilot-runs.json` | Last 500 runs |
| `autopilot-catalog.json` | Model catalog **and** discovered conversations |
| `autopilot-attachments.json` | Backup ledger |
| `autopilot-secret.json` | DPAPI-encrypted fallback API key |
| `attachments/<job>/<attachment>/` | Backup copies |

Writes are atomic; a corrupt file is preserved as `<name>.corrupt-<timestamp>` instead of being
deleted. Editing while a task runs is safe — changes are auto-saved adaptively (500 ms base,
stretched under load, never more than 15 s apart) and flushed on suspend and shutdown.

## 11. Limits

| Item | Value |
|---|---|
| Prompt length | 200 000 characters |
| Attachments per task | 40 |
| Single attachment size | 512 MiB default (configurable 1 MiB…16 GiB) |
| Backup quota | 2 GiB default (64 MiB…1 TiB), oldest evicted first |
| Backup retention | 7 days default (1…3650) |
| Attempts per task | 12 default, 60 max; new tasks inherit the Settings value |
| Run deadline | attempts × 60 s |
| Steps per run | 200 |
| Runs kept / shown | 500 / 60 |
| Send clicks per run | 2 |
| Scheduler sleep / tolerance | ≤60 s / 250 ms |
| UI broadcast debounce | 150 ms |
| Backup cleanup | hourly |

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `TARGET_NOT_RUNNING` every time | The app is closed, or its window is on another desktop | Start it and leave the window visible |
| Task blocked with `DUPLICATE_RISK` | Send was clicked twice without confirmation | Check the target app for a modal or a changed send button, then re-enable the task |
| Nothing happens at the scheduled time | Catch-up window expired, or the task is `Manual only` | Check **If a run was missed** and the catch-up window |
| Weekly task fires on the wrong days | No weekday selected | Pick the weekdays in the Schedule card |
| Chip says Taken over / High load | Remote-control tool or CPU load | Close the tool or raise the threshold; delivery resumes after the 20 s cooldown |
| `FALLBACK_UNCONFIGURED` | Both channels disabled | Enable Ollama, or enable remote access and store a key |
| `FALLBACK_NO_KEY` | Remote enabled, key missing | Store the key in Settings → Emergency channels |
| Model list is empty | Account out of quota, or never synced | Press **Sync**; Autopilot also refreshes before selecting |
| Prompt arrives without an attachment | File missing/oversized, or restore target unwritable | Read the appended `【附件缺失说明】` note and the Attachments tab |

## 13. Known limitations

- **No dry-run or whitelist for Autopilot.** It clicks for real. Use **Run now** attended first.
- **The target app must already be running**; nothing auto-launches it.
- **Fallback answers are not returned** to the target app, and images are dropped on the API channel.
- **OCR depends on the target's current layout.** Control positions are stored as window-relative
  ratios (not screen pixels) so non-maximised windows, multi-monitor and DPI changes work, but a
  redesign of the target app can still break recognition.
- **Canvas-only UIs** with no accessibility tree and no readable text cannot be driven.
- Real-machine delivery against ZCode and WorkBuddy is verified per release; see the
  [release notes](release-notes-v1.2.0.md) for exactly what was and was not exercised.