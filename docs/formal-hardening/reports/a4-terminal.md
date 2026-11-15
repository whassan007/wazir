# Subagent A4 Findings Report: Terminal Status & Cancellation Monotonicity

- **Subagent**: A4 (Terminal Status & Cancellation Monotonicity)
- **Target Repository**: Wazir (`whassan007/wazir`)
- **Git HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Isolated Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh-a4-terminal`
- **Alloy Analyzer JAR**: `/Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar` (Alloy 6.2.0, SAT4J)
- **Status**: **CONFIRMED & FIXED**

---

## 1. Executive Summary

As part of the Wazir 12-Agent Formal Hardening Campaign, Subagent A4 investigated terminal state monotonicity, cancellation races, completion callbacks, and retry dispatch across `jobOrchestrator.ts`, `jobManager.ts`, `statusTransitions.ts`, and `proactive/taskManager.ts`.

Using formal temporal modeling in Alloy 6 verified via the Alloy Analyzer CLI, complemented by negative-control mutation testing and deterministic Vitest reproductions, we uncovered and remediated **4 verified defects** (1 P0 critical safety bug, 3 P1 integrity/reliability bugs) in Wazir's production orchestration engine:

1. **[P0] False Completion Masking Cancelled Tasks (`A4-01`)**: When tasks in a job were cancelled (via `cancelTask`), the job orchestrator's graph walk evaluated `allFinished` but only checked `anyFailed`. If no tasks failed, the job unconditionally transitioned to `completed` and emitted `job:completed`, masking cancelled work as verified completion.
2. **[P1] Cancellation-Placement TOCTOU Race (`A4-02`)**: When `cancelTask` or `cancelJob` raced with an asynchronous `assignTask` awaiting worker resources, `assignTask` completion blindly transitioned the node from `cancelled` to `running`, triggering an uncaught `InvalidStatusTransitionError: cancelled -> running` that crashed the entire orchestrator pump loop.
3. **[P1] Illegal Retry Dispatch on Cancelled Jobs (`A4-03`)**: When a job was cancelled while a task was in-flight, a subsequent failure or exception from the task triggered the retry handler, attempting `updateTaskStatus(..., 'pending')` on a cancelled task and crashing with uncaught `InvalidStatusTransitionError: cancelled -> pending`.
4. **[P1] ProactiveTaskManager Terminal Resurrections (`A4-04`)**: `ProactiveTaskManager` had zero status transition validation; cancelled, completed, or failed tasks were resurrected to `running` via `updateStatus`, and `recordTrigger` mutated trigger counts and flipped cancelled tasks to `completed`.

All defects were deterministically reproduced with failing tests on the unpatched codebase, verified against Alloy 6 counterexamples, minimally patched in `/Users/wael/Code/Wazir/.worktrees/fh-a4-terminal`, and confirmed passing across all 7 hardening test cases and 54 existing core lifecycle/orchestrator tests.

---

## 2. Invariants & Alloy 6 Formal Specification

We authored an Alloy 6 temporal specification in `docs/formal-hardening/models/a4-terminal.als` and a negative control mutant in `docs/formal-hardening/models/a4-terminal-mutant.als`.

### Key Formal Invariants

1. **`JobTerminalMonotonicity`**:
   $$\Box \left( (\text{Job} \in \text{Completed} \cup \text{Failed} \implies \Box (\text{Job} = \text{Job})) \land (\text{Job} = \text{Cancelled} \implies \Box (\text{Job} \in \text{Cancelled} \cup \text{Failed})) \right)$$
   Once terminal, a job never reverts to `Pending` or `Running`. Cancelled jobs may only reconcile to `Failed` (for timeout abort finalization).
2. **`TaskTerminalMonotonicity`**:
   $$\Box \left( \forall t \in \text{Tasks} \ldotp (t.\text{status} \in \text{Completed} \cup \text{Cancelled}) \implies \Box (t.\text{status} = t.\text{status}) \right)$$
   Completed or cancelled tasks never transition to any other status.
3. **`NoCompletedJobWithCancelledTasks`**:
   $$\Box \left( \text{Job} = \text{Completed} \implies \neg \exists t \in \text{Tasks} \ldotp t.\text{status} \in \text{Cancelled} \cup \text{Failed} \right)$$
   A job may reach `JobCompleted` only if ALL tasks succeeded; a cancelled task can never be masked under a completed job.
4. **`NoTaskRetryOnCancelledJob`**:
   $$\Box \left( \text{Job} \in \text{Cancelled} \cup \text{Failed} \cup \text{Completed} \implies \Box \forall t \in \text{Tasks} \ldotp t.\text{status}' \notin \text{Pending} \cup \text{Running} \right)$$
   When a job is cancelled, no task within it can ever be retried or transition back to `Pending`/`Running`.
5. **`CancelledTaskNeverCompletes`**:
   $$\Box \left( \forall t \in \text{Tasks} \ldotp t.\text{status} = \text{Cancelled} \implies \Box (t.\text{status} \neq \text{Completed}) \right)$$
   Immunity to late completion callbacks.

### Alloy 6 Execution Evidence

**Analyzer CLI Execution Command**:
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a4-terminal \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a4-terminal.als
```

