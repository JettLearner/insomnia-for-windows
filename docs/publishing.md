# GitHub publishing checklist (maintainer)

> Maintainer document. None of the commands below have been run yet. Get explicit
> authorization before creating a public repository or a Release.
> 中文：[publishing.zh-CN.md](publishing.zh-CN.md)

Target version: **1.2.0** (adds Autopilot).

## 1. Release assets

| File | In the repository | Uploaded as a Release asset |
|---|---|---|
| Source, `resources/`, `scripts/`, `docs/` (no build output, no local recon dumps) | Yes | No (GitHub archives the source itself) |
| `LICENSE`, `README.md`, `README.zh-CN.md`, `SECURITY.md`, `SECURITY.zh-CN.md`, `.gitignore` | Yes | No |
| `design-archive/` (historical design, review, acceptance records, old release notes) | Yes | No |
| `release/InsomniaZ-Windows-1.2.0-x64.exe` | No (`release/` is ignored) | Yes |
| `release/InsomniaZ-Windows-1.2.0-portable.exe` | No | Yes |
| `release/InsomniaZ-Windows-1.2.0-screenshots.zip` | No | Yes |
| `release/SHA256SUMS.txt` | No | Yes |
| `release/README.md` | No | Yes |
| `docs/release-notes-v1.2.0.md` (or the Chinese one) | Yes | Used as the Release body |

Do not upload `InsomniaZ-Windows-1.2.0-x64.exe.blockmap` — this project has no auto-update.

`design-archive/probes/` and `design-archive/winrt-scratch/` are raw desktop reconnaissance
dumps. They contain personal window titles and local paths, are gitignored, and are **never
published**.

## 2. Pre-release checks

### 2.1 Automated verification

- [ ] `npm run typecheck` passes (current baseline: 0 errors).
- [ ] `npm test` passes (current baseline: **302 tests in 22 files**).
- [ ] `npm run build` passes (main process, renderer, `InsomniaZHelper.exe`, `InsomniaZAuto.exe`).
- [ ] `npx electron . --smoke` passes completely and `docs/smoke.json` has no failures.
  - Note: `--smoke` and `npm run capture` change the **real system power policy**. Do not run
    them while lid-close protection is active.
- [ ] The smoke result is written back into the verification table of
    `docs/release-notes-v1.2.0.md`.

### 2.2 On-hardware verification (still open — do not skip)

- [ ] Attended ZCode end-to-end delivery: model sync → model selection → thinking level → send →
    the landed text matches the prompt.
- [ ] Attended WorkBuddy end-to-end delivery (PrintWindow + WinRT OCR path).
- [ ] Stress run: scheduler concurrency, long-running behaviour, throttled saving under load,
      flush before suspend and shutdown.
- [ ] Only after all three may binaries be built.

### 2.3 Privacy and configuration

- [ ] The repository contains no user name, host name, personal path, log, API key, prompt body
      or original-app store asset.
- [ ] `docs/assets/`, `docs/appstore.json`, `.scratch/`, `build-out*/` and `release-*/` are all in
      `.gitignore`.
- [ ] The published binaries come from the `win-unpacked` directory produced by this build — do
      not reuse `release/win-unpacked`, which is a still-running older version.
