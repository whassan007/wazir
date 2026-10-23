# Agent 05: Autonomous Recovery and Repair — Completion & Handoff Report

- **Agent ID**: Agent 05 (`feat/parallel-recovery`)
- **Role**: Autonomous Recovery and Repair Engineer (Workstream 05)
- **Worktree**: `/Users/wael/Code/Wazir-gs/agent-05`
- **Branch**: `feat/parallel-recovery`
- **Starting Commit SHA**: `e20355e30855f17cedeeeefb1ab7630f3e423ff6`
- **Implementation Commit SHA**: `2b080ef20e3b24745887cfc7e90849b49bd6fb17`

---

## 1. Files Owned & Modified

All modified and created files are strictly within Agent 05's ownership boundaries per `reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md`:

### `packages/goals/src/recovery/**` & `packages/goals/tests/recovery/**`
- [`packages/goals/src/recovery/index.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/src/recovery/index.ts) — Barrel exporting `classify`, `signature`, `hypothesis`, `service`, and `continuation`.
- [`packages/goals/src/recovery/classify.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/src/recovery/classify.ts) — Deterministic failure classification (`classifyGoalFailure`) mapping `GoalStudioError` and `AcceptanceGateDecision` into the 7 contract failure classes (`transient`, `deterministic`, `environment`, `policy`, `verification`, `no_progress`, `unknown`) and fine-grained `@wazir/shared` categories.
- [`packages/goals/src/recovery/signature.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/src/recovery/signature.ts) — Deterministic failure fingerprinting (`computeFailureSignature`) producing `fs1:<failureClass>:<sha256-24>` across target ID, failure class, core category, error code, failing acceptance criteria, and volatility-normalized error signatures.
- [`packages/goals/src/recovery/hypothesis.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/src/recovery/hypothesis.ts) — Hypothesis novelty verification (`normalizeHypothesis`, `isDuplicateHypothesis` with Jaccard token-set similarity $\ge 0.8$), unsafe proposal rejection (`isUnsafeHypothesis`), rule-based deterministic generator (`createRuleBasedHypothesisGenerator`), and optional model-backed generator (`createModelHypothesisGenerator`).
- [`packages/goals/src/recovery/service.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/src/recovery/service.ts) — `createRecoveryService(deps?: Partial<RecoveryServiceDeps>): RecoveryService` implementing bounded transient retries with exponential backoff, no-progress detection (`maxSameActionNoProgress`), bounded repair budget enforcement (`maxRepairsPerTask`), pinned graph constitution limit loading (`GOAL_STORE_KEYS.graphRevision`), novel repair hypothesis selection, and controller helpers (`attemptErrorFromGate`, `recoveryBlocker`, `recoveryBlockError`, `recoveryEventData`).
- [`packages/goals/src/recovery/continuation.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/src/recovery/continuation.ts) — Pure branch-isolation planner (`planBlockedTargetContinuation`) and idempotent ledger mutator (`applyBlockedContinuation`) ensuring a blocked target only blocks its transitive dependents while unrelated eligible targets continue executing.
- [`packages/goals/tests/recovery/fixtures.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/tests/recovery/fixtures.ts) — Test fixtures loading `nobel_goal_graph.yaml`.
- [`packages/goals/tests/recovery/recoveryService.test.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/goals/tests/recovery/recoveryService.test.ts) — 18 unit and integration tests covering every recovery path, branch continuation, and core failure-intelligence service.