**Alloy Analyzer Output (`a4-terminal.als`)**:
```text
00. run   WitnessNormalJobCompletion                      SAT (instance found)
01. run   WitnessTaskCancellationAndJobTermination        SAT (instance found)
02. run   WitnessTaskRetryThenSuccess                     SAT (instance found)
03. check JobTerminalMonotonicity                         UNSAT (no counterexample, 2 Task, 7 steps)
04. check TaskTerminalMonotonicity                        UNSAT (no counterexample, 2 Task, 7 steps)
05. check NoCompletedJobWithCancelledTasks                UNSAT (no counterexample, 2 Task, 7 steps)
06. check NoTaskRetryOnCancelledJob                       UNSAT (no counterexample, 2 Task, 7 steps)
07. check CancelledTaskNeverCompletes                     UNSAT (no counterexample, 2 Task, 7 steps)
```

**Negative Control Mutant (`a4-terminal-mutant.als`)**:
We introduced the exact flawed logic from `jobOrchestrator.ts:891-897` into `a4-terminal-mutant.als`:
```alloy
pred finishJobActionMutant {
  Job.jobStatus = JobRunning
  all t: Job.tasks | t.taskStatus in TaskCompleted + TaskFailed + TaskCancelled
  (some t: Job.tasks | t.taskStatus = TaskFailed) implies {
    Job.jobStatus' = JobFailed
  } else {
    Job.jobStatus' = JobCompleted
  }
  taskStatus' = taskStatus
}
```
Executing Alloy on `a4-terminal-mutant.als`:
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a4-terminal-mutant \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a4-terminal-mutant.als
```
Output:
```text
00. check NoCompletedJobWithCancelledTasks                SAT (COUNTEREXAMPLE FOUND)
```
The solver extracted a 4-state trace violating `NoCompletedJobWithCancelledTasks`:
1. `JobRunning`, `Task0: TaskRunning`, `Task1: TaskPending`
2. `JobRunning`, `Task0: TaskCompleted`, `Task1: TaskCancelled`
3. `JobCompleted`, `Task0: TaskCompleted`, `Task1: TaskCancelled` $\leftarrow$ **Violation**

---

## 3. Discovered Production Defects

### A4-01 [P0]: False Verified Job Completion Masking Task Cancellation
- **Location**: `packages/core/src/services/jobOrchestrator.ts:891-897`
- **Flaw**:
  ```ts
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
  If a task was cancelled (via `cancelTask`), but no task failed, `anyFailed` was `false`. The orchestrator called `finishJob('completed')`. Because `cancelTask` does not abort the top-level `jobAbortController` or set `job.status = 'cancelled'`, `finishJob` transitioned the job to `completed` and emitted `job:completed`.
- **Impact**: Missions where work was aborted or cancelled by the user reported 100% success/completion to callers, webhooks, and downstream workflows.
- **Fix**: Check `anyCancelled = job.graph.nodes.some(n => n.state === 'cancelled')`. If true, call `finishJob(anyFailed ? 'failed' : 'cancelled')`.

