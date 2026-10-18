# Wazir Release Notes - v0.2.10

**Release**: `v0.2.10`
**Theme**: P0 Execution Reliability, Dead-PID SQLite Lock Recovery, Sub-2s Local Model Turnaround, and Phase Telemetry

`v0.2.10` resolves P0 execution reliability and latency bottlenecks across the CLI, SQLite store, LM Studio adapter, and native coding agent, cutting median local task turnaround from `>20s` timeouts to `2.14s` (`10/10` benchmark pass rate).

## Highlights

- **Immediate Dead-PID SQLite Lock Recovery**: Automatically reclaims `wazir.sqlite.write.lock` when the foreign lock holder PID is no longer alive (`ESRCH`), eliminating 10-second cascading lock timeouts after `SIGTERM`/`SIGKILL` interruptions.
- **Sub-1.3s Local Model Startup & Reuse**: Uses cached HTTP `/api/v0/models` readiness checks for resident LM Studio models instead of spawning redundant `lms ls`, `lms ps`, and `lms load --estimate-only` CLI subprocesses on every task.
- **Single-Turn Non-Mutating Task Execution**: Accurately classifies queries, inline JSON/text returns, and standalone code snippets as `mutationRequired: false`, skipping unnecessary multi-turn planning and repo-wide verification checks when zero files are modified.
- **Enhanced CLI & Chat Observability**: Adds `--model` and `--routing-mode` flags to `wa chat`/`wa fleet` and emits structured `dispatch` and `first_token` NDJSON events in `wa run --json`.

---

# Wazir Release Notes - v0.2.9

**Release**: `v0.2.9`
**Theme**: Chat UI Discoverability, Input Responsiveness, Live Token Streaming, and Execution Resilience

`v0.2.9` upgrades the `wa chat` conversation experience with a discoverable welcome screen, accurate horizontal cursor tracking, real-time execution feedback and incremental token streaming, discoverable slash commands (`/clear`, `/status`, `/help`), and hardened concurrent task execution logging.

## Highlights

- **Discoverable Welcome Screen**: Displays loaded model counts, connected computer status, example coding prompts, active routing configuration, and command shortcuts upon launching `wa chat`.
- **Real-Time Execution Feedback & Streaming**: Immediately acknowledges submitted requests (`✓ Request received`, `◌ Planning & scheduling job...`), surfaces model/computer routing (`◌ Model: ... · Computer: ...`), and streams generated tokens live in conversation mode.
- **Responsive Input & Slash Commands**: Accurate horizontal cursor positioning across single-line and multiline prompts, plus `/clear`, `/status`, expanded `/help`, and unknown slash command validation.
- **Concurrent Execution Resilience**: Prevents lock-contended store writes from crashing concurrent `wa run` tasks and accurately classifies failed tool operations in conversation summaries.

---

# Wazir Release Notes - v0.2.8

**Release**: `v0.2.8`
**Theme**: Persistent, Verified Automatic Updates

`v0.2.8` adds an opt-in five-minute update service with per-user platform scheduling, verified official release artifacts, safe staging and rollback paths, persistent history, and CLI/TUI management. Update paths that lack a safe installation adapter continue to request the package manager or operator.

## Highlights

- **Automatic Updates**: Manage the native scheduler and update lifecycle with `wa update status|check|now|enable|disable|history|rollback|config`.
- **Safe Activation**: Verify release checksums before staging, defer activation while local Wazir sessions run, and validate or roll back supported npm and standalone installations.
- **Recovery and Diagnostics**: Persist update journals, retry backoff, and update history under `WAZIR_HOME`.

---

# Wazir Release Notes - v0.2.7

**Release**: `v0.2.7`
**Theme**: Policy-Governed NVIDIA Native Provider, Modern Mission Control TUI, and Shared Resource Quota Hardening

`v0.2.7` delivers a first-class, policy-governed NVIDIA hosted execution provider (`nvidia/nemotron-3.5-super-vl-120b-a12b`), the modernized Wazir Mission Control terminal interface for `wa fleet` (preserving inline Codex-style chat in `wa chat`), shared resource quota routing hardening, and distributed worker lease fencing.

## Highlights

