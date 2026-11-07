# Security Policy

中文版本：[SECURITY.zh-CN.md](SECURITY.zh-CN.md)

## Supported versions

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| 1.1.x and earlier | No — please upgrade |

## Reporting a vulnerability

Please report privately through the repository's **Security → Report a vulnerability**.
Do not open a public issue. Include:

- the affected app version and Windows version;
- reproduction steps and impact;
- whether it involves the elevated helper, lid-policy write/restore, IPC authorisation,
  renderer isolation, the network guard, or GUI delivery.

In scope: bypassing the elevation boundary, a lid policy left unrestored, named-pipe or token
disclosure, IPC argument injection, CSP or navigation bypass, unintended network access, and
clicking or typing into a window the user did not authorise. General usage questions
belong in Issues.

## Design boundaries

### Network and secrets

- The app makes no remote requests by default and contains no auto-update or telemetry.
- Soft Stop only contacts loopback endpoints; remote endpoints require an explicit opt-in.
- The fallback chain prefers a local Ollama runtime. An OpenAI-compatible remote
  endpoint is used only when remote access is explicitly enabled **and** a key is stored;
  without a key it fails with `FALLBACK_NO_KEY` instead of calling a paid API.
- No `Authorization` header is ever sent to a local Ollama endpoint.
- API keys are encrypted with Windows DPAPI (`safeStorage`). Logs and audit entries record
  only whether a key exists, never its value, and never prompt text.

### Elevation and lid policy

- The elevated helper is not a Windows service, scheduled task or startup entry. It is launched
  through UAC only when lid-close protection is turned on.
- It accepts a fixed command set over a randomly named pipe with a random token and watches its
  parent process; when the parent exits or crashes it restores the original lid policy and exits.
- The original lid value is written to disk before any change and read back after it; a failed
  verification rolls back immediately. A normal exit deletes the backup.

### GUI automation (Soft Stop fallback)

- Teaching mode uses a low-level **mouse** hook only. There is no keyboard hook: no typed text,
  clipboard content or screen text is recorded. Saved profiles keep control fingerprints and
  labels, not coordinates, ordering or durations.
- Screenshots are taken only when the user explicitly opts in, and only of the selected window.
- Soft Stop's GUI fallback requires a whitelist match and, by default, dry-run plus confirmation.

### Attachments

- Attachment resolution reads file names, sizes and a SHA-256 of the first 64 KiB. It searches the
  original directory, its parent, previously seen paths, any roots you configure, and your
  Desktop/Documents/Downloads folders. It does not read document contents into logs.
- A known file is only matched by name **plus** size or hash, so an unrelated namesake is never
  delivered in its place.
- Backups are stored under `%APPDATA%\InsomniaZ\attachments\`. Before delivery, a backup is
  restored to the file's **original path** and the target app reads that original path — never the
  backup directory. If the original directory is unusable, the attachment is skipped and a note is
  appended to the prompt.
- Backup deletion is confined to the managed backup root; the original file is never deleted.

### Renderer

- `contextIsolation` and `sandbox` are enabled, `nodeIntegration` is disabled, a strict CSP is
  applied, and DevTools are disabled in production builds.

### Distribution

- Release binaries are **not code-signed**. Verify downloads against `SHA256SUMS.txt`.

## Response

The maintainer will acknowledge reports and assess impact as soon as possible. Please avoid
publishing details until a fix is released.