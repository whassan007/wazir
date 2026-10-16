# Wazir Desktop

A Tauri 2 native shell around the existing Wazir control plane. It does not
implement a second orchestration engine: the window simply loads the same
dashboard served by `@wazir/web`, which talks to `@wazir/api` exactly as it
does in a browser.

## Status: dev scaffold only

What works:

- `npm run desktop:dev` from the repo root (or `npm run dev` here) builds the
  Rust shell, starts `@wazir/api` + `@wazir/web` (via `start:dashboard`), and
  opens a native window pointed at the dashboard.
- Native menu: Reload, Open in Browser, View Logs, Quit/About.
- App icon generated from `assets/brand/logo.jpeg`.

What is **not** implemented yet (tracked, not forgotten):

- Packaging/installers for Windows, Linux, or macOS (`tauri build` bundling,
  code signing, notarization, CI workflows).
- Mode B (remote host connection) — reusing the Android app's mobile pairing
  protocol (`apps/api/src/mobile.ts`, `POST /api/v1/mobile/pair/request`) is
  the planned path, not yet wired into this shell.
- Mode C (bundling a managed runtime inside the installer).
- OS keychain-backed credential storage (currently the shell relies on the
  same server-side `WAZIR_API_TOKEN` handling `@wazir/web/server.js` already
  does; no desktop-specific secret storage exists yet).
- Auto-update.

## Prerequisites

- Rust toolchain (`cargo`, `rustc`) — not required by any other part of this
  repo, only by this package. Install via `brew install rust` or rustup.
- Everything `@wazir/api` and `@wazir/web` already require (Node 22+).

## Development

```bash
npm run desktop:dev     # from repo root
```

This builds `@wazir/api`/`@wazir/web` dist output if missing, starts both
servers, and opens the desktop window against `http://127.0.0.1:4801`.

## Why reuse `apps/web/public` instead of a new frontend

`apps/web/public/index.html` is already the complete dashboard UI and already
proxies `/api/*` + `/health` to `@wazir/api`, injecting the operator bearer
token server-side so it never reaches the webview. Building a second frontend
would duplicate that logic for no benefit — this shell just points a native
window at it instead of a browser tab, mirroring (and intended to eventually
replace) the AppleScript-driven launcher in `scripts/build-dmg.sh`.