- **Policy-Governed NVIDIA Hosted Provider (`@wazir/runtimes-nvidia`, `@wazir/core`, `@wazir/cli`)**:
  - Native support for `nvidia/nemotron-3.5-super-vl-120b-a12b` on `https://integrate.api.nvidia.com/v1` via `NVIDIA_API_KEY` or `wa auth login nvidia`.
  - Multimodal vision input (`image_url`), structured JSON schema output (`response_format`), SSE streaming, cancellation, and tool-call execution.
  - Strict local-first policy enforcement (`LOCAL_ONLY`, `LOCAL_FIRST`, `CLOUD_ALLOWED`, `HOSTED_PREFERRED`, `PROVIDER_PINNED`) that never falls back to hosted cloud inference without explicit policy permission, and explainable placement decisions that clearly separate NVIDIA API Catalog cloud execution from local DGX Spark worker execution.
  - Honest cost accounting (`ACTUAL`, `ESTIMATED`, `UNKNOWN`) in the SQLite resource ledger and `wa resources`.
- **Modern Mission Control TUI (`@wazir/cli`)**:
  - 6-state model readiness classification in `wa fleet` (`LOCAL · GPU LOADED`, `LOCAL · UNLOADED`, `HOSTED · READY`, `HOSTED · UNAVAILABLE`, `PROVIDER-ONLY ROUTING`, `AVAILABILITY UNKNOWN`) so hosted NVIDIA models are ready without requiring local GPU residency.
  - Execution inspector with explicit separation of model completion claims from deterministic verification evidence (`MODEL CLAIM != EXECUTION EVIDENCE`), interactive `/filter <query>`, and responsive narrow/wide terminal layouts while keeping `wa chat` in inline Codex-style conversation mode.
- **Shared Quota Routing & Lease Fencing (`@wazir/core`, `@wazir/api`)**:
  - Shared quota group accounting and routing in `BudgetManager` and `ResourceRouter`, plus stale lease fencing and retry deduplication in `@wazir/api`.

## Validation

Verified across the NVIDIA adapter, NVIDIA provider system, Mission Control TUI, fleet TUI, resource ledger/router, and durable dispatch test suites, plus `npm run build`, `npm run check-dist`, `npm run package:check`, and `npm run release:verify`.

---

# Wazir Release Notes - v0.2.5

**Release**: `v0.2.5`
**Theme**: Conversation Shell Visibility, NVIDIA API Catalog Provider, and Durable Execution API

`v0.2.5` restores durable shell command output and visible operational/missing-model errors in `wa chat` conversation mode, adds first-class support for the NVIDIA API Catalog execution provider (`@wazir/runtimes-nvidia`), and unifies durable execution history and cancellation endpoints in `@wazir/api`.

## Highlights

- **Visible Inline Shell Execution in `wa chat`**: `!command` and `/sh command` submissions are recorded in the durable conversation transcript along with stdout, stderr, exit codes, duration, and block references—without invoking an LLM or losing output on redraw.
- **Interactive Operational Status & Missing-Model Recovery**: Interactive TTY conversation frames now surface live operational statuses (`Command running`, `Command completed`, `Model unavailable`, `Provider disconnected`, `Scheduler rejected task`, `Waiting for approval`, `Execution failed`, `Tool execution failed`) and durable, actionable recovery guidance when no eligible model is registered.
- **NVIDIA API Catalog Execution Provider (`@wazir/runtimes-nvidia`)**: First-class hosted/self-hosted NVIDIA NIM & API Catalog adapter with SSE token streaming, tool-call normalization, curated model discovery (`moonshotai/kimi-k2-instruct`, `deepseek-ai/deepseek-v3.1`, `qwen/qwen3-coder-480b-a35b-instruct`, `nvidia/llama-3.3-nemotron-super-49b-v1.5`, `meta/llama-3.3-70b-instruct`), `wa auth login nvidia`, and `wa providers list|inspect|test`.
- **Unified Durable Execution API (`@wazir/api`)**: Consolidated SQLite-backed execution records across `POST /api/executions`, `GET /api/executions`, `GET /api/executions/:id`, and `POST /api/executions/:id/cancel`.

