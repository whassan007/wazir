# Changelog

## v0.2.14 — 2026-10-22

**Release**: `v0.2.14`
**Theme**: Goal Studio autonomous execution platform, preflight model resource eligibility, cost-aware routing, and accurate model readiness reporting

- **Goal Studio Autonomous Execution Platform (`@wazir/goals`, `@wazir/core`, `@wazir/api`, `@wazir/cli`, `@wazir/web`)**:
  - Added Goal Studio DAG data model (`GoalNode`, `GoalEdge`, `GoalGraph`, `GoalRun`), continuous goal controller with cycle-detection and verification gates, autonomous recovery & repair, Prompt Studio, and Execution Control Center.
  - Integrated `wa goals` (`create`, `list`, `show`, `run`, `status`, `pause`, `resume`, `cancel`, `results`, `ui`), interactive TUI Goal Studio view (`/goals`), Web UI Goal Studio canvas & inspector, REST lifecycle endpoints (`/api/v1/goals/*`), and the reusable Nobel Goal Graph example (`examples/nobel-goal-graph/`).
- **Preflight Model Resource Eligibility & Cost-Aware Routing (`@wazir/core`)**:
  - Integrated computer placement and resource assessment (`Scheduler.assessPlacements()`) directly into Phase 1 model selection (`routeModel`) so models whose memory requirements exceed available host RAM/VRAM (e.g., a 22 GB model on a host with 0.1 GB available memory) are rejected before model selection rather than failing after routing.
  - Added cost- and footprint-aware scoring in `Scheduler.scoreModel()` to prefer already-loaded or smaller eligible models on routine tasks over cold-loading 20+ GB local models, while strictly preserving explicit model pins, `allowFallback=false`, and `provider_only` / `local_only` constraints.
  - Updated `ModelLifecycleService.assessModelSync()` to evaluate estimated model memory against host available/total RAM and classify `SAFE`, `WARNING`, or `INSUFFICIENT`.
- **Accurate Model Status Reporting & Chat Recovery (`@wazir/core`, `@wazir/cli`)**:
  - Extended `ModelReadiness` with `registeredCount`, `availableCount`, `localLoadedCount`, and `hostedAvailableCount` so cloud-hosted catalog models are reported as `available` (`AVAILABLE (HOSTED)`) and never misreported as locally loaded in memory.
  - Replaced misleading `85 model(s) loaded` startup messages across `wa chat`, `FleetTui`, `wa status`, `wa doctor`, `wa models list`, and `wa models loaded` with accurate `registered`, `available`, and `locally loaded` counts, plus actionable scheduling failure recovery and `!<cmd>` / `/sh <cmd>` direct shell execution guidance.

## v0.2.13 — 2026-10-22

**Release**: `v0.2.13`
**Theme**: Autonomous multi-agent remediation, execution & distributed recovery hardening, security isolation, and fast-startup optimization

- **Execution Correctness & Stream Integrity (`@wazir/agents`, `@wazir/core`, `@wazir/evaluation`, `@wazir/cli`, `@wazir/runtimes-*`)**:
  - Guarded the conversational fast path (`isConversationalFastPathRequest`) against question-phrased coding or mutation prompts by evaluating `mutationRequired`, `expectedArtifacts`, `expectedFiles`, file paths, and mutation verbs prior to routing (`ISS-006`).
  - Enforced explicit terminal completion markers across NVIDIA (`[DONE]` / `finish_reason`), LM Studio, Ollama (`done: true`), OpenAI, Anthropic (`message_stop`), and Google (`finishReason`) adapters, rejecting malformed JSON chunks and truncated timeout streams (`ISS-007`).
  - Removed the `hasCurrentPassingChecks` override in `evaluateExecution` so unresolved failed shell commands cannot be masked by later passing checks, and removed fabricated benchmark/evaluation fallback metrics (`ISS-008`).
  - Persisted terminal `failed` execution records when preflight, `planTask`, `planTaskResume`, or `activateExecution` fails (`ISS-009`), wired `wa task status <id>` to authoritative `engine.executions` / `engine.orchestrator` state (`ISS-010`), enabled incremental token streaming (`execution.token`) on `wa run`, removed 500-character JSON output truncation, and propagated `AbortSignal` across remote and subagent execution (`ISS-011`).
- **Durable Recovery, Lease Fencing & Quota Accounting (`@wazir/core`, `@wazir/api`)**:
  - Enforced terminal job immutability (`completed`, `failed`, `cancelled`) and `canTransitionExecution` guards across `orphan()`, `pause()`, `resume()`, and CLI retry (`ISS-012`).
  - Fixed `JobManager.load()` store hydration, required `findUnknownOutcomeToolCall` checks before resetting expired `running` tasks (`UNKNOWN_MUTATION_OUTCOME`), and expanded `reconcileLocalOutcomes` to recover interrupted standalone `running`/`verifying` executions on startup (`ISS-013`).
  - Moved worker `assertLease()` ahead of all in-memory state/event mutations and fenced canonical `execution/${executionId}` updates in `@wazir/api` by `leaseEpoch` (`ISS-014`).
  - Released token budget reservations with `ambiguous: false` when provider generation fails before emitting output, and released `ResourceReservation` when both `loadModel()` and `inspectModel()` fail (`ISS-015`).