### A4-02 [P1]: Placement-Cancellation TOCTOU Race Crashing Pump Loop
- **Location**: `packages/core/src/services/jobOrchestrator.ts:580-615`
- **Flaw**:
  During `await this.assignTask(job.id, taskId)`, worker placement queries the scheduler and execution engine asynchronously. If `cancelTask` or `cancelJob` is called during this window, the task/node state transitions to `'cancelled'`. Upon resolving `assignTask`, the orchestrator immediately ran:
  ```ts
  node.state = 'running';
  await this.jobManager.updateAgentState(job.id, node.id, 'running');
  await this.jobManager.updateTaskStatus(job.id, taskId, 'running');
  ```
  `assertNodeTransition('cancelled', 'running')` threw `InvalidStatusTransitionError`. Because this was inside `doPump()`, it caused an unhandled rejection in the pump loop and crashed the job execution.
- **Impact**: Cancellation during scheduling or placement crashed the orchestrator with uncaught errors instead of cleanly stopping the job.
- **Fix**: Added explicit cancellation checks (`taskAbort.signal.aborted || jobAbortController.signal.aborted || node.state === 'cancelled' || task.status === 'cancelled' || job.status === 'cancelled'`) immediately after `assignTask` returns and in its `catch` block to cleanly bail out and release `activeTasks`.

### A4-03 [P1]: Uncaught Rejection on Task Retry After Job Cancellation
- **Location**: `packages/core/src/services/jobOrchestrator.ts:771-797, 841-860`
- **Flaw**:
  When a job was cancelled via `jobManager.cancel(job.id)` (e.g. from an external worker, recovery daemon, or control plane), tasks were transitioned to `'cancelled'`. If an in-flight executor completed with failure or threw an exception, lines 773 and 843 checked `retries < maxRetries` and unconditionally attempted:
  ```ts
  await this.jobManager.updateAgentState(job.id, node.id, 'idle');
  await this.jobManager.updateTaskStatus(job.id, taskId, 'pending');
  ```
  `assertTaskTransition('cancelled', 'pending')` threw `InvalidStatusTransitionError`, rejecting the asynchronous task IIFE without handling and crashing `runJob`.
- **Impact**: Retrying tasks on cancelled jobs violated terminal monotonicity and led to unhandled promise rejections.
- **Fix**: Added `isCancelled` check before entering the retry logic in all 4 retry handlers. If the job or task is cancelled, retry is skipped, state is finalized as `cancelled`, and the task aborts cleanly.

### A4-04 [P1]: ProactiveTaskManager Lack of Terminal Monotonicity
- **Location**: `packages/core/src/proactive/taskManager.ts:80-120`
- **Flaw**:
  `ProactiveTaskManager` had no status transition validation. `updateStatus(taskId, 'running')` allowed resurrecting cancelled, completed, or failed tasks. `recordTrigger(taskId)` mutated trigger counters and flipped cancelled tasks to `'completed'` if `!repeat`. `cancelTask(taskId)` allowed overwriting already completed tasks.
- **Impact**: Background health checks and proactive execution monitors could be resurrected from terminal states or falsely reported as completed.
- **Fix**: Introduced `TERMINAL_PROACTIVE_STATUS` (`completed`, `cancelled`, `failed`) and guarded `updateStatus`, `recordTrigger`, and `cancelTask` against mutating terminal tasks.

### Additional Hardening:
- **Duplicate `task:cancelled` and `job:cancelled` events**: Fixed line 921 in `jobOrchestrator.ts` to check `handle.cancelledTaskIds.has(taskId)` before emitting `task:cancelled` when an aborted executor rejects. Added deduplication for `job:cancelled` in `cancelJob` and `finishJob`.
- **In-Memory `JobManager.cancel` Graph Node Synchronization**: Updated `jobManager.cancel` in-memory branch to cancel `job.graph.nodes` consistently with the store-backed branch.
- **Immediate Pump Waking**: Added `handle?.wakePump?.()` to `cancelTask` and `cancelJob` so cancellations take effect immediately without awaiting subsequent task completions.

---

## 4. Verification Evidence & Test Results

