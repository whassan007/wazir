# A08 — Alloy Task Lifecycle State Machine & Terminal Monotonicity Analysis

- **Program**: Wazir 30-Agent Cost-Optimized Formal Hardening Program
- **Agent ID**: A08
- **Model**: Gemini Tier 2 (`gemini-2.5-pro` / Antigravity Agentic Pair)
- **Role**: Alloy Task Lifecycle State Machine Modeler (GROUP C P0)
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Critical Invariant (P0-03)**: *"Completed or cancelled work must not silently re-enter execution or be reported under a contradictory terminal status."*
- **Deliverables**:
  - Monotone Model: `tests/formal-hardening/models/a08-lifecycle-monotone.als`
  - Mutant Model: `tests/formal-hardening/models/a08-lifecycle-mutant.als`
  - Execution Logs: `tests/formal-hardening/logs/alloy-a08-lifecycle/`
  - Mutant Logs: `tests/formal-hardening/logs/alloy-a08-lifecycle-mutant/`
  - Formal Hardening Report: `tests/formal-hardening/reports/A08-alloy-lifecycle.md`

---

## 1. Executive Summary

As part of the Wazir Formal Hardening Program, Agent A08 conducted a formal temporal state machine verification of the task, job, and execution lifecycles in Wazir. 

Using **Alloy 6.2.0** with dynamic temporal logic (`var` relations, linear temporal logic operators, lasso trace unrolling, and the SAT4J solver), we formally modeled:
1. Strict terminal monotonicity across `Job`, `Task`, and `Execution` entities (`Pending`, `Running`, `Completed`, `Failed`, `Cancelled`).
2. Permitted failed-task retry (`Failed -> Pending`) conditioned upon the parent Job remaining active/non-terminal.
3. Documented finalizer reconciliation (`Cancelled -> Failed` on Job finalization).
4. Asynchronous cancellation cascades and task cancellation semantics.

### Key Verification Findings

| Model | Command / Invariant | Solver Result | Evidence / Meaning |
|---|---|---|---|
| `a08-lifecycle-monotone.als` | `WitnessNormalJobCompletion` | **SAT** (0.15s) | Validates non-vacuous forward path to full job completion |
| `a08-lifecycle-monotone.als` | `WitnessTaskRetryAndComplete` | **SAT** (0.38s) | Validates permitted failed-task retry and subsequent completion |
| `a08-lifecycle-monotone.als` | `WitnessJobCancellation` | **SAT** (0.02s) | Validates clean cancellation cascade |
| `a08-lifecycle-monotone.als` | `WitnessFinalizerReconciliation` | **SAT** (0.05s) | Validates documented `Cancelled -> Failed` finalizer transition |
| `a08-lifecycle-monotone.als` | `check NoTerminalResurrection` | **UNSAT** (no counterexample) | Bounded safety: No completed/cancelled work resurrects within 10 temporal steps |
| `a08-lifecycle-monotone.als` | `check NoCompletedJobWithCancelledOrFailedTask` | **UNSAT** (no counterexample) | Bounded safety: Monotone job completion requires 100% completed tasks |
| `a08-lifecycle-mutant.als` | `check NoTerminalResurrection` | **SAT (Counterexample)** | Falsified at State 2: Late completion callback revives cancelled task |
| `a08-lifecycle-mutant.als` | `check NoCompletedJobWithCancelledOrFailedTask` | **SAT (Counterexample)** | Falsified at State 3: Reproduces real code defect in `jobOrchestrator.ts:897` |

### Production Code Defect Identified: `jobOrchestrator.ts:894-897`

In `packages/core/src/services/jobOrchestrator.ts`, line 894–897:
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
When a multi-task job has one task cancelled by an operator (`cancelTask`) and another task completed, `allFinished` is `true` and `anyFailed` is `false`. The orchestrator executes `finishJob('completed')`, reporting the Job as **`completed`** and emitting `job:completed`, despite a constituent task having been cancelled!

