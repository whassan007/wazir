# Wazir Goal Studio — Operator, Integration & Verification Guide

Goal Studio is Wazir's persistent, evidence-gated strategic goal execution and governance subsystem (`@wazir/goals`, contract version `1`). It separates declarative **target graphs** (what strategic milestones exist, their dependencies, priorities, artifacts, and acceptance criteria) from **execution/prompt graphs** (how tasks are planned, routed, challenged, independently verified, gated, repaired, or escalated for human approval).

---

## 1. Architecture & Contract Overview

The machine-checked source of truth is [`packages/goals/src/contracts.ts`](../../packages/goals/src/contracts.ts), with ownership boundaries documented in [`reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md`](../../reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md).

### Core Services (`GoalStudioServices`)

| Service | Contract Interface | Key Responsibilities |
|---|---|---|
| `graphs` | `GoalGraphStore` | Import YAML/JSON goal graphs, validate DAG structure (`SCHEMA`, `DUPLICATE_TARGET`, `UNKNOWN_DEPENDENCY`, `CYCLE`, `SELF_DEPENDENCY`, `UNKNOWN_EXECUTOR`, `INVALID_LIMIT`), persist immutable monotonic revisions (`GraphRevision`) and canonical SHA-256 digests. |
| `ledger` | `GoalLedgerStore` | Create and query `GoalRunLedger` instances pinned to `(graphId, graphRevision, graphDigest)`, perform atomic optimistic-concurrency commits (`ledgerRevision`) fenced by `RunLease.epoch`, enforce deterministic idempotency via `once(key, effect)`, and persist `TargetAttempt` and `TargetTransition` records. |
| `events` | `GoalEventLog` | Append and stream per-run monotonic `GoalStudioEvent` records (`seq`), supporting SSE reconnect replay via `?after=<seq>` / `Last-Event-ID`. |
| `controller` | `GoalController` | Drive the continuous execution lifecycle (`startRun`, `pause`, `resume`, `stop`, `retryTarget`, `runEligible`, `eligibleTargets`, `recoverRuns`). |
| `verification` | `VerificationService` | Run independent checks on workspace artifacts (`verify`), evaluate acceptance criteria via `AcceptanceGateDecision` (`gate`), and query persisted `EvidenceRecord` items. |
| `recovery` | `RecoveryService` | Classify failures (`transient`, `deterministic`, `environment`, `policy`, `verification`, `no_progress`, `unknown`), generate novel repair hypotheses, and enforce retry/repair/no-progress budgets. |
| `prompts` | `PromptStore` | Store and retrieve immutable versioned `PromptDefinition` templates keyed by `executorKey`. |
| `router` | `ModelRouter` | Route tasks to verified-ready local or hosted models within `remainingHostedBudgetUsd` (`localFirst: true` by default). |
| `governance` | `GoalGovernance` | Enforce preflight authorization (`allow` / `ask` / `deny`), hard spending caps (`authorizeSpend`), single-use scoped approvals, and durable audit logging (`audit`). |
| `executor` | `TargetTaskExecutor` | Bridge individual target attempts to Wazir's `ExecutionEngine` and worker fleet under an `IdempotencyKey`. |

---

## 2. The 12-Step Goal Studio Lifecycle

The acceptance suite in [`tests/goal-studio/e2eLifecycle.test.ts`](../../tests/goal-studio/e2eLifecycle.test.ts) and [`tests/goal-studio/adversarialInvariants.test.ts`](../../tests/goal-studio/adversarialInvariants.test.ts) verifies the complete 12-step lifecycle against `GoalStudioServices`:

1. **Create a Goal Studio project** (`GoalProject`).
2. **Import the strategic goal graph** ([`packages/goals/fixtures/nobel_goal_graph.yaml`](../../packages/goals/fixtures/nobel_goal_graph.yaml)).
3. **Validate graph structure and dependencies** (reject cycles, self-dependencies, unknown dependencies, duplicate target IDs, and negative resource limits).
4. **Persist graph state and revisions** (each edit produces a new immutable `GraphRevision` with a canonical SHA-256 `digest`; active runs remain pinned to their starting revision).
5. **Inspect initial target statuses** (root targets with satisfied dependencies become `eligible` in priority order; downstream targets start `queued`).
6. **Start autonomous execution** (`controller.startRun` acquires a fenced `RunLease` and transitions the run to `running`).
7. **Execute eligible targets** (`Y1.1 → Y1.2 → Y1.3` on the Nobel fixture, or `Y1.1`, `Y1.2`, `Y1.3` concurrently when configured as roots).
8. **Produce real workspace artifacts** (e.g., `scope.md`, `threat-model.md`, `formal-claim.md`, `model.smt2`, `reference-gate/`).
9. **Run independent verification** (`VerificationService.verify` hashes exact artifact bytes on disk with a `validatorIdentity` distinct from `executorIdentity`; self-reported executor claims are ignored).
10. **Update target state strictly from verification evidence**:
    - Only `completed` unlocks dependent targets (`UNLOCKING_TARGET_STATUSES = ['completed']`).
    - `verified` alone never unlocks dependents.
    - Targets with `externalDependency: true` (`Y1.4`, `Y2.3`, `Y3.3`, or any target configured with `external_dependency: true`) transition to `awaiting_external` unless an attributable `external-record` or `human-signoff` evidence record is present.
11. **Controlled failure, repair, and branch isolation**:
    - Repairable verification failures traverse `DIAGNOSE → REPAIR_HYPOTHESIS → REPLAN → RETEST` with a novel hypothesis per repair attempt.
    - Repeated identical failure signatures trigger `no_progress` blocking once `maxSameActionNoProgress` is reached.
    - When one target branch is `blocked`, unrelated `eligible` branches continue to execute and complete normally.
12. **Persist and reload state across process restart**:
    - All ledger state, transitions, attempts, idempotency records, evidence, and events persist through `JsonFileStore` (or `PostgresStore`).
    - On restart, `controller.recoverRuns()` acquires a higher lease `epoch` and resumes non-terminal runs without re-executing completed `once(key, effect)` side effects.

---

## 3. Running Verification & Readiness Suites

### Typecheck & Acceptance Tests

```sh
npx tsc --build
npx vitest run tests/goal-studio
```

To force the acceptance suite to run against the reference contract fakes even after `apps/api/src/goalStudio/services.ts` is wired:

```sh
WAZIR_GOAL_STUDIO_FORCE_FAKES=1 npx vitest run tests/goal-studio
```

### Demo & Benchmark Script

[`scripts/goal-studio-demo.mjs`](../../scripts/goal-studio-demo.mjs) runs a self-contained readiness check and 250-target synthetic DAG scheduling benchmark:

```sh
node scripts/goal-studio-demo.mjs
node scripts/goal-studio-demo.mjs --json
```

### Comparing Full-Suite Results Against the Pre-Integration Baseline

See [`docs/goal-studio/baseline-test-results.md`](./baseline-test-results.md) for the recorded pre-integration baseline (`e20355e`). To check for regressions across the entire repository:

```sh
npx tsc --build
npx vitest run --reporter=json --outputFile=/tmp/vitest.json
node scripts/goal-studio-baseline-diff.mjs /tmp/vitest.json
```