## Validation

Verified across the TUI conversation projection, PTY session-exit, fleet TUI, NVIDIA runtime adapter, provider system, auth status, hosted provider failure, and durable execution API test suites, plus `npm run build`, `npm run typecheck`, `npm run check-dist`, `npm run package:check`, `npm run release:verify`, and `npm run release:gate`.

---

# Wazir Release Notes - v0.2.4

**Release**: `v0.2.4`
**Theme**: Conversation-first terminal experience

`wa chat` now opens Wazir's focused, conversation-first coding interface by default. The Mission Control fleet dashboard remains available as `wa fleet` or `wa chat --dashboard`, and `/fleet` and `/chat` switch views during an interactive session.

## Highlights

- **Conversation-first chat** with a persistent prompt, readable task summaries, streamed events, and execution status.
- **Keyboard controls** for quick actions, task history, model selection, shell mode, clipboard, and dashboard navigation.
- **Mission Control remains available** with current jobs, agents, providers, approvals, activity, and verification evidence.
- **Terminal integrity** across narrow and wide layouts, resize, paste, cancellation, and clean exit.
- **Rendered PTY evidence** in [`docs/verification/mission-control`](verification/mission-control/README.md), including before and after screenshots.

## Validation

Verified with the TUI, terminal integrity, PTY session-exit, conversation projection, and paste-barrier suites; `npm run build`, `npm run typecheck`, `npm run check-dist`, `npm run package:check`, `npm run release:verify`, and `npm run release:gate`.

---

# Wazir Release Notes - v0.2.3

**Release**: `v0.2.3`
**Theme**: Wazir Mission Control terminal interface

`wa chat` and `wa fleet` now open a cohesive Mission Control experience. It surfaces current jobs, model/provider readiness, approvals, activity and verification evidence, with the official terminal logo and responsive narrow-terminal layout. Existing task cycling, inline shell mode, job detail and approval interactions remain available. The new task and model views use recorded Wazir state and show unknown values honestly.

Before/after PTY screenshots and validation evidence are in [`docs/verification/mission-control`](verification/mission-control/README.md).

## Highlights

- **Mission Control landing view** with the Wazir logo, workspace navigation, real-time job status, agent and provider availability, token usage, approval queue, activity and verification evidence.
- **Keyboard-first model management**: browse registered models and pin routing from the model view.
- **Responsive terminal layouts** with compact presentation and readable status at narrow widths.
- **Evidence-backed status**: removed the home and task panes' fabricated fleet, model, verification and cost values.
- **Release verification**: captured actual terminal output in wide and narrow PTYs, including before/after screens and keyboard interactions.

## v0.2.2

**Release**: `v0.2.2`
**Theme**: Mandatory Git Synchronization, Verification, and Commit Authorization Policy & Multi-Surface Companion Completion

This release enforces Wazir's mandatory Git Synchronization, Verification, and Commit Authorization policy in code across all self-improvement workflows and completes remaining Desktop/CLI, iOS, and Android companion features.

## Highlights

- **Mandatory Git Preflight & 8-Boundary Checkpoint Revalidation**: `runGitPreflight` and `revalidateGitCheckpoint` inspect repository state before planning, worktree creation, applying changes, agent mutation, final verification, approval requests, staging/commit, and supervisor restart recovery.
- **Explicit Commit Authorization Modes (`MANUAL_COMMIT` default, `AUTO_COMMIT`, `NO_COMMIT`)**: `resolveEffectiveCommitPolicy` validates provenance (`user_explicit`, `cli_flag`, `scoped_config`), repository/task/worktree scope, and expiration while `resolvePermissionMatrix` separates code execution, local commit, push, merge, and deployment permissions.
- **Durable Manual Commit Approval Workflow & CLI**: `wa improve preflight`, `wa improve approvals`, and `wa improve approve <attemptId> --action <COMMIT|REVISE|KEEP_UNCOMMITTED|DISCARD|CANCEL>` manage candidate revisions bound to verified diff hashes, with pre-commit secret scanning (`scanCandidateForSecrets`), intended-file-only staging (`WorktreeManager.commitWorktree`), and Git hooks enabled.
- **Desktop/CLI, iOS, and Android Feature Completion**: Full `wa canary` CLI command suite, real SSE token streaming in `LMStudioAdapter.streamTask`, and native QR pairing, task submission, approval filtering, batch low-risk approval, and `wazir://pair` deep links across iOS and Android.

