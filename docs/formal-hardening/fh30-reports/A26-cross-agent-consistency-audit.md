# A26 — Formal Audit Report: Context Propagation, Delegation Permissions & Cross-Agent Consistency

- **Agent ID**: A26 (Gemini TIER 1 — Context Propagation & Cross-Agent Consistency Auditor)
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target Commit**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Assigned Subsystem**: Context Propagation, Delegation Permissions, Event Ordering, Cross-Agent Result Consistency (GROUP I P1)
- **Critical Invariant**: *"One agent must not silently overwrite another agent's confirmed work."*
- **Alloy 6 Formal Model**: [`tests/formal-hardening/models/a26-cross-agent-consistency.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a26-cross-agent-consistency.als)
- **Deterministic Reproduction Suite**: [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (7 / 7 confirmed passing tests)
- **Status**: **CONFIRMED PRODUCTION DEFECTS IDENTIFIED & DETERMINISTICALLY REPRODUCED**

---

## 1. Executive Summary

This formal audit investigated the lifecycle of multi-agent and multi-task graph execution in Wazir, specifically examining how upstream task outputs, shared context objects, steering instructions, permissions, and event sequences propagate across fan-out / fan-in task graphs. The investigation encompassed [`JobOrchestrator`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts), [`JobManager`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts), [`ExecutionEngine`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts), [`WorktreeManager`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts), [`VerifiedIntegrationCoordinator`](file:///Users/wael/Code/Wazir/packages/core/src/services/verifiedIntegrationCoordinator.ts), [`CodingAgent`](file:///Users/wael/Code/Wazir/packages/agents/src/codingAgent.ts), [`fleetRunner.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts), and [`run.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts).

Our analysis confirmed that **the critical invariant ("One agent must not silently overwrite another agent's confirmed work") is violated across multiple reachable production paths**. Specifically:

1. **Silent Loss of Confirmed Work on AutoMerge Conflict**: When tasks execute in isolated worktrees (`shareJobWorktree === false`), [`fleetRunner.ts:649`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L648-L650) invokes `engine.worktrees.mergeBranch(engine.projectRoot, worktreeInfo.branch)`. If two concurrent tasks modify the same file, Git triggers a conflict, `mergeBranch` runs `git merge --abort`, and returns `{ success: false, conflicts: [...] }`. Crucially, `fleetRunner.ts` **completely ignores the return value**. No exception is thrown; the runner reports `success: true`. [`JobOrchestrator`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L705-L715) marks the task as **`completed`**, even though its verified work was completely aborted and dropped from the repository. Downstream fan-in tasks run against a workspace where upstream confirmed changes do not exist.
2. **Shared Worktree Premature Commit & Mutation Race**: Under default settings (`runnerOptions.shareJobWorktree !== false`), all tasks within a job share a single worktree directory via `getOrCreateJobWorktree(projectRoot, jobId)`. In a fan-out graph where multiple tasks run concurrently, [`commitWorktree`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L385) executes `git add -A`. When Task 1 completes, it stages and commits **unverified, broken intermediate files belonging to concurrently executing Task 2**. If autoMerge is enabled, Task 2's unverified changes are merged into the target repository before Task 2 has passed verification. If Task 2 subsequently fails or cancels, its broken edits remain permanently committed.
3. **Fan-In Context Propagation Loss via ID Mismatch**: In [`JobOrchestrator.ts:648`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L648-L649), upstream outcomes are propagated to downstream tasks using `job.graph.nodes.filter(n => node.dependencies.includes(n.id))`. While [`JobManager.ts:779, 793`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts#L779) checks both `n.id === dep || n.taskId === dep`, `JobOrchestrator` strictly checks `node.dependencies.includes(n.id)`. When tasks specify dependencies by `taskId` (the standard in task creation, replanning, and dynamic repair), `node.dependencies.includes(n.id)` evaluates to `false` whenever `n.id !== n.taskId`. Consequently, `previousOutcomes` is empty (`Map(0) {}`), and downstream fan-in nodes receive zero upstream context or outputs.
4. **Live Mutable Graph References Exposed to Asynchronous Executors**: In [`JobOrchestrator.ts:627, 658`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L627), `JobTaskExecutionContext` passes raw, unfrozen references to `node` (`job.graph.nodes[i]`) and `task` (`job.tasks[i]`). Any asynchronous executor or agent can mutate `context.node.state = 'failed'` or `task.input = '...'` in memory, directly corrupting the authoritative job state and bypassing `JobManager` transition invariant checks.
5. **Subagent Delegation Privilege Escalation**: When an agent delegates via `dispatch_subagent`, [`run.ts:1408`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1408) provisions tools by inspecting `wazir-coding` capabilities rather than constraining them to the parent agent's capability bounds. A restricted read-only agent (e.g. auditor, reviewer) can dispatch a subagent that receives full filesystem mutation (`write`, `edit`) and arbitrary execution (`shell`), bypassing parent capability restrictions and sandboxing.
6. **Steering Instructions Lost on DAG Fan-In & Task Retries**: In [`JobOrchestrator.ts:178-187`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L178-L187), `steerJob` only iterates over `handle.activeTasks.keys()`. Any queued, idle, or downstream fan-in tasks never receive steering instructions. Furthermore, when an active task fails and retries, line 881 (`this.steeringQueues.delete(taskId)`) purges the steering queue, ensuring that retried attempts run unsteered.
7. **Complete Bypass of VerifiedIntegrationCoordinator**: Although Wazir contains a formally specified [`VerifiedIntegrationCoordinator`](file:///Users/wael/Code/Wazir/packages/core/src/services/verifiedIntegrationCoordinator.ts) with semantic conflict analysis, oracle protection, and spec write fencing, neither `JobOrchestrator` nor `createFleetTaskExecutor` calls it during multi-agent DAG execution, instead relying on unguarded calls to `worktreeManager.mergeBranch`.

---

## 2. Exhaustive Cross-Agent State & Context Mutation Matrix

| Subsystem / Operation | Source File & Line | Concurrency Gate | Isolation Mechanism | Observed Behavior / Defect | Severity |
|---|---|---|---|---|---|
| **AutoMerge Conflict Handling** | [`fleetRunner.ts:648-650`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L648-L650) | ❌ None | Isolated worktree branch | `mergeBranch` returns `{ success: false }`; return value is ignored. Task reports `completed`, confirmed work is silently lost. | **P1 (Critical)** |
| **Shared Worktree Staging** | [`fleetRunner.ts:109-112`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L109-L112), [`worktreeManager.ts:385`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L385) | ❌ None | Shared job worktree | `git add -A` commits concurrent task's unverified broken files into another task's verified commit; auto-merges broken code. | **P1 (Critical)** |
| **Fan-In Context Propagation** | [`jobOrchestrator.ts:648-649`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L648-L649) | ❌ Broken filter | In-memory `Map` | Filters on `node.dependencies.includes(n.id)`; fails when dependency is `taskId`. Downstream gets empty `previousOutcomes`. | **P1** |
| **Execution Context Node Passing** | [`jobOrchestrator.ts:627`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L627) | ❌ Raw reference | None (shared memory) | `node` passed directly to `executor`. Agent can mutate `node.state` or `node.error` in place, corrupting DAG invariants. | **P1** |
| **Execution Context Task Passing** | [`jobOrchestrator.ts:658`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L658) | ❌ Raw reference | None (shared memory) | `task` passed directly to `executor`. Agent can mutate `task.input`, `task.policy`, `task.requirements` in place. | **P1** |
| **Context Assignment Policy** | [`jobOrchestrator.ts:636`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L636) | ❌ Hardcoded empty | None | `assignment.policy: []` hardcoded as empty array. Task's configured security policy rules are stripped from execution context. | **P1** |
| **Subagent Tool Scoping** | [`run.ts:1408`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1408) | ❌ Inverted filter | Depth check only | Child toolset populated from `wazir-coding` descriptor instead of parent capabilities. Read-only parent spawns mutating child. | **P1** |
| **Subagent Spec Fencing** | [`run.ts:1383-1405`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1383-L1405) | ❌ Missing registration | None | `registerSpecFence` never called for child execution. Sandboxing and spec fencing applied to parent are bypassed by child. | **P1** |
| **Subagent Revision Invalidation** | [`run.ts:1609-1610`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1609-L1610) | ❌ Dual mutation record | Shared workspace | Child mutations recorded against `parentExecutionId`, bumping parent revision and invalidating parent passing verification evidence. | **P1** |
| **Steer Job Broadcast** | [`jobOrchestrator.ts:178-187`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L178-L187) | ❌ Active-only loop | Memory map | `steerJob` only broadcasts to currently active tasks. Queued, idle, or downstream fan-in tasks never receive steering. | **P2** |
| **Steering Queue on Retry** | [`jobOrchestrator.ts:881`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L881) | ❌ Purged in `finally` | Memory map | `steeringQueues.delete(taskId)` purges unconsumed steering instructions on failure, leaving subsequent retry attempts unsteered. | **P2** |
| **Integration Qualification** | [`fleetRunner.ts:649`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L649) | ❌ Direct merge call | Git CLI | Completely bypasses `VerifiedIntegrationCoordinator`. No pre-merge conflict matrix, oracle verification, or gate evaluation. | **P1** |
| **Cross-Task Event Sequencing** | [`executionEngine.ts:1456`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L1456) | ❌ Per-exec sequence | Local wall clock | Event sequence numbers are local to execution history (`history.length + 1`). No causal vector clock or global DAG order across tasks. | **P2** |

---

## 3. Detailed Vulnerability Analyses

### 3.1 [P1-A26-01] AutoMerge Silently Drops Confirmed Work on Git Merge Conflict
- **Locations**:
  - [`apps/cli/src/fleetRunner.ts:648-650`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L648-L650)
  - [`packages/core/src/services/worktreeManager.ts:435-480`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L435-L480)
- **Severity**: **P1 (Critical Data Integrity)**
- **Critical Invariant Violated**: *"One agent must not silently overwrite another agent's confirmed work."*
- **Mechanism**:
  When tasks execute with isolated worktrees (`runnerOptions.shareJobWorktree === false`), each task operates on an isolated Git branch (`wazir/${jobId}/${taskId}`). Upon successful evaluation:
  ```typescript
  // apps/cli/src/fleetRunner.ts:642-650
  if (worktreeInfo && evaluation.success && !wasCancelled) {
    const commitRes = await engine.worktrees.commitWorktree(
      worktreeInfo,
      `wazir(${jobId}): ${task.title || task.input.slice(0, 60)}`,
    );

    if (runnerOptions.autoMerge && commitRes.committed) {
      await engine.worktrees.mergeBranch(engine.projectRoot, worktreeInfo.branch);
    }
  ```
  In [`worktreeManager.ts:435-480`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L435-L480), `mergeBranch` attempts `git merge --no-ff`. If a conflict occurs with changes already merged by a concurrent sibling task:
  1. Git exits with conflict status (`UU <file>`).
  2. `mergeBranch` catches the error, runs `git merge --abort` to restore a clean repo, and returns:
     ```typescript
     return { success: false, mergedBranch: branch, targetBranch: target, conflicts, error: ... };
     ```
  3. In `fleetRunner.ts:649`, the call is `await engine.worktrees.mergeBranch(...)`. **The return value is not captured or checked**.
  4. Execution falls through to line 652:
     ```typescript
     return {
       success: evaluation.success, // true
       result: summary,
       filesChanged: finalRecord.filesChanged,
       usage: finalRecord.usage,
       durationMs,
     };
     ```
  5. `JobOrchestrator` receives `success: true` and marks the task **`completed`** via `completeTask(job.id, taskId, outcome.result)`.
- **Impact**:
  The task's changes are discarded by `git merge --abort`, yet the task is reported to the user, API, and downstream tasks as `completed`. Subsequent fan-in tasks (e.g. build, integration, package) execute against `projectRoot` where the confirmed changes are missing, producing silent regression or downstream build failure.
- **Physical Reproduction**:
  Verified deterministically in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (Test 1).

---

### 3.2 [P1-A26-02] Shared Worktree Concurrency Hazard: `git add -A` Commits Unverified Intermediate Code Across Concurrent Tasks
- **Locations**:
  - [`apps/cli/src/fleetRunner.ts:109-112`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L109-L112)
  - [`packages/core/src/services/worktreeManager.ts:191-203`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L191-L203)
  - [`packages/core/src/services/worktreeManager.ts:385`](file:///Users/wael/Code/Wazir/packages/core/src/services/worktreeManager.ts#L385)
- **Severity**: **P1 (Integrity & Isolation)**
- **Critical Invariant Violated**: *"Unverified or in-flight work must never be committed into target revision history."*
- **Mechanism**:
  By default, `runnerOptions.shareJobWorktree !== false`. In `fleetRunner.ts:109-111`:
  ```typescript
  worktreeInfo = runnerOptions.shareJobWorktree !== false
    ? await engine.worktrees.getOrCreateJobWorktree(engine.projectRoot, jobId)
    : await engine.worktrees.createWorktree(engine.projectRoot, jobId, taskId);
  ```
  `getOrCreateJobWorktree` maps all tasks in `jobId` to a single worktree directory. When a fan-out graph dispatches Task 1 and Task 2 concurrently:
  1. Both tasks execute in the identical working directory.
  2. Task 1 finishes and calls `worktrees.commitWorktree(worktreeInfo, ...)`.
  3. Inside `commitWorktree` (`worktreeManager.ts:385`):
     ```typescript
     await execFileAsync('git', [...GIT_NO_HOOKS, 'add', '-A'], { cwd: info.worktreeDir });
     ```
  4. `git add -A` stages **every modified or newly created file in the worktree**, including half-written, unverified intermediate files produced by concurrent Task 2!
  5. Task 1 commits the entire working tree and auto-merges it to `projectRoot`.
  6. If Task 2 subsequently fails verification or is cancelled, its broken code is already permanently merged into `main` under Task 1's commit!
- **Impact**:
  Broken or unverified code from failing tasks is committed and merged into production repositories.
- **Physical Reproduction**:
  Verified deterministically in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (Test 2).

---

### 3.3 [P1-A26-03] Fan-In Context Loss: Upstream Task Outcomes Dropped Due to `node.dependencies.includes(n.id)` Mismatch
- **Locations**:
  - [`packages/core/src/services/jobOrchestrator.ts:648-649`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L648-L649)
  - [`packages/core/src/services/jobManager.ts:778-782, 792-796`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts#L778-L782)
- **Severity**: **P1 (Workflow & Context Propagation)**
- **Mechanism**:
  In [`jobOrchestrator.ts:648-649`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L648-L649):
  ```typescript
  previousOutcomes: new Map(job.graph.nodes.filter(n => node.dependencies.includes(n.id))
    .map(n => [n.taskId ?? n.id, { success: n.state === 'completed', result: structuredClone(n.result), error: n.error }])),
  ```
  In `JobManager`:
  - A task's dependencies can be defined using task IDs (e.g. `dependencies: ['task-1']`).
  - In `jobManager.dependenciesSatisfied`:
    ```typescript
    for (const dep of node.dependencies) {
      const depNode = job.graph.nodes.find((n) => n.id === dep || n.taskId === dep);
      if (depNode && depNode.state !== 'completed') return false;
    }
    ```
    `dependenciesSatisfied` correctly matches against both `n.id === dep || n.taskId === dep`.
  - However, in `jobOrchestrator.ts:648`, the filter is strictly:
    `job.graph.nodes.filter(n => node.dependencies.includes(n.id))`
  - If `n.id` was assigned an internal node ID (e.g. generated UUID, graph node ID `node-1`), while `node.dependencies` contains `task-1`, `node.dependencies.includes(n.id)` evaluates to `false`.
  - As a result, `previousOutcomes` is completely empty.
- **Impact**:
  Downstream fan-in tasks, synthesis agents, or supervisor nodes (`node.type === 'supervisor'`) receive an empty dependency map. In [`fleetRunner.ts:560-562`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L560-L562), supervisor agents fail or reject work because evidence is missing:
  `Review the dependency evidence against the task requirements... reject if evidence is missing.`
- **Physical Reproduction**:
  Verified deterministically in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (Test 3).

---

### 3.4 [P1-A26-04] Direct Exposure of Live Mutable Node and Task References in `JobTaskExecutionContext`
- **Locations**:
  - [`packages/core/src/services/jobOrchestrator.ts:627, 658`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L627)
  - [`packages/core/src/services/statusTransitions.ts:40-50`](file:///Users/wael/Code/Wazir/packages/core/src/services/statusTransitions.ts#L40-L50)
- **Severity**: **P1 (State Integrity)**
- **Mechanism**:
  In [`jobOrchestrator.ts:624-658`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L624-L658):
  ```typescript
  const executionContext: JobTaskExecutionContext = {
    jobId,
    taskId,
    node, // <--- DIRECT LIVE REFERENCE to job.graph.nodes[i]
    ...
  };
  let outcome: JobTaskOutcome = await executor(task, executionContext); // <--- DIRECT LIVE REFERENCE to job.tasks[i]
  ```
  Neither `node` nor `task` is defensively cloned or frozen (`Object.freeze`).
  1. An asynchronous executor or rogue agent tool can directly mutate `task.input = 'hijacked'`, corrupting the authoritative task prompt.
  2. If an executor mutates `context.node.state = 'failed'` while in flight, and then returns `{ success: true, ... }`:
     [`jobOrchestrator.ts:706`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L706) invokes `this.completeTask(job.id, taskId, outcome.result)`, which calls `jobManager.updateNodeState(job, taskId, 'completed')`.
     `updateNodeState` invokes `assertNodeTransition(..., node.state, 'completed')`. Because `node.state` was already mutated to `'failed'`, it throws:
     `Invalid node status transition for '<job>/<task>': failed -> completed`.
     This crashes the task with an unhandled exception, causing the task to fail despite returning success.
- **Physical Reproduction**:
  Verified deterministically in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (Test 4).

---

### 3.5 [P1-A26-05] Subagent Delegation Privilege Escalation Beyond Parent Capability Constraints
- **Locations**:
  - [`apps/cli/src/run.ts:1408`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1408)
  - [`packages/agents/src/codingAgent.ts:738-740`](file:///Users/wael/Code/Wazir/packages/agents/src/codingAgent.ts#L738-L740)
- **Severity**: **P1 (Authorization & Least Privilege)**
- **Mechanism**:
  In [`apps/cli/src/run.ts:1408`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1408):
  ```typescript
  // Filter tools to strictly omit dispatch_subagent for child agent
  const subagentTools = engine.tools.forModel(undefined, engine.agents.get('wazir-coding')?.descriptor.capabilities)
    .filter((t) => t.name !== 'dispatch_subagent' && policySupportsModelTool(engine, t.name));
  ```
  The child agent's available tools are derived exclusively from `engine.agents.get('wazir-coding')?.descriptor.capabilities`.
  If the parent agent was restricted to read-only capabilities (e.g. `['read', 'glob']`), invoking `dispatch_subagent` spawns a child agent endowed with `wazir-coding`'s full capabilities (`['coding', 'fileOps', 'shellExecution', 'git', 'terminal']`).
  The child agent executes `write`, `edit`, and `shell` against `context.projectRoot`, completely evading the capability limits imposed on the delegating parent.
- **Physical Reproduction**:
  Verified deterministically in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (Test 7).

---

### 3.6 [P1-A26-06] Steering Instructions Lost for Downstream Fan-In Tasks & Retried Attempts
- **Locations**:
  - [`packages/core/src/services/jobOrchestrator.ts:178-187, 881`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L178-L187)
- **Severity**: **P2 (Operator Steering & Reliability)**
- **Mechanism**:
  1. `JobOrchestrator.steerJob`:
     ```typescript
     steerJob(jobId: string, instruction: string): void {
       const handle = this.activeJobs.get(jobId);
       if (handle) {
         for (const taskId of handle.activeTasks.keys()) {
           this.steerTask(jobId, taskId, instruction);
         }
       }
     }
     ```
     `handle.activeTasks` only contains currently executing tasks. Any queued tasks, waiting dependencies, or downstream fan-in nodes are ignored. When they are later dispatched, they execute without the operator's steer instruction.
  2. In [`jobOrchestrator.ts:881`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L881), when an active task attempt finishes (either successfully or through failure):
     ```typescript
     } finally {
       activeTasks.delete(taskId);
       this.steeringQueues.delete(taskId);
       void pump().catch(reject);
     }
     ```
     `this.steeringQueues.delete(taskId)` unconditionally purges the queue. If a task fails transiently and is scheduled for retry (subject to `maxRetries`), any queued steering instructions intended for subsequent attempts are permanently erased.
- **Physical Reproduction**:
  Verified deterministically in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (Test 5).

---

### 3.7 [P1-A26-07] Subagent Child File Mutations Invalidate Parent Verification Without Provenance Attribution
- **Locations**:
  - [`apps/cli/src/run.ts:1609-1610`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1609-L1610)
  - [`packages/core/src/services/executionEngine.ts:885-915`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L885-L915)
- **Severity**: **P1 (Verification Integrity)**
- **Mechanism**:
  In [`run.ts:1609-1610`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1609-L1610), when a subagent mutates files:
  ```typescript
  await engine.executions.recordFileMutations(childExecId, mutations);
  await engine.executions.recordFileMutations(context.parentExecutionId, mutations);
  ```
  `recordFileMutations` on `parentExecutionId` increments `parentRecord.workspaceState.revision`.
  Under [`executionEngine.ts:910-915`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L910-L915), any prior passing verification evidence on the parent with `revision < currentRev` is marked stale and emits `verification.invalidated`.
  When the child finishes and the parent resumes, if the parent attempts to complete, [`executionEngine.ts:430-435`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L430-L435) rejects completion with `ARTIFACT_CONTRACT_FAILED` because the child's mutations invalidated the parent's verification state.
  Furthermore, the events pushed into the parent's event log are attributed to `parentRecord.execution.agentId` without provenance indicating that the mutations originated from a child subagent.
- **Physical Reproduction**:
  Verified deterministically in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts) (Test 6).

---

### 3.8 [P1-A26-08] Bypass of `VerifiedIntegrationCoordinator` in Fleet and CLI Execution Paths
- **Locations**:
  - [`packages/core/src/services/verifiedIntegrationCoordinator.ts:177-730`](file:///Users/wael/Code/Wazir/packages/core/src/services/verifiedIntegrationCoordinator.ts#L177-L730)
  - [`apps/cli/src/fleetRunner.ts:648-650`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L648-L650)
- **Severity**: **P1 (Architecture & Release Integrity)**
- **Mechanism**:
  Wazir contains an advanced `VerifiedIntegrationCoordinator` implementing:
  - Branch qualification reports with DAG dependency ordering.
  - Conflict classification (`same-file`, `rename-delete`, `dependency`, `test-fixture`).
  - Strict spec write fencing (`SPEC_WRITE_FENCE`) and test oracle protection (`protectTestOracles`).
  - Required qualification check suites before candidate branch integration.
  However, **neither `JobOrchestrator` nor `createFleetTaskExecutor` ever invokes `VerifiedIntegrationCoordinator`**.
  Instead, `fleetRunner.ts:649` executes an uncoordinated, raw `git merge` via `worktreeManager.mergeBranch`. All architectural guarantees designed into `VerifiedIntegrationCoordinator` are completely dead code in actual multi-agent execution.

---

### 3.9 [P1-A26-09] Hardcoded Empty Policy in `JobTaskExecutionContext.assignment`
- **Locations**:
  - [`packages/core/src/services/jobOrchestrator.ts:636`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L636)
- **Severity**: **P1 (Policy Enforcement)**
- **Mechanism**:
  When `JobOrchestrator` constructs `executionContext`:
  ```typescript
  assignment: {
    jobId,
    taskId,
    agentId: assignment.agentId,
    modelId: assignment.modelId,
    runtimeId: assignment.runtimeId,
    computerId: assignment.computerId,
    assignedAt: new Date(),
    policy: [], // <--- HARDCODED EMPTY ARRAY!
  },
  ```
  The task's configured policy (`task.policy`) is never mapped into `assignment.policy`. Any executor or agent relying on `context.assignment.policy` operates under empty policy rules, stripping configured restrictions.

---

### 3.10 [P1-A26-10] Cross-Task Event Sequence Monotonicity and Distributed Clock Gap
- **Locations**:
  - [`packages/core/src/services/executionEngine.ts:1456`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L1456)
  - [`packages/core/src/services/jobOrchestrator.ts:144-156`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L144-L156)
- **Severity**: **P2 (Observability & Causal Audit)**
- **Mechanism**:
  Event sequence numbering in `ExecutionEngine` is strictly local to each execution history: `sequence: history.length + 1`.
  Within a Job DAG, multiple tasks execute concurrently across different threads or remote fleet computers.
  1. There is no job-level monotonic sequence or Lamport timestamp.
  2. `JobOrchestratorEvent`s are emitted asynchronously without sequencing numbers.
  3. Auditing distributed execution logs reveals interleavings where dependent downstream task events have earlier wall-clock timestamps than their predecessor events due to machine clock drift.

---

## 4. Formal Alloy 6 Modeling & Proof Analysis

To formally verify the critical invariant across concurrent multi-agent graph executions, an Alloy 6 temporal specification was constructed in [`tests/formal-hardening/models/a26-cross-agent-consistency.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a26-cross-agent-consistency.als).

