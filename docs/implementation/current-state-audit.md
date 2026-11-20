# Wazir AI OS — Current State Repository & Infrastructure Audit

**Audit Date:** 2026-11-20  
**Baseline Branch / Commit:** `fix/p0-reliability-recovery` @ `998d44b` (v0.3.2), integration branch `feat/wazir-ai-os-launch`  
**Local Host:** `WaelMacPro.local` (Apple M5 Pro, 18 cores, 24 GB unified memory, macOS Darwin 27.0.0 arm64)

---

## 1. Verified Infrastructure & Hardware Inventory

| Machine ID | Hostname / Endpoint | OS & Arch | CPU / GPU / RAM | Runtimes & Tools | Status |
|---|---|---|---|---|---|
| `local` | `WaelMacPro.local` | macOS Darwin 27.0.0 (`arm64`) | Apple M5 Pro (18 cores, 24 GB UMA) | `ollama` (`:11434`), `mlx_lm.server` (`:8080`, `Qwen3.5-9B-6bit`), `lmstudio` (`:1234`), `node`, `npm`, `pnpm`, `cargo`, `rustc`, `python3`, `docker`, `gh`, `xcode`, `Android Studio` | **Online** |
| `dgx_spark` | `waelbot` (`100.113.62.112`) | Ubuntu 24.04 (`aarch64`, Linux 7.0.0-1024-nvidia) | NVIDIA GB10 Grace Blackwell (20 cores, 121 GiB RAM / 128 GB UMA) | `ollama` (`:11434`, `qwen3-coder:30b`, `qwen3.6:35b-a3b-q8_0`, `qwen3.8:27b`, `qwen2.5vl:72b`, `gemma4:26b`), `node`, `npm`, `docker` | **Online (SSH verified)** |
| `mac_studio` | `studio` (`100.76.30.71`) | macOS (`arm64`) | Apple M4 Max (14 cores, 36 GB) | Configured in `~/.wazir/config.json` | **Offline (SSH timed out)** |
| `rtx_win` | `laptop-rtx-win` (`100.84.209.95`) | Windows (`x64`) | RTX GPU | Configured in `~/.wazir/config.json` | **Unverified / Offline** |

### Public Web Hosting Status
- `https://cable.wael.bot`: `HTTP/2 200` (Cloudflare edge).
- `https://wazir.wael.bot`: `HTTP/2 502` (Cloudflare DNS/edge active, origin not serving).

---

## 2. Subsystem Audit & Reuse / Repair / Build Matrix