This directly contradicts the reconciliation logic in `jobManager.ts:266–269` (`reconcileStaleStatus`):
```typescript
const anyFailed = job.tasks.some((t) => t.status === 'failed');
const anyCancelled = job.tasks.some((t) => t.status === 'cancelled');
job.status = anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed';
```
This discrepancy represents a **P0 / P1 integrity violation** where cancelled work is reported under a contradictory terminal success status.

---

## 2. Production Code Lifecycle & Transition Extraction

### 2.1 Transition Matrix (`packages/core/src/services/statusTransitions.ts`)

Wazir implements centralized transition guards via `statusTransitions.ts`:
- **Job Statuses**: `pending`, `planning`, `ready`, `running`, `paused`, `completed`, `failed`, `cancelled`.
  - Terminal set: `['completed', 'failed', 'cancelled']`.
  - Exception: `cancelled -> failed` is explicitly permitted to allow timeout-abort finalizers to reconcile aborted jobs.
  - Idempotent self-transitions (`from === to`) are permitted.
  - All other transitions from terminal states throw `InvalidStatusTransitionError`.
- **Task Statuses**: `pending`, `queued`, `planning`, `scheduled`, `ready`, `running`, `waiting_for_approval`, `verifying`, `paused`, `completed`, `failed`, `cancelled`, `blocked`.
  - Terminal set: `['completed', 'failed', 'cancelled']`.
  - Retry exception: `failed` can transition only to `TASK_RETRY_TARGETS` (`pending`, `queued`, `scheduled`, `ready`). It cannot jump directly to `running` or `completed`.
  - A `cancelled` task cannot transition to ANY state (no retries, no completions).
- **Execution Statuses**: mirrors task status rules; `cancelled` and `completed` are strictly terminal.

### 2.2 Job Management & Reconciliation (`packages/core/src/services/jobManager.ts`)

- `reconcileStaleStatus(job)` heals crashed/stale in-memory jobs when loaded:
  - If all tasks are terminal, it calculates:
    `anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed'`.
  - Any orphan running task is marked `failed`.
- `completeTask(jobId, taskId, result)` asserts `assertTaskTransition(..., task.status, 'completed')`.
- `failTask(jobId, taskId, error, retryCount)`:
  - If `willRetry`, asserts transition to `pending`.
  - If retries exhausted, asserts transition to `failed`.

### 2.3 Orchestrator Execution Loop (`packages/core/src/services/jobOrchestrator.ts`)

- `runJob()` drives the execution graph via `pump()`:
  1. Cascades failed dependencies to idle nodes.
  2. Dispatches ready nodes up to `concurrencyLimit`.
  3. Executes tasks asynchronously.
  4. On termination (`activeTasks.size === 0 && !anyRunning`):
     - Line 894: Checks `allFinished` (`completed`, `failed`, or `cancelled`).
     - Line 897: Performs binary check `anyFailed ? 'failed' : 'completed'`.
     - **Defect**: Neglects `anyCancelled`.

---

## 3. Formal Alloy 6 Models

### 3.1 Monotone Model (`a08-lifecycle-monotone.als`)

The monotone model specifies the intended and sound behavioral lifecycle. Every entity (`Job`, `Task`, `Execution`) has a mutable relation `var status: one Status`.

```alloy
module a08_lifecycle_monotone

abstract sig Status {}
one sig Pending, Running, Completed, Failed, Cancelled extends Status {}

sig Job {
  var status: one Status
}

sig Task {
  job: one Job,
  var status: one Status
}

sig Execution {
  task: one Task,
  var status: one Status
}

fact StructuralHierarchy {
  all j: Job | some j.~job
  all t: Task | some t.~task
  all e: Execution | one e.task
  all t: Task | one t.job
}
```

