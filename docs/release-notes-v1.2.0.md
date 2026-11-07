# InsomniaZ for Windows 1.2.0

> 2026-11-07 · Windows 10 22H2 / Windows 11 · x64
> 中文版：[release-notes-v1.2.0.zh-CN.md](release-notes-v1.2.0.zh-CN.md)

An independent Windows port of the macOS menu-bar app **InsomniaZ – Never Sleep**.
1.2.0 keeps everything from 1.0.0/1.1.0 — sleep prevention, lid-close protection, display modes,
timed sessions, low-battery protection, Soft Stop, tray interactions and the bilingual UI — and adds
**Autopilot**, a background scheduler that delivers complete prompts into desktop AI chat apps.

**Not affiliated with the original author. No copyrighted assets from the original app are included.**

> **Release status: prepared, not published.** The 1.2.0 installers have not been built yet, and two
> verification gates are still open (see *Verification*). Nothing here has been pushed to GitHub.

## Download

| File | Size | Purpose |
|---|---:|---|
| `InsomniaZ-Windows-1.2.0-x64.exe` | to be built | NSIS installer (recommended), per-user, choosable directory |
| `InsomniaZ-Windows-1.2.0-portable.exe` | to be built | Portable, single file |
| `InsomniaZ-Windows-1.2.0-screenshots.zip` | to be built | Panel, onboarding, settings and Autopilot screenshots |
| `SHA256SUMS.txt` | — | Binary checksums, generated at packaging time |
| `README.md` | — | Bilingual download and usage notes |

### SHA-256

Generated when the binaries are built; paste the contents of `release/SHA256SUMS.txt` here before
publishing. Verify with:

```powershell
Get-FileHash .\InsomniaZ-Windows-1.2.0-x64.exe -Algorithm SHA256
Get-FileHash .\InsomniaZ-Windows-1.2.0-portable.exe -Algorithm SHA256
```

## What's new in 1.2.0

### Autopilot — scheduled prompt delivery

- **A real native window**: freely resizable, minimisable, maximisable, fullscreen, with a taskbar
  entry. Closing or minimising only hides it; the scheduler keeps running. Closing Settings brings
  the control panel back.
- **Any schedule**: manual, once, daily, weekly with a weekday picker, or every N minutes
  (1…10080), plus a catch-up policy (`run once` / `skip`) bounded by a configurable window.
- **Per-task model, thinking level and parameters**: five-position thinking ring
  (Off/Low/Medium/High/Max), stepped with `Ctrl+T` in ZCode and read back to confirm;
  temperature / top-p / max-tokens passed through.
- **No preselection**: the target app does not need to be in the foreground, and Autopilot does not
  pick a model or conversation unless the task says so.
- **Live catalog and conversation sync** merged with a built-in seed catalog. When ZCode hides
  models because the account is out of quota, the model list is refreshed *before* selection.
- **Three-level control location**: MSAA name/role → OCR label → window-relative ratio anchors.
  Ratios, not screen pixels, so non-maximised windows, multi-monitor and DPI changes work.
  WorkBuddy is read with `PrintWindow` + WinRT OCR because its accessibility tree is nearly empty.
- **Attachments**: path validation, search for moved files, optional backups with quota and
  retention, and the **original-path rule** — a backup is restored into the original directory
  *before* the target app reads the original path. Missing or oversized files are skipped with a
  note appended to the prompt instead of failing the run.
- **Built-in error catalog**: ~50 codes, each with its own attempt limit, backoff and terminal
  action (fallback / defer / next candidate / continue / fail / block). At most **two send clicks**
  per run; if confirmation is still missing the run fails as `DUPLICATE_RISK` and the task is
  blocked rather than risking a duplicate post.
- **Emergency fallback**: local Ollama first (`/api/chat`, no `Authorization` header ever), then an
  OpenAI-compatible endpoint that is **off by default** and requires both opt-in and a stored key.
  Three attempts per channel, quadratic backoff, 60 s timeout. Without a key it fails with
  `FALLBACK_NO_KEY` instead of calling a paid API.
- **Protection gate**: on screen recording, remote control or CPU above the threshold, the Autopilot
  window is hidden completely and GUI delivery is deferred, with a 20 s cooldown and a 5-minute
  hold. With no enabled GUI task it does not probe at all.
- **Adaptive real-time saving**: 500 ms base interval stretched under load (never more than 15 s),
  atomic writes, corrupt files preserved rather than deleted, flush on suspend and shutdown.
- **Six tabs**: Tasks, Runs, Models, Conversations, Attachments, Settings — all bilingual.

### Fixes

- **Attachment resolution no longer prefers a namesake over your own backup.** Restoring the backup
  into the original directory now happens before any search, and a known file only matches a
  candidate when the size or SHA-256 agrees. Previously an unrelated `NOTES.md` in your Documents
  folder could be delivered in place of a missing `notes.md`.
