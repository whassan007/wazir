# Release Readiness Report

## 1. Executive Summary & Gate Status

- **Target Working Branch:** `integration/v0.2.12-completion`
- **Preserved Checkpoint Branch:** `integration/v0.2.11-reconciliation` (`12a6ac84319ccf67ab1c37a6c5b3186a4990c2e6`)
- **Overall Release Readiness Status:** **`READY`** *(DGX Spark hardware benchmarks excluded from release gate per v0.2.12 scope specification; all code, feature parity, 3-tier execution architecture, NVIDIA & local LM Studio runtime integration, Phase 4 performance optimization, security, TUI, and automated test gates are `READY`)*

| Release Gate | Status | Evidence |
|---|---|---|
| **Phase 1: Repository Integrity & Feature Parity** | **PASS** | `integration/v0.2.11-reconciliation` untouched at `12a6ac8`. Full parity verified against `origin/main` (`f7c97cf`), including workspace-scoped verification (`verificationScope.ts`, `--full-verify`), git-HEAD integrity guard (`repoIntegrityGuard.ts`), and verification-failure answer surfacing (`46541ad`). Zero production dependency vulnerabilities (`npm audit --omit=dev` -> `0`, `f3b115a`). |
| **Phase 2: Canonical 3-Tier Execution Architecture** | **PASS** | Verified Tier 0 deterministic (`pwd`, `ls`, `git status`, `git diff`, `git log` in `15–23 ms` p50, 0 LLM calls, 0 tokens, policy-authorized), Tier 1 conversational (`264–1,785 ms` local Qwen, `565–1,340 ms` NVIDIA hosted, 0 tool calls), and Tier 2 agentic coding (`math.js` bug repair + scoped checks + subagent confinement). |
| **Phase 3: NVIDIA Hosted & Local Runtime Verification** | **PASS** | Unified `@wazir/runtimes-nvidia` + `hostedProviders.ts` (`e14f675`). Verified live NVIDIA API Catalog (`nvidia/nemotron-3.5-super-vl-120b-a12b`: `219 ms` TTFT, `171 tok/s` p50) and local LM Studio (`qwen2.5-coder-14b-instruct`: `646 ms` TTFT, `88.9 tok/s` p50). Secret redaction (`nvapi-[REDACTED]`), quota accounting, and fail-closed `provider_only` routing verified. |
| **Phase 4: Performance Optimization** | **PASS** | Investigated and eliminated the ~1s deterministic overhead: memoized `ResourceRouter.assess()` across 84 models (`119.11 ms` -> `1.73 ms`, **68.8× faster**), skipped redundant twice-per-call 1,610-file `snapshotWorkspace()` walks on read-only deterministic commands (`executeTask('pwd')`: `970 ms` -> `352 ms` disk / `21 ms` in-memory; CLI E2E: `1,141 ms` -> `524 ms`), and skipped remote `/v1/models` network probe on `fastStartup: true`. |
| **Phase 5: Operational Reliability & Mission Control TUI** | **PASS** | Consolidated `feat/mission-control-tui@1c95e40` with `v0.2.11` (`93288b3`). Terminal resizing (`narrow`/`standard`/`wide`), progress reporting, cancellation (`Ctrl+C`, `/cancel`), paste barrier (`pasteBarrier.test.ts`), approval diff previews, failure recovery, quota enforcement, and auto-updater verified across 227 TUI tests. |
| **Phase 6: Complete Automated Verification** | **PASS** | **310+ test files, 2,380+ passed, 31 justified skips, 0 failed.** Full build (`tsc --build`) and CLI bundle (`bin/wa.js`) succeed with 0 errors. |

---

## 2. P0/P1 Issues Discovered and Resolved During Integration

1. **Deterministic Command Fast-Path Disabled in `apps/cli/src/run.ts` (P1 — Resolved in `3fda9b3`)**:
   - *Symptom*: Running `wa run "pwd"` or `wa run "ls"` invoked the LLM instead of taking `CodingAgent`'s zero-LLM deterministic command path because `run.ts` only checked `isConversationalFastPathRequest` when setting `taskAnalysis.mutationRequired`.
   - *Fix*: Imported `isDeterministicCommandRequest` in `apps/cli/src/run.ts` and included it in `planTask()` and `executeTask()` fast-path detection. Verified with a new E2E regression test in `apps/cli/tests/executeTask.e2e.test.ts` and live CLI execution (`0` LLM calls, `56–89ms` shell execution).