- [ ] Soft Stop and Autopilot data under `%APPDATA%\InsomniaZ\` (profiles, audit trail, catalog,
      keys) stays out of the repository.

### 2.4 Artifact consistency

- [ ] `release/SHA256SUMS.txt` matches the actual files (`sha256sum -c SHA256SUMS.txt`, run
      inside `release/`).
- [ ] `release/README.md` and `docs/release-notes-v1.2.0.md` say the same thing: file list,
      verification method, limitation notes.
- [ ] The version resources of installer and portable exe read 1.2.0 (verify after `rcedit`).
- [ ] The screenshot paths in the README exist; the screenshot zip contains the current panel,
      onboarding, settings and Autopilot shots.

### 2.5 What the user must be told

- [ ] Unsigned; SmartScreen shows an unknown publisher.
- [ ] Physical lid close is untested and protective sleep was never executed on real hardware.
- [ ] Autopilot has **no dry-run, whitelist or confirmation gate** — it really clicks send.
- [ ] The portable edition does not support launch on startup.

### 2.6 Legal and metadata

- [ ] `LICENSE` (MIT) and `SECURITY.md` / `SECURITY.zh-CN.md` exist and are correct.
- [ ] Every user-facing document exists in English and Chinese and cross-links.
- [ ] The disclaimer keeps "not affiliated with the original author, no copyrighted assets".

## 3. Packaging (run only after the user confirms)

```bash
npm run build
npx electron-builder --win --dir --x64 \
  --config.directories.output=build-out --config.win.signAndEditExecutable=false
.tools/winCodeSign/rcedit-x64.exe build-out/win-unpacked/InsomniaZ.exe \
  --set-icon release/.icon-ico/icon.ico \
  --set-version-string FileDescription InsomniaZ \
  --set-version-string ProductName InsomniaZ \
  --set-version-string CompanyName "Independent Windows port" \
  --set-version-string LegalCopyright "Copyright (c) 2026 Independent Windows port" \
  --set-file-version 1.2.0 --set-product-version 1.2.0.0
npx electron-builder --win nsis portable --x64 --prepackaged build-out/win-unpacked \
  --config.directories.output=build-out-installers --config.win.signAndEditExecutable=false
```

- Do not reuse an output directory left with a dead handle by a previous failed run (`EBUSY`).
- After packaging, copy both exes into `release/` and rename them `InsomniaZ-Windows-1.2.0-*`.
- Generate `release/SHA256SUMS.txt`:

```bash
cd release && sha256sum InsomniaZ-Windows-1.2.0-x64.exe InsomniaZ-Windows-1.2.0-portable.exe > SHA256SUMS.txt
```

## 4. Commit and push

The local repository already has history (`git init` done, **no remote configured**). The working
tree currently holds a large set of changes; review before committing:

```bash
git status --short
git add -A
git status --short          # confirm no release/, node_modules/, docs/assets/, build-out*/, design-archive/probes/
git commit -m "InsomniaZ for Windows 1.2.0"
```

Suggested repository name: `insomniaz-windows`. Description: `Keep your Windows PC awake, even
with the lid closed.`

First push (creates a public repository — needs explicit authorization):

```bash
gh repo create <owner>/insomniaz-windows --public --source=. --remote=origin --push
```

Suggested topics: `windows`, `electron`, `tray`, `keep-awake`, `lid-close`, `power-management`,
`automation`.

## 5. Create the v1.2.0 Release

```bash
gh release create v1.2.0 \
  release/InsomniaZ-Windows-1.2.0-x64.exe \
  release/InsomniaZ-Windows-1.2.0-portable.exe \
  release/InsomniaZ-Windows-1.2.0-screenshots.zip \
  release/SHA256SUMS.txt \
  release/README.md \
  --title "InsomniaZ for Windows 1.2.0" \
  --notes-file docs/release-notes-v1.2.0.md
```

After publishing:

- [ ] The Release page shows 5 assets whose names match the body.
- [ ] Download the installer and the portable build from the Release; `Get-FileHash` matches
      `SHA256SUMS.txt`.
- [ ] The installer starts and exits; the portable build starts.
- [ ] The limitation notes in the Release body are not truncated.

## 6. Later versions

1. Bump the version in `package.json` (and the `version` plus root-package `version` in
   `package-lock.json`), then rebuild the helpers, renderer and installers.
2. Update `docs/release-notes-vX.Y.Z.md` (English and Chinese) and `release/SHA256SUMS.txt`.
3. Tag with the same flow; never re-upload assets of an older version.
4. If code signing or auto-update is added later, revisit `blockmap` and the update server. The
   current version needs neither.