### 4.1 Invariants Modeled
1. **`NoSilentLostUpdate`**:
   $$\forall t, dep \in Task \cdot (dep \in t.dependencies \land t.state = Running \land dep.state = Completed) \implies dep.modifiedFiles \subseteq TargetHeadFiles$$
   *Plain language*: If a task is confirmed `Completed`, all of its modified files must exist in target HEAD before any dependent downstream task executes.
2. **`NoUnverifiedCommits`**:
   $$\forall f \in File \cdot (f \in TargetHeadFiles) \implies f \notin UnverifiedFiles$$
   *Plain language*: Unverified or in-flight files from concurrently executing tasks must never be committed into target HEAD.
3. **`DelegatedCapabilityContainment`**:
   $$\forall t \in Task \cdot (ReadOnly \in t.agent.capabilities \land MutateFiles \notin t.agent.capabilities) \implies \neg (some\ t.TaskBranchFiles)$$
   *Plain language*: An agent lacking file mutation capabilities must never be able to commit file mutations through delegation.

### 4.2 Counterexample Trace (Alloy 6 Verification)
When checked under scope 3 Tasks, 3 Files, 6 Steps:
- **`NoSilentLostUpdate`**: **VIOLATED (SAT Counterexample found at Step 4)**.
  - *Trace Interleaving*:
    1. Step 0: `TaskB` (Pending), `TaskC` (Pending), `TaskD` (Pending, depends on B and C).
    2. Step 1: `TaskB` and `TaskC` dispatched concurrently (`Running`). Both mutate `File1`.
    3. Step 2: `TaskB` auto-merges to `TargetHeadFiles`. `TargetHeadFiles` contains `TaskB`'s version.
    4. Step 3: `TaskC` attempts auto-merge; conflict on `File1`. `git merge --abort` leaves `TargetHeadFiles` unchanged. `TaskC` transitions to `Completed`.
    5. Step 4: `TaskD` is dispatched (`Running`) because dependencies $B$ and $C$ are `Completed`. However, `TaskC.modifiedFiles \not\subseteq TargetHeadFiles`.
    6. **Violates `NoSilentLostUpdate`**.