- **Security Isolation, Mobile Handshake & Auto-Updater (`@wazir/core`, `@wazir/tools`, `@wazir/api`, `@wazir/cli`)**:
  - Propagated `effectiveIsolation` (`sandboxStatus().mode`) across all `policy.authorize()` call sites, enforced fail-closed `requiredIsolation`, disabled `allowWorkspaceArtifactExecution` auto-approval when unsandboxed (`none`), reclassified `code_mode` as `NON_IDEMPOTENT_WRITE` / `MUTATING` / `exclusive`, and locked down VM realm prototype chains without mutating host globals (`ISS-018`).
  - Restored the `wa update` subsystem (`apps/cli/src/updater/*`, `scripts/build-cli.mjs`) with SHA-256 verification, atomic staging, rollback, and durable active-work draining across `execution/*`, `job/*`, and `dispatch/*` records (`ISS-001`, `ISS-017`).
  - Added real semver range and protocol compatibility negotiation on `/api/v1/mobile/handshake`, blocked rotation of expired mobile credentials, and preserved HTTP/HTTPS scheme fidelity (`ISS-016`).
- **Startup Performance, TUI Truthfulness & Release Packaging (`@wazir/core`, `@wazir/cli`, `@wazir/api`, `packaging/`, `scripts/`)**:
  - Accelerated warm 9.65 MB disk-store `createEngine({ fastStartup: true })` startup by **79.4%** (`430.52 ms → 88.83 ms`) and store deserialization by **2.24×** via lazy date revival, lazy store hydration, terminal-record skipping, and memoized CPU/PATH/runtime discovery (`ISS-019`).
  - Modularized `fleetTui.ts`, `commands.ts`, and `mobile.ts` with 100% barrel re-export compatibility and removed fabricated TUI fallback strings (`ISS-020`).
  - Unified all 26 workspace `package.json` versions, `AGPL-3.0-only` licensing, Node.js `>=22.13.0` floor, exact-SHA CI/release workflows, DEB/RPM systemd units, Homebrew/Scoop/WinGet manifests, dynamic `scripts/build-dmg.sh` versioning, and zero production `npm audit` vulnerabilities (`ISS-002`–`ISS-005`, `RR-001`, `RR-003`).

## v0.2.12 — 2026-10-21

**Release**: `v0.2.12`
**Theme**: Canonical NVIDIA provider, Mission Control TUI, 3-tier execution optimization, and fleet routing guardrails

- **NVIDIA Hosted Provider (`@wazir/runtimes-nvidia`, `@wazir/cli`, `@wazir/core`)**:
  - Canonical OpenAI-compatible NVIDIA API Catalog provider (`https://integrate.api.nvidia.com/v1`) with 84-model discovery, streaming `delta.reasoning_content` separation, tool calling, HTTP 400 unsupported-parameter retry stripping, HTTP 429 `Retry-After` backoff, secret redaction (`nvapi-*` and `Bearer`), and explicit `HOSTED_API_INFERENCE` vs `LOCAL_GPU_INFERENCE` placement explainability.
- **Mission Control TUI (`@wazir/cli`)**:
  - Consolidated interactive Mission Control interface (`missionControl.ts`, `conversationProjection.ts`, `conversationRenderer.ts`) with responsive `narrow`/`standard`/`wide` terminal layouts, bracketed paste barrier, live telemetry, and diff-preview approval queue while preserving all CLI commands and non-interactive execution.
- **3-Tier Execution Architecture & Performance (`@wazir/core`, `@wazir/agents`, `@wazir/tools`, `@wazir/cli`)**:
  - Unified Tier 0 (`classifyDeterministicCommand`), Tier 1 (`isConversationalTask` -> `ChatAgent`), and Tier 2 (`CodingAgent`) execution pipeline.
  - Optimized `ResourceRouter.assess()` with batch ledger caching (**68.8× faster** `planTask`), skipped redundant workspace snapshots on read-only deterministic commands (**2.75× faster** on disk, **32.9× faster** in-memory), hoisted `fs.realpath(root)` in `snapshotWorkspace()`, and added workspace-scoped verification (`--full-verify`) and git-HEAD integrity guard (`repoIntegrityGuard.ts`).
- **Fleet Subagent Routing Guardrails (`@wazir/agents`, `@wazir/core`)**:
  - Enforced parent `provider_only` confinement, `PolicyEngine.checkHostedEligibility()`, `ResourceRouter.assess()` quota admission, and model capability verification on every delegated subagent task (`Guardrail 3`).
- **Dependency Security**:
  - Upgraded `@modelcontextprotocol/client` (`1.29.0`) and `shell-quote` (`1.8.4`) to resolve all production `npm audit` advisories (`0 vulnerabilities`).

## v0.2.11 — 2026-10-19

**Release**: `v0.2.11`
**Theme**: Deterministic fast path, earlier failure stops, and availability-checked model dispatch

- **Agent execution (`@wazir/agents`, `@wazir/core`)**:
  - Deterministic fast path for read-only commands (`ls`, `pwd`, `git status`, `git diff`, `git log`) that answers without a model round-trip. The classifier no longer blocks on ambiguous verbs alone, and explicit tool directives that name network commands (`curl`, `nslookup`, `openssl`) route to the full coding agent.
  - A second identical tool-validation failure now stops the run immediately with `IDENTICAL_VALIDATION_FAILURE`, instead of repeating the same call until the turn budget is spent.
  - Failed tool operations are classified correctly, and lock-contended execution writes no longer crash the task.
- **Model dispatch (`@wazir/cli`, `@wazir/core`)**: a model must be confirmed installed in its runtime before a load or inference is dispatched. The routed model and runtime are shown in Mission Control.
- **Mobile and dispatch (`@wazir/api`, `apps/mobile`)**: mobile app scaffold, dispatch cancellation and recovery, and migration of the test directory layout.
- **Execution latency (`@wazir/cli`)**: cold-start, store, and conversational fast-path latency reduced for `wa run`.
- **Release gates (`@wazir/cli`, `test/`)**: 6-category execution integrity suites, TUI usability coverage, and LIVE-CODE-01..08 release-gate suites.