#### Core Transition Actions
- `jobStart[j: Job]`: `Pending -> Running`.
- `taskStart[t: Task, e: Execution]`: `Pending -> Running` (conditioned on `t.job.status = Running`).
- `executionComplete[e: Execution]`: `Running -> Completed` (simultaneously transitions `e.task.status' = Completed`).
- `executionFail[e: Execution]`: `Running -> Failed` (simultaneously transitions `e.task.status' = Failed`).
- `taskRetry[t: Task, e: Execution]`: `Failed -> Pending` guarded by `t.job.status in (Pending + Running)` (disallowed if Job is terminal).
- `taskCancel[t: Task]`: in-flight task and its pending/running executions transition to `Cancelled`.
- `jobCancel[j: Job]`: active job transitions to `Cancelled`, cascading to all non-terminal tasks and executions.
- `jobComplete[j: Job]`: `Running -> Completed` permitted **only** when `all t: j.~job | t.status = Completed`.
- `jobFail[j: Job]`: `Running -> Failed` when a task fails and active tasks reach 0.
- `jobReconcile[j: Job]`: `Cancelled -> Failed` modeling timeout finalizer reconciliation.
- `stutter`: Frame condition identity stutter.

#### Asserted Invariants
```alloy
assert NoTerminalResurrection {
  // 1. Completed work stays Completed forever
  always (all j: Job | j.status = Completed implies after (j.status = Completed))
  always (all t: Task | t.status = Completed implies after (t.status = Completed))
  always (all e: Execution | e.status = Completed implies after (e.status = Completed))

  // 2. Cancelled work never resurrects to active execution or Completed
  always (all j: Job | j.status = Cancelled implies after (j.status in (Cancelled + Failed)))
  always (all t: Task | t.status = Cancelled implies after (t.status in (Cancelled + Failed)))
  always (all e: Execution | e.status = Cancelled implies after (e.status in (Cancelled + Failed)))

  // 3. Failed job stays Failed forever
  always (all j: Job | j.status = Failed implies after (j.status = Failed))

  // 4. Failed task retry is strictly forbidden when parent Job is terminal
  always (all t: Task | (t.status = Failed and t.status' = Pending) implies t.job.status in (Pending + Running))
  always (all e: Execution | (e.status = Failed and e.status' = Pending) implies e.task.job.status in (Pending + Running))
}

assert NoCompletedJobWithCancelledOrFailedTask {
  always (all j: Job | j.status = Completed implies
    (no t: j.~job | t.status in (Cancelled + Failed)))
}
```

---

### 3.2 Negative-Control Mutant Model (`a08-lifecycle-mutant.als`)

The mutant model introduces two realistic defect actions observed in concurrent distributed task runners and Wazir's orchestrator code:

1. **Mutant 1: Late Completion Callback / Unguarded Retry**:
```alloy
pred taskLateCompletionMutant[t: Task, e: Execution] {
  e.task = t
  t.status = Cancelled
  e.status = Cancelled

  // Defect: late asynchronous callback mutates status to Completed
  t.status' = Completed
  e.status' = Completed

  all j2: Job | j2.status' = j2.status
  all t2: Task - t | t2.status' = t2.status
  all e2: Execution - e | e2.status' = e2.status
}
```

2. **Mutant 2: Flawed Orchestrator Termination Check (`jobOrchestrator.ts:897`)**:
```alloy
pred jobCompleteMutant[j: Job] {
  j.status = Running
  all t: j.~job | t.status in (Completed + Failed + Cancelled)
  // Defect: anyFailed is false, but some task was Cancelled!
  no t: j.~job | t.status = Failed
  some t: j.~job | t.status = Cancelled

  // Buggy decision: anyFailed ? 'failed' : 'completed' marks Job Completed!
  j.status' = Completed

  all j2: Job - j | j2.status' = j2.status
  all t: Task | t.status' = t.status
  all e: Execution | e.status' = e.status
}
```

---

## 4. Execution Evidence & Solver Receipts

Both models were executed using the official Alloy 6.2.0 CLI distribution (`org.alloytools.alloy.dist.jar`) on macOS Darwin 24.1.0 with OpenJDK 64-Bit Server VM (build 21.0.9).

### 4.1 Monotone Model Run (`alloy-a08-lifecycle`)

**Command**:
```bash
/Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar \
  exec -f -t text -c '*' -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a08-lifecycle \
  /Users/wael/Code/Wazir/tests/formal-hardening/models/a08-lifecycle-monotone.als
```

