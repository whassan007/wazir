# Wazir v0.2.13

## Overview

**Wazir `v0.2.13`** is a production reliability, security, and performance release completing the 8-phase autonomous remediation (`ISS-001`–`ISS-020`) and 12-agent independent release qualification (`RR-001`, `RR-003`). It hardens 3-tier task routing and provider stream completion across all six runtime adapters, enforces pre-mutation worker lease fencing and crash-safe startup reconciliation, locks down sandbox isolation and `code_mode` VM boundaries, restores the durable CLI auto-updater, and cuts warm engine startup latency by **79.4%**.

**Verification:** `359 passed | 8 skipped (367)` test files (`2,740 passed | 52 skipped` default tests + `7/7` opt-in `WAZIR_DISTRIBUTED=1` tests = `2,747` passing tests, `0` failures), `10/10` live E2E acceptance checks, `15/15` package verification checks, and `0` production `npm audit` vulnerabilities.

---

## Major Improvements

### 1. Execution Correctness & Provider Stream Integrity
- **Mutation-Aware Fast-Path Guardrails**: `isConversationalFastPathRequest` now inspects `mutationRequired`, `expectedArtifacts`, `expectedFiles`, explicit file paths, and mutation verbs before routing, preventing question-phrased coding tasks from taking the tool-free conversational path.
- **Strict Stream Completion Markers**: NVIDIA (`[DONE]` / `finish_reason`), LM Studio, Ollama (`done: true`), OpenAI, Anthropic (`message_stop`), and Google (`finishReason`) adapters now require explicit protocol termination and reject malformed stream JSON chunks or partial timeout output.
- **Truthful Independent Evaluation**: `evaluateExecution` receives `mutationRequired` and no longer allows later passing checks (`hasCurrentPassingChecks`) to mask unresolved failed shell commands. Fabricated benchmark and evaluation fallback scores have been removed.
- **Authoritative CLI Task State & Streaming**: `wa task status <id>` queries live `engine.executions` and `engine.orchestrator` records (`exit 0` when found, `exit 1` when missing), `wa run` streams incremental tokens (`execution.token`) without 500-character JSON result truncation, and `AbortSignal` cancels in-flight remote and subagent runs.

### 2. Durable Recovery & Distributed Lease Fencing
- **Terminal State Immutability**: Jobs and executions in `completed`, `failed`, or `cancelled` states are immutable; `ExecutionEngine.orphan()`, `pause()`, and `resume()` enforce transition guards, and CLI retries transition cleanly via `queued` before `running`.
- **Crash-Safe Startup Reconciliation**: Fixed `JobManager.load()` store hydration, enforced `findUnknownOutcomeToolCall` checks (`UNKNOWN_MUTATION_OUTCOME`) before resetting expired `running` tasks, and expanded `reconcileLocalOutcomes` to recover interrupted standalone `running`/`verifying` executions.
- **Pre-Mutation Worker Lease Fencing**: `ExecutionEngine` validates `assertLease()` before mutating in-memory state or emitting events, and `@wazir/api` updates canonical `execution/${executionId}` records in place with `leaseEpoch` fencing.
- **Accurate Quota & Reservation Release**: Pre-output provider failures settle token budgets with `ambiguous: false` (no false quota charge), and `ModelLifecycleService` releases `ResourceReservation` when both `loadModel()` and `inspectModel()` fail.

### 3. Security Isolation, Mobile Compatibility & Auto-Updater
- **End-to-End Sandbox Policy Enforcement**: Propagated `effectiveIsolation` (`sandboxStatus().mode`) across all `policy.authorize()` call sites (`run.ts`, `fleetRunner.ts`, `toolExecution.ts`, `fleetTui.ts`), enforced fail-closed `requiredIsolation`, and disabled automatic approval of workspace artifact execution when sandbox isolation is `'none'`.
- **CodeMode VM Lockdown**: Reclassified `code_mode` as `NON_IDEMPOTENT_WRITE` / `MUTATING` / `exclusive` and locked down VM realm prototype chains in `CodeModeService` without mutating host globals.
- **Durable Auto-Updater (`wa update`)**: Restored the CLI updater (`check`, `apply`, `rollback`, `status`, `channel`) with SHA-256 checksum validation, atomic staging, and active-work draining across durable `execution/*`, `job/*`, and `dispatch/*` store records in addition to OS process checks.
- **Mobile Handshake & Credential Hygiene**: `/api/v1/mobile/handshake` dynamically reports the root package version and negotiates semver/protocol compatibility, expired device credentials can no longer be rotated, and advertise URLs preserve HTTP/HTTPS scheme fidelity.