## Validation

Verified across `@wazir/core`, `@wazir/evaluation`, and `@wazir/cli` (`gitSynchronizationPolicy.test.ts`, `selfImprovementSupervisor.test.ts`, `improveSupervisorE2E.test.ts`, `worktreeManager.test.ts`, `executeTask.e2e.test.ts`), `swift test`, and `./gradlew testDebugUnitTest assembleDebug`.

---

# Wazir Release Notes - v0.2.1

**Release**: `v0.2.1`
**Theme**: Evaluation Qualification Fail-Closed Defaults, Benchmark Deadline Isolation, Dynamic Phase Routing, and Static Path Containment

This release hardens Wazir's autonomous self-improvement engine, benchmark runner isolation, and web static file serving in response to the October 16, 2026 repository review (`F1`–`F5`).

## Highlights

- **Fail-Closed Verification & Empty-Suite Guards (`F2`)**: `RegressionGuard.evaluate` no longer defaults `candidateVerificationPassed` to `true` when omitted; every candidate run must carry explicit `physicalVerificationSuccess === true` (`MISSING_VERIFICATION_EVIDENCE`), and empty suites fail closed (`EMPTY_BENCHMARK_SUITE`).
- **Duplicate Promotion Fencing (`F3`)**: `OptimizerStateManager.promote` prevents promoting an already-promoted `candidateId` or `runId` (`OPTIMIZER_CANDIDATE_ALREADY_PROMOTED`) in addition to atomic `baselineRevision` fencing.
- **Canonical Static Path Containment (`F4`)**: `apps/web/server.js` enforces canonical `fs.realpath` + `path.relative` containment and regular-file checks, blocking sibling-prefix and symlink path traversal.
- **Dynamic Phase Model Resolution (`F5`)**: `MetaOptimizerService.resolveModelForPhase` queries `Scheduler` and `ModelRegistry` to select eligible models and emit explainable fallback reasons when configured preferred models (`gemma-27b`, `qwen-2.5-coder`, `gpt-4o`) are missing, unloaded, or ineligible.
- **Hard Benchmark Deadlines & Fixture Isolation**: `BenchmarkService.runTask` copies `customContext.workspaceRoot` into an isolated temp directory and races `runner.run(...)` against a hard timeout timer (`BENCHMARK_DEADLINE_EXCEEDED`) even when a runner ignores `abortSignal`.
- **Native Continuous Self-Improvement Supervisor & DGX Spark 4-Phase Qualification**:
  - Full CLI lifecycle (`wa improve start|run|status|history|stop|rollback|doctor|service`) backed by `SelfImprovementSupervisor`, singleton lock protection, candidate worktree fingerprint tamper rejection (`CANDIDATE_WORKTREE_TAMPERED`), and phase-receipt verification (`scripts/self-improvement-builder.sh`).
  - Protocol adapter tool aliasing and fail-closed `UNSUPPORTED_TOOL_SURFACE` circuit breaking in `CodingAgent`, qualified with live local LLM execution on DGX Spark (`docs/self-improvement-recovery.md`).

## Validation

Verified with `npm run build && npm run typecheck && npm run check-dist && npm run package:check -- --skip-build && npm run release:verify` and evaluation/CLI self-improvement E2E suites.

---

# Wazir Release Notes - v0.2.0

**Release**: `v0.2.0`
**Theme**: Unified Applications, Multi-LLM Optimization, Evaluation Integrity, and Controlled Self-Improvement

This release delivers the Wazir v0.2 architecture and quality roadmap (`docs/roadmap-v0.2.md`) alongside the October 2026 security and reliability remediation across Desktop, Web, Mobile, Scheduler, Resource Router, Evaluation, and Meta-Optimizer subsystems.

## Highlights