- **`NoUnverifiedCommits`**: **VIOLATED (SAT Counterexample found at Step 3)**.
  - *Trace Interleaving*:
    1. Step 1: `TaskB` and `TaskC` running in shared worktree. `TaskC` writes `File2` (Unverified).
    2. Step 2: `TaskB` finishes and executes `sharedWorktreeCommit` (`git add -A`).
    3. Step 3: `File2` $\in TargetHeadFiles$, while `File2` $\in UnverifiedFiles$.
    4. **Violates `NoUnverifiedCommits`**.

---

## 5. Summary of Physical Reproductions

All 7 vulnerability classes were reproduced against the unpatched codebase in [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts):

```
✓ tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts (7) 547ms
  ✓ GAP 1: AutoMerge silently drops confirmed work on git merge conflict without error or failure (330ms)
  ✓ GAP 2: Default shared worktree commits unverified intermediate files of concurrent tasks via git add -A
  ✓ GAP 3: JobOrchestrator previousOutcomes filter drops upstream outputs when dependencies reference taskId instead of node.id
  ✓ GAP 4: JobTaskExecutionContext provides live mutable references to node and task, allowing corruption of Job state
  ✓ GAP 5: steerJob omits queued fan-in tasks and task retry purges queued steering instructions
  ✓ GAP 6: Recording child file mutations against parentExecutionId bumps revision and invalidates parent passing evidence
  ✓ GAP 7: Subagent dispatch unconditionally provisions wazir-coding tools, escalating privileges beyond restricted parent capabilities
```