### 4. Fast Startup & Maintainability
- **Engine Startup Optimization**: Replaced global regex JSON revivers in `JsonFileStore` with native `JSON.parse` + lazy `reviveDatesInPlace` (**2.24×** faster on a 9.65 MB store), made `JobManager`/`CheckpointService`/`HandoffService` loads lazy on `fastStartup`, skipped terminal records during fast startup, and memoized CPU/PATH/runtime discovery:
  - Warm 9.65 MB disk-store `createEngine({ fastStartup: true })`: **`430.52 ms → 88.83 ms` (`-79.4%`)**
  - Cold 9.65 MB disk-store `createEngine({ fastStartup: true })`: **`256.56 ms → 186.61 ms` (`-27.3%`)**
  - 84-model `ResourceRouter.assess()` batch routing: **`48.20 ms → 2.38 ms` (`-95.1%`)**
- **Modularization & TUI Truthfulness**: Split `fleetTui.ts`, `commands.ts`, and `mobile.ts` into focused submodules with 100% barrel re-export compatibility, and removed fabricated TUI fallback strings.

---

## Fixed Issues (`ISS-001`–`ISS-020`, `RR-001`, `RR-003`)

| ID | Priority | Summary |
|---|---|---|
| **`ISS-001`** | P0 | Restored orphaned `v0.2.8`–`v0.2.10` CLI auto-updater (`apps/cli/src/updater/*`) and standalone CLI bundler (`scripts/build-cli.mjs`) reconciled with Mission Control TUI. |
| **`ISS-002`** | P0 | Added Linux WebKitGTK/AppIndicator/librsvg/patchelf Tauri build dependencies in `.github/workflows/ci.yml` and aligned `.github/workflows/reliability.yml` path triggers (`test/reliability/**`, `tests/reliability/**`). |
| **`ISS-003`** | P0 | Pinned `.github/workflows/release.yml` checkouts to `ref: ${{ github.sha }}`, gated release publishing on `scripts/release-integrity.mjs`, and derived `draft` status dynamically. |
| **`ISS-004`** | P0 | Unified Node.js floor to `>= 22.13.0` (`node:sqlite`) across DEB, RPM, Homebrew, and `wa doctor`; fixed DEB/RPM systemd `ExecStart` paths; synchronized Homebrew, Scoop, and WinGet manifests. |
| **`ISS-005`** | P0 | Unified SPDX license to `AGPL-3.0-only` and synchronized versions across all 26 `package.json` files, `Dockerfile`, and packaging manifests (`tests/release/packageParity.test.ts`). |
| **`ISS-006`** | P0 | Fixed `isConversationalFastPathRequest` to inspect `mutationRequired`, `expectedArtifacts`, `expectedFiles`, file paths, and mutation verbs before taking the chat fast path; propagated fields through `planTask`, `executeTask`, and `runSubagent`. |
| **`ISS-007`** | P0 | Enforced explicit terminal completion markers across NVIDIA, LM Studio, Ollama, OpenAI, Anthropic, and Google adapters; rejected malformed stream JSON chunks and partial timeout output. |
| **`ISS-008`** | P0 | Passed `mutationRequired` into `evaluateExecution`, removed `hasCurrentPassingChecks` masking of unresolved failed shell commands, and eliminated fabricated benchmark/evaluation fallbacks. |
| **`ISS-009`** | P0 | Persisted terminal `failed` execution records when preflight, `planTask`, `planTaskResume`, or `activateExecution` fails so tasks never remain stuck in `queued`. |
| **`ISS-010`** | P0 | Replaced the hardcoded `Task <id>: queued` placeholder in `wa task status <id>` with authoritative lookups against `engine.executions` and `engine.orchestrator`. |
| **`ISS-011`** | P0 | Enabled incremental token streaming (`execution.token`) on `wa run`, removed 500-char JSON output truncation in `commands.ts`, and propagated `AbortSignal` across remote and subagent execution. |
| **`ISS-012`** | P1 | Enforced terminal job immutability (`completed: []`, `failed: []`, `cancelled: []`), added `canTransitionExecution` guards to `orphan()`, `pause()`, and `resume()`, and routed CLI retry via `queued`. |
| **`ISS-013`** | P1 | Fixed inverted `!this.store` check in `JobManager.load()`, enforced `findUnknownOutcomeToolCall` before resetting expired `running` tasks, and expanded `reconcileLocalOutcomes` startup recovery. |
| **`ISS-014`** | P1 | Moved `assertLease()` before any in-memory state/event mutation in `ExecutionEngine` and updated canonical `execution/${executionId}` API records in place with `leaseEpoch` fencing. |
| **`ISS-015`** | P1 | Settled pre-output provider failures with `budget.fail(requestId, { ambiguous: false })` and released `ResourceReservation` when both `loadModel()` and `inspectModel()` fail. |
| **`ISS-016`** | P1 | Replaced hardcoded `0.1.63` mobile `CONTROLLER_VERSION` with dynamic root `package.json` version, added semver/protocol negotiation on `/api/v1/mobile/handshake`, blocked expired credential rotation, and preserved scheme fidelity. |
| **`ISS-017`** | P1 | Extended `UpdateService` and `UpdateScheduler` to inspect durable `execution/*`, `job/*`, and `dispatch/*` store records and drain active work (`drainAndApply`) before applying updates. |
| **`ISS-018`** | P1 | Propagated `effectiveIsolation` across all `policy.authorize()` call sites, enforced fail-closed `requiredIsolation`, disabled unsandboxed artifact auto-allow, and hardened `CodeModeService` VM realm prototypes. |
| **`ISS-019`** | P2 | Optimized `JsonFileStore` date revival (`2.24×`), deferred non-critical store hydration on `fastStartup`, skipped terminal records, and memoized CPU/PATH/runtime discovery (`-79.4%` warm startup latency). |
| **`ISS-020`** | P2 | Modularized `fleetTui.ts`, `commands.ts`, and `mobile.ts` into cohesive submodules with full barrel re-exports and removed fabricated TUI fallback strings. |
| **`RR-001`** | P1 | Upgraded `@modelcontextprotocol/server` (`^2.3.0`), `@modelcontextprotocol/client` (`^2.3.1`), removed `ts-node-dev`, and pinned security overrides (`shell-quote`, `hono`, `source-map-js`, `esbuild`, `tinypool`, `vite`) for `0` production `npm audit` vulnerabilities. |
| **`RR-003`** | P2 | Fixed `scripts/build-dmg.sh` to read `VERSION` dynamically from `package.json` instead of hardcoded `0.1.0` and inject it into macOS `Info.plist`. |