| Subsystem | Location | Current State | Decision | Action Required |
|---|---|---|---|---|
| **Wazir Core & Orchestration** | `packages/core/src/services/`, `packages/scheduler/`, `packages/policies/`, `packages/models/` | Working: `JobOrchestrator`, `ComputerRegistry`, `ModelLifecycleService`, `Scheduler`, `PolicyEngine`, `VerificationEngine`, `CheckpointService`, `ExecutionRecovery`. | **Reuse & Extend** | Integrate `engineProfiles.ts` (from `wazir-os-macification`), add canonical job-state & diagnostics ingestion routes. |
| **Native Coding Agent** | `packages/agents/src/qwenCore/*`, `packages/agents/src/acp/*` | Working: Selective TypeScript port of Qwen Code (`wazirQwenAgent.ts`, `coreToolScheduler.ts`, `loopDetectionService.ts`, `proportionalVerify.ts`). | **Reuse** | Keep as primary coding agent; fix `wazirMcpServer.ts` stdout pollution causing `wazir_ask` JSON parse error. |
| **CLI (`wa`)** | `apps/cli/src/` | Working: `wa exec`, `wa chat`, `wa fleet`, `wa doctor`, `wa dashboard`, TUI (`apps/cli/src/tui/`), bundled into `bin/wa.js`. Missing: `wa shell`, `wa about`, `wa license`. | **Extend** | Add `wa shell` (PTY-backed universal shell with `!`/`?`/auto classification), `wa about`, `wa license`, and first-launch consent check. |
| **Wazir Shell (Desktop GUI)** | *Missing* (`.worktrees/wazir-os-ubuntu` has `packages/ubuntu-os/src/hybridShell.ts`, `shellClassifier.ts`) | No dedicated native graphical terminal app (`Wazir Shell.app` / Linux desktop app). | **Build** | Build Tauri 2 + `portable-pty` + `xterm.js` **Wazir Shell** app with native tabs, menus, `.icns`/`.desktop`, universal command bar, Mission Control deep-link, and first-launch disclosure. |
| **Wazir Mission Control** | `apps/desktop/`, `apps/web/public/index.html`, `apps/web/public/goal-studio/` | `Wazir Desktop` (Tauri 2) wraps `apps/web/public`. Has fleet table, Goal Studio graph, approvals polling, keychain token sync. Missing: full 10-state execution graph, machine drill-down, replay, About/License dialog, separate `Wazir Mission Control` branding. | **Repair & Upgrade** | Upgrade UI with interactive fleet drill-down, 10-state execution graph (`User Request -> Planner -> Model Router -> Worker -> Tool Execution -> Verification -> Result`), job actions, replay, and Mission Control branding/packaging. |
| **Wazir Workers & API** | `apps/api/src/`, `apps/worker/src/` | Working: Express/HTTP+SSE API (`:4800`), worker registration, heartbeat, lease fencing, protocol routes, mobile routes. | **Reuse & Extend** | Add `/api/v1/diagnostics/*` ingestion, deduplication, redaction, and `/api/v1/public/demo-fleet` sanitized endpoint. |
| **Wazir Mobile (GrapheneOS / Android)** | `apps/android/` | Full Jetpack Compose app (`ai.wazir.mobile`) with Pairing, Dashboard, Tasks, CreateTask, Operations, SecurityLayer, SSE stream, mDNS, Room DB. | **Verify & Package** | Verify Gradle build & unit tests, confirm zero-root GrapheneOS permissions, add Termux ARM64 CLI integration & docs. |
| **Wazir Diagnostics & Privacy** | `packages/observability/src/index.ts` | Only a 73-line in-memory logger/metrics stub. No consent gate, redaction pipeline, crash fingerprinting, or ingestion API. | **Build** | Build `@wazir/observability` diagnostics client/queue/redactor, first-launch acceptance gate, API ingestion + Qwen triage workflow, and adversarial leakage tests. |
| **Wazir Portal (`wazir.wael.bot`)** | `apps/web/public/`, `apps/web/server.js` | `apps/web/public/index.html` is the internal operator dashboard, not a public product website. | **Build & Deploy** | Build public portal (`apps/web/public/portal/` or root public routes separated from authenticated `/dashboard`), interactive component explorer, sanitized fleet demo, downloads, 8-step onboarding, docs, licensing, and deploy to `wazir.wael.bot`. |
| **Licensing & Attribution** | `LICENSE` (AGPL-3.0-only) | Sole repo owner (`whassan007`) + `Wazir Hardening Suite`; selective Apache-2.0 Qwen Code port. Missing `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, third-party notices, commercial license workflow. | **Audit & Build** | Create `docs/legal/licensing-audit.md`, `NOTICE`, `AUTHORS`, `CONTRIBUTORS`, `THIRD_PARTY_LICENSES.md`, preserve AGPL-3.0 on existing code, document PolyForm Noncommercial 1.0.0 candidate for new wholly-owned modules. |
| **Packaging & Installers** | `scripts/build-dmg.sh`, `build-deb.mjs`, `build-rpm.mjs`, `Formula/wazir.rb` | CLI `.deb`/`.rpm`/`.dmg`/Homebrew exist. Missing: `Wazir Shell.app`, `Wazir Mission Control.app`, Linux `.desktop` + AppImage, SBOM, release manifest. | **Extend & Verify** | Build macOS `.app`/`.dmg`, Linux `.deb`/`.rpm`/AppImage/CLI, SHA-256 manifest, and SBOM. |

---

## 3. Baseline Build & Test Verification

- `npm run typecheck`: **PASS** (`tsc --build --force` exited 0).
- `npm run build`: **PASS** (compiled all TypeScript workspaces, `wazir-desktop` Rust Tauri binary, and `bin/wa.js` CLI bundle).
- `npx vitest run test/packaging/packageManagers.test.ts`: **PASS** (11/11 tests).
- `npx vitest run apps/web/tests/goalStudioUi.test.ts`: 18/19 passed (1 loopback `fetch` test blocked by sandbox `EPERM 127.0.0.1` — requires unsandboxed run for network/loopback integration tests).
