# InsomniaZ for Windows 1.2.0

> 2026-11-07 · Windows 10 22H2 / Windows 11 · x64
> 中文版：[release-notes-v1.2.0.zh-CN.md](release-notes-v1.2.0.zh-CN.md)

An independent Windows port of the macOS menu-bar app **InsomniaZ – Never Sleep**.
1.2.0 keeps everything from 1.0.0/1.1.0 — sleep prevention, lid-close protection, display modes,
timed sessions, low-battery protection, Soft Stop, tray interactions and the bilingual UI — and is a
maintenance release focused on documentation.

**Not affiliated with the original author. No copyrighted assets from the original app are included.**

> **Release status: prepared, not published.** Both verification gates passed on 2026-11-07, and the
> installers were built, checksummed and launch-checked on 2026-11-08 (see *Verification*). Nothing
> here has been pushed to GitHub; creating the repository and the Release still needs an explicit
> go-ahead.

## Download

| File | Size | Purpose |
|---|---:|---|
| `InsomniaZ-Windows-1.2.0-x64.exe` | 96.7 MB | NSIS installer (recommended), per-user, choosable directory |
| `InsomniaZ-Windows-1.2.0-portable.exe` | 96.4 MB | Portable, single file |
| `InsomniaZ-Windows-1.2.0-screenshots.zip` | 3.0 MB | Panel, onboarding and settings screenshots (21 images) |
| `SHA256SUMS.txt` | — | Binary checksums, listed below |
| `README.md` | — | Bilingual download and usage notes |

### SHA-256

```text
d9720450d003535eac6047120a499ee0c2a57ff6a938b842b2914295d2ca7a59  InsomniaZ-Windows-1.2.0-x64.exe
3910b56cc2e4ae267d1ca4718a04e0194cb4a0181216054e61bf11cede8e57ee  InsomniaZ-Windows-1.2.0-portable.exe
```

Verify with:

```powershell
Get-FileHash .\InsomniaZ-Windows-1.2.0-x64.exe -Algorithm SHA256
Get-FileHash .\InsomniaZ-Windows-1.2.0-portable.exe -Algorithm SHA256
```

## What's new in 1.2.0

### Documentation

- Every user-facing document now exists in **English and Chinese**, side by side: the README, the
  security policy, the Soft Stop guide, the publishing checklist and these release notes. Each
  document links to its counterpart.
- **One archive folder for the historical records.** The v1.0.0 requirement baseline, architecture
  design, UI specification, acceptance report, design/code/security review, an internal scheduler's
  pre-implementation design and the 1.0.0/1.1.0 release notes were moved into
  [`design-archive/`](../design-archive/README.md), which carries a bilingual index of what each
  file is and where the living documentation went.
- Raw desktop reconnaissance dumps stay local and are gitignored — they contain personal window
  titles and paths and are never published.
- Documentation drift was corrected along the way: the settings file, the catalog file and the
  actual runtime behaviour of the GUI fallback were checked against the code instead of being
  described from memory.

### Fixes

- **The automation helper compiles again with the in-box .NET 4.8 compiler.** `out _` (C# 7) in the
  foreground-lock path was rejected by `csc.exe`; it now uses an explicit out variable.
- **The attachment resolver no longer prefers a namesake over your own backup.** Restoring a backup
  into the original directory now happens before any search, and a known file only matches a
  candidate when the size or SHA-256 agrees. Previously an unrelated `NOTES.md` in your Documents
  folder could be delivered in place of a missing `notes.md`.

## Install and upgrade

1. Prefer the installer; run the portable exe if you do not want to install. Installing over
   1.0.0/1.1.0 keeps settings and session data.
2. Verify the SHA-256. The binaries are unsigned, so SmartScreen may warn; after checking the
   checksum choose "More info → Run anyway".
3. Complete the three-step onboarding; the app then lives in the tray.
4. Soft Stop stays off by default; the remote endpoint has to be enabled explicitly.
5. Enabling lid-close protection triggers one UAC prompt; declining it leaves the other keep-awake
   features working.

There is no auto-update. Uninstalling keeps `%APPDATA%\InsomniaZ\` (settings, logs and Soft Stop
data); delete that directory manually for a full cleanup.

## Verification

| Item | Result |
|---|---|
| TypeScript type check (main + renderer + tests) | **Pass** |
| Vitest unit/integration | **307 tests in 24 files pass** — real helper processes, real HTTP sockets, the Soft Stop state machine, GUI recognition and the teaching recorder |
| Production build | **Pass** — main, renderer, `InsomniaZHelper.exe` and the automation helper |
| Real Electron smoke | **44/44 pass** on 1.2.0 (2026-11-07) — real interaction against the live desktop |
| Load / stress run | **12/12 pass** — 3-minute window under two saturated CPU processes: 36 samples, largest gap 5.1 s, 36 settings writes with the file parseable throughout, power helper connected throughout, session file removed on deactivate. Peak app-tree RSS 486 MB, peak app CPU 8.6% |
| Packaged binaries | **Built and launch-checked on 2026-11-08** — installer and portable read version 1.2.0 and are unsigned (`NotSigned`); the portable exe started with `packaged:true`, connected the 1.2.0 power helper and rendered the panel; `sha256sum -c` passes |
| Protective sleep | Implemented and unit-tested; never executed on real hardware |
| Lid policy write/restore | Verified on real hardware; physical lid close untested |

The binaries are built and checksummed; publishing itself needs an explicit go-ahead.
See the [publishing checklist](publishing.md).

## Known limitations

- **Protective sleep and physical lid close remain untested on real hardware.**
- **Unsigned binaries**, Windows 11 / OEM power schemes, notification visuals, installer startup and
  clean-system NSIS install/uninstall still need per-machine confirmation.
- **Memory** idle ≈213 MB versus a 160 MB design target; idle CPU 0–0.16%. Under the sustained
  saturated-CPU load run the process tree climbed to ≈486 MB and then stayed flat.
- **GUI recognition depends on the target's accessibility and layout** — pure-canvas UIs cannot be
  read, and a target-app redesign can break ratio anchors and OCR labels.

Guides: [Soft Stop](soft-stop.md) · [Security](../SECURITY.md).
Historical evidence: [design archive](../design-archive/README.md).

## License

Code under MIT. The `InsomniaZ` name and related trademarks belong to the original author. This
project is not affiliated with them and includes none of the original app's icons, screenshots or
other copyrighted resources.