## v0.2.5 — 2026-10-17

**Release**: `v0.2.5`
**Theme**: Conversation Shell Visibility, NVIDIA API Catalog Provider, and Durable Execution API

- **Conversation Shell Execution & Error Visibility (`@wazir/cli`)**:
  - Appended inline shell commands (`!cmd`, `/sh cmd`) and their durable stdout/stderr, exit codes, execution duration, and block references directly into the conversation transcript without invoking an LLM.
  - Added operational status visibility (`Command running`, `Command completed`, `Execution failed`, `Model unavailable`, `Provider disconnected`, `Scheduler rejected task`, `Waiting for approval`) to interactive TTY conversation frames.
  - Added explicit missing-model recovery explanations and actionable recovery commands directly in the conversation transcript while keeping shell execution usable without an AI provider.
  - Hardened terminal stdin EOF and error handling to prevent unexpected returns to the parent shell.
- **NVIDIA API Catalog Execution Provider (`@wazir/runtimes-nvidia`, `@wazir/cli`, `@wazir/core`)**:
  - Added `@wazir/runtimes-nvidia` runtime adapter supporting NVIDIA API Catalog (`https://integrate.api.nvidia.com/v1`), OpenAI-compatible chat completions, SSE streaming, tool calling, and curated catalog discovery.
  - Added `wa providers` CLI commands (`list`, `inspect`, `test`), `wa auth login nvidia`, and hosted provider routing and failure diagnostics across Mission Control and `wa doctor`.
- **Durable Execution History & Endpoints (`@wazir/api`)**:
  - Unified durable execution history (`GET /api/executions`, `GET /api/executions/:id`, `POST /api/executions`, `POST /api/executions/:id/cancel`) with SQLite persistence across API restarts.

## v0.2.4 — 2026-10-17

**Release**: `v0.2.4`
**Theme**: Conversation-first terminal experience

- Restored the Codex-style conversation-first interface as the default for `wa chat`.
- Kept Mission Control available through `wa fleet` and `wa chat --dashboard`, with `/fleet` and `/chat` navigation during a session.
- Added conversation transcript rendering, event summaries, keyboard quick actions, clipboard support, responsive terminal capabilities, and clean terminal restoration.
- Added wide and narrow PTY screenshots and terminal regression coverage.

## v0.2.3 — 2026-10-17

**Release**: `v0.2.3`
**Theme**: Wazir Mission Control terminal interface

- Activated the Mission Control dashboard for `wa chat` and `wa fleet`, with the official Wazir terminal logo, live job and provider state, evidence, approvals, activity, and responsive layouts.
- Added model browsing and pinning, restored-job landing coverage, and honest unknown cost and verification states.
- Preserved inline shell execution, task cycling, job inspection, and existing terminal interactions.
- Added real PTY before/after and narrow/wide screen captures.


## v0.2.2 — 2026-10-16

**Release**: `v0.2.2`
**Theme**: Mandatory Git Synchronization, Verification, and Commit Authorization Policy & Multi-Surface Companion Completion

- **Mandatory Git Synchronization, Verification, and Commit Authorization (`@wazir/evaluation`, `@wazir/core`, `@wazir/cli`)**:
  - Added `runGitPreflight` and `revalidateGitCheckpoint` enforcing Git repository root, branch, HEAD SHA, dirty working-tree preservation, active worktrees, remote tracking, bounded `git fetch --prune origin`, and `REMOTE_UNAVAILABLE` offline policy (`allow` | `block`) across all 8 execution checkpoints.
  - Enforced explicit commit authorization modes (`MANUAL_COMMIT` default, `AUTO_COMMIT`, `NO_COMMIT`) with provenance, scope, and expiration validation (`resolveEffectiveCommitPolicy`) and separated permission matrices (`resolvePermissionMatrix`).
  - Added durable manual approval state machine (`IMPLEMENTING → VERIFYING → READY_FOR_REVIEW → AWAITING_COMMIT_APPROVAL → COMMITTING → COMMITTED`) supporting `COMMIT`, `REVISE`, `KEEP_UNCOMMITTED`, `DISCARD` (confirmation required), and `CANCEL` via `wa improve preflight`, `wa improve approvals`, and `wa improve approve <attemptId>`.
  - Added pre-commit secret scanning (`scanCandidateForSecrets`), isolated intended-file staging with Git hooks enabled (`WorktreeManager.commitWorktree`), and supervisor restart reconciliation (`reconcileCandidateAfterRestart`).
- **Desktop/CLI, iOS, and Android Feature Completion (`@wazir/cli`, `@wazir/runtime-lmstudio`, `apps/ios`, `apps/android`)**:
  - Completed `wa canary` CLI subcommands (`status`, `inspect`, `history`, `compare`, `shadow`, `rollback`, `pause`, `resume`, `advance`, `throttle`) and `LMStudioAdapter.streamTask` real token streaming.
  - Added iOS & Android QR camera scanner sheets, interactive task submission, approval risk filter chips, batch approve-low-risk, and custom `wazir://pair` deep-link handling.

## v0.2.1 — 2026-10-16

**Release**: `v0.2.1`
**Theme**: Evaluation Qualification Fail-Closed Defaults, Benchmark Deadline Isolation, Dynamic Phase Routing, and Static Path Containment

Addresses findings `F1`–`F5` and Section 2 improvements from the October 16, 2026 Wazir Repository Review:

- **F1 & F2 — Fail-Closed Qualification & Verification Evidence (`RegressionGuard`)**:
  - Removed the permissive `candidateVerificationPassed = true` default in `RegressionGuard.evaluate`; omitted verification now requires explicit `physicalVerificationSuccess === true` across all candidate runs (`MISSING_VERIFICATION_EVIDENCE`).
  - Added fail-closed rejection (`EMPTY_BENCHMARK_SUITE`) when baseline or candidate benchmark suites contain zero results.
- **F3 — Duplicate Promotion Fencing (`OptimizerStateManager`)**:
  - Added explicit duplicate-candidate and duplicate-run promotion rejection (`OPTIMIZER_CANDIDATE_ALREADY_PROMOTED`) alongside atomic `baselineRevision` and `configRevision` fencing in `OptimizerStateManager.promote`.
- **F4 — Canonical Static Path Containment (`@wazir/web`)**:
  - Replaced `filePath.startsWith(PUBLIC)` in `apps/web/server.js` with canonical `fs.realpathSync(PUBLIC)`, `decodeURIComponent` + null-byte rejection, `path.relative` boundary verification, symlink target resolution (`fs.realpath`), and regular-file validation (`stats.isFile()`).
- **F5 — Dynamic Phase Model Resolution (`MetaOptimizerService`)**:
  - Added `MetaOptimizerService.resolveModelForPhase(phase, task)` backed by `Scheduler` and `ModelRegistry` to dynamically resolve `plan`, `implement`, and `repair` models with explainable fallbacks when preferred models (`gemma-27b`, `qwen-2.5-coder`, `gpt-4o`) are missing, unloaded, or ineligible.
- **Benchmark Deadline & Workspace Isolation (`BenchmarkService`)**:
  - `BenchmarkService.runTask` now copies `customContext.workspaceRoot` into an isolated temporary directory (`fs.cp`) cleaned up in `finally`, races `runner.run(...)` against a hard timeout timer (`BENCHMARK_DEADLINE_EXCEEDED`) even if the runner ignores `abortSignal`, and rejects empty benchmark suites in `runSuite` and `runBenchmarkSuite`.
- **Native Continuous Self-Improvement Supervisor & DGX Spark Qualification (`SelfImprovementSupervisor`, `@wazir/cli`)**:
  - Added durable self-improvement supervision (`wa improve start|run|status|history|stop|rollback|doctor|service`) with singleton lock protection, atomic state and attempt persistence, candidate worktree fingerprint tamper detection (`CANDIDATE_WORKTREE_TAMPERED`), and systemd user-service management (`scripts/self-improvement-builder.sh`).
  - Repaired native tool-surface circuit breaking (`UNSUPPORTED_TOOL_SURFACE`) and protocol adapter tool-name aliasing (`documentSymbols`, `findReferences`, `code_mode`), qualified end-to-end across all four builder phases on DGX Spark (`docs/self-improvement-recovery.md`).
- **Git Synchronization & Worktree Safety (`GitSynchronizationPolicy`, `WorktreeManager`)**:
  - Enforced protected-branch and clean-worktree synchronization policies alongside iOS/Android companion operation workflows.

## v0.2.0 — 2026-10-16

**Release**: `v0.2.0`
**Theme**: Unified Applications, Multi-LLM Optimization, Evaluation Integrity, and Controlled Self-Improvement

Delivers the Wazir v0.2 roadmap (`docs/roadmap-v0.2.md`) and completes autonomous codebase remediation across all four engineering workstreams:

- **Workstream A — Unified Applications (Desktop, Web, Mobile)**:
  - Hardened `@wazir/web` reverse proxy (`apps/web/server.js`) and CLI dashboard (`apps/cli/src/dashboardServer.ts`) with loopback-only default binding, `HttpOnly; SameSite=Strict` session cookies, `X-CSRF-Token` and same-origin `Origin` validation, viewer vs. operator role separation, and single-use SSE stream tickets.
  - Native desktop supervision (`apps/desktop/src-tauri/src/main.rs`) with OS keychain credential storage and detached worker survival on window close.
  - Native iOS (`apps/ios/WazirMobile`) and Android (`apps/android`) companion apps with QR pairing, biometric approval gating (`BIOMETRIC_REQUIRED`), stale approval rejection (`APPROVAL_EXPIRED`), immutable `eventId` SSE deduplication in `MobileEventHub`, and idempotent concurrent task cancellation across surfaces (`cancelTask`).
- **Workstream B — Multi-LLM Optimization & Pre-Dispatch KV-Cache Placement**:
  - Added `minVerifiedSuccessRate` ($Q_{\min}$) and `maxLatencyMs` ($L_{\max}$) policy constraints to `ResourcePolicy` and `ResourceRouter`.
  - Updated `ResourceRouter.assess` to evaluate total expected cost per verified success (`effectiveCostPerSuccessUsd`), accounting for empirical task success rates, cold-start model load latency (`estimatedLoadMs`), and eviction penalties (`evictionRequired`).
  - Enhanced `Scheduler.scheduleComputer` and `Scheduler.estimatePlacement` to compute incremental KV-cache VRAM demand and active `ResourceReservation` `vramBytes`, rejecting GPU placement before dispatch when usable VRAM fits model weights (or a resident model at smaller context) but cannot fit the target context KV cache.