- **Unified Control Plane Across Desktop, Web, and Mobile (Workstream A)**:
  - Loopback-first web proxy (`apps/web/server.js`) and CLI dashboard (`apps/cli/src/dashboardServer.ts`) with `HttpOnly; SameSite=Strict` session cookies, CSRF and `Origin` enforcement, viewer/operator privilege separation, and short-lived SSE tickets.
  - Native Tauri desktop shell (`apps/desktop`) with OS keychain integration and background worker survival when the window closes.
  - Native iOS (`apps/ios/WazirMobile`) and Android (`apps/android`) companions with QR pairing, biometric approval gates, stale approval expiration, immutable `eventId` SSE deduplication (`MobileEventHub`), and idempotent multi-surface task cancellation (`cancelTask`).
- **Expected Cost per Verified Success & KV-Cache Placement (Workstream B)**:
  - `ResourceRouter` evaluates `effectiveCostPerSuccessUsd` (incorporating empirical verified success rate and retry probability), enforces `minVerifiedSuccessRate` ($Q_{\min}$) and `maxLatencyMs` ($L_{\max}$), and accounts for cold-start load latency (`estimatedLoadMs`) and model eviction (`evictionRequired`).
  - `Scheduler` estimates incremental KV-cache VRAM demand and active `ResourceReservation` `vramBytes`, rejecting GPU placement before dispatch when usable VRAM fits model weights but cannot fit the KV cache for the required context window.
- **Evaluation Integrity & Statistical Qualification (Workstream C)**:
  - `readBenchmarkMetric` and `extractMetricValueSafe` preserve metric provenance (`measured`, `estimated`, `unavailable`) and never substitute `0` for missing data.
  - `EvaluationService` and `RegressionGuard` reject protected benchmark fixture edits (`PROTECTED_FIXTURE_MODIFIED`) and benchmark context contamination (`BENCHMARK_CONTAMINATED`), enforce `minSampleCount >= 5` with Bonferroni-corrected exact paired sign tests (`pairedEvidence.ts`), and report per-category pass rates (`categoryBreakdown` / `CATEGORY_REGRESSION`).
- **Controlled Self-Improvement & Atomic Recovery (Workstream D)**:
  - `OptimizerStateManager` persists atomic versioned snapshots at `meta_optimizer/state/v1` with durable per-sample reservations and accounting receipts.
  - `RegressionGuard` detects model-scoped divergence (`scopedModels` / `MODEL_SCOPED_REGRESSION`) to block global promotion when a candidate improves one model while harming another.
  - `MetaOptimizerService` derives baseline models dynamically from `routingRules` and enforces atomic baseline version checks (`OPTIMIZER_BASELINE_CHANGED`), canary deployment, and automatic rollback.

## Validation

Verified across all 23 workspace packages (`npm run build && npm run typecheck && npm run check-dist`), standalone CLI bundle (`bin/wa.js`), native Tauri desktop build, and 275 automated test suites including `packages/evaluation/tests/roadmapV02.test.ts`, `metricIntegrity.test.ts`, `statisticalQualification.test.ts`, `optimizerRecovery.test.ts`, and `apps/api/tests/mobileApi.test.ts`.

---

# Wazir Release Notes - v0.1.66

**Release**: `v0.1.66`
**Theme**: Verified integration for parallel coding agents and cross-platform package validation

This release adds traceable integration manifests and conflict planning for parallel agent branches. Candidate changes are combined in a disposable worktree and qualified together before promotion, with a durable journal for safe recovery. It also fixes Windows package validation for archives under drive-letter paths.

## Validation

Release verification and platform CI results are recorded with the published release assets after the v0.1.66 workflows complete.

---

# Wazir Release Notes - v0.1.64

**Release**: `v0.1.64`
**Theme**: Complete npm distribution package, cross-platform CI gating, and macOS/Windows parity

