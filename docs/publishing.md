# GitHub publishing checklist (maintainer)

> Maintainer document. None of the commands below have been run yet. Get explicit
> authorization before creating a public repository or a Release.
> 中文：[publishing.zh-CN.md](publishing.zh-CN.md)

Target version: **1.2.0** (maintenance release).

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

- [x] `npm run typecheck` passes (current baseline: 0 errors).
- [x] `npm test` passes (current baseline: **307 tests in 24 files**).
- [x] `npm run build` passes (main process, renderer, `InsomniaZHelper.exe`, `InsomniaZAuto.exe`).
- [x] `npx electron . --smoke` passes completely and `docs/smoke.json` has no failures — **44/44 on 2026-11-07**.
  - Note: `--smoke` and `npm run capture` change the **real system power policy**. Do not run
    them while lid-close protection is active.
- [x] The smoke result is written back into the verification table of
    `docs/release-notes-v1.2.0.md` (44/44 smoke and 12/12 load rows).

### 2.2 On-hardware verification

- [x] Load run: **12/12 on 2026-11-07** (`STRESS_MINUTES=3 npx electron . --stress`). A keep-awake
      session ran for the full 3-minute window under two saturated CPU processes; 36 samples, largest
      gap 5.1 s; 36 settings writes with the file parseable throughout; the power helper stayed
      connected throughout; the session file was removed on deactivate. Peak app-tree RSS 486 MB,
      peak app CPU 8.6%. Report: `docs/stress.json`.
- [x] The smoke run and the load run are both green, so binaries may be built.
- [x] Installers rebuilt on 2026-11-09 after the rename to *Insomnia for Windows*:
      `build-out10/win-unpacked` → `rcedit` 1.2.0 icon/version → `build-out10-installers`, then staged
      in `release/` with a regenerated `SHA256SUMS.txt` and screenshots zip. The 2026-11-08 launch
      check (startup log `packaged:true`, helper 1.2.0 connected, panel rendered) applies to the
      pre-rename build; the post-rename live launch re-check is pending until the running instance
      is closed, because it holds the single-instance lock on `%APPDATA%\InsomniaZ`.
- [ ] Creating the public repository, pushing and creating the Release still need an explicit
      go-ahead.

### 2.3 Privacy and configuration

- [x] The repository contains no user name, host name, personal path, log, API key, prompt body
      or original-app store asset. Checked on 2026-11-08 against the working tree **and every commit**
      (`git grep` over `git rev-list --all`): zero hits; the largest blob in history is a 0.28 MB
      screenshot, so no binary or dump ever entered history.
- [x] `docs/assets/`, `docs/appstore.json`, `.scratch/`, `build-out*/` and `release-*/` are all in
      `.gitignore`; `git status --short --ignored` lists exactly the intended local directories.
- [x] The published binaries come from the `win-unpacked` directory produced by this build
      (`build-out10/win-unpacked`) — `release/win-unpacked` (the older 1.0.0 tree) was not reused.
- [x] Soft Stop data under `%APPDATA%\InsomniaZ\` (profiles, audit trail, stored keys) stays out
      of the repository; screenshots were taken in the isolated `docs/.capture-profile` profile.

### 2.4 Artifact consistency

- [x] `release/SHA256SUMS.txt` matches the actual files (`sha256sum -c SHA256SUMS.txt` → both OK,
      2026-11-09).
- [x] `release/README.md` and `docs/release-notes-v1.2.0.md` say the same thing: file list,
      verification method, limitation notes; the notes now carry the real sizes and SHA-256 values.
- [x] The version resources of installer and portable exe read 1.2.0 (read back with
      `VersionInfo.FileVersion/ProductVersion` after `rcedit`); `Get-AuthenticodeSignature` reports
      `NotSigned` for both, as documented.
- [x] The screenshot paths in the README exist; captures were refreshed at v1.2.0 on 2026-11-09
      (capture mode no longer force-enables the unpublished scheduler), and the zip contains the 21
      current panel, onboarding and settings shots.

### 2.5 What the user must be told

- [x] Unsigned; SmartScreen shows an unknown publisher. Stated in both READMEs, both release notes
      and `release/README.md`.
- [x] Physical lid close is untested and protective sleep was never executed on real hardware.
      Stated in the same four documents.
- [x] The portable edition does not support launch on startup. Stated in the same four documents.

### 2.6 Legal and metadata

- [x] `LICENSE` (MIT) and `SECURITY.md` / `SECURITY.zh-CN.md` exist and are correct.
- [x] Every user-facing document exists in English and Chinese and cross-links (checked pairwise on
      2026-11-08).
- [x] The disclaimer keeps "not affiliated with the original author, no copyrighted assets".

## 3. Packaging (run only after the user confirms)

Executed on 2026-11-09 with the output directories `build-out10` and `build-out10-installers`; the
results are staged in `release/`. The commands below are the reusable form:

```bash
npm run build
npx electron-builder --win --dir --x64 \
  --config.directories.output=build-out --config.win.signAndEditExecutable=false
.tools/winCodeSign/rcedit-x64.exe "build-out/win-unpacked/Insomnia for Windows.exe" \
  --set-icon release/.icon-ico/icon.ico \
  --set-version-string FileDescription "Insomnia for Windows" \
  --set-version-string ProductName "Insomnia for Windows" \
  --set-version-string CompanyName "JettLearner" \
  --set-version-string LegalCopyright "Copyright (c) 2026 JettLearner" \
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

The local repository already has history (`git init` done, **no remote configured**) and the working
tree is clean after the release-preparation commit. Review before committing anything new:

```bash
git status --short
git add -A
git status --short          # confirm no release/, node_modules/, docs/assets/, build-out*/, design-archive/probes/
git commit -m "Insomnia for Windows 1.2.0"
```

Repository: <https://github.com/JettLearner/insomnia-for-windows>. Description: `Keep your Windows PC
awake, even with the lid closed.` The maintainer creates the repository and pushes; the commands
below are recorded for reference only.

First push (creates a public repository — needs explicit authorization):

```bash
gh repo create JettLearner/insomnia-for-windows --public --source=. --remote=origin --push
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
  --title "Insomnia for Windows 1.2.0" \
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
