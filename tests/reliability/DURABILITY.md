# Execution durability, idempotency and recovery

Scope: Workstream 2 (`hardening/p1-durable-correctness`). This file covers what Wazir
persists, what a fresh process can reconstruct, and which guarantees have been
exercised by a test. A guarantee that is not listed under "exercised" is not claimed.

## What is durable and what is process-local

| State | Where | Survives a fresh process? |
|---|---|---|
| Job graph, task status, node state, `retryCount`, attempts, results | `JobManager` → `KeyValueStore` key `job/<id>`, written with atomic `update` and a `revision` compare-and-set | Yes (file / Postgres / SQLite store). `MemoryStore`: no |
| Job ownership lease (`ownership.{ownerId,epoch,expiresAt}`) and cross-process cancel request (`control`) | same record | Yes |
| Execution record and its full event log (`tool.started`, `tool.completed`, `execution.*`, `generation.started`, reconciliation evidence) | `ExecutionEngine` → `persistExecutionRecord` key `execution/<id>`; `storageRevision` CAS, prior events must be preserved verbatim | Yes |
| Tool-call checkpoints (STARTED / COMPLETED / FAILED / OUTCOME_UNKNOWN) | derived from the event log on load (`toolCheckpoints`) | Yes (derived) |
| Execution owner (`pid`, `host`) | on the execution record | Yes; used to detect a dead owner on the same host |
| Dispatch queue, worker lease token, attempt count, committed outcome | `TaskDispatcher` → key `dispatch/<requestId>` | Yes |
| Proactive tool receipts | `ToolReceiptManager` → key `tool_receipt/<fingerprint>` when given a store | Only with a durable store; the default is in-memory |
| Orchestrator `activeJobs`, per-run `retryCounts`, AbortControllers, steering queues | `JobOrchestrator` memory | No. `retryCounts` is re-seeded from the persisted `node.retryCount` |
| `pausedExecutions`, `cancelledToolCalls`, steering on `ExecutionEngine` | memory | No |
| Worker `activeClaims`, `inFlight`, renewal timers | `Worker` memory | No. The control plane's lease is the durable side |
| Agent transcript, compaction summary, circuit-breaker fingerprints | `CodingAgent` memory | No. A resumed attempt gets `AgentResumeContext` built from the durable execution record instead |

`ToolReceiptManager` is **not** on the production tool path. The authoritative record of
dispatched tool calls is the ExecutionEngine event log. The receipt manager was
corrected (see below) but deliberately not wired in as a second source of truth.

## State-machine invariants (`packages/core/src/services/lifecycleTransitions.ts`)

* `completed` and `cancelled` are final for tasks, graph nodes and jobs. Re-applying the
  same status is an idempotent no-op.
* `failed` is final except for an explicit retry, which first returns to the queued state
  (task `pending`, node `idle`). A failed task never goes straight to `running` or
  `completed`.
* A finished job never changes status.
* Executions: `completed` is final. A `failed` or `cancelled` execution can become active
  again only when its latest lifecycle event is an explicit `execution.resumed` (recorded
  by `planTaskResume`). It can never jump straight to a different terminal status.
* A settled execution dispatches no tool calls (`EXECUTION_NOT_ACTIVE`).
* Operator `pause` and `resume` apply only to live or paused executions.
* A job-store write that the store refuses (lost lease, revision conflict) is rolled back
  in memory rather than left there as if it had happened.
* A job timeout records `failed`, never `cancelled`-then-`failed`. A task the operator
  cancelled before the timeout stays `cancelled`.

## Side-effect classes and retry safety

Existing classification (`ToolSideEffectClass`) mapped to the four requested classes:

| Requested | Wazir | Recovery behaviour |
|---|---|---|
| READ_ONLY | `READ_ONLY` | An interrupted call is reconciled `NOT_APPLIED` and may be repeated |
| IDEMPOTENT | `IDEMPOTENT_WRITE` (write) | Physical inspection proves APPLIED / NOT_APPLIED; re-issuing sets exact content |
| NON_IDEMPOTENT | `NON_IDEMPOTENT_WRITE` (shell, git, MCP, default for unclassified tools) | Never replayed without proof. Blocks resume and every further write until reconciled |
| UNKNOWN_OUTCOME | checkpoint state `OUTCOME_UNKNOWN` / `STARTED` with no result | Treated as "may have happened", never as a safe failure |

Delivery vs commitment: model requests to workers are delivered **at least once**
(lease expiry → redelivery). Terminal results are committed **at most once** per
dispatch (`TaskDispatcher.commit`) and per execution (`ExecutionEngine` transition rules).
Nothing here is exactly-once: a process can die after an external effect and before
recording it. That window is what OUTCOME_UNKNOWN represents.

## Guarantees exercised by tests