- **Workstream C — Evaluation Integrity & Statistical Qualification**:
  - Eliminated fabricated zero fallback metrics via tagged `readBenchmarkMetric` (`measured`, `estimated`, `unavailable`) and `extractMetricValueSafe` (`NaN` on missing telemetry).
  - Enforced repeated paired sign-test qualification (`minSampleCount >= 5`, Bonferroni-adjusted $\alpha$) in `RegressionGuard` and `pairedEvidence.ts`.
  - Added protected benchmark fixture modification detection (`PROTECTED_FIXTURE_MODIFIED`), benchmark context contamination rejection (`BENCHMARK_CONTAMINATED`), and per-category pass-rate regression breakdown (`categoryBreakdown` / `CATEGORY_REGRESSION`).
- **Workstream D — Controlled Self-Improvement & Atomic Optimizer State**:
  - Implemented versioned atomic optimizer persistence at `meta_optimizer/state/v1` (`OptimizerStateManager`) with durable per-sample reservations, idempotent accounting receipts, and fault-resilient hydration.
  - Added model-scoped divergence detection (`scopedModels` / `MODEL_SCOPED_REGRESSION`) in `RegressionGuard` so candidates that improve one model while regressing another cannot be promoted globally.
  - Updated `MetaOptimizerService.recordBaseline` to derive baseline models dynamically from active `routingRules` rather than static model lists, and enforced atomic baseline version checks (`OPTIMIZER_BASELINE_CHANGED`), canary evaluation, and rollback.

## v0.1.69 — 2026-10-15

**Release**: `v0.1.69`
**Theme**: Dashboard state handling — stop showing "0" when the real answer is "unknown"

Rounds out the v0.1.68 OFFLINE/502 fix by repairing the dashboard's own
state handling, which had the exact bug the original report flagged: a
failed request rendering as a confirmed zero instead of an unknown value.

- Tab badges (Activity/Infrastructure/Catalog) only updated as a side
  effect of a successful render, so a total outage froze them at a literal
  "0". They now show "—" whenever every section feeding them has never
  loaded, and recompute every refresh cycle regardless of success/failure.