This release merges the npm distribution packaging and verification pipeline (PR #9) with the `v0.1.63` distributed PostgreSQL and worker fault-qualification baseline, resolves all 14 macOS and Windows test and sandbox parity issues, and enables full cross-OS CI gating across Linux, macOS, and Windows.

---

# Wazir Release Notes - v0.1.63

**Release**: `v0.1.63`
**Theme**: PostgreSQL integration and production worker fault qualification

This release adds real PostgreSQL and production-process verification, with explicit
limits on distributed recovery guarantees. It includes the security and reliability
changes documented below for the previously unpublished v0.1.61 candidate.

Inherited security changes enforce operator/viewer authorization on Agent Protocol
and MCP mutations, route protocol tools through shared policy enforcement, persist
worker credentials before returning them, and require evidence for successful
completion. Provider stream resets have bounded retries and terminal worker result
posts are recorded once.

## Added and verified

- Mandatory Ubuntu PostgreSQL 16 CI integration in `postgres-distributed.yml`,
  using a disposable dedicated database. Missing configuration or an unreachable
  database fails the job. Tests refuse database names outside `wazir_*_test`.
- `npm run test:postgres`, `npm run test:distributed`, and dedicated test typechecks.
- Production API and two independent worker processes exercise registration,
  authentication, heartbeat, SSE dispatch, claims, SIGKILL, durable controller restart,
  and same-computer recovery. Retained evidence includes PID logs, exit signals,
  task IDs, lease attempts/deadlines, responses, and final outcomes.
- Authenticated stale results are rejected with HTTP 409 `LEASE_LOST` after expiry
  and replacement. Competing claims select one winner; duplicate result submissions
  preserve the first authoritative outcome, including acknowledgment loss/restart.
- Expired-renewal/claim races, surviving-worker reconnect, tasks running beyond the
  original lease deadline, and observable mutation-before-acknowledgment replay.

## Distributed safety limits

The production API does not automatically sweep missing workers or mark abandoned
expired dispatches failed/orphaned. A different computer cannot take over a dispatch;
recovery requires a replacement worker with the original computer identity.

Lease fencing protects result authority, **not exactly-once external execution**.
A crash after mutation but before acknowledgment can replay an opaque provider
request. The live test observes two effects without external idempotency and one
with it, in both cases with two executions and one authoritative result.
Known-tool `UNKNOWN_OUTCOME` unit handling remains covered, but is not automatic
physical reconciliation for opaque API dispatch. Distributed cancellation has no
public API, so its completion race is not qualified.

## Validation

Local Linux ARM64: build and repository/test typechecks passed; PostgreSQL 16.15
integration passed 20 tests; the complete distributed suite passed 17 tests.
Strengthened reconnect and beyond-original-deadline scenarios also passed.
The broad regression run passed 2,210 tests and found seven missing-native-PTY
failures; rebuilding `node-pty` resolved them and all eight affected tests passed
on rerun. Ordinary CI dependency installation builds the native module.

**CI verification:** [Release workflow](https://github.com/whassan007/wazir/actions/runs/38561969821)
passed all quality gates (2,217 tests passed; 44 intentional skips) and built all
six native targets. [PostgreSQL/distributed workflow](https://github.com/whassan007/wazir/actions/runs/38561969750)
passed 20 real PostgreSQL tests, 17 distributed tests, and 2,217 regression tests
(27 intentional skips). All eight release assets matched `SHA256SUMS.txt`; the
Linux ARM64 standalone binary reported `0.1.63`. Native manifests contain the
verified artifact hashes on `release/v0.1.63`.

Full report and reproduction: `tests/distributed/evidence-report.md` and
`tests/distributed/README.md`; actual traces: `tests/distributed/evidence/`.
No universal distributed-safety or exactly-once claim is made.

---

# Wazir Release Notes - v0.1.61

**Release**: `v0.1.61`  
**Theme**: Protocol Authorization, Unified Policy-Enforced Execution, and Evidence-Based Completion

A security and reliability release. Network clients of the Agent Protocol and MCP endpoints can
no longer act beyond their credential, every tool they reach runs through the same policy path as
coding agents, and a task is reported successful only when there is evidence for it.

## Security

- **Protocol authorization.** Viewer tokens are read-only on `/ap/v1` and `/mcp`. Creating
  tasks, executing steps, creating artifacts, `tools/call`, unknown JSON-RPC methods and batches
  containing them need operator scope (HTTP 403, JSON-RPC `-32001`). Caller identity comes only
  from the credential, never from the request body.
- **One policy-enforced tool path.** MCP and Agent Protocol tool calls now go through scope
  checks, a fixed protocol tool surface, schema validation, PolicyEngine with human approval
  (`ask` is denied when no approver is configured), test-file protection, workspace snapshots,
  timeout, cancellation on client disconnect, and a durable audit record written before dispatch.
  The direct `tool.execute()` fallback is removed.
- **Worker credentials** are persisted before they are returned; revocation and unreadable
  credential stores fail closed.

## Truthful completion

- A failed, denied, cancelled or timed-out tool fails its step and the parent task, whatever
  `is_last` says. Text-only steps are recorded as `RECORDED`, not as executed work.
- Verification runs the project's checks through the same tool path. PASS needs at least one
  check actually run, all passing, bound to the step, with a workspace revision hash.
  `wazir://verification/status` no longer reports `verified: true` without that evidence.
- Finished tasks reject late or duplicate steps (409); steps are serialized per task.

## Reliability

- Tool receipts fingerprint the tool name and input (previously every call hashed the same) and
  never cache failed attempts; duplicate worker result posts are recorded once.
- Model streams cut by a transport reset are re-requested (up to 2 times).
- Checkpoint boundary validation, provider fault tests, a recovery-process test and a reliability
  benchmark workflow.

**Verification:** locally on Linux ARM64 — build, typecheck, `npm test`, `test:agent`,
`test:plan:acceptance` (80/80) and `release:gate` pass; 35 black-box protocol security tests.


---

# Wazir Release Notes - v0.1.59

**Release**: `v0.1.59`  
**Theme**: Heterogeneous Fleet Execution, Durable Recovery, and Production Cross-Platform Release Validation

---

## Highlights

### 1. Heterogeneous Fleet Execution Across 6 Platform Pairs
- Validated distributed controller-to-worker dispatch and streaming execution across all cross-platform permutations:
  - macOS controller -> Linux worker (including ARM64 DGX Spark)
  - Windows controller -> Linux worker
  - Linux controller -> Windows worker
  - macOS controller -> Windows worker
  - Windows controller -> macOS worker
  - Linux controller -> macOS worker
- Full token-authenticated SSE streaming, remote cancellation, and outcome collection.

### 2. Linux ARM64 NVIDIA DGX Spark Support
- Hardware discovery engine hardened for ARM64 Cortex-X925/A725 CPUs without traditional `/proc/cpuinfo` `model name` fields using `lscpu`.
- Deep integration for the NVIDIA GB10 Blackwell GPU with Address Translation Services (ATS), GPU Chip-to-Chip (C2C) interconnect, and 122 GB host-GPU unified memory.

### 3. Resource-Aware Heterogeneous Scheduling
- OS platform and CPU architecture affinity (+1.5 OS match, +1.0 architecture match).
- CUDA accelerator routing (+2.0 for NVIDIA CUDA capability match, +0.5 for unified memory).
- Hard rejection of incompatible workloads (preventing CUDA tasks from routing to non-CUDA machines or macOS tasks to Windows machines).

### 4. Durable Recovery and Split-Brain Fencing
- WAL-backed durable task dispatch and claim leases with unique cryptographically random tokens.
- Fencing of stale / expired leases (`LEASE_LOST`), preventing stale result commitments; external effects require idempotency or reconciliation.
- RecoveryManager provides orphan handling for known executions; the production API dispatcher still requires integration for automatic abandoned-task reconciliation.

### 5. Automated Release Validation Gate
- `scripts/release-gate.mjs` provides strict validation across all 8 capability categories: Installation, Build, CLI, Agents, Persistence, TUI, Fleet, and Recovery.
- Multi-platform matrix reporting with strict no-false-PASS semantics.

---

## Upgrade Instructions

### Linux / macOS
```bash
npm install -g wazir@0.1.59
# Or download native standalone binary
curl -LO https://github.com/whassan007/wazir/releases/download/v0.1.59/wazir-v0.1.59-linux-arm64.tar.gz
```

### Windows
```powershell
npm install -g wazir@0.1.59
# Or download native wa.exe
Invoke-WebRequest https://github.com/whassan007/wazir/releases/download/v0.1.59/wazir-v0.1.59-windows-x64.zip -OutFile wazir.zip
```