- **The automation helper now compiles with the in-box .NET 4.8 compiler.** `out _` (C# 7) in the
  foreground-lock path was rejected by `csc.exe`; it now uses an explicit out variable.
- **Weekly tasks honour the selected weekdays.** The editor had no weekday picker, so a weekly task
  silently fired every day.
- **The protection chip reports the real reason** — Taken over / High load — instead of always
  saying "Screen capture".
- **UI limits now match the contract**: prompt length 200 000 (was truncated at 32 000 in the
  editor), attempts up to 60 (the field capped at 10), CPU threshold 0.3…0.99 with a 0.75 default
  (the field allowed 0.05…1 and silently re-clamped).
- **"Default attempts for new tasks" is now actually used** — new tasks inherit the Settings value
  instead of a hard-coded 3.
- **Catch-up policy is exposed in the editor** (`run once` / `skip`).

### Documentation

- Every user-facing document now exists in **English and Chinese**: README, SECURITY, the Autopilot
  and Soft Stop guides, the publishing checklist and these release notes.
- Historical design, acceptance and review records, the pre-implementation Autopilot design and the
  1.0.0/1.1.0 release notes were moved into [`design-archive/`](../design-archive/README.md).
  Raw desktop reconnaissance dumps stay local and are gitignored — they contain personal window
  titles and paths and are never published.
- Corrected documentation drift: Autopilot settings live in `autopilot-settings.json` and the model
  catalog **and** conversations live in `autopilot-catalog.json`, both under
  `%APPDATA%\InsomniaZ\autopilot\`.

## Install and upgrade

1. Prefer the installer; run the portable exe if you do not want to install. Installing over
   1.0.0/1.1.0 keeps settings and session data.
2. Verify the SHA-256. The binaries are unsigned, so SmartScreen may warn; after checking the
   checksum choose "More info → Run anyway".
3. Complete the three-step onboarding; the app then lives in the tray.
4. Soft Stop stays off by default. Autopilot's remote fallback and attachment backups are also off
   by default.
5. **Before the first scheduled delivery**: start the target app yourself, leave its window visible,
   sync models, then watch a **Run now** end to end. Autopilot has no dry-run and no whitelist — it
   really clicks send.
6. Enabling lid-close protection triggers one UAC prompt; declining it leaves the other keep-awake
   features working.

There is no auto-update. Uninstalling keeps `%APPDATA%\InsomniaZ\` (settings, logs, Soft Stop and
Autopilot data); delete that directory manually for a full cleanup.

## Verification

| Item | Result |
|---|---|
| TypeScript type check (main + renderer + tests) | **Pass** |
| Vitest unit/integration | **302/302 pass in 22 files** — real helper processes, real HTTP sockets, scheduler and catch-up, error catalog and backoff, model matching, attachment quadrants, fallback channels (including "no Authorization to Ollama" and "no key, no paid call"), protection gate cooldown and idle behaviour |
| Production build | **Pass** — main, renderer, `InsomniaZHelper.exe` (59 392 B) and `InsomniaZAuto.exe` (36 864 B) |
| Real Electron smoke | **Not re-run for 1.2.0.** Last full run: 44/44 on 1.1.0. Re-running touches the system power policy, which is currently holding an active lid-protected session |
| Attended ZCode / WorkBuddy delivery | **Outstanding.** Control maps were recorded from the real apps and are unit-tested; a live end-to-end delivery on 1.2.0 has not been performed |
| Load / stress run | **Outstanding** |
| Protective sleep | Implemented and unit-tested; never executed on real hardware |
| Lid policy write/restore | Verified on real hardware; physical lid close untested |

**Do not publish binaries until the smoke run, an attended delivery and the stress run are done.**
See the [publishing checklist](publishing.md).

## Known limitations

- **Autopilot has no dry-run, whitelist or confirmation gate.** It clicks for real; the target app
  must already be running and visible, and nothing auto-launches it.
- **Fallback answers are not returned** to the target app and are not stored. Images are base64
  inlined for Ollama only and dropped on the remote API channel.
- **GUI automation depends on the target's accessibility and layout.** Pure-canvas UIs cannot be
  read; a target-app redesign can break ratio anchors and OCR labels; elevated targets need equal
  elevation.
- **Protective sleep and physical lid close remain untested on real hardware.**
- **Unsigned binaries**, Windows 11 / OEM power schemes, notification visuals, installer startup and
  clean-system NSIS install/uninstall still need per-machine confirmation.
- **Memory** idle ≈213 MB versus a 160 MB design target; idle CPU 0–0.16%.

Guides: [Autopilot](autopilot.md) · [Soft Stop](soft-stop.md) · [Security](../SECURITY.md).
Historical evidence: [design archive](../design-archive/README.md).

## License

Code under MIT. The `InsomniaZ` name and related trademarks belong to the original author. This
project is not affiliated with them and includes none of the original app's icons, screenshots or
other copyrighted resources.