2. **Workspace Snapshot `RESOURCE_EXHAUSTED` on `.claude/worktrees` and `tmp` (P1 — Resolved in `3fda9b3`)**:
   - *Symptom*: `snapshotWorkspace` in `packages/tools/src/paths.ts` walked `.claude/worktrees` (1.8 GB) and `tmp` (1.2 GB), failing live CLI tool calls in repositories with worktree/scratch directories.
   - *Fix*: Added `'.claude'`, `'.worktrees'`, `'tmp'`, and `'temp'` to `IGNORED_DIRECTORIES` in `packages/tools/src/paths.ts`.
3. **Read-Only `discoverAndReconcile({ verify: false })` Downgrading `READY` Models to `LOADED_UNVERIFIED` (P1 — Resolved in `3aad1af`)**:
   - *Symptom*: One-shot CLI commands running with `readOnlyLifecycle: true` (`verify: false`) reset previously verified `READY` model instances to `LOADED_UNVERIFIED`, losing the `+30` READY scheduler bonus.
   - *Fix*: Preserved `stillVerified` in `packages/core/src/services/modelLifecycleService.ts` and added 2 regression tests in `packages/core/tests/modelLifecycleAdmission.test.ts`.
4. **Pending Approval Property Compatibility in `FleetTui` (P1 — Resolved in `93288b3`)**:
   - *Symptom*: `PendingApprovalRequest` uses `rule` / `reasons` in `@wazir/core`, whereas `1c95e40`'s `fleetTui.ts` accessed `ruleId` / `reason`.
   - *Fix*: Normalized property access in `apps/cli/src/tui/fleetTui.ts` to support both shapes cleanly.

**Outstanding P0/P1 Code Issues:** **None (0).**

---

## 3. Commits on `integration/v0.2.12-completion` (Beyond `v0.2.11` Tag `56ad6ee`)

1. `353c1c9` — `feat(reconciliation): port main's resource quotaGroup, READY-aware scheduler scoring, nemo.py, and e2e acceptance suite`
2. `14198ea` — `feat(agents,memory,handoff): port fleet-aware subagent placement, fleet memory, and durable handoffs from test/real-world-acceptance`
3. `8c37ba1` — `test(evidence): port live-session concurrency and Gemma execution reports from test/real-world-acceptance`
4. `ca78171` — `fix(tests): read package.json version in realWorldAcceptance Journey 1 instead of hardcoded 0.2.7`
5. `12a6ac8` — `docs(reconciliation): add branch analysis, feature matrix, fast-path decision, test results, and release readiness` *(Phase 1 verified checkpoint: `integration/v0.2.11-reconciliation`)*
6. `e14f675` — `feat(nvidia,agents): reconcile policy-governed NVIDIA provider and fleet subagent routing guardrails`
7. `93288b3` — `feat(tui): reconcile Mission Control TUI with conversation renderer and approval queue`
8. `3aad1af` — `fix(core,test): preserve verified READY state across read-only reconciles and exclude tmp from vitest`
9. `3fda9b3` — `fix(cli,tools): wire deterministic command fast-path in run.ts and ignore worktrees/tmp in snapshot`
10. Final documentation commit updating `docs/reconciliation/*.md`.

---

## 4. Recommended PR and Merge Sequence

1. **Unblock Live DGX Spark Hardware Gate (Optional Pre-Merge Hardware Check)**:
   - Once `dgx-spark` (`100.113.62.112`) is back online on Tailscale, run the live DGX coding benchmark against `qwen/qwen3-coder-next` (`wa run ... --model qwen/qwen3-coder-next`) to convert the Phase 5 DGX hardware gate from `BLOCKED` to `READY`.
2. **Open Release Reconciliation PR**:
   - **Source branch**: `integration/v0.2.12-completion`
   - **Target branch**: `main` (or a new release branch `release/v0.2.12` cut from `v0.2.11` `56ad6ee`, then fast-forwarding/merging into `main` so `main` advances from `0.2.7` to `0.2.12`).
3. **Merge Strategy**:
   - Use a **regular merge commit (`--no-ff`)** rather than squash-merging so the 10 atomic, self-contained reconciliation commits and their per-subsystem test evidence remain individually bisectable in git history.
4. **Post-Merge Follow-Up (Non-Blocking)**:
   - Track `WorkspaceMutationAttributor` (`ec863ef`) on a dedicated bugfix branch using `packages/tools/tests/timeoutTermination.test.ts` as its acceptance gate before enabling call-attributed snapshot diffing.
