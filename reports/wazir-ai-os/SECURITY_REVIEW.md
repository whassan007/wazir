# Security Review — Wazir AI OS v0.4.2+

- **Tauri CSP**: Tightened to `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:4800 http://127.0.0.1:4801 http://localhost:4800 http://localhost:4801; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`.
- **Consent & Telemetry**: `set_consent_state` writes `~/.wazir/consent.json` (`0600`) and purges `~/.wazir/diagnostics-queue.jsonl` on decline.
- **Nautilus & GNOME**: Local-first privacy; no automatic file uploads.
- **Status**: `VERIFIED_OPERATIONAL`.