### Deterministic Reproduction Test Suite

File: `packages/core/tests/terminalMonotonicityHardening.test.ts`

**Pre-Fix Failure Output**:
```text
FAIL packages/core/tests/terminalMonotonicityHardening.test.ts
  ✕ A4-Bug1: job must never finish as completed when a task was cancelled
    AssertionError: expected 'completed' not to be 'completed'
  ✕ A4-Bug1b: single-task job cancelled via cancelTask must finish as cancelled, not completed
    AssertionError: expected 'completed' not to be 'completed'
  ✕ A4-Bug2: cancellation racing with assignTask must not throw InvalidStatusTransitionError
    InvalidStatusTransitionError: Invalid task status transition: cancelled -> running
  ✕ A4-Bug3c: late failure after jobManager.cancel must not retry task or crash
    InvalidStatusTransitionError: Invalid task status transition: cancelled -> pending
  ✕ A4-Bug4: ProactiveTaskManager must enforce terminal status monotonicity
    AssertionError: expected 'running' not to be 'running'
```

**Post-Fix Passing Output**:
```text
✓ packages/core/tests/terminalMonotonicityHardening.test.ts (7)
  ✓ A4-Bug1: job must never finish as completed when a task was cancelled
  ✓ A4-Bug1b: single-task job cancelled via cancelTask must finish as cancelled, not completed
  ✓ A4-Bug2: cancellation racing with assignTask must not throw InvalidStatusTransitionError or resurrect cancelled node
  ✓ A4-Bug3: a task must never be retried after the job is cancelled
  ✓ A4-Bug3b: late failure from executor after job is cancelled must not retry or transition cancelled task to pending
  ✓ A4-Bug3c: late failure after jobManager.cancel must not retry task or crash with uncaught InvalidStatusTransitionError
  ✓ A4-Bug4: ProactiveTaskManager must enforce terminal status monotonicity

Test Files  1 passed (1)
     Tests  7 passed (7)
```

**Regression Suite Across Affected Subsystems**:
```text
Test Files  5 passed (5)
     Tests  54 passed (54)
✓ packages/core/tests/jobOrchestrator.test.ts (19 passed)
✓ packages/core/tests/jobLifecycleAndValidation.test.ts (15 passed)
✓ packages/core/tests/statusTransitions.test.ts (9 passed)
✓ packages/core/tests/recoveryManager.test.ts (4 passed)
✓ packages/core/tests/terminalMonotonicityHardening.test.ts (7 passed)
```

---

## 5. Summary of Files Changed

In isolated worktree `/Users/wael/Code/Wazir/.worktrees/fh-a4-terminal`:
1. `packages/core/src/services/jobOrchestrator.ts`:
   - Termination logic checks `anyCancelled` before completing job.
   - Guarded `assignTask` against cancellation TOCTOU race.
   - Guarded retry dispatch against job and task cancellation.
   - Deduplicated cancellation event emissions; added `wakePump()` on cancel.
2. `packages/core/src/proactive/taskManager.ts`:
   - Added `TERMINAL_PROACTIVE_STATUS` guards to `updateStatus`, `recordTrigger`, and `cancelTask`.
3. `packages/core/src/services/jobManager.ts`:
   - Synchronized graph node cancellation in in-memory `cancel`.
4. `packages/core/tests/terminalMonotonicityHardening.test.ts`:
   - 7 deterministic Vitest regression test cases for all terminal monotonicity scenarios.

In docs / formal hardening directory:
1. `docs/formal-hardening/models/a4-terminal.als` (temporal model with 5 invariants & 3 witnesses)
2. `docs/formal-hardening/models/a4-terminal-mutant.als` (flawed mutant finding counterexample)
3. `docs/formal-hardening/results/a4-terminal/receipt.json` (Alloy 6 verification receipt)
4. `docs/formal-hardening/results/a4-terminal-mutant/receipt.json` (Alloy 6 counterexample receipt)
5. `docs/formal-hardening/reports/a4-ledger.csv` (CSV ledger rows for A4-01 through A4-04)
6. `docs/formal-hardening/reports/a4-terminal.md` (this report)
