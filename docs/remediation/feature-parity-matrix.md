# Wazir Release Feature Parity Matrix

Comparison across `v0.2.10` (`71b409c`), `v0.2.11` (`56ad6ee`, PR #16), `origin/fix/comprehensive-live-reliability` (`b8e0e40`, PR #15), `v0.2.12` (`2846834`, `main`), and target `remediation/v0.2.13`.

| Subsystem / Capability | `v0.2.10` (`71b409c`) | `v0.2.11` (`56ad6ee` / PR #16) | PR #15 (`b8e0e40`) | `v0.2.12` (`2846834` / `main`) | `remediation/v0.2.13` Target |
|---|---|---|---|---|---|
| **Autonomous 5-Minute Updater (`apps/cli/src/updater/*`, `wa update`)** | Present (`1d1ce13`) | Missing | Missing | **Missing (Regression)** | **Restored & Hardened (Phase 1 & 4)** with controller/job activity awareness & rollback |
| **Decoupled CLI Build (`scripts/build-cli.mjs`, `npm run build:cli`)** | Missing (on `9f70a61`) | Missing | Missing | **Missing** | **Restored (Phase 1)** |
| **Release Integrity & Cross-Platform Gate (`scripts/release-integrity.mjs`)** | Missing | Missing | Partial (`live-reliability-gate.mjs`) | **Missing (on `87d4a34`)** | **Integrated (Phase 1)** |
| **Linux Desktop / Tauri CI Prerequisites (`libwebkit2gtk-4.1-dev`)** | Missing in `ci.yml` | Missing in `ci.yml` | Missing in `ci.yml` | **Missing in `ci.yml` / `reliability.yml`** | **Integrated across CI workflows (Phase 1)** |
| **Debian / RPM / Homebrew / Scoop Version & Node `>=22.13.0` Parity** | Partial (`>=22.5.0`) | Partial (`0.2.5`) | Partial (`0.2.5`) | **Partial (`>=22.5.0`, Homebrew/Scoop `0.2.5`)** | **Full Parity & Automated Gate (Phase 1)** |
| **NVIDIA Hosted Provider (`packages/runtimes/nvidia`)** | Present | Missing | Present | **Present** | **Retained + Terminal Stream & Signal Hardening (Phase 2)** |
| **Mission Control TUI (`apps/cli/src/tui/fleetTui.ts`)** | Present (`f1c26f3`) | Legacy + fixes | Hardened slash commands | **Present (Reconciled)** | **Retained + Governed Inline Shell & Modularized (Phase 4 & 6)** |
| **Tier 0 Deterministic Fast-Path (`packages/agents/src/fastPath.ts` / `codingAgent.ts`)** | Present | Present | Present | **Present (`a774e2e`)** | **Retained + Expected-File & Mutation Guardrails (Phase 2)** |
| **Tier 1 Conversational Fast-Path (`ChatAgent`, `isConversationalFastPathRequest`)** | Present | Present | Present | **Present** | **Retained + Mutation/Artifact/EOF Guardrails (Phase 2)** |
| **Authoritative `wa task status <id>`** | Stub (`queued`) | Stub (`queued`) | Stub (`queued`) | **Stub (`queued`)** | **Authoritative Durable Lookup + `--json` (Phase 2)** |
| **Immediate CLI Token Streaming & Cancellation Propagation** | Partial | Partial | Partial | **Partial (`streamJson: false` in `commands.ts`)** | **Full Live Streaming & Signal Propagation (Phase 2)** |
| **Durable Job & Standalone Execution Startup Recovery** | Inverted `!this.store` | Inverted `!this.store` | Partial | **Inverted `!this.store` bug** | **Fixed + Unknown-Outcome Mutating Tool Guard (Phase 3)** |
| **Distributed Lease Fencing & Worker Result Persistence** | Partial (`0d1c61f`) | Partial | Partial | **Split Lease / Malformed `recordExecution`** | **Unified Monotonic Fencing & Idempotent Finalization (Phase 3)** |
| **Resource Reservation Release on Pre-Output Failure** | Charges conservative | Charges conservative | Charges conservative | **Charges conservative / leaks on load error** | **Releases Reservation Cleanly (Phase 3)** |
| **Mobile API Protocol Negotiation & Dynamic Controller Version** | Hardcoded `0.1.63` | Hardcoded `0.1.63` | Hardcoded `0.1.63` | **Hardcoded `0.1.63` & `compatible: true`** | **Dynamic `wazirVersion()` & Semver Negotiation (Phase 4)** |
| **Fail-Closed Sandbox Isolation & `code_mode` Governance** | Warn-only fallback | Warn-only fallback | Inner `code_mode` auth | **Silent `effectiveIsolation` bypass** | **Enforced Isolation Compliance & `MUTATING` `code_mode` (Phase 4)** |
| **Fast Startup (`createEngine` Single-Pass History & Single Discovery)** | Slow | Slow | Slow | **Partial (`a774e2e`, still 2x discovery)** | **Optimized Single-Pass & Lazy CLI Discovery (Phase 5)** |