---

## 6. Hardening Recommendations

To guarantee that "One agent must not silently overwrite another agent's confirmed work" without breaking existing functionality, the following minimal, targeted remediations are required:

1. **Verify Merge Return Value & Fail on Conflict**:
   In [`apps/cli/src/fleetRunner.ts:648-650`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L648-L650):
   ```typescript
   if (runnerOptions.autoMerge && commitRes.committed) {
     const mergeResult = await engine.worktrees.mergeBranch(engine.projectRoot, worktreeInfo.branch);
     if (!mergeResult.success) {
       const conflictErr = `AUTOMERGE_CONFLICT: Failed to merge branch '${worktreeInfo.branch}' into target: ${mergeResult.conflicts?.join(', ')}`;
       await engine.executions.recordError(executionId, conflictErr);
       await engine.executions.setStatus(executionId, 'failed');
       return { success: false, error: conflictErr, errorKind: 'conflict', reasons: [conflictErr] };
     }
   }
   ```
2. **Default to Isolated Task Worktrees in Concurrency**:
   In `fleetRunner.ts:109`: Change default behavior so that concurrent tasks never share a worktree directory. If `shareJobWorktree` is requested, `commitWorktree` must use explicit `intendedFiles` staging rather than `git add -A`.
3. **Fix Dependency Outcome Lookup in JobOrchestrator**:
   In [`jobOrchestrator.ts:648`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L648):
   ```typescript
   previousOutcomes: new Map(job.graph.nodes
     .filter(n => node.dependencies.includes(n.id) || (n.taskId && node.dependencies.includes(n.taskId)))
     .map(n => [n.taskId ?? n.id, { success: n.state === 'completed', result: structuredClone(n.result), error: n.error }])),
   ```
