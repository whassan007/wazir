# Wazir Product × Platform × Architecture Qualification Matrix (v0.4.1)

- **Source Revision:** `79a39e6` (`feat/coordination-fabric` + hardening & qualification fixes)
- **Generated:** 2026-11-25

| Product | Platform | Arch | Distribution | Status | Evidence / Notes |
|---|---|---|---|---|---|
| `apps/cli` (`wa`, `wazir`) | macOS | `arm64` | npm tarball, Homebrew, SEA binary | **PASS** | `npm run build`, `npm run typecheck`, `npm run check-dist`, `npm run package:check`, `npm run release:verify`, `npm run release:gate` |
| `apps/cli` (`wa`, `wazir`) | macOS | `x64` | npm tarball, Homebrew, SEA binary | **NOT_RUN** (local) / CI | Covered by `ci.yml` / `release.yml` (`macos-15-intel`) |
| `apps/cli` (`wa`, `wazir`) | Linux (Ubuntu/Debian/RHEL) | `x64` | npm, `.deb`, `.rpm`, SEA binary | **NOT_RUN** (local) / CI | Covered by `ci.yml` / `release.yml` (`ubuntu-latest`) |
| `apps/cli` (`wa`, `wazir`) | Linux (DGX Spark GB10) | `arm64` | `.deb`, source, SEA binary | **PASS** (fleet) / **NOT_RUN** (local) | `dgx_spark:ollama` healthy at `100.113.62.112:11434`; `ubuntu-24.04-arm` in `release.yml` |
| `apps/cli` (`wa`, `wazir`) | Linux (Jetson Thor) | `arm64` | Source / CLI | **BLOCKED** | Host `100.83.18.14` unreachable (`EPERM` in sandbox) |
| `apps/cli` (`wa`, `wazir`) | Windows 11 | `x64` | `install.ps1`, Scoop, WinGet, SEA | **NOT_RUN** (local) / CI | Covered by `ci.yml` / `release.yml` (`windows-latest`) |
| `apps/cli` (`wa`, `wazir`) | Windows 11 | `arm64` | `install.ps1`, Scoop, WinGet, SEA | **EXPERIMENTAL** | `windows-11-arm` in `release.yml`; `win32-arm64` marked `experimental` in `release-gate.mjs` |
| `apps/cli` (`wa`, `wazir`) | Android / Termux | `arm64` | `scripts/install-termux.sh` | **NOT_RUN** | No physical Termux device attached |
| `apps/shell` | macOS | `arm64` | Tauri 2 `.app` / `.tar.gz` | **PASS** (Rust tests) | `cargo test --manifest-path apps/shell/src-tauri/Cargo.toml`; strict CSP & PTY child cleanup |
| `apps/desktop` | macOS | `arm64` | Tauri 2 `.app` / `.tar.gz` | **PASS** (Rust tests) | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`; strict CSP & `build` fail-closed |
| `apps/web` | macOS / Linux / Windows | `any` | Node HTTP server (`server.js`) | **PASS** | Security headers added; loopback/origin trust boundary enforced |
| `apps/api` | macOS / Linux / Windows | `any` | Node HTTP/SSE control plane | **PASS** | Auth, diagnostics, public, and mobile routes |
| `apps/worker` & `packages/workers` | macOS / Linux / Windows | `any` | Node daemon / systemd / launchd | **PASS** | Lease-fenced SSE task pull |
| `apps/android` | Android / GrapheneOS | `arm64` | APK (`ai.wazir.mobile`) | **BLOCKED** (sandbox) | Gradle wrapper cache `Operation not permitted` in sandbox |
| `apps/ios/WazirMobile` | iOS 16+ | `arm64` | Xcode (`ai.wazir.mobile`) | **BLOCKED** (sandbox) | `CoreSimulatorService` connection invalid in sandbox |
| `apps/mobile` | Android / iOS | `any` | Archived Expo scaffold | **UNSUPPORTED (SUPERSEDED)** | Documented in `apps/mobile/README.md`; superseded by `apps/android` and `apps/ios/WazirMobile` |
| `apps/portal` | Cloudflare Pages | `any` | Static site + `_headers` | **PASS** | Validated in headless Chromium (`test/portal-browser-qa.py`) across 4 viewports |
