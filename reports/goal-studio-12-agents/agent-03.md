# Agent 03 Report — Continuous Goal Controller (`feat/parallel-goal-controller`)

## 1. Summary of Scope & Ownership

- **Agent ID**: `agent-03`
- **Role**: Continuous Goal Controller (`GoalController`) & Task Execution Bridge (`TargetTaskExecutor`)
- **Branch**: `feat/parallel-goal-controller`
- **Starting Commit SHA**: `e20355e`
- **Files Owned & Modified / Created**:
  - `packages/goals/src/controller/eligibility.ts` — Pure deterministic target eligibility, critical-path DAG analysis (`computeCriticality`), comparator (`compareTargets`), dependency gate (`dependenciesCompleted`), newly unlocked target discovery (`newlyUnlockedTargets`), and transition state-machine guardrails (`TARGET_TRANSITIONS`, `HUMAN_TARGET_TRANSITIONS`, `canTransitionTarget`, `assertTargetTransition`).
  - `packages/goals/src/controller/controller.ts` — Full `createGoalController(deps)` implementation driving pinned goal-graph revisions through the continuous lifecycle under lease fencing, optimistic concurrency (`ledger.commit`), and idempotent side-effect execution (`ledger.once`).
  - `packages/goals/src/controller/executor.ts` — `createTargetTaskExecutor(deps)` bridging Goal Studio target attempts to Wazir's `@wazir/core` `ExecutionEngine` and `JobTaskExecutor` (or deterministic workspace artifact synthesis), guarded by `IdempotencyKey`.
  - `packages/goals/src/controller/index.ts` — Public workstream barrel exporting `createGoalController`, `createTargetTaskExecutor`, `eligibleTargets`, `computeEligibleTargets`, `computeCriticality`, and supporting helpers/types.
  - `packages/goals/tests/controller/controller.test.ts` — 11 comprehensive unit and lifecycle integration tests covering every required state transition, branch isolation rule, resource ceiling, approval/external gate, and crash recovery path.
  - `reports/goal-studio-12-agents/agent-03.md` — This engineering handoff report.

---

## 2. Architecture & State Machine Implementation

### 2.1 Continuous Target Lifecycle (`GoalPhase`)

Every target attempt is driven deterministically through the contract state machine:

```
LOAD_LEDGER → UNLOCK_DEPENDENCIES → SELECT_TARGET → PLAN_TASK → PREFLIGHT →
ROUTE_MODEL → EXECUTE → CHALLENGE → INDEPENDENT_VERIFY → ACCEPTANCE_GATE →
COMMIT_PROGRESS → UNLOCK_DEPENDENCIES → SELECT_NEXT_TARGET
```

- **Failure / Repair Loop**:
  `FAIL → DIAGNOSE → REPAIR_HYPOTHESIS → REPLAN → RETEST`
  - Invokes `recovery.decide(...)` inside `ledger.once(idempotencyKey(runId, targetId, attempt, 'DIAGNOSE'))`.
  - Enforces `maxRepairsPerTask`, `maxSameActionNoProgress` (consecutive identical `failureSignature`), and novel `repairHypothesis` checks before transitioning `failed → repairing` and recording the next `TargetAttempt` in phase `REPLAN` / `RETEST`.
- **Exhausted / Blocked Branch**:
  `BLOCK_TARGET → RECORD_EVIDENCE`
  - Transitions only the affected target to `blocked`, records blocker diagnostics on `TargetLedgerEntry.blockers`, and immediately wakes the scheduling loop so unrelated eligible branches continue running to completion.
- **Approval Branch**:
  `AWAIT_APPROVAL → PERSIST_STATE`
  - Triggered either at `PREFLIGHT` / `ROUTE_MODEL` (`kind: 'execute'`) or at `ACCEPTANCE_GATE` when `target.requiresApproval` is set (`kind: 'complete'`).
  - Transitions the target to `needs_approval`, persists a scoped approval marker (`approval:pending:<kind>:<attempt>:<scope>`), emits `approval.requested` + governance audit, and continues driving other unrelated eligible targets.
- **External Dependency Handling**:
  - When `AcceptanceGateDecision.decision === 'awaiting_external'` or `target.externalDependency` lacks an `external-record` or `human-signoff` `PASS` evidence record, transitions the target to `awaiting_external`, records evidence (`RECORD_EVIDENCE`), and continues other unrelated eligible targets.

### 2.2 Deterministic Target Eligibility & Critical-Path Scheduling

- **Verification-Gated Dependency Unlocking**:
  `dependenciesCompleted(run, target)` checks `UNLOCKING_TARGET_STATUSES` (`['completed']`). A target in `verified` status **never** unlocks downstream dependents; only `completed` (which requires an `AcceptanceGateDecision` of `completed` backed by independent `PASS` evidence where `validatorIdentity !== executorIdentity`) unlocks dependents.