4. **Defensively Clone Context Objects**:
   In [`jobOrchestrator.ts:627, 658`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L627):
   Pass deep clones or `Object.freeze(structuredClone(node))` and `Object.freeze(structuredClone(task))` to `executor`.
5. **Propagate Task Policy into Assignment**:
   In [`jobOrchestrator.ts:636`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L636):
   Populate `assignment.policy: task.policy ? [task.policy] : []`.
6. **Constrain Subagent Capabilities by Parent Bounds**:
   In [`apps/cli/src/run.ts:1408`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L1408):
   Intersect `wazir-coding` capabilities with `context.parentCapabilities`. If parent lacks `fileOps` or `shellExecution`, omit mutating tools. Register `specFence` for `childExecId`.
7. **Broadcast Steering to Pending Tasks & Retain Queues on Retry**:
   In `steerJob`, broadcast to all uncompleted nodes in `job.tasks`. In `finally` block of `runOwnedJob`, only delete steering queue if the task has reached a terminal status (`completed`, `failed` with retries exhausted, or `cancelled`).

---

## 7. Compliance & Traceability

- **Skill Invoked**: `wazir-formal-hardening`
- **Production Files Modified**: **ZERO** (Strict adherence to rule 3: no production code modified).
- **Deliverables Produced**:
  - Audit Report: [`tests/formal-hardening/reports/A26-cross-agent-consistency-audit.md`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reports/A26-cross-agent-consistency-audit.md)
  - Formal Model: [`tests/formal-hardening/models/a26-cross-agent-consistency.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a26-cross-agent-consistency.als)
  - Deterministic Reproduction Suite: [`tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A26-cross-agent-consistency.test.ts)
