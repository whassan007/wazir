# A07 — Task, Job, Node, and Execution Lifecycle Audit Report

- **Agent ID**: A07
- **Role**: Gemini TIER 1 — Task Lifecycle Auditor
- **Program**: Wazir 30-Agent Cost-Optimized Formal Hardening Program
- **Group**: GROUP C (P0 / Core Lifecycle Integrity)
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target Commit**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Status**: AUDIT COMPLETE — CONFIRMED VULNERABILITIES IDENTIFIED & DETERMINISTICALLY REPRODUCED
- **Alloy Models**:
  - Reference Monotone Model: `tests/formal-hardening/models/a08-lifecycle-monotone.als` (Exit=0, UNSAT)
  - Adversarial Mutant Model: `tests/formal-hardening/models/a08-lifecycle-mutant.als` (Exit=0, SAT — Counterexamples Found)
- **Reproduction Test Suite**: `tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts` (6 / 6 confirmed reproductions pass)

---

## 1. Executive Summary & Critical Invariant

### Core Safety Invariant
> **"Completed or cancelled work must not silently re-enter execution or be reported under a contradictory terminal status."**

Our audit examined the formal state machines, transition policies, concurrency gates, timeouts, cancellation paths, and retry mechanisms across four distinct lifecycle layers:
1. **Job** (`JobStatus` via `packages/core/src/services/jobManager.ts` & `jobOrchestrator.ts`)
2. **Task** (`TaskStatus` via `packages/core/src/services/jobManager.ts` & `jobOrchestrator.ts`)
3. **Graph Node** (`AgentState` via `packages/core/src/services/jobManager.ts` & `jobOrchestrator.ts`)
4. **Execution** (`ExecutionStatus` via `packages/core/src/services/executionEngine.ts`)

### Primary Findings Overview
We uncovered **3 High-Severity P0 Defects** and **4 Material P1/P2 Defects** where:
- A multi-task job containing a **cancelled task** is reported as **`completed`** and emits `job:completed` (`jobOrchestrator.ts:894-897`).
- A job timeout finalizer forcibly overwrites prior user-cancelled tasks to **`failed`**, rewriting terminal history (`jobOrchestrator.ts:476-487`).
- Process lease recovery in `JobManager.acquire` explicitly resurrects **`failed`** jobs back to **`running`**, bypassing transition invariants (`jobManager.ts:175-178`).
- `JobManager.cancel` fails to cancel graph nodes and ignores tasks in non-pending/running states (`jobManager.ts:433-439`).
- Unleased workers can append progress events to terminal executions because `assertLease` bypasses terminal checks when credentials are empty (`executionEngine.ts:1356-1362, 1407-1413`).
- Retrying a failed execution retains a stale `completedAt` timestamp while in `queued`/`pending` status (`executionEngine.ts:450-457`).

---

## 2. Allowed State Transition Map