- The executions pagination counter's "Showing 0 of 0" was both the
  pre-load placeholder and the genuine-empty-result text, making the two
  indistinguishable. Placeholder is now "No data yet"; "Showing 0 of 0"
  from a real successful response is unchanged (it's correct there).
- The global status pill can now tell "backend reachable but rejecting our
  token" apart from a real outage: 401/403 responses surface as
  "authentication required" instead of folding into generic "offline".

Verified in a real Chrome tab: forced a 401 via a deliberate token
mismatch (pill read "authentication required", all counters "—"), then
fixed the token and confirmed full recovery with real data.

## v0.1.68 — 2026-10-15

**Release**: `v0.1.68`
**Theme**: Fix Wazir Desktop OFFLINE / 502 on a cold local launch

Any launch of `@wazir/desktop` outside the `tauri dev` CLI (a built binary, or
`tauri build --no-bundle` output) showed "Runtime: OFFLINE" with 502s on every
dashboard call — `beforeDevCommand` only runs under `tauri dev`, so nothing
had actually started the backend.

- `main.rs` now health-checks ports 4800/4801 on startup and spawns `node
  dist/main.js` (apps/api) and `node server.js` (apps/web) itself when
  nothing's listening, logging to `~/Library/Logs/Wazir/{api,web}.log`. The
  window stays hidden until the web port responds, then navigates to the live
  dashboard — no more flash of the broken static page. Only child processes
  this instance spawned are tracked and killed on quit; a pre-existing or
  remote runtime is left untouched.
- Fixing the connectivity race surfaced a second, previously-masked failure:
  `apps/api`'s operator token is mandatory by default (`auth.ts`), and nothing
  set `WAZIR_API_TOKEN` for the self-spawned backend, so every
  `/api/v1/*`/`/executions` call 401'd even once the race was fixed. Desktop
  now generates a random per-launch token and passes it to both spawned
  processes; `apps/web`'s existing proxy attaches it to proxied requests
  server-side, so it never reaches the webview.
- Verified end-to-end on a cold launch with both ports free: dashboard loads
  real data (`GET /api/v1/executions` → 200), and quitting the app leaves no
  orphaned node processes or held ports.

## v0.1.67 — 2026-10-15

**Release**: `v0.1.67`
**Theme**: Wazir Desktop scaffold (dev-only)

- **New `@wazir/desktop` package**: a Tauri 2 native shell that opens a window onto the existing `@wazir/web` dashboard and `@wazir/api` control plane instead of a second, duplicate frontend/runtime. `npm run desktop:dev` builds the Rust shell and boots both servers via the existing `start:dashboard` script.
- Native menu (Reload, Open in Browser, View Logs, Quit/About) and a generated app icon set (`icon.icns`/`.ico`/PNGs) from the existing brand logo.
- Scope is intentionally limited to a verified dev build: no installers, code signing, notarization, or CI packaging workflows yet, and no remote-host (Mode B) connection — see `apps/desktop/README.md` for what's deferred and why.

## v0.1.66 — 2026-10-14

**Release**: `v0.1.66`
**Theme**: Verified integration for parallel coding agents and cross-platform package validation

- Add traceable merge readiness manifests, conflict planning, disposable integration candidates, combined-result qualification, durable recovery journaling, and operator reports for parallel agent worktrees.
- Fix Windows package archive extraction when the tarball path contains a drive letter.

## v0.1.65 — 2026-10-14

**Release**: `v0.1.65`
**Theme**: Supersedes v0.1.64 (release gate failed; never published)

- Restore v0.1.63 behaviour in the external agent adapter: stderr is kept for diagnostics and never counted as the agent's answer, so a vendor agent cannot pass the preflight probe by writing to stderr. The v0.1.64 merge had reintroduced stderr into captured output.
- Includes everything listed for v0.1.64.

## v0.1.64 — 2026-10-14

**Release**: `v0.1.64`
**Theme**: Complete npm distribution package, cross-platform CI gating, and macOS/Windows parity

- **Publishable npm package (`scripts/pack-npm.mjs` & `scripts/package-check.mjs`)**: Stages a self-contained npm package (`bin/wa.js`, `README.md`, `LICENSE`) with external native modules (`node-pty`, `@napi-rs/keyring`) declared as `optionalDependencies` and zero install lifecycle scripts.
- **Runtime startup guard & canonical version**: Enforces Node.js `>=22.13.0` with `node:sqlite`, suppresses the experimental SQLite warning on CLI startup, and injects a single canonical version from `package.json`.
- **Cross-platform CI & test suite gating**: Resolved all 14 macOS and Windows unit, integration, PTY/ConPTY, Seatbelt `file-read-metadata`, and acceptance test failures, and made macOS and Windows test jobs fully gating in `.github/workflows/ci.yml`.

## v0.1.63 — 2026-10-14

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

### Added and verified

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

### Distributed safety limits

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

### Validation

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

## v0.1.61 — 2026-10-13

A security and reliability release. Network clients of the Agent Protocol and MCP endpoints can
no longer act beyond their credential, every tool they reach runs through the same policy path as
coding agents, and a task is reported successful only when there is evidence for it.

### Security

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

### Truthful completion

- A failed, denied, cancelled or timed-out tool fails its step and the parent task, whatever
  `is_last` says. Text-only steps are recorded as `RECORDED`, not as executed work.
- Verification runs the project's checks through the same tool path. PASS needs at least one
  check actually run, all passing, bound to the step, with a workspace revision hash.
  `wazir://verification/status` no longer reports `verified: true` without that evidence.
- Finished tasks reject late or duplicate steps (409); steps are serialized per task.

### Reliability

- Tool receipts fingerprint the tool name and input (previously every call hashed the same) and
  never cache failed attempts; duplicate worker result posts are recorded once.
- Model streams cut by a transport reset are re-requested (up to 2 times).
- Checkpoint boundary validation, provider fault tests, a recovery-process test and a reliability
  benchmark workflow.

**Verification:** locally on Linux ARM64 — build, typecheck, `npm test`, `test:agent`,
`test:plan:acceptance` (80/80) and `release:gate` pass; 35 black-box protocol security tests.

## v0.1.60 — 2026-10-12

A cross-platform fleet and distribution release. Wazir can run work across heterogeneous
machines with platform-aware process cleanup, and now ships release artifacts and native
install paths for more operating systems.

### Added

- **Cross-platform agent and worker execution** with Windows process-tree cleanup, executable
  resolution, filesystem handling and hardware discovery across Linux, macOS and Windows.
- **Heterogeneous fleet scheduling** that matches tasks to registered workers and their runtime
  capabilities.
- **Native package distribution** for npm, standalone archives, Homebrew, Scoop, WinGet,
  Debian and RPM, with package checks, release verification, SBOM generation and checksums.
- **Container and service support** with Docker Compose, Debian/RPM service integration and
  platform worker setup guides.
- **Agent configuration discovery** for local Codex, Claude Code and Antigravity CLIs, with
  configuration provenance, project trust boundaries and bounded connection checks.

### Security and compatibility

- Existing vendor CLI sessions are tested through their own executables; authentication tokens
  are not imported into Wazir.
- Codex uses its native CLI in a read-only sandbox because the pinned ACP bridge did not support
  the installed model. Write tasks through this fallback are unavailable.
- Release artifacts are built on Linux x64/ARM64, macOS ARM64/x64 and Windows x64/ARM64 runners.

**Verification:** CI passed on Linux x64, macOS ARM64 and Windows x64 (Node 22), including
build, typecheck, distribution/package checks, 2,138 unit and integration tests (18 skipped),
acceptance and agent execution plans, native installer smoke tests and standalone binary checks.
The full run is [CI #38357922769](https://github.com/whassan007/wazir/actions/runs/38357922769).
A local Linux run also passed the same 2,138-test suite. Agent discovery tests used controlled
CLI fixtures; provider live execution was not part of this release validation.

## v0.1.59 — 2026-10-12

A reliability release. Delegated agents are now judged on evidence Wazir gathers itself, not
on their exit code; agents no longer outlive a crashed `wa`; and budget reservations survive
long delegations. Full audit: `docs/audits/WAZIR_HARDENING_v0.1.58.md`.

**Verification:** locally 2072 tests pass, 0 fail (18 skipped); typecheck clean. Live on the
DGX Spark: an Antigravity delegation was verified by Wazir running the project's tests itself;
a Codex delegation failed correctly (codex-cli 0.157.1 is too old for its default model). New
multi-process tests race six real processes on one ledger. Not tested: benchmarks, network
partitions, GPU saturation, agent failover (not implemented).

### ⚠️ Behaviour changes

- **Delegated tasks are verified by Wazir.** After a delegated agent runs, Wazir records the
  files it changed and, when source changed, runs the project's npm `build`, `typecheck`,
  `lint` and `test` scripts itself. The task fails if a check fails, if no check exists, if
  the agent weakened tests (removed assertions or test cases, added skips, deleted tests), or
  if it edited a check script in `package.json`. Previously an exit code of 0 was enough.
  Projects without npm scripts that change source now fail with "no checks were executed".
- **Executions left running by a dead process are marked failed** (`INTERRUPTED`) when the
  next `wa` starts, instead of staying `running` forever.
- **An unknown limit with `unknownLimitPolicy: "deny"` is blocked**, not deferred: waiting
  never makes the limit known.

### Added

- `wa resources validate [--profile production] [--json]` checks policy, account mappings,
  unknown vs unlimited limits, pricing and spend ceilings, and previews admission per account
  without reserving anything. `--profile production` exits 1 unless enforcement is on and every
  non-local account is explicitly configured with known limits. It never changes policy.
- `wa agents check` reports **DEGRADED** when an agent answers the probe but its latest real
  task failed in the agent, and shows each agent's last task and last verified task.

### Fixed

- A delegated agent (and any command it started) is killed when `wa` itself dies (SIGKILL,
  OOM, closed terminal), for both CLI and ACP agents. Before, it kept editing the workspace.
- Budget reservations for delegations and silent generations renew on a timer, so a run
  longer than `leaseMs` (15 min) is no longer settled mid-flight and dropped from concurrency limits.
- Concurrent recovery of one expired reservation records one `expired` event, not one per process.
- The test-weakening detector counts `assert.strictEqual(...)`-style assertions.

## v0.1.58 — 2026-10-12

A delegation and resource-orchestration release. Wazir can hand a task to Claude Code, Codex,
Qwen Code, Gemini or Antigravity, checks those agents before use, and puts every model request
through one budget-aware gate with a persistent ledger and a resource dashboard.

**Verification:** CI (build, typecheck, test) passes on PR #3 and PR #4. Locally 2053 tests
pass, 0 fail (18 skipped: PostgreSQL, bwrap sandbox and live lifecycle infrastructure);
acceptance gates 80/80 PASS. Live on the DGX Spark: governed LM Studio requests recorded with
provider-reported usage; an Antigravity delegation fixed a bug end to end; governance overhead
+0.14 ms p50 per request. Not tested live: paid APIs, Claude Code and Codex subscriptions,
vLLM, Ollama.

### ⚠️ Behaviour changes

- **Every model request is recorded** in `~/.wazir/resources.db` (SQLite, WAL). Set
  `WAZIR_IN_MEMORY=1` to keep it in memory.
- **Limits are not enforced by default.** `policy.enforce` is `false`: usage is estimated,
  recorded, routed and shown, but nothing is refused for budget reasons. Set
  `"enforce": true` in `~/.wazir/resources.json` to enforce quotas, spend ceilings, GPU
  concurrency and cooldowns. The emergency stop (`wa resources stop`) applies either way.
- **Routing prefers already-loaded local models** over ones that need a load or a reload.

### Added

- **Delegation to external coding agents:** `wa run --agent <name>` for Claude Code, Codex,
  Qwen Code, Gemini and Antigravity, through their own CLIs and logins. Second logins run as
  instances such as `claude-code@work`.
- **`wa agents check`:** preflight for delegated agents (installed, version, signed in).
- **Resource orchestration:** account registry (local, API, subscription), token budget
  manager with advisory/conserve/critical/exhausted modes, reservations reconciled against
  provider-reported usage, idempotent settlement, lease recovery after a crash, and an
  append-only audit trail.
- **Resource-aware routing** inside the existing scheduler: quality, reliability, capacity,
  cost, latency and quota risk, weighted by mode (`balanced`, `local-first`,
  `quality-first`, `budget-first`).
- **DGX Spark capacity probe:** GPU, temperature, power, unified memory, LM Studio, Ollama
  and vLLM state.
- **`wa resources`:** dashboard (`--watch`, `--json`) plus `init`, `validate`, `stop`,
  `resume`, `reset`, `explain` and `events`.
- **Structured provider failures:** auth, quota, rate limit (with `Retry-After` and
  rate-limit headers), server and context overflow; cache and reasoning token usage.
- Docs: `docs/resources/` (architecture, runbook, test report, limitations) and
  `scripts/bench-resource-governor.mjs`.

### Fixed

- Delegating to an external agent no longer tries to load a local model first.
- External agent exit errors include the agent's last output.

### Known limitations

- `wa ask` is governed but bypasses resource-aware routing.
- Subscription usage is estimated: vendor CLIs report no token counts.


## v0.1.57 — 2026-10-12

A persistence release. Checkpoints and long-term memory now survive restarts, the coding
agent keeps native tool-call history, and the web dashboard is no longer exposed beyond
localhost by default.

**Verification:** from a clean checkout, every CI step passes: build, typecheck, dist
check; 1964 tests pass, 0 fail (18 skipped:
PostgreSQL, bwrap sandbox and live lifecycle infrastructure); acceptance gates
80/80 PASS, verdict READY FOR RELEASE. Live (LM Studio `qwen/qwen3.8-27b`): every
`wa run` outcome matched an independent `npm test`.

### ⚠️ Behaviour changes

- **Node.js ≥ 22.5 is now required** (was ≥ 20). `@wazir/memory` uses the built-in
  `node:sqlite`, first shipped in 22.5, and Node 20 reached end-of-life on 2026-04-30.
  The install script, `engines` field, CI matrix and Docker images (`node:22-alpine`)
  are updated to match.
- **Web dashboard binds `127.0.0.1` by default.** Set `WAZIR_WEB_HOST=0.0.0.0` to
  restore network access.
- **A corrupt or unsupported persisted checkpoint stops engine startup** with
  `INVALID_CHECKPOINT` or `CHECKPOINT_DIGEST_MISMATCH` naming the record. Wazir fails
  closed rather than overwrite evidence. Move the named record aside to recover.
- **`integrations/ai-test-harness/install.sh` requires the pinned upstream revision**
  listed in `upstream-revisions.json`.

### Added

- **Durable checkpoints:** persisted to the host store with a version and digest,
  restored and verified at startup.
- **Durable episodic and procedural memory** in the SQLite store, reloaded on startup.
- **Native tool-call history in the coding agent:** provider call IDs are kept through
  assistant and tool messages, and a plain-text final answer from a native
  function-calling provider is accepted, subject to the usual verification.
- **Pinned upstream revisions** for ai-test-harness and Qwen-Live-Harness.

### Fixed

- **Clean builds failed** (TS2307 `Cannot find module '@wazir/memory'`), breaking every
  CI run of `main`: `core` and `evaluation` imported `@wazir/memory` without declaring
  it. A stale local `dist/` hid this. CI now passes from a clean checkout.
- A parallel batch of tool calls (common with Qwen models) aborted the whole run. It
  is now rejected as one invalid attempt: nothing in it executes, and the model is
  asked to issue one call. Live runs with 3 and 6 batches completed.
- The web dashboard never timed out stalled API requests, and kept proxying after the
  client disconnected.
- Checkpoint digests could collide for different path/content pairs.

## v0.1.56 — 2026-10-12

A reliability release. It adds the Qwen-Live-Harness integrations and fixes 22 defects
found by a stability audit and by running Wazir through
[schubergphilis/ai-test-harness](https://github.com/schubergphilis/ai-test-harness)
against a live local model.

**Verification:** typecheck and build pass; 1957 tests pass, 0 fail (18 skipped:
PostgreSQL, bwrap sandbox and live lifecycle infrastructure); acceptance gates
80/80 PASS, verdict READY FOR RELEASE.

### ⚠️ Behaviour changes

- **ACP permission requests now fail closed.** An `AcpClientAdapter` without an
  `onRequestPermission` resolver denies every request; previously it auto-approved.
- **Environment variables override `config.json`** for `WAZIR_OLLAMA_URL`,
  `WAZIR_LMSTUDIO_URL`, `WAZIR_API_URL`, `WAZIR_API_TOKEN` and
  `WAZIR_REGISTRATION_TOKEN`.
- **Reasoning is no longer part of model answers.** OpenAI-compatible / LM Studio
  streams emit model thinking as separate `reasoning` events. A reasoning model that
  runs out of tokens while thinking now returns an empty answer with
  `finishReason: 'length'` instead of its chain-of-thought.

### Added

- **Qwen-Live-Harness integration:** ACP client adapter (stdio delegation to Qwen
  Code, Claude Code, Codex, Gemini CLI), Subagents Ledger, Permission Broker, Tool
  Receipts, and a SQLite memory store with lexical ranking and time decay.
- **ai-test-harness integration** (`integrations/ai-test-harness/`): runs Wazir under
  the same compat-contract, Inspect and behaviour-scenario suites as Strands and other
  reference harnesses.
- **`/canary` view** in Mission Control (tabs, history selection), which existed but
  was unreachable.
- **`WAZIR_LMSTUDIO_API_KEY`** for authenticated OpenAI-compatible endpoints (LiteLLM,
  vLLM `--api-key`, LM Studio with auth).
- **`finishReason`** on `completed` runtime events (`content_filter`, `length`, …,
  or `cancelled` when the stream was aborted).
- **Acceptance gates G97–G100** (semantic strategy retrieval, false-positive control,
  cross-language transfer, anti-strategy). The harness reports `UNDEFINED` and `ERROR`
  separately from `FAIL`.

### Fixed

**Security and safety**
- ACP delegated agents were auto-approved when no operator decided. ACP options are
  now classified by their protocol `kind`, so a reject option labelled "No" is no
  longer read as approve.
- Mission Control `why …` explanations showed fabricated hashes, benchmark scores and
  health values. They now report only observed state, or `UNKNOWN`.

**Lifecycle and cancellation**
- External agent harnesses ignored cancellation until exit (up to 10 min), and their
  timeout never ended the run because child processes held the output pipe open.
  Cancellation now takes about 360 ms and kills the whole process tree.
- `cancelTask` on a finished task overwrote `completed` with `cancelled`.
- Provider streams are aborted when the consumer stops reading, so local models no
  longer keep generating.
- ACP: a missing executable or a failed turn crashed the host process. `initialize`
  is now bounded by a timeout.
- A job deleted while running was re-added to the TUI when it finished.

**Accuracy**
- All five provider adapters corrupted multi-byte UTF-8 (emoji, Arabic, CJK) split
  across stream chunks.
- Model reasoning leaked into answers and corrupted them. Seen live: "Answer
  8888888." + "8888888" was read as `88888888888888`.
- Tool results are sent in the native tool-call format when call IDs are known,
  instead of always as user text.

**Persistence and availability**
- One model that could not be inspected (e.g. LM Studio holding two instances of it)
  took the whole runtime offline, so every `wa run` failed. Only that model is now
  marked unavailable.
- Worker task streams leaked (registration and keep-alive timer) when a worker
  disconnected during subscribe.
- SQLite memory search could never return segments older than the newest 100.
- `config.json` silently overrode `WAZIR_*` environment variables, which broke the
  documented container setup.
- Ollama model listing could hang without a timeout.
- The acceptance harness crashed on undefined gates and on an absolute `--report`
  path.

### Docs

- `docs/audits/`: baseline, code audit, repairs, functional tests, performance,
  remaining risks and external-harness results.

### Known issues

See `docs/audits/WAZIR_REMAINING_RISKS.md`. In short: API dispatch records have no
retention policy; ACP is not yet wired into any CLI path; the tool sandbox needs
unprivileged user namespaces (unavailable on some Ubuntu hosts).

## v0.1.55 — 2026-09-24

Canary stage transitions refined; TUI prompt hotkey handling fixed.

## v0.1.54

TUI navigation hotkeys refined.