### `packages/core/src/services/**` & Barrels
- [`packages/core/src/services/failureIntelligenceService.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/core/src/services/failureIntelligenceService.ts) — Pipeline-stage progress/regression ordering (`BUILD_FAILED` $\to$ `TYPECHECK_FAILED` $\to$ `LINT_FAILED` $\to$ `CODE_FAILURE` $\to$ `TEST_FAILED` $\to$ `ARTIFACT_CONTRACT_FAILED`), `consecutiveSameSignature`, `isPhysicalProgress`, and `isRegression`.
- [`packages/core/src/services/failureSignatureGenerator.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/core/src/services/failureSignatureGenerator.ts) — Volatility normalization (`normalizeMessage` stripping ISO timestamps, UUIDs, hashes, `/tmp` paths, durations, PIDs/ports, line:col while preserving test failure counts) and `fromError`.
- [`packages/core/src/services/repairContextBuilder.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/core/src/services/repairContextBuilder.ts) — Token-bounded `CompactRepairContext` builder (`REPAIR_CONTEXT_LIMITS`).
- [`packages/core/src/services/diagnosticHintGenerator.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/core/src/services/diagnosticHintGenerator.ts) — Deterministic, deduplicated diagnostic hints per `@wazir/shared` `FailureClass` and progress status.
- [`packages/core/src/services/index.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/core/src/services/index.ts) — Append-only exports for the 4 core failure intelligence services.
- [`packages/core/src/types/index.ts`](file:///Users/wael/Code/Wazir-gs/agent-05/packages/core/src/types/index.ts) — Append-only export for `failureIntelligence.js` types.

---

## 2. Changes Implemented & Verified

1. **Failure Classification (`classifyGoalFailure`)**:
   - Classifies every failure into `transient`, `deterministic`, `environment`, `policy`, `verification`, `no_progress`, or `unknown`.
   - Enforces that policy/control-plane denials (`POLICY_DENIED`, `FORBIDDEN`, `UNAUTHORIZED`, `APPROVAL_REQUIRED`, `BUDGET_EXCEEDED`, `CANCELLED`) are **always terminal (`action: 'block'`)**, even if `error.retryable === true`.
   - Distinguishes retryable environment failures (e.g. `NO_ROUTE` with `retryable: true`) from operator-terminal environment failures (`AUTH_FAILED`, `QUOTA_EXHAUSTED`) and non-retryable routing failures.
2. **Failure Signature Fingerprinting (`computeFailureSignature` & `FailureSignatureGenerator`)**:
   - Generates `fs1:<failureClass>:<sha256-24>` fingerprints.
   - Normalizes volatile runtime output (timestamps, UUIDs, SHA256 digests, temp paths, durations, localhost ports, line:column numbers) so identical root causes produce identical signatures across attempts, while preserving test failure counts (`2 tests failed` vs `1 tests failed`) as true progress.
3. **No-Progress Detection (`maxSameActionNoProgress`)**:
   - Tracks occurrences of `failureSignature` across `priorAttempts` for the target.
   - Immediately returns `action: 'block'` with `failureClass: 'no_progress'` when the same non-transient signature reaches `maxSameActionNoProgress` (default 2, read from the run's pinned graph constitution).
4. **Bounded Repair Budget (`maxRepairsPerTask`) & Hard Caps**:
   - Enforces `maxRepairsPerTask` (default 3 from constitution, clamped to `RECOVERY_HARD_CAPS`).
   - Enforces `maxTransientRetries` with exponential backoff (`backoffMs`) and an absolute `maxAttemptsPerTarget` ceiling (`RECOVERY_HARD_CAPS.maxAttemptsPerTarget = 30`) so no execution path can loop unboundedly.
5. **Novel & Safe Repair Hypotheses**:
   - Prioritizes criterion-specific verification repair strategies when `failureClass === 'verification'` or failing acceptance criteria are present, followed by pipeline-stage strategies and generic falsifiable strategies.
   - Rejects any candidate hypothesis that duplicates or rewords a prior attempt's `repairHypothesis` (using stopword-stripped token Jaccard similarity $\ge 0.8$).
   - Rejects any unsafe model hypothesis attempting to weaken tests/verification, raise limits/budgets, self-approve, or mark targets complete.
   - Returns `action: 'block'` when no novel hypothesis can be produced.
6. **Branch Isolation & Continuation (`planBlockedTargetContinuation` & `applyBlockedContinuation`)**:
   - Computes `deadEnds`, `eligible`, `reachable`, `unreachable`, and `idle` across the pinned `GoalGraphDefinition`.
   - Ensures a blocked target only marks its transitive dependents as `unreachable` (recording `unreachable: dependency ... blocked or stopped` in `entry.blockers` while keeping their status `queued`), leaving all unrelated eligible branches active and selectable.

---

## 3. Tests Executed & Exact Results

### TypeScript Build
Command:
```bash
npx tsc --build
```
Result: **Exit code 0** (clean compilation across all workspace packages).

### Recovery & Failure Intelligence Test Suite
Command:
```bash
npx vitest run packages/goals/tests/recovery
```
Result: **1 passed test file, 18 passed tests (0 failed)** in `580ms`:
- `RecoveryService.decide > retries a transient failure with a backoff hint, then the target succeeds` — PASS
- `RecoveryService.decide > bounds transient retries with exponential backoff and then blocks` — PASS
- `RecoveryService.decide > repairs a deterministic failure up to 3 times with distinct hypotheses, then blocks` — PASS
- `RecoveryService.decide > blocks as no_progress when the identical signature is seen twice` — PASS
- `RecoveryService.decide > blocks a policy denial immediately, even when marked retryable` — PASS
- `RecoveryService.decide > rejects a duplicate (reworded) hypothesis from the generator and picks a novel one` — PASS
- `RecoveryService.decide > blocks when no novel hypothesis exists` — PASS
- `RecoveryService.decide > rejects unsafe model proposals and falls back when the model adapter fails` — PASS
- `RecoveryService.decide > is deterministic for identical inputs` — PASS
- `RecoveryService.decide > repairs gate-only failures; recorded gate errors keep the same signature` — PASS
- `RecoveryService.decide > refuses to decide when there is no failure` — PASS
- `RecoveryService.decide > reads limits from the pinned graph revision and clamps them to hard caps` — PASS
- `RecoveryService.decide > terminates for every failure kind even with the largest allowed limits` — PASS
- `RecoveryService.decide > works with zero arguments (createRecoveryService()) and formats event/blocker helpers` — PASS
- `RecoveryService.decide > classifies environment failures (retryable vs non-retryable vs operator-terminal)` — PASS
- `planBlockedTargetContinuation & applyBlockedContinuation > isolates a blocked branch while keeping unrelated targets eligible and reachable` — PASS
- `Core Failure Intelligence & Signature Services > normalizes volatile fragments in FailureSignatureGenerator while preserving test counts` — PASS
- `Core Failure Intelligence & Signature Services > tracks progress, regression, and same-failure streaks in FailureIntelligenceService, RepairContextBuilder, and DiagnosticHintGenerator` — PASS

---

## 4. Integration Instructions & Notes

### Factory Wiring (`apps/api/src/goalStudio/services.ts`)
Wire `RecoveryService` in `GoalStudioServices` using:
```ts
import { createRecoveryService } from '@wazir/goals';

const recovery = createRecoveryService(deps);
```
`createRecoveryService(deps?: Partial<RecoveryServiceDeps>)` accepts `GoalStudioDeps` (`{ store, clock, workspaceRoot }`) or zero arguments for standalone/test usage. When `store` is provided, it automatically reads the run's pinned graph revision (`GOAL_STORE_KEYS.graphRevision(run.graphId, run.graphRevision)`), verifies `record.digest === run.graphDigest`, and enforces `constitution.resourceLimits.{maxRepairsPerTask, maxSameActionNoProgress}`.

### Controller Integration (`packages/goals/src/controller/`)
- When an acceptance gate returns `decision: 'repair'` or `'blocked'` without an execution error, use `attemptErrorFromGate(gate)` to persist the structured `GoalStudioError` on the failed `TargetAttempt` so subsequent attempts share a deterministic `failureSignature`.
- When `recovery.decide(...)` returns `action: 'block'`, record `recoveryBlockError(decision)` on the attempt, append `recoveryBlocker(decision)` to `ledger.targets[targetId].blockers`, and call `planBlockedTargetContinuation(ledger, graph, targetId)` + `applyBlockedContinuation(ledger, plan, now)` inside `ledger.commit(...)`.
- Emit `recovery.decided` events with `data: recoveryEventData(decision)`.

### Remaining Risks / Failures
- **None.** All 18 tests and `npx tsc --build` pass with zero errors.
