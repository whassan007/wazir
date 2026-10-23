# Goal Studio integration contracts (v1)

Baseline: `main` @ `f7a4077` (Wazir v0.2.13). Every workstream branches from the
contract commit on `integration/goal-studio-12-agents` that adds this file.

The machine-checked source of truth is **`packages/goals/src/contracts.ts`**.
This document explains it and defines file ownership. If they disagree, the
TypeScript file wins.

## 1. Package layout

New workspace package `@wazir/goals` (`packages/goals`). It depends on
`@wazir/core` and `@wazir/shared`; nothing in `@wazir/core` may depend on it.

| Path | Owner |
|---|---|
| `packages/goals/src/contracts.ts`, `src/index.ts`, `package.json`, `tsconfig.json` | Coordinator |
| `packages/goals/src/ledger/**`, `tests/ledger/**` | 01 Execution reliability |
| `packages/goals/src/graph/**`, `tests/graph/**`, `fixtures/**` (read-only for others) | 02 Goal graph |
| `packages/goals/src/controller/**`, `tests/controller/**` | 03 Goal controller |
| `packages/goals/src/verification/**`, `tests/verification/**` | 04 Verification |
| `packages/goals/src/recovery/**`, `tests/recovery/**` | 05 Recovery |
| `packages/goals/src/prompts/**`, `tests/prompts/**` | 08 Prompt Studio |
| `packages/goals/src/routing/**`, `tests/routing/**` | 09 Model fleet |
| `packages/goals/src/governance/**`, `tests/governance/**` | 10 Security & governance |

Each workstream exports **only** through its own `src/<area>/index.ts`. The
coordinator's top-level barrel re-exports every area.

## 2. Existing code ownership (edits allowed only by the owner)

| Area | Owner |
|---|---|
| `packages/core/src/services/{executionEngine,executionPersistence,executionRecovery,checkpointService,statusTransitions,recoveryManager}.ts`, `packages/shared/src/{store,retry,faultInjection}.ts` | 01 |
| `packages/core/src/services/{jobOrchestrator,jobManager,planner}.ts`, `packages/scheduler/**` | 03 |
| `packages/core/src/services/{verificationEngine,verificationIntegrity,verificationOracles,verificationEvidenceInspector,verificationPlanning,evidencePolicy,provenanceManager}.ts`, `packages/core/src/types/verification.ts` | 04 |
| `packages/core/src/services/{failureIntelligenceService,failureSignatureGenerator,repairContextBuilder,diagnosticHintGenerator}.ts` | 05 |
| `apps/web/public/goal-studio/{index.html,shell.js,graph.js,goal-studio.css}`, `apps/web/server.js` | 06 |
| `packages/core/src/services/approvalQueue.ts`, `apps/web/public/goal-studio/control.js`, `apps/cli/src/commands/goalCommands.ts` (new) | 07 |
| `apps/web/public/goal-studio/prompts.js` | 08 |
| `packages/core/src/services/{scheduler,modelRegistry,modelReliability,modelPerformance,modelIntelligenceService,modelLifecycleService,runtimeRegistry,computerRegistry}.ts`, `packages/workers/**`, `apps/web/public/goal-studio/fleet.js` | 09 |
| `packages/core/src/services/{policyEngine,governanceService,secretBroker}.ts`, `packages/core/src/permissions/**`, `packages/policies/**`, `packages/shared/src/{audit,sanitize}.ts`, `packages/tools/src/{sandbox,resourceLimits,process,process-tools}.ts`, `apps/api/src/auth.ts` | 10 |
| `apps/cli/src/**` (except `commands/goalCommands.ts`), `apps/cli/tests/**`, `bin/**` | 11 |
| `tests/goal-studio/**`, `scripts/goal-studio-*.mjs`, `docs/goal-studio/**` | 12 |
| `apps/api/src/server.ts`, `apps/api/src/goalStudio/{index,context,services}.ts`, root `package.json`, `tsconfig.json`, `vitest.config.ts`, `package-lock.json`, `apps/web/public/index.html`, all `reports/goal-studio-12-agents/*.md` except `agent-XX.md` | Coordinator |

HTTP route modules (each owner mounts under `/api/v1/goal-studio/`):
`graphRoutes.ts` 02 · `controlRoutes.ts` 07 · `promptRoutes.ts` 08 ·
`fleetRoutes.ts` 09 · `verificationRoutes.ts` 04 · `governanceRoutes.ts` 10.

**Shared barrels** (`packages/core/src/index.ts`, `packages/core/src/services/index.ts`,
`packages/core/src/types/index.ts`): append-only. You may append export lines for
new files you own, at the end of the file, nothing else. The coordinator resolves
any resulting trivial merge conflicts.

**New test files** under `packages/core/tests/` or elsewhere are allowed if the
filename is prefixed with your area (e.g. `executionEngine.leaseFencing.test.ts`).