---

## Upgrade Notes

- **Node.js `>= 22.13.0` Required**: All distribution channels (npm, standalone tarball, DEB, RPM, Homebrew) and `wa doctor` now uniformly enforce Node.js `>= 22.13.0` for built-in `node:sqlite` stability (`ISS-004`).
- **Fail-Closed Sandbox & Artifact Execution Policy**: When running on a host without OS sandboxing (`sandboxStatus().mode === 'none'`), `allowWorkspaceArtifactExecution` no longer auto-approves workspace binary/script execution, and policies specifying `requiredIsolation` fail closed if the host cannot satisfy the requested isolation level (`ISS-018`).
- **`code_mode` Approval & Exclusivity**: `code_mode` is now classified as `NON_IDEMPOTENT_WRITE` / `MUTATING` / `exclusive` and goes through standard mutation authorization rather than read-only auto-allow (`ISS-018`).
- **Mobile Companion Handshake & Credentials**: Mobile clients connecting to `/api/v1/mobile/handshake` are validated against semver compatibility ranges (`>=0.1.60`), and expired mobile device credentials must be re-paired rather than rotated in place (`ISS-016`).
- **Systemd Service Units (DEB/RPM)**: After upgrading the `.deb` or `.rpm` package, run `sudo systemctl daemon-reload && sudo systemctl restart wazir` to pick up the updated `ExecStart` unit definitions (`ISS-004`).

---

## Known Limitations

- **Dev-Only Transitive Audit Advisories**: Production dependencies have **`0` vulnerabilities** (`npm audit --omit=dev`). Three low/moderate advisories remain in dev-only test tooling (`@vitest/coverage-v8` / `vitest` transitive dependencies) and do not ship in `bin/wa.js`, npm packages, or native installers (`RR-001`).
- **Distributed Lease Fencing vs. External Idempotency**: Worker lease fencing (`leaseEpoch`) guarantees single authoritative result persistence and blocks stale worker mutations (`StaleWorkerLeaseError`), but cannot undo external side effects if a worker crashes mid-flight while executing a non-idempotent mutating tool; such tasks are quarantined as `UNKNOWN_MUTATION_OUTCOME` for operator review rather than automatically retried (`ISS-013`, `ISS-014`).
- **Platform Sandbox Availability**: macOS uses `sandbox-exec` (Seatbelt) and Linux uses `bwrap` (bubblewrap) + seccomp when unprivileged user namespaces are enabled. Hosts without unprivileged user namespaces report `sandbox: none` in `wa doctor` and enforce stricter interactive approval gates (`ISS-018`).
