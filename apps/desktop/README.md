# Wazir Desktop

A Tauri 2 native shell around the existing Wazir control plane. It does not
implement a second orchestration engine: the window simply loads the same
dashboard served by `@wazir/web`, which talks to `@wazir/api` exactly as it
does in a browser.

## Capabilities

What works:

- `npm run desktop:dev` from the repo root (or `npm run dev` here) builds the
  Rust shell, ensures `@wazir/api` (port 4800) and `@wazir/web` (port 4801) are
  running with a shared operator credential, and opens a native window once both
  ports are ready.
- **OS Keychain & Credential Sync:** Synchronizes the local operator bearer
  token between `~/.wazir/local-operator.token` (`0600`) and the OS keychain
  (macOS `security` Keychain / Linux `secret-tool`) so `@wazir/api`,
  `@wazir/web`, and `wazir-desktop` always share a deterministic credential.
- **Multi-Host & SSH Config Integration:** Native **Control** menu items for
  **Pair or Switch Remote Host…** (`CmdOrCtrl+Shift+H`), **Import SSH Hosts
  (`~/.ssh/config`)**, and **Switch to Local Host**, bridged via
  `window.__WAZIR_SURFACE__`.
- **Autonomy & Scheduler Shortcuts:** Native menu actions to switch Autonomy
  postures (`read-only`, `request-review`, `auto-sandbox`) and jump directly to
  **Scheduled Tasks (`@wazir/scheduler`)** (`CmdOrCtrl+Shift+S`).
- **Background Approval Notifications:** Polls pending tool approvals over
  loopback and dispatches native OS notifications (macOS, Linux, Windows) plus
  `wazir://approval-pending` events.
- **App Icons & Bundling:** Multi-platform bundle icons (`icns`, `ico`, `png`)
  and `targets: "all"` configured in `src-tauri/tauri.conf.json`.

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