Everything else is read-only. If you need a change outside your ownership,
write it up under "Integration notes" in your report with the exact diff you
want, and work around it locally (adapter or test double).

## 3. Identifiers and keys

* Graph revisions and prompt versions are monotonic integers, immutable once written.
* A run pins `(graphId, graphRevision, graphDigest)` at creation. Editing a graph
  creates a new revision; active runs never see it.
* `IdempotencyKey = runId:targetId:attempt:phase`, deterministic. Every
  side-effecting phase (EXECUTE, COMMIT_PROGRESS, external calls) goes through
  `GoalLedgerStore.once(key, effect)`.
* KeyValueStore prefixes are in `GOAL_STORE_KEYS`; each prefix has one writer.

## 4. States

`TargetStatus`: queued, eligible, active, verifying, verified, completed, failed,
repairing, needs_approval, blocked, awaiting_external, stopped.

* **Only `completed` unlocks dependents.** `completed` requires an
  `AcceptanceGateDecision` of `completed` whose criteria all have `PASS` evidence
  produced by a validator whose identity differs from the executor.
* `externalDependency` targets cannot reach `completed` without an
  `external-record` or `human-signoff` evidence record; otherwise `awaiting_external`.
* `blocked` is terminal for the run but never blocks unrelated eligible targets.

`GoalRunStatus`: created, running, pausing, paused, stopping, stopped, idle,
completed, failed. `idle` = nothing eligible but non-terminal targets remain.

Lifecycle phases (`GoalPhase`) follow the YAML execution graph:
LOAD_LEDGER → SELECT_TARGET → PLAN_TASK → PREFLIGHT → ROUTE_MODEL → EXECUTE →
CHALLENGE → INDEPENDENT_VERIFY → ACCEPTANCE_GATE → COMMIT_PROGRESS →
UNLOCK_DEPENDENCIES → SELECT_NEXT_TARGET; failure: DIAGNOSE →
REPAIR_HYPOTHESIS → REPLAN → RETEST; exhausted: BLOCK_TARGET → RECORD_EVIDENCE;
approval: AWAIT_APPROVAL → PERSIST_STATE.

## 5. Persistence

* All ledger writes go through `GoalLedgerStore.commit`, an atomic
  compare-and-set on `ledgerRevision`, fenced by the run lease `epoch`
  (`STALE_LEASE` if a newer holder exists). Transitions are written in the same commit.
* Recovery resumes only from the last committed ledger revision.
* Must work on `MemoryStore`, `JsonFileStore`, and Postgres (`KeyValueStore.update`
  when present gives atomicity; otherwise implement a lock).

## 6. Events

`GoalStudioEvent` with a per-run monotonic `seq`, persisted by `GoalEventLog`.
SSE endpoint: `GET /api/v1/goal-studio/runs/:runId/events` honours `Last-Event-ID`
and `?after=`. Clients must be able to reconnect and replay with no gaps.

## 7. Errors

Throw `GoalStudioFailure(code, message, {retryable, details})`. HTTP routes map
codes with `GOAL_STUDIO_HTTP_STATUS` and respond `{ error: { code, message, details } }`.

## 8. Authorization boundaries

* Read routes: `auth.requireViewerOrOperator`. Mutating routes: `auth.requireOperator`.
* The executing model is never a principal. Model output cannot approve,
  change limits, change policy, edit the graph, or mark a target complete.
* Spending: `GoalGovernance.authorizeSpend` before any hosted inference;
  `hostedSpendUsd: 0` means hosted inference is denied.
* Approvals reuse `ApprovalQueue` (core). An approval is scoped to
  `(runId, targetId, attempt, action)` and is not reusable elsewhere.
* All control-plane mutations and denials emit audit events through `GoalGovernance.audit`.

## 9. Web shell contract

`apps/web/public/goal-studio/index.html` (owner 06) loads `shell.js`, then optional
modules `graph.js`, `control.js`, `prompts.js`, `fleet.js`. Each module calls
`window.WazirGoalStudio.register(name, { mount(el, ctx), unmount?() })` where
`ctx = { api(path, init?) => Promise<Response>, events(runId, onEvent) => close, state }`.
Missing modules must not break the shell. No build step; vanilla ES modules,
matching the existing `apps/web/public/index.html` style. External libraries
only from a pinned CDN URL, or vendored.

## 10. Composition

`apps/api/src/goalStudio/services.ts` (coordinator) builds `GoalStudioServices`
from each workstream's factory. Each area must export a factory named
`create<Thing>(deps: GoalStudioDeps & {...})`, documented in its agent report.
Until wired, `ctx.services.<x>` may be undefined; routes must answer 503
`{ error: { code: 'INTERNAL', message: '<service> not configured' } }`.
