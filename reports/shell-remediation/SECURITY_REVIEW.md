# Security Review — Wazir Shell

- **Content Security Policy (`apps/shell/src-tauri/tauri.conf.json`)**: Tightened to `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:4800 http://127.0.0.1:4801 http://localhost:4800 http://localhost:4801; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. Removed `'unsafe-inline'` from `script-src` by moving all JS to external `apps/shell/ui/app.js`.
- **Capabilities (`apps/shell/src-tauri/capabilities/default.json`)**: Minimal `core:default` and `opener:default` permissions on `main` window only.
- **Consent & Telemetry**: `set_consent_state` writes `~/.wazir/consent.json` with `0600` permissions and deletes `~/.wazir/diagnostics-queue.jsonl` when declined.
- **PTY & Process Isolation**: `MAX_PTY_SESSIONS = 32` enforced; `pty_close` kills and reaps child processes.