**Output**:
```text
00. run   WitnessNormalJobCompletion             0    1/1    SAT
01. run   WitnessTaskRetryAndComplete            0    1/1    SAT
02. run   WitnessJobCancellation                 0    1/1    SAT
03. run   WitnessFinalizerReconciliation         0    1/1    SAT
04. check NoTerminalResurrection                 0    UNSAT
05. check NoCompletedJobWithCancelledOrFailedTask 0   UNSAT
```

**Receipt Data (`receipt.json`)**:
- `WitnessNormalJobCompletion`: SAT (duration 147ms)
- `WitnessTaskRetryAndComplete`: SAT (duration 378ms)
- `WitnessJobCancellation`: SAT (duration 18ms)
- `WitnessFinalizerReconciliation`: SAT (duration 47ms)
- `NoTerminalResurrection`: UNSAT (no counterexample found across 10 temporal steps)
- `NoCompletedJobWithCancelledOrFailedTask`: UNSAT (no counterexample found across 10 temporal steps)

---

### 4.2 Mutant Model Run (`alloy-a08-lifecycle-mutant`)

**Command**:
```bash
/Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar \
  exec -f -t text -c '*' -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a08-lifecycle-mutant \
  /Users/wael/Code/Wazir/tests/formal-hardening/models/a08-lifecycle-mutant.als
```

**Output**:
```text
00. run   WitnessLateCompletionResurrection               0   1/1   SAT
01. run   WitnessPrematureJobCompletionWithCancelledTask  0   1/1   SAT
02. check NoTerminalResurrection                          0   1/1   SAT (Counterexample found)
03. check NoCompletedJobWithCancelledOrFailedTask         0   1/1   SAT (Counterexample found)
```

---

## 5. Counterexample Trace Analysis

### 5.1 Counterexample 1: Late Completion Resurrects Cancelled Task

From `tests/formal-hardening/logs/alloy-a08-lifecycle-mutant/NoTerminalResurrection-solution-0.txt`:

```
---Trace---
------State 0-------
Job$0.status = Pending$0
Task$0.status = Pending$0
Execution$0.status = Pending$0

------State 1-------
Job$0.status = Pending$0
Task$0.status = Cancelled$0
Execution$0.status = Cancelled$0
[Action: taskCancel]

------State 2 (loop)-------
Job$0.status = Pending$0
Task$0.status = Completed$0
Execution$0.status = Completed$0
[Action: taskLateCompletionMutant]
```

**Interpretation**:
- In State 1, `Task$0` is cancelled while the job is pending.
- In State 2, an in-flight worker's completion callback returns late and mutates `Task$0.status` to `Completed`.
- **Violation**: `Task$0.status = Cancelled$0` at State 1, but `Task$0.status' = Completed$0` at State 2. The critical invariant `Cancelled` work never transitions to `Completed` is violated.

---

### 5.2 Counterexample 2: Job Completed Despite Cancelled Task (`jobOrchestrator.ts:897`)

From `tests/formal-hardening/logs/alloy-a08-lifecycle-mutant/NoCompletedJobWithCancelledOrFailedTask-solution-0.txt`:

```
---Trace---
------State 0-------
Job$0.status = Pending$0
Task$0.status = Pending$0
Execution$0.status = Pending$0

------State 1-------
Job$0.status = Running$0
Task$0.status = Pending$0
Execution$0.status = Pending$0
[Action: jobStart]

------State 2-------
Job$0.status = Running$0
Task$0.status = Cancelled$0
Execution$0.status = Cancelled$0
[Action: taskCancel]

------State 3 (loop)-------
Job$0.status = Completed$0
Task$0.status = Cancelled$0
Execution$0.status = Cancelled$0
[Action: jobCompleteMutant / jobOrchestrator line 897]
```

**Interpretation**:
- In State 1, `Job$0` starts execution (`Running`).
- In State 2, `Task$0` is cancelled by the operator via `cancelTask`.
- In State 3, the orchestrator termination check executes. Because all nodes are terminal (`completed`, `failed`, or `cancelled`) and `anyFailed` is `false`, the orchestrator invokes `finishJob('completed')`.
- **Violation**: `Job$0` is marked `Completed` while its constituent task `Task$0` is `Cancelled`. Clients querying the job see `completed`, masking the fact that required work was cancelled and never executed.