| Guarantee | Test |
|---|---|
| Receipt fingerprints are injective for NaN/±Infinity, bigint, Date, array holes, Map, Set, typed arrays, `$`-prefixed keys; 3,000-input seeded corpus (seed `0x5eed`) | `packages/core/tests/toolReceipt.test.ts` |
| Duplicate delivery (same idempotency key) is deduplicated; an intentional repeat (new key) runs | same |
| Expired non-idempotent receipt attempt → `outcome_unknown`, fenced late settle, reconcile APPLIED/NOT_APPLIED | same |
| Terminal-state corruption rejected (jobs, tasks, nodes, executions), including two processes on one file store | `packages/core/tests/lifecycleInvariants.test.ts` |
| Resume bounded (`MAX_EXECUTION_RESUMES` = 8) and refused while a live process owns the execution | `apps/cli/tests/taskResume.test.ts` |
| Ten crash points × {SIGKILL, SIGTERM}, recovered by an independent process from the store alone | `tests/reliability/crashPoints.test.ts` |
| Recovery itself killed mid-persist converges on the next run; reconciliation recorded exactly once; no extra retry burned | same, case 10 |
| Worker: duplicate delivery, concurrent claims across two dispatcher instances on one file store, renewal failure, dropped/reset result POSTs, bounded result delivery, stale lease commit, stop/complete race, `timeoutMs`, truncated/aborted stream, SIGKILL and SIGTERM worker death with takeover by a new worker process | `tests/reliability/workerFailures.test.ts` |

Not exercised, and so not claimed: Postgres/SQLite store behaviour under these crash
points (only `JsonFileStore` was used); cross-host ownership (dead-owner detection is
same-host only, via signal 0); clock skew between control plane and workers; power loss
(fsync durability of `JsonFileStore` is the store's own guarantee and was not tested
here); Windows signal semantics (the process tests are skipped there).

## Unresolved distributed risks

1. **Unbounded redelivery** (dispatcher D1) and **late-result rejection** (D2). Both need a
   Workstream 1 change in `apps/api/src/server.ts`. The failing tests are in
   `dispatcherIntegration.test.ts` and the verified patch in
   `integration-patches/workstream1-dispatcher.patch`.
2. **Cross-host dead-owner detection.** `ExecutionEngine` marks an execution INTERRUPTED
   only when its owner pid is on this host and dead. An execution owned by a crashed
   process on another host stays `running` until a job-lease takeover re-queues the task
   and `planTaskResume` handles it.
3. **Wall-clock leases.** Job, dispatch and receipt leases compare `Date.now()` from
   different processes. Fencing tokens and epochs keep a stale holder from committing,
   but large clock skew can shorten or extend leases.
4. **Shell/MCP outcomes are never provable.** A crash inside a non-idempotent shell call
   always needs an operator to reconcile. This is the intended trade-off.
5. **`ExecutionEngine.flush` claims ownership on every write.** A process that loaded a
   record can take its owner field over by writing to it. `storageRevision` CAS stops lost
   updates, but owner reassignment is not fenced by a lease the way jobs are.

## Retention proposal (not implemented)

Growth today is unbounded for `job/*`, `execution/*` (plus each record's full event log,
re-validated on every write, so a long execution costs O(n²) to persist), `dispatch/*`,
`tool_receipt/*` and checkpoints. Proposed policy. Every rule only touches terminal
records, and never one still needed for reconciliation:

* **Never prune:** non-terminal jobs/executions; any execution with a STARTED or
  OUTCOME_UNKNOWN tool call; a dispatch without an outcome; a receipt in `pending` or
  `outcome_unknown`.
* **Terminal executions:** keep 30 days or the latest 5,000, whichever is larger. Past
  that, compact the event log to lifecycle + tool-completion + reconciliation events and
  drop streaming/token events. Delete only after the owning job is deleted.
* **Terminal jobs:** keep 90 days. `JobManager.delete` already refuses active jobs; add a
  `pruneTerminal({ olderThan })` that deletes the job and then its executions.
* **Dispatch records:** delete 24h after `outcome` is committed (the result is already in
  the execution history). The 10k per-record event cap stays.
* **Receipts:** `committed`/`failed` receipts can expire with their execution. A
  `committed` receipt must outlive any possible redelivery of its operation, so its TTL
  must be at least the dispatch retention.
* **Checkpoints:** keep the latest N per execution (proposed 10) plus any referenced by
  an open rollback.

The API-side part (dispatch pruning, `MAX_EXECUTION_RECORDS` already caps in-memory API
history) belongs in `apps/api/src/server.ts` and is left to Workstream 1.

## Self-repair audit (packages/agents, read-only for this workstream)

Verified by reading `packages/agents/src/codingAgent.ts`. Not changed here, because it is
outside this workstream's ownership:

* **Compaction misreports the repair bound.** The summary writes
  `${repairState.cycle} / ${this.maxRepairCycles}` (line ~785), but the loop enforces the
  per-request `maxRepairCycles` (line ~597). With a request override the model is told the
  wrong limit. Fix: use the local `maxRepairCycles`.
* **Compaction drops the record of failed approaches.** The summary keeps task, plan,
  files, unresolved diagnostics and repair cycle, but not which fixes were already tried
  and failed. Unresolved diagnostics survive, so success isn't declared without evidence.
  The model can still re-propose an approach that already failed and was compacted away.
  The exact-repeat circuit breaker and the no-progress counter live outside the transcript
  and do survive compaction.
* Retry and stop bounds that do exist and were confirmed: `maxTurns` (default 30),
  `maxRepairCycles` (2), the identical-call circuit breaker, the no-progress streak,
  `MODEL_PROTOCOL_BUDGET_EXHAUSTED` after 3 malformed/invalid actions, stream re-request
  capped at 2, cancellation checked before each turn, and the job timeout now recorded as
  `failed`. Across restarts, retries are bounded by the persisted `node.retryCount`
  (lease takeover now honours per-task `maxRetries`) and by `MAX_EXECUTION_RESUMES`.