The canonical transition guards are defined in [`statusTransitions.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/statusTransitions.ts). The table below summarizes the intended transition rules vs. actual runtime enforcement:

| Subsystem | Terminal States | Retry Targets | Allowed Terminal Transitions | Defect / Bypass Identified |
|---|---|---|---|---|
| **Job** | `completed`, `failed`, `cancelled` | None | `cancelled -> failed` (finalizer reconciliation only) | `acquire()` resurrects `failed -> running` (`jobManager.ts:176`). `jobOrchestrator.ts:897` reports `completed` with cancelled tasks. |
| **Task** | `completed`, `failed`, `cancelled` | `pending`, `queued`, `scheduled`, `ready` | None (strictly terminal) | Timeout finalizer forces `cancelled -> failed` (`jobOrchestrator.ts:485`). `JobManager.cancel` misses tasks in `ready`/`blocked`. |
| **Node** | `completed`, `failed`, `cancelled` | `idle`, `assigned` | None (strictly terminal) | Timeout finalizer forces `cancelled -> failed` (`jobOrchestrator.ts:478`). `JobManager.cancel` leaves nodes `idle`/`running`. |
| **Execution** | `completed`, `failed`, `cancelled` | `pending`, `queued`, `scheduled`, `ready` | None (strictly terminal) | `recordEvent` permits late writes to terminal executions when unleased (`executionEngine.ts:1360`). `completedAt` not cleared on retry. |

---

## 3. Detailed Confirmed Defects & Vulnerabilities

### Defect 1 (P0): False Verified Job Completion with Cancelled Task
- **File & Lines**: [`packages/core/src/services/jobOrchestrator.ts:890-898`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L890-L898)
- **Severity**: **P0 (False Verified Completion)**
- **Alloy Invariant**: `NoCompletedJobWithCancelledOrFailedTask` in `a08-lifecycle-mutant.als` (SAT: Counterexample found)
- **Vulnerability Description**:
  In `JobOrchestrator.runOwnedJob`, step 4 of `doPump` evaluates job termination:
  ```typescript
  const allFinished = job.graph.nodes.every(
    (n) => n.state === 'completed' || n.state === 'failed' || n.state === 'cancelled',
  );
  if (allFinished) {
    const anyFailed = job.graph.nodes.some(
      (n) => n.state === 'failed' && !supersededTaskIds.has(n.taskId ?? n.id),
    );
    await finishJob(anyFailed ? 'failed' : 'completed');
    return;
  }
  ```
  If a task is cancelled (e.g. by `orchestrator.cancelTask(jobId, taskId)`), its node state is `'cancelled'`. When all tasks finish:
  - `allFinished` evaluates to `true`.
  - `anyFailed` **only** checks for `n.state === 'failed'`.
  - Because `cancelled !== 'failed'`, `anyFailed` evaluates to **`false`**!
  - `finishJob('completed')` is called!
  - `finishJob` sets `job.status = 'completed'` and emits `job:completed`.
- **Impact**:
  A mission whose required task was explicitly cancelled is permanently persisted and reported to the user as successfully `completed`.
- **Reproduction**:
  Verified in `tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts` (Test: `DEFECT 1`).

---

### Defect 2 (P0): Timeout Finalizer Overwrites User-Cancelled Tasks and Nodes to Failed
- **File & Lines**: [`packages/core/src/services/jobOrchestrator.ts:468-488`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L468-L488)
- **Severity**: **P0 (Terminal Monotonicity Violation / Contradictory Status)**
- **Alloy Invariant**: `NoTerminalResurrection` in `a08-lifecycle-mutant.als` (SAT: Counterexample found)
- **Vulnerability Description**:
  When a job timeout fires in `JobOrchestrator.runOwnedJob`:
  ```typescript
  if (timedOut) {
    finalStatus = 'failed';
    const reason = `Task exceeded the ${timeoutSeconds}s timeout and was automatically stopped`;
    for (const node of job.graph.nodes) {
      if (node.state !== 'completed' && node.state !== 'failed') {
        node.state = 'failed';
        node.error = node.error ?? reason;
        node.completedAt = node.completedAt ?? new Date();
      }
    }
    for (const task of job.tasks) {
      if (task.status !== 'completed' && task.status !== 'failed') {
        task.status = 'failed';
      }
    }
  }
  ```
  If a task was previously cancelled by the user (`task.status === 'cancelled'`, `node.state === 'cancelled'`), it satisfies `status !== 'completed' && status !== 'failed'`.
  The finalizer directly overwrites `task.status = 'failed'` and `node.state = 'failed'`.
  This violates:
  1. `canTransitionTask('cancelled', 'failed') === false`.
  2. `canTransitionNode('cancelled', 'failed') === false`.
  3. Bypasses `assertTaskTransition` and `assertNodeTransition`.
- **Impact**:
  User cancellation records are wiped and falsely attributed to system timeout failures.
- **Reproduction**:
  Verified in `tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts` (Test: `DEFECT 2`).

---

### Defect 3 (P0): `JobManager.acquire` Resurrects Failed Jobs to Running
- **File & Lines**: [`packages/core/src/services/jobManager.ts:130-178`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts#L130-L178)
- **Severity**: **P0 (Terminal Monotonicity Violation)**
- **Alloy Invariant**: `NoTerminalResurrection` (Failed job must remain Failed)
- **Vulnerability Description**:
  In `JobManager.acquire(jobId)`:
  ```typescript
  const hasExpiredLeaseOrphan =
    current.status === 'failed' &&
    Boolean(current.ownership && current.ownership.expiresAt > 0 && current.ownership.expiresAt <= this.now()) &&
    current.graph.nodes.some((n) => n.state === 'failed' && n.error?.startsWith('Orphaned:'));
  ...
  } else if (hasExpiredLeaseOrphan && next.tasks.some(t => t.status === 'pending')) {
    next.status = 'running';
    next.completedAt = undefined;
  }
  ```
  If a previous process crashed or its lease expired, `current.status` is `'failed'`. `acquire()` resets `next.status = 'running'` and clears `completedAt`.
  This directly contradicts `statusTransitions.ts`:
  > *"completed and failed jobs are strictly terminal; only `cancelled -> failed` is permitted so timeout-abort finalizers can reconcile after cancelling in-flight tasks."*
  `canTransitionJob('failed', 'running')` is `false`.
- **Impact**:
  External consumers or UIs observing a terminal failure will see the job unexpectedly reappear as `running` without an audit log or new job identity.
- **Reproduction**:
  Verified in `tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts` (Test: `DEFECT 4`).

---

### Defect 4 (P1): `JobManager.cancel` Fails to Cancel Graph Nodes and Non-Pending/Running Tasks
- **File & Lines**: [`packages/core/src/services/jobManager.ts:430-440`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts#L430-L440)
- **Severity**: **P1 (State Inconsistency / Orphaned Active Nodes)**
- **Vulnerability Description**:
  In `JobManager.cancel(jobId)` (local/in-memory or leased path):
  ```typescript
  job.status = 'cancelled';
  for (const task of job.tasks) {
    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'cancelled';
    }
  }
  await this.flush(job);
  ```
  1. Any task in `'ready'`, `'queued'`, `'scheduled'`, `'planning'`, `'waiting_for_approval'`, `'verifying'`, or `'blocked'` is **not** cancelled.
  2. `job.graph.nodes` is **never updated**! All graph nodes retain their existing state (`running`, `idle`, etc.).
  Contrast with the unowned store path (lines 425-426), which correctly maps all non-terminal nodes to `'cancelled'`.
- **Impact**:
  In-memory representation leaves active tasks and nodes inside a cancelled job.
- **Reproduction**:
  Verified in `tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts` (Test: `DEFECT 3`).

---

### Defect 5 (P1): `ExecutionEngine.assertLease` Bypasses Terminal State Check for Unleased Callers
- **File & Lines**: [`packages/core/src/services/executionEngine.ts:1356-1362, 1407-1413`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L1356-L1362)
- **Severity**: **P1 (Stale Zombie Mutation on Terminal Execution)**
- **Vulnerability Description**:
  In `ExecutionEngine.assertLease`:
  ```typescript
  if (!claimant) return;
  const claimedEpoch = claimant.leaseEpoch ?? claimant.epoch;
  const claimedWorker = claimant.workerId;
  const claimedToken = claimant.leaseToken;
  if (claimedWorker === undefined && claimedEpoch === undefined && claimedToken === undefined) {
    return;
  }
  ...
  if (rejectIfTerminal && isTerminalExecutionStatus(record.execution.status)) {
    throw new StaleWorkerLeaseError(...);
  }
  ```
  If a caller invokes `recordEvent(executionId, type, data)` without supplying a `claimant` containing credentials, `assertLease` returns immediately at line 1361. The subsequent `rejectIfTerminal` check at line 1407 is completely bypassed.
- **Impact**:
  Late background callbacks or unauthenticated workers can write new progress/turn events to an execution that has already completed or been cancelled.
- **Reproduction**:
  Verified in `tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts` (Test: `DEFECT 5`).

---

### Defect 6 (P2): Execution Retries Retain Stale `completedAt` Timestamps
- **File & Lines**: [`packages/core/src/services/executionEngine.ts:450-457`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L450-L457)
- **Severity**: **P2 (Contradictory Telemetry Metadata)**
- **Vulnerability Description**:
  When a failed execution is retried into `'queued'`, `'scheduled'`, or `'ready'`, `record.execution.status` is updated, but `record.execution.completedAt` is **not** cleared.
- **Impact**:
  An active/queued execution presents a non-null completion timestamp from its previous failed attempt.
- **Reproduction**:
  Verified in `tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts` (Test: `DEFECT 6`).

---

### Defect 7 (P1): Unguarded Direct Execution Status Mutation in `GovernanceService`
- **File & Lines**: [`packages/core/src/services/governanceService.ts:229-232`](file:///Users/wael/Code/Wazir/packages/core/src/services/governanceService.ts#L229-L232)
- **Severity**: **P1 (Policy Bypass / Unchecked Status Transition)**
- **Vulnerability Description**:
  On hard budget termination:
  ```typescript
  const record = await executionEngine.get(executionId);
  if (record) {
    record.execution.status = 'failed';
  ```
  `governanceService` directly sets `status = 'failed'` without calling `assertExecutionTransition` or `executionEngine.setStatus`. If the execution had already reached `completed` or `cancelled`, this directly overwrites terminal state without an audit event.

---

### Defect 8 (P1): `cancelJob` Does Not Wake Pump Loop, Hanging Non-Cooperative Executors
- **File & Lines**: [`packages/core/src/services/jobOrchestrator.ts:307-320`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L307-L320)
- **Severity**: **P1 (Unbounded Orchestrator Hang on Cancellation)**
- **Vulnerability Description**:
  In `JobOrchestrator.cancelJob`:
  Unlike `pauseJob` (line 331) and `resumeJob` (line 337), `cancelJob` **never** calls `handle.wakePump?.()`.
  If an active task executor does not immediately terminate upon `signal.aborted` (or hangs on synchronous I/O or network), `pump()` is never re-entered. The job promise returned by `runJob()` hangs indefinitely.

---

## 4. Formal Verification: Alloy 6 Models & Findings

### Model Artifacts
1. **Reference Monotone Model**:
   - Location: `tests/formal-hardening/models/a08-lifecycle-monotone.als`
   - Scope: 3 entities, 1 Job, 2 Tasks, 2 Executions, 10 steps
   - Results:
     - `check NoTerminalResurrection`: **UNSAT** (Proven safe within bound)
     - `check NoCompletedJobWithCancelledOrFailedTask`: **UNSAT** (Proven safe within bound)
     - Witnesses 00–03: **SAT** (All valid operational paths reachable)

2. **Adversarial Mutant Model**:
   - Location: `tests/formal-hardening/models/a08-lifecycle-mutant.als`
   - Solver execution:
     ```bash
     /Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar \
       exec -f -t text -c '*' -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a08-lifecycle-mutant \
       /Users/wael/Code/Wazir/tests/formal-hardening/models/a08-lifecycle-mutant.als
     ```
   - Results:
     - `check NoTerminalResurrection`: **SAT** (Counterexample logged: `NoTerminalResurrection-solution-0.txt`)
     - `check NoCompletedJobWithCancelledOrFailedTask`: **SAT** (Counterexample logged: `NoCompletedJobWithCancelledOrFailedTask-solution-0.txt`)

### Minimal Counterexample Trace (Alloy Extract: Defect 1)
```
State 0: Job.status = Pending, Task0.status = Pending, Task1.status = Pending
State 1: Job.status = Running, Task0.status = Running, Task1.status = Running
State 2: Task0.status = Completed (Task1 still Running)
State 3: Task1.status = Cancelled (by taskCancel)
State 4: allFinished is True (Task0=Completed, Task1=Cancelled)
         anyFailed is False (no task is Failed)
         --> jobCompleteMutant fires!
State 5: Job.status = Completed, while Task1.status = Cancelled!
         VIOLATION: NoCompletedJobWithCancelledOrFailedTask
```

---

## 5. Recommended Remediation Plan for Agent A09 (Codex)

To repair these defects without breaking legitimate recovery flows:

1. **Fix `jobOrchestrator.ts:894-897`**:
   Check for **both** failed and cancelled nodes:
   ```typescript
   const anyFailed = job.graph.nodes.some(
     (n) => n.state === 'failed' && !supersededTaskIds.has(n.taskId ?? n.id),
   );
   const anyCancelled = job.graph.nodes.some(
     (n) => n.state === 'cancelled',
   );
   const finalStatus = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed';
   await finishJob(finalStatus);
   ```

2. **Fix `jobOrchestrator.ts:476-487` (Timeout finalizer)**:
   Do not overwrite existing terminal statuses (`completed`, `failed`, `cancelled`):
   ```typescript
   for (const node of job.graph.nodes) {
     if (node.state !== 'completed' && node.state !== 'failed' && node.state !== 'cancelled') {
       node.state = 'failed';
       node.error = node.error ?? reason;
       node.completedAt = node.completedAt ?? new Date();
     }
   }
   for (const task of job.tasks) {
     if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
       task.status = 'failed';
     }
   }
   ```

3. **Fix `jobManager.ts:130-178` (`acquire`)**:
   Do not silently resurrect `failed` jobs back to `running`. If recovery is requested, either transition through an explicit retry/re-queue API or require re-instantiating the job.

4. **Fix `jobManager.ts:430-440` (`cancel`)**:
   Ensure `cancel()` cancels all non-terminal tasks (not just `pending` and `running`), and updates `job.graph.nodes` to `'cancelled'`.

5. **Fix `executionEngine.ts:1356-1362` (`assertLease`)**:
   Check `rejectIfTerminal && isTerminalExecutionStatus(record.execution.status)` before returning early on empty claimant.

6. **Fix `executionEngine.ts:450-457` (`setStatus`)**:
   Clear `record.execution.completedAt = undefined` when status transitions into a non-terminal status (`queued`, `pending`, `running`).

---

## 6. Ledger Update Entry

The following entries are recorded in `tests/formal-hardening/issues.csv`:
```csv
FORMAL-A07-LFC-01,P0,jobOrchestrator,A07,Gemini,gemini-flash,4661c33a6caeaca0639853463e4ccbbe3ebc63d8,packages/core/src/services/jobOrchestrator.ts,897,"Completed or cancelled work must not silently re-enter execution or be reported under a contradictory terminal status",Job is marked completed and emits job:completed when a required constituent task was cancelled,"npx vitest run tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts",tests/formal-hardening/models/a08-lifecycle-mutant.als,tests/formal-hardening/logs/alloy-a08-lifecycle-mutant/NoCompletedJobWithCancelledOrFailedTask-solution-0.txt,tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts,,,CONFIRMED,Bounded alloy verification scope 10 steps
FORMAL-A07-LFC-02,P0,jobOrchestrator,A07,Gemini,gemini-flash,4661c33a6caeaca0639853463e4ccbbe3ebc63d8,packages/core/src/services/jobOrchestrator.ts,485,"Terminal status monotonicity: cancelled tasks must not be rewritten to failed",Job timeout finalizer overwrites user-cancelled tasks and graph nodes to failed with timeout error string,"npx vitest run tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts",tests/formal-hardening/models/a08-lifecycle-mutant.als,tests/formal-hardening/logs/alloy-a08-lifecycle-mutant/NoTerminalResurrection-solution-0.txt,tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts,,,CONFIRMED,Bounded alloy verification scope 10 steps
FORMAL-A07-LFC-03,P0,jobManager,A07,Gemini,gemini-flash,4661c33a6caeaca0639853463e4ccbbe3ebc63d8,packages/core/src/services/jobManager.ts,176,"Failed jobs are terminal and must not silently resurrect to running",JobManager.acquire resets job status from failed to running when expired lease orphan is detected,"npx vitest run tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts",tests/formal-hardening/models/a08-lifecycle-mutant.als,,tests/formal-hardening/reproductions/a07-task-lifecycle.test.ts,,,CONFIRMED,Bounded alloy verification scope 10 steps
```