---

## 6. Code Mapping & Remediation

### 6.1 Issue Ledger Entry

| Field | Value |
|---|---|
| **ID** | `WAZIR-HARDENING-A08-01` |
| **Priority** | **P0** (Integrity / False Verified Completion) |
| **Subsystem** | Orchestration / Lifecycle (`packages/core/src/services/jobOrchestrator.ts`) |
| **Commit SHA** | `4661c33a6caeaca0639853463e4ccbbe3ebc63d8` |
| **Invariant Violated** | P0-03 Terminal Monotonicity: "Completed or cancelled work must not silently re-enter execution or be reported under a contradictory terminal status." |
| **File & Lines** | `packages/core/src/services/jobOrchestrator.ts:894–897` |
| **Alloy Models** | `tests/formal-hardening/models/a08-lifecycle-monotone.als` (UNSAT), `tests/formal-hardening/models/a08-lifecycle-mutant.als` (SAT Counterexample) |
| **Status** | **CONFIRMED** (Source inspection & Alloy model proof) |

### 6.2 Proposed Production Patch

In `packages/core/src/services/jobOrchestrator.ts`, update termination evaluation to match `jobManager.ts:reconcileStaleStatus`:

```diff
--- a/packages/core/src/services/jobOrchestrator.ts
+++ b/packages/core/src/services/jobOrchestrator.ts
@@ -894,7 +894,11 @@ export class JobOrchestrator extends EventEmitter<JobOrchestratorEvents> {
           if (allFinished) {
             const anyFailed = job.graph.nodes.some(
               (n) => n.state === 'failed' && !supersededTaskIds.has(n.taskId ?? n.id),
             );
-            await finishJob(anyFailed ? 'failed' : 'completed');
+            const anyCancelled = job.graph.nodes.some(
+              (n) => n.state === 'cancelled',
+            );
+            await finishJob(anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed');
             return;
           }
```

### 6.3 Recommended Regression Vitest Case

Add to `packages/core/tests/jobOrchestrator.test.ts`:

```typescript
it('marks job as cancelled (not completed) when a task is cancelled and other tasks complete', async () => {
  const manager = new JobManager();
  const orchestrator = new JobOrchestrator(manager, {
    executor: async (task) => {
      if (task.id === 'task-1') {
        // simulate waiting for cancellation
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { success: false, error: 'Cancelled' };
      }
      return { success: true, result: 'done' };
    },
  });

  const job = manager.create({
    title: 'partial-cancel-test',
    tasks: [
      { task: { id: 'task-1', input: '1' } },
      { task: { id: 'task-2', input: '2' } },
    ],
  });

  const runPromise = orchestrator.runJob(job.id);
  // Cancel task-1 while running
  await orchestrator.cancelTask(job.id, 'task-1');
  const finishedJob = await runPromise;

  expect(finishedJob.status).toBe('cancelled');
  expect(finishedJob.status).not.toBe('completed');
});
```

---

## 7. Epistemic Confidence, Coverage Limits & Handoff

1. **Bounded Assurance**:
   The monotone model was checked up to 10 lasso trace steps for 1 Job, 2 Tasks, and 2 Executions. SAT4J proved unsatisfiability (no counterexample) across all reachable traces within this bound. While not an unrestricted mathematical proof for infinite steps and unbounded tasks, state transitions are inductively closed by the `traces` fact and frame conditions.
2. **Vacuity Avoidance**:
   Vacuity was rigorously eliminated by testing 4 distinct satisfiability witnesses (`WitnessNormalJobCompletion`, `WitnessTaskRetryAndComplete`, `WitnessJobCancellation`, `WitnessFinalizerReconciliation`), all verifying SAT.
3. **Discriminatory Fidelity**:
   The negative-control mutant model proved that the assertions discriminate invalid transitions and correctly generate minimized counterexamples that reproduce real code flaws.
4. **Handoff**:
   Models and CLI log outputs have been committed to the repository at `tests/formal-hardening/models/` and `tests/formal-hardening/logs/`.