- **Deterministic Ordering (`compareTargets`)**:
  1. `transitiveDependents` (descending) — number of downstream targets transitively unlocked by this target.
  2. `longestDownstreamChain` (descending) — critical-path chain depth.
  3. `target.priority` (descending).
  4. `target.id` (ascending lexicographical tie-breaker).

### 2.3 Resource Limits & Lease Fencing

- Every ledger mutation goes through `ledger.commit(runId, expectedRevision, lease, mutate, transitions)` with optimistic concurrency retries on `LEDGER_CONFLICT` and immediate abort on `STALE_LEASE`.
- Enforces all `constitution.resourceLimits`:
  - `maxTasksPerRun`: checked atomically inside `startAttempt` CAS; transitions run to `stopped` when no further tasks can be started.
  - `maxRepairsPerTask`: caps `entry.repairs` before transitioning to `blocked`.
  - `maxSameActionNoProgress`: tracks consecutive identical `failureSignature`s across attempts and blocks with `NO_PROGRESS`.
  - `maxRunMinutes`: checked against `run.resource.deadlineAt` using the injected clock; aborts in-flight work and stops the run on deadline expiry.
  - `hostedSpendUsd`: checks remaining hosted budget and `governance.authorizeSpend` before any hosted model execution.
  - `maxConcurrentTargets`: bounds `driver.active.size`.

---

## 3. Factory Signatures & Integration Notes (for Coordinator Wiring in `apps/api/src/goalStudio/services.ts`)

### `createGoalController`

```ts
import { createGoalController, createTargetTaskExecutor } from '@wazir/goals';

const executor = createTargetTaskExecutor({
  store: deps.store,
  clock: deps.clock,
  workspaceRoot: deps.workspaceRoot,
  ledger,
  executionEngine, // optional @wazir/core ExecutionEngine
  taskExecutor,    // optional @wazir/core JobTaskExecutor
});

const controller = createGoalController({
  store: deps.store,
  clock: deps.clock,
  workspaceRoot: deps.workspaceRoot,
  holderId: `api-${process.pid}`,
  services: {
    graphs,
    ledger,
    events,
    verification,
    recovery,
    prompts,
    router,
    governance,
    executor,
  },
});
```

### Extended Controller Methods (`ContinuousGoalController`)

In addition to all methods on `GoalController` (`startRun`, `pause`, `resume`, `stop`, `retryTarget`, `runEligible`, `eligibleTargets`, `recoverRuns`), `createGoalController` exposes:
- `resolveApproval(runId, targetId, { granted, principal, reason })`: human operator resolution of a pending `execute` or `complete` approval scoped to `(runId, targetId, attempt)`.
- `settled(runId)`: resolves when the controller finishes driving active work for `runId` (reaching `completed`, `idle`, `paused`, `stopped`, or `failed`).
- `activeTargets(runId)`: returns currently in-flight `TargetId[]`.
- `shutdown({ releaseLeases })`: cleanly stops active drivers and timers.

---

## 4. Verification & Test Evidence

Executed inside `/Users/wael/Code/Wazir-gs/agent-03`:

1. `npx tsc --build` — **Exited with code `0`** (zero TypeScript errors across all workspace packages).
2. `npx vitest run packages/goals/tests/controller` — **11 passed (11 total)** in `packages/goals/tests/controller/controller.test.ts`:
   - Deterministic eligibility & critical-path sorting (`verified` never unlocks dependents; only `completed` does)
   - Full lifecycle progression `LOAD_LEDGER → … → UNLOCK_DEPENDENCIES → SELECT_NEXT_TARGET`
   - Defense-in-depth rejection of self-certified evidence (`validatorIdentity === executorIdentity`)
   - Repair loop (`DIAGNOSE → REPAIR_HYPOTHESIS → REPLAN → RETEST`) up to `maxRepairsPerTask`
   - Branch isolation on `BLOCK_TARGET → RECORD_EVIDENCE` while unrelated eligible branches complete
   - Branch isolation on `AWAIT_APPROVAL → PERSIST_STATE` and `awaiting_external`, followed by `resolveApproval` and `retryTarget`
   - `pause`, `resume`, `stop`, and crash recovery (`recoverRuns`) with idempotent `ledger.once` replay
   - Enforcement of `maxTasksPerRun`, `hostedSpendUsd`, `maxSameActionNoProgress`, and `maxRunMinutes`
   - `runEligible` operator preference scheduling
   - `createTargetTaskExecutor` integration with `@wazir/core` `ExecutionEngine` and idempotency per `IdempotencyKey`
