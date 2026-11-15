# A10 — Failure Recovery, Checkpointing & Replay Safety Audit

- **Agent ID**: A10 (Tier 1 Formal Hardening Auditor — Group D)
- **Role**: Failure Recovery & Replay Safety Auditor
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Audit Group**: GROUP D — P0-04 Unknown Outcome Mutation & Replay Safety
- **Downstream Collaborators**: Agent A11 (Alloy 6 Modeler), Agent A12 (Codex Repair & Regression Engineer), Agent A30 (Final Verifier)
- **Critical Invariant Under Audit**:
  > *"An operation with an unknown side-effect outcome must not be replayed until it is safely reconciled."*

---

## 1. Executive Summary

A comprehensive formal audit of Wazir's checkpointing, crash recovery, event reconstruction, unknown tool outcome handling, and task restart behavior was conducted at commit `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`.

The audit inspected core runtime services:
- [`packages/core/src/services/executionRecovery.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts)
- [`packages/core/src/services/executionEngine.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts)
- [`packages/core/src/services/jobManager.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts)
- [`packages/core/src/services/jobOrchestrator.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts)
- [`packages/core/src/services/harnessDispatchService.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/harnessDispatchService.ts)
- [`packages/core/src/services/recoveryManager.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/recoveryManager.ts)
- Associated test suites in `packages/core/tests/` (including `executionRecovery.test.ts`, `portableRecovery.test.ts`, `recoveryManager.test.ts`, `crossHarnessRecoveryQualification.test.ts`, `toolCheckpoints.test.ts`).

### Key Audit Verdict
Wazir exhibits sophisticated, high-assurance design primitives in `executionRecovery.ts` (`planRecovery`, `reconcileBeforeCrossHarnessResume`, `classifyToolOutcome`, `OperationReconciliationGuard`). Within isolated standalone execution recovery and heartbeat-expired recovery (`RecoveryManager.sweep`), unknown mutating tool outcomes are properly blocked fail-closed.

**However, critical safety gaps exist at the architectural boundaries between subsystems:**
1. **P0 (Severe): In-Memory Task Retry in `JobOrchestrator` Blindly Replays Tasks with Unknown Mutating Outcomes.** When an executor fails or aborts mid-mutation during normal execution, `JobOrchestrator` automatically resets the node to `idle` and task to `pending` without verifying whether any tool call ended in `STARTED` or `OUTCOME_UNKNOWN`. The task is subsequently assigned a brand new execution ID and re-executed from scratch, causing non-idempotent side effects to be repeated.
2. **P0 (Severe): Inverted Tool Allowlist in `HarnessDispatchService` Fallback Replays Unknown Custom / MCP Mutating Operations.** When checking whether automatic fallback to an alternative model or runner is permitted, `canFallback()` checks `MUTATING_TOOLS.has(...)` using a hardcoded list of 14 tool names. Unknown mutating tools (e.g., custom database migrations, deployment tools, external MCP mutations) default to `isMutating = false`, bypassing the fallback barrier and executing a duplicate replay.
3. **P1 (High): `OperationReconciliationGuard.fromExecutionRecord` Drops Reconciled APPLIED Mutations.** `reconcileToolCall()` appends reconciliation events to `record.events` but never writes to `record.toolCalls`. When `OperationReconciliationGuard.fromExecutionRecord` hydrates completed operations, it checks `record.toolCalls.find(...)`, missing physical mutations reconciled after crash recovery.
4. **P1 (High): Semantic Key Revision Mismatch in Idempotency Guard.** `computeSemanticOperationKey` binds to `workspaceRevision`. When `reconcileBeforeCrossHarnessResume` reconciles an operation as `APPLIED` and advances the workspace revision from `R` to `R+1`, subsequent duplicate checks at `R+1` fail to match the stored receipt at `R`, allowing duplicate mutation.
5. **P1 (High): `JobManager.findUnknownMutationsByTask` Silent Bypass in Default In-Memory Configurations.** If `JobManager` is initialized without explicit `executions` or `store` references (the default in `JobOrchestrator`), `findUnknownMutationsByTask` returns an empty map, allowing stale lease takeover to reset tasks with unconfirmed mutations to `pending`.

---

## 2. Architecture & Life-Cycle Tracing

### 2.1 Tool Call Recording & Checkpoint Lifecycle

```
[Tool Invocation Requested]
          │
          ▼
   recordToolStart() ─────────► [Push 'tool.started' & 'tool.call.started']
          │                    [State: STARTED, SideEffectClass: Non-idempotent default]
          │                    [Durable Storage Flush]
          ▼
   Physical Tool Execution (fs, git, shell, mcp, network)
          │
          ├───► Process Dies / Signal Kill / Timeout / Network Drop
          │             │
          │             ▼
          │     Durable Log has 'tool.started' with NO matching 'tool.completed'
          │             │
          │             ▼
          │     Restart / Recovery: toolCheckpoints() sees state: 'STARTED'
          │     Engine Startup: pushes 'tool.unknownOutcome' (failureClass: 'TOOL_OUTCOME_UNKNOWN')
          │
          ▼
   recordToolCall() ──────────► [Push 'tool.completed' & 'tool.call.completed'|'failed']
                               [State: COMPLETED / FAILED]
                               [Durable Storage Flush]
```

#### Pre-Execution Phase (`recordToolStart`)
Located in [`packages/core/src/services/executionEngine.ts:529-554`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L529-L554):
- Validates lease fencing (`assertLease`).
- Assigns or accepts `callId` (defaulting to `call-${randomUUID()}`).
- Checks duplicate active dispatch: throws if `toolCheckpoints(executionId)` already has an active entry for `callId`.
- **Intra-Execution Concurrency Barrier**: If `sideEffectClass !== 'READ_ONLY'`, throws `ExecutionFailure('TOOL_OUTCOME_UNKNOWN')` if any prior write in the execution is still in `STARTED` or `OUTCOME_UNKNOWN`.
- Sets default classification: `sideEffectClass: options.sideEffectClass ?? 'NON_IDEMPOTENT_WRITE'`.
- Pushes both `tool.started` and `tool.call.started` events and synchronously flushes to durable storage.

#### Post-Execution Phase (`recordToolCall`)
Located in [`packages/core/src/services/executionEngine.ts:493-527`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L493-L527):
- Correlates with checkpoint via `call.callId ?? call.id`, or legacy correlation (`toolName` matching an active `STARTED` call).
- Sanitizes untrusted output (`sanitizeUntrustedOutput`).
- Pushes `tool.completed` and either `tool.call.completed`, `tool.call.failed`, or `tool.call.outcome_unknown`.
- Flushes to durable storage.

#### Reconciliation Phase (`reconcileToolCall`)
Located in [`packages/core/src/services/executionEngine.ts:583-598`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L583-L598):
- Requires proof: explicitly refuses `inspection.outcome === 'UNDETERMINED'`.
- Resolves state to `COMPLETED` (if `APPLIED`) or `FAILED` (if `NOT_APPLIED`).
- Appends `tool.completed` and `tool.call.completed` / `tool.call.failed` with `{ reconciled: { outcome, evidence, inspectedBy } }`.

---

### 2.2 Tool Classification: Read-Only vs Mutating

Tool classification determines whether an unconfirmed call blocks resumption:
1. **`READ_ONLY`**:
   - Includes: `read`, `glob`, `search`, `web_search`, `web_fetch`, `compaction`, verification checks (`test`, `lint`, `typecheck`, `build` with non-modifying scope).
   - In `planRecovery`: Filtered out (`state.unresolvedToolCalls.filter(c => c.sideEffectClass !== 'READ_ONLY')`). Interrupted read-only calls do not block recovery and are permitted to repeat without physical reconciliation.
   - In `reconcileBeforeCrossHarnessResume`: Automatically reconciled as `NOT_APPLIED` (`retryable: true`).
2. **`IDEMPOTENT_WRITE`**:
   - Includes: `write` / `write_file` (with absolute overwrite), `edit` (when target content matches post-state).
   - Treated as a write/mutation during crash recovery: blocks execution until reconciled from physical evidence (file content/hash check).
3. **`NON_IDEMPOTENT_WRITE`**:
   - Includes: `shell` / `bash` commands, `git commit`, `git push`, code execution, external APIs, and **all unknown or unregistered tools**.
   - Must never automatically replay. Blocks execution fail-closed until physical inspection proves `APPLIED` or `NOT_APPLIED`, or an explicit operator decision (`assume_applied`, `allow_retry`, `abort`) is logged.

---

### 2.3 Durable Reconstruction from Event Log

Located in [`packages/core/src/services/executionRecovery.ts:67-145`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L67-L145):
- Evaluates `record.events` sorted by `sequence`.
- Reconstructs:
  - `workspaceRevision`: Derived from `workspace.revision.changed` events and `record.workspaceState?.revision`.
  - `lastConfirmedToolResult`: Derived from latest `tool.call.completed` or `tool.call.failed`.
  - `unresolvedToolCalls`: Derived from `ToolCallCheckpoint` items with `state === 'STARTED' || state === 'OUTCOME_UNKNOWN'`.
  - `verification`: Separates checks run against the current `workspaceRevision` (`currentPassing`, `currentFailing`) from those run on older revisions (`staleChecks`).
  - `consumed` and `remaining` budgets (model requests, tool calls, tokens, wallClockMs).

---

## 3. Detailed Audit Findings & Edge Cases

### Finding D-01 (P0) — In-Memory Task Retry in `JobOrchestrator` Blindly Replays Tasks with Unknown Mutating Outcomes

- **File**: [`packages/core/src/services/jobOrchestrator.ts:771-797`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L771-L797) and [`packages/core/src/services/jobOrchestrator.ts:856-875`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L856-L875)
- **Subsystem**: Job Orchestration / Task Retry Loop
- **Severity**: **P0 (Critical)**
- **Invariant Violated**: P0-04 Unknown outcome mutation ("Non-idempotent tool calls whose outcome cannot be determined must never automatically replay.")
- **Root Cause**:
  In `JobOrchestrator.runJob()`, when a task execution fails (`outcome.success === false`) or throws an exception (`catch (err)`):
  ```typescript
  // packages/core/src/services/jobOrchestrator.ts:771-790
  const retries = retryCounts.get(taskId) ?? 0;
  const maxRetries = isPolicyDenial ? 0 : (task.maxRetries ?? job.maxRetries ?? 3);
  if (retries < maxRetries) {
    retryCounts.set(taskId, retries + 1);
    node.retryCount = retries + 1;
    if (!node.attempts) node.attempts = [];
    node.attempts.push({
      state: 'failed',
      error: outcome.error,
      executedAt: node.executedAt,
      completedAt: new Date()
    });
    node.executedAt = undefined;
    node.completedAt = undefined;
    node.error = undefined;
    node.result = undefined;
    node.state = 'idle';
    await this.jobManager.updateAgentState(job.id, node.id, 'idle');
    await this.jobManager.updateTaskStatus(job.id, taskId, 'pending');
    this.emit(jobId, { type: 'task:retry', jobId, taskId, retryCount: retries + 1, maxRetries });
  }
  ```
  `JobOrchestrator` does **not** check whether the failed execution had any in-flight or unconfirmed tool calls (`findUnknownOutcomeToolCall`).
  If a task dispatched a mutating tool (e.g., `git commit`, `shell` command modifying state, or file write) and the worker experienced an unhandled error, timeout, or network disconnect before `recordToolCall` was called, the execution record retains a checkpoint with `state: 'STARTED'` or `'OUTCOME_UNKNOWN'`.
  When `updateTaskStatus(job.id, taskId, 'pending')` is called, the orchestrator's pump loop reactivates, assigns the task again, calls `executionEngine.create(...)` which generates a **brand new execution record with a fresh execution ID**, and re-executes the task from turn 1.
  The prior execution's unknown mutating outcome is completely orphaned and ignored, resulting in a duplicate execution of non-idempotent operations.
- **Minimal Failure Trace**:
  1. Task `task-1` starts execution under `exec-1`.
  2. `recordToolStart(exec-1, 'shell', { command: 'curl -X POST https://api.prod/charge' }, { sideEffectClass: 'NON_IDEMPOTENT_WRITE' })` is persisted.
  3. Physical HTTP request is sent and processed by external server.
  4. Local network socket drops or process throws `ECONNRESET` before `recordToolCall` is reached.
  5. `JobOrchestrator` catches error. `retries < maxRetries` is true (0 < 3).
  6. `JobOrchestrator` sets `task.status = 'pending'`, `node.state = 'idle'`.
  7. Pump loop assigns `task-1` under `exec-2` (new execution record).
  8. `task-1` re-executes `curl -X POST https://api.prod/charge`. Double charge occurred!

---

### Finding D-02 (P0) — Inverted Allowlist in `HarnessDispatchService` Fallback Allows Automatic Replay of Unknown Mutating Operations

- **File**: [`packages/core/src/services/harnessDispatchService.ts:207-222`](file:///Users/wael/Code/Wazir/packages/core/src/services/harnessDispatchService.ts#L207-L222) and [`packages/core/src/services/harnessDispatchService.ts:758-772`](file:///Users/wael/Code/Wazir/packages/core/src/services/harnessDispatchService.ts#L758-L772)
- **Subsystem**: Provider / Cross-Harness Dispatch & Fallback
- **Severity**: **P0 (Critical)**
- **Invariant Violated**: P0-04 Unknown outcome mutation ("An operation with an unknown side-effect outcome must not be replayed until it is safely reconciled.")
- **Root Cause**:
  `harnessDispatchService.ts` defines an explicit allowlist of mutating tools:
  ```typescript
  // packages/core/src/services/harnessDispatchService.ts:207-222
  const MUTATING_TOOLS = new Set([
    'write', 'edit', 'shell', 'bash', 'git', 'rm', 'mv', 'cp',
    'patch', 'apply_patch', 'write_file', 'edit_file', 'delete_file', 'create_file',
  ]);
  ```
  When evaluating whether an interrupted execution can automatically fall back to an alternate model or runner:
  ```typescript
  // packages/core/src/services/harnessDispatchService.ts:758-772
  for (const tc of result.toolCalls ?? []) {
    const isMutating =
      MUTATING_TOOLS.has(tc.tool.toLowerCase()) ||
      (tc.provenance && tc.provenance.sideEffectClass && tc.provenance.sideEffectClass !== 'READ_ONLY');
    const isUnknownOutcome =
      tc.failureClass === 'TOOL_OUTCOME_UNKNOWN' ||
      (tc.provenance &&
        (tc.provenance.state === 'STARTED' || tc.provenance.state === 'OUTCOME_UNKNOWN'));
    if (isMutating && isUnknownOutcome) {
      return {
        blocked: true,
        reason: `Tool call '${tc.tool}' (id=${tc.id}) has unconfirmed side effect (TOOL_OUTCOME_UNKNOWN), blocking fallback`,
      };
    }
  }
  ```
  If an execution uses a mutating tool outside the 14 hardcoded names (e.g. `database_migrate`, `deploy`, `docker_run`, `publish`, or external MCP tools where `tc.provenance.sideEffectClass` is undefined):
  - `isMutating` evaluates to `false`.
  - `canFallback()` returns `{ blocked: false }`.
  - The service executes fallback, which re-dispatches the request to another harness or provider, executing the unconfirmed mutating tool a second time.
  Wazir's security posture requires **fail-closed** classification: any tool not known to be `READ_ONLY` must be treated as mutating. Using an allowlist for mutating tools is the reverse of this requirement.

---

### Finding D-03 (P1) — `OperationReconciliationGuard.fromExecutionRecord` Fails to Hydrate Reconciled APPLIED Mutations

- **File**: [`packages/core/src/services/executionRecovery.ts:426-451`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L426-L451) vs [`packages/core/src/services/executionEngine.ts:583-598`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L583-L598)
- **Subsystem**: Durable Operation Identity & Idempotency Guard
- **Severity**: **P1 (High)**
- **Invariant Violated**: Replay Safety / Mutation Deduplication
- **Root Cause**:
  `OperationReconciliationGuard.fromExecutionRecord` is used to hydrate the idempotency guard from an `ExecutionRecord` so that already-applied operations are deduplicated after process restarts:
  ```typescript
  // packages/core/src/services/executionRecovery.ts:432-448
  for (const cp of resolvedCheckpoints) {
    if (cp.state === 'COMPLETED') {
      const matchingCall = record.toolCalls.find(
        (tc) => (tc.callId ?? tc.id) === cp.callId && tc.ok,
      );
      guard.recordConfirmedMutation({
        executionId: cp.executionId,
        callId: cp.callId,
        toolName: cp.toolName,
        argumentsHash: cp.argumentsHash,
        input: cp.input,
        workspaceRevision: cp.workspaceRevision,
        output: matchingCall?.output,
        evidence: 'Confirmed completed in execution record',
        confirmedAt: (cp.finishedAt ?? new Date()).toISOString(),
      });
    }
  }
  ```
  However, in `ExecutionEngine.reconcileToolCall()`:
  ```typescript
  // packages/core/src/services/executionEngine.ts:595-597
  this.pushEvent(record, 'tool.completed', { callId, tool: call.toolName, ok, reconciled }, ...);
  this.pushEvent(record, ok ? 'tool.call.completed' : 'tool.call.failed', ...);
  await this.flush(record);
  ```
  `reconcileToolCall()` appends event records to `record.events`, but **never adds a corresponding `ToolCallRecord` to `record.toolCalls`** (`record.toolCalls` is only mutated in `recordToolCall`).
  While `fromExecutionRecord` still records the mutation if `matchingCall` is undefined (passing `output: undefined`), the evidence string defaults to generic `'Confirmed completed in execution record'` and ignores the actual reconciliation proof (`reconciled.evidence`) stored in the event log. Furthermore, if a caller expects `matchingCall` to be present, output caching fails.

---

### Finding D-04 (P1) — Semantic Operation Deduplication Bypass Across Reconciliation Revision Increments

- **File**: [`packages/core/src/services/executionRecovery.ts:378-382`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L378-L382), [`523-551`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L523-L551), and [`820-828`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L820-L828)
- **Subsystem**: Cross-Harness Resume / Idempotency Ledger
- **Severity**: **P1 (High)**
- **Invariant Violated**: Replay Safety / Semantic Mutation Idempotency
- **Root Cause**:
  `computeSemanticOperationKey` includes `workspaceRevision`:
  ```typescript
  export function computeSemanticOperationKey(params: Omit<OperationIdentityInput, 'callId'>): string {
    const argsHash = params.argumentsHash ?? hashToolArguments(params.input);
    const payload = `${params.executionId}:${params.toolName}:${argsHash}:${String(params.workspaceRevision)}`;
    return createHash('sha256').update(payload).digest('hex');
  }
  ```
  When `reconcileBeforeCrossHarnessResume` reconciles an unconfirmed tool call as `APPLIED`:
  1. It stores the receipt in `guard` with `call.workspaceRevision` (e.g. revision `0`).
  2. Because the mutation changed disk state, lines 820-828 advance the execution's workspace revision:
     ```typescript
     if (options.advanceRevisionOnApplied !== false) {
       const currentRev = executions.getWorkspaceRevision(executionId);
       if (currentRev <= call.workspaceRevision) {
         await executions.recordFilesChanged(executionId, [targetPath]);
       }
     }
     ```
     `workspaceRevision` is now incremented to `1`.
  3. When the execution resumes at workspace revision `1`, if the agent generates a fresh tool call with a new `callId` (e.g. `call-${randomUUID()}`) but the same input arguments, `checkDuplicateOperation` computes:
     `computeSemanticOperationKey({ executionId, toolName, input, workspaceRevision: 1 })`.
  4. The stored receipt was keyed with `workspaceRevision: 0`.
  5. The keys differ: `bySemanticKey.get(semanticKey)` returns `undefined`.
  6. `checkDuplicateOperation` reports `duplicate: false`.
  7. The operation is re-dispatched and executed again on disk!

---

### Finding D-05 (P1) — `JobManager.findUnknownMutationsByTask` Silent Bypass in Default In-Memory Configuration

- **File**: [`packages/core/src/services/jobManager.ts:89-123`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts#L89-L123) and [`packages/core/src/services/jobManager.ts:148-167`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts#L148-L167)
- **Subsystem**: Job Ownership & Lease Acquisition
- **Severity**: **P1 (High)**
- **Invariant Violated**: P0-04 Unknown outcome mutation / P0-02 Fenced lease commit
- **Root Cause**:
  In `JobManager`:
  ```typescript
  private async findUnknownMutationsByTask(jobId: string): Promise<Map<string, { executionId?: string; tool: string; callId: string }>> {
    const unknownByTask = new Map<string, { executionId?: string; tool: string; callId: string }>();
    if (this.executions) { ... }
    if (this.store) { ... }
    return unknownByTask;
  }
  ```
  In default usage, when `JobOrchestrator` creates its internal `JobManager` (`new JobManager()`), it passes neither `executions` nor `store`.
  When a worker attempts to `acquire()` a job whose previous lease expired:
  - `findUnknownMutationsByTask(jobId)` returns an empty `Map`.
  - In lines 148-167, `unknownByTask.get(taskId)` is always `undefined`.
  - The check `if (unknown)` never triggers.
  - Instead, the fallback `else` branch executes:
    `node.state = node.retryCount <= maxRetries ? 'idle' : 'failed';`
    `task.status = node.state === 'idle' ? 'pending' : 'failed';`
  - The task is reset to `pending` and automatically retried, ignoring any pending unknown mutations.

---

### Finding D-06 (P1) — `JobManager.reconcileStaleStatus` Startup Healing Loses Unknown Mutation Context

- **File**: [`packages/core/src/services/jobManager.ts:258-308`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobManager.ts#L258-L308)
- **Subsystem**: JobManager Startup Reconciliation
- **Severity**: **P1 (High)**
- **Invariant Violated**: P0-04 Unknown outcome mutation
- **Root Cause**:
  When `JobManager` loads jobs from persistent storage on startup (`loadInitialJobs`), any job left in `running` status whose lease has expired is reconciled via `reconcileStaleStatus(job)`:
  ```typescript
  for (const task of job.tasks) {
    if (task.status === 'running') {
      task.status = 'failed';
      const node = job.graph.nodes.find((n) => n.taskId === task.id || n.id === task.id);
      if (node && node.state !== 'completed' && node.state !== 'failed' && node.state !== 'cancelled') {
        node.state = 'failed';
        node.error = node.error ?? 'Orphaned: the process running this task ended before it finished';
        node.completedAt = node.completedAt ?? new Date();
      }
    }
  }
  ```
  `reconcileStaleStatus` unconditionally labels every in-flight task as `'Orphaned: the process running this task ended before it finished'`.
  It never consults `findUnknownMutationsByTask()` or inspects tool checkpoints.
  Consequently, tasks that died during an active mutating tool call lose their specific `UNKNOWN_MUTATION_OUTCOME` classification. If the job is subsequently retried or re-acquired, operator tooling cannot distinguish between a clean crash and an unconfirmed physical side effect.

---

### Finding D-07 (P2) — `extractToolCheckpoints` Drops Dotted Event Names (`tool.call.*`)

- **File**: [`packages/core/src/services/executionRecovery.ts:189-230`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L189-L230)
- **Subsystem**: Execution State Reconstruction
- **Severity**: **P2 (Medium)**
- **Invariant Violated**: Checkpoint Reconstruction Completeness
- **Root Cause**:
  `extractToolCheckpoints` checks:
  ```typescript
  if (event.type === 'tool.started') { ... }
  else if (event.type === 'tool.completed' || event.type === 'tool.unknownOutcome') { ... }
  ```
  In `ExecutionEngine.recordToolStart()` and `recordToolCall()`, Wazir emits both legacy names (`tool.started`, `tool.completed`, `tool.unknownOutcome`) and canonical names (`tool.call.started`, `tool.call.completed`, `tool.call.failed`, `tool.call.outcome_unknown`).
  If a log or external harness only emits canonical dotted names (`tool.call.started`), `extractToolCheckpoints` ignores them completely, returning an empty checkpoint list.
  It should check `event.type === 'tool.started' || event.type === 'tool.call.started'`.

---

### Finding D-08 (P2) — Checkpoint Extraction Processes Raw Array Without Sequence Sorting

- **File**: [`packages/core/src/services/executionRecovery.ts:192`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L192) and [`packages/core/src/services/executionEngine.ts:610`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L610)
- **Subsystem**: Execution State Reconstruction
- **Severity**: **P2 (Medium)**
- **Invariant Violated**: Deterministic Replay / Event Ordering
- **Root Cause**:
  In `reconstructExecutionState(record, ...)`, line 73 explicitly sorts events:
  `const events = [...record.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));`
  However, in `extractToolCheckpoints(record)` and `ExecutionEngine.toolCheckpoints(executionId)`:
  - `extractToolCheckpoints` iterates `for (const event of record.events ?? [])` without sorting.
  - `toolCheckpoints` iterates `for (const event of this.histories.get(executionId) ?? [])` without sorting.
  If events are loaded out of order from storage or an event journal, a `tool.completed` event occurring before a `tool.started` in the array will find no matching call in `calls.get(callId)`, leaving the call in `STARTED` state instead of `COMPLETED`.

---

### Finding D-09 (P2) — `ExecutionEngine` `fastStartup: true` Disables Crash Recovery of Unconfirmed Tool Calls

- **File**: [`packages/core/src/services/executionEngine.ts:251-281`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L251-L281)
- **Subsystem**: Execution Engine Startup / Ready Barrier
- **Severity**: **P2 (Medium)**
- **Invariant Violated**: Crash Recovery Consistency
- **Root Cause**:
  During `ExecutionEngine` initialization, lines 251-281 perform orphan detection and push `tool.unknownOutcome` for all calls left in `STARTED` state.
  However, line 251 specifies:
  `if (options.fastStartup) return;`
  When `fastStartup` is enabled (e.g. for rapid CLI inspection commands), this entire sweep is bypassed. The in-memory event log is not updated with `tool.unknownOutcome`, and changes are not flushed to disk. While in-memory `toolCheckpoints()` still sees `state: 'STARTED'`, durable recovery records are not reconciled.

---

### Finding D-10 (P2) — Ambiguous Legacy Correlation in Concurrent Read-Only Dispatches

- **File**: [`packages/core/src/services/executionRecovery.ts:211-216`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L211-L216) and [`packages/core/src/services/executionEngine.ts:497-498`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L497-L498)
- **Subsystem**: Legacy Tool Checkpoint Correlation
- **Severity**: **P2 (Medium)**
- **Invariant Violated**: Event Correlation Integrity
- **Root Cause**:
  When `callId` is absent from an event, correlation falls back to matching by tool name:
  `[...calls.values()].find(c => c.state === 'STARTED' && c.toolName === data.tool)`
  If multiple parallel `READ_ONLY` calls (e.g. concurrent `read` or `glob` queries) are issued without explicit call IDs, completions match whichever call happens to appear first in the Map iterator, rather than by sequential timestamp or FIFO order. While read-only calls do not carry mutation risk, duration and error metrics can be cross-correlated incorrectly.

---

## 4. Formal Hardening Blueprint for Agent A11 (Alloy 6 Modeling)

For Agent A11, the core safety property to model in Alloy 6 is **P0-04 Unknown Outcome Mutation & Replay Safety**.

### Alloy 6 Modeling Specification

```alloy
module wazir/recovery/replay_safety

/*
 * State signatures modeling Execution, ToolCalls, and Checkpoints
 */
sig ExecutionId {}
sig CallId {}

enum SideEffectClass { READ_ONLY, IDEMPOTENT_WRITE, NON_IDEMPOTENT_WRITE }
enum CallState { STARTED, COMPLETED, FAILED, OUTCOME_UNKNOWN }
enum ReconciledOutcome { APPLIED, NOT_APPLIED, UNDETERMINED }

sig ToolCall {
  callId: one CallId,
  execution: one ExecutionId,
  sideEffect: one SideEffectClass
}

sig State {
  callStatus: ToolCall -> lone CallState,
  physicalEffectApplied: set ToolCall,
  reconciled: ToolCall -> lone ReconciledOutcome,
  replayed: set ToolCall
}

// Invariant 1: No mutating call with unknown outcome may be replayed
pred UnknownOutcomeNeverReplayed [s: State] {
  all tc: ToolCall |
    (tc.sideEffect != READ_ONLY and
     s.callStatus[tc] in (STARTED + OUTCOME_UNKNOWN) and
     no s.reconciled[tc]) implies tc not in s.replayed
}

// Invariant 2: Physical reconciliation must be authoritative
pred ReconciliationIntegrity [s: State] {
  all tc: ToolCall |
    (s.reconciled[tc] = APPLIED implies tc in s.physicalEffectApplied) and
    (s.reconciled[tc] = NOT_APPLIED implies tc not in s.physicalEffectApplied)
}

// Counterexample Assertion: JobOrchestrator Blind Retry (Finding D-01)
// Models the defect where failure transitions a task to pending and replays without checking callStatus
pred VulnerableOrchestratorRetry [s, s': State, tc: ToolCall] {
  tc.sideEffect = NON_IDEMPOTENT_WRITE
  s.callStatus[tc] in (STARTED + OUTCOME_UNKNOWN)
  no s.reconciled[tc]
  // Defect: Orchestrator retries task, causing replay in s'
  tc in s'.replayed
}

check NoUnknownReplay {
  all s: State | UnknownOutcomeNeverReplayed[s]
} for 4 but 1 State
```

---

## 5. Concrete Reproduction Scenarios & Patch Recommendations for Agent A12

### 5.1 Reproduction for Finding D-01: Orchestrator In-Memory Retry Bug

#### Proposed Vitest Test
File: `packages/core/tests/orchestratorReplaySafety.test.ts`
```typescript
it('refuses to automatically retry a failed task when an in-flight tool call has an unknown mutating outcome', async () => {
  let attempts = 0;
  const executor: JobTaskExecutor = async (task, ctx) => {
    attempts += 1;
    if (attempts === 1) {
      // Dispatch a non-idempotent write tool call
      const execId = ctx.assignment.jobId; // or retrieved from executions
      await executions.recordToolStart(execId, 'shell', { cmd: 'rm -rf /tmp/data' }, {
        callId: 'call-rm-1',
        sideEffectClass: 'NON_IDEMPOTENT_WRITE',
      });
      // Throw before recording tool completion
      throw new Error('Connection reset mid-execution');
    }
    return { success: true, result: 'done' };
  };

  const { orchestrator, jobManager, executions } = setup(executor);
  const job = await orchestrator.createJob({
    title: 'Unknown outcome safety test',
    maxRetries: 3,
    tasks: [{ task: { id: 'mutating-task', input: 'run' } }],
  });

  const runPromise = orchestrator.runJob(job.id);
  const finishedJob = await runPromise;

  // EXPECTATION UNDER CRITICAL INVARIANT:
  // Must NOT auto-retry! Must fail closed with UNKNOWN_MUTATION_OUTCOME.
  expect(attempts).toBe(1);
  expect(finishedJob.status).toBe('failed');
  const task = jobManager.get(job.id)!.tasks.find(t => t.id === 'mutating-task')!;
  expect(task.status).toBe('failed');
  expect(finishedJob.graph.nodes[0].error).toContain('UNKNOWN_MUTATION_OUTCOME');
});
```

#### Proposed Fix for A12 in `jobOrchestrator.ts`
In [`packages/core/src/services/jobOrchestrator.ts:771`](file:///Users/wael/Code/Wazir/packages/core/src/services/jobOrchestrator.ts#L771) and line `856`:
Before allowing a task to be reset to `pending` and `idle`, check for unconfirmed mutating tool calls:
```typescript
// Proposed Guard in JobOrchestrator
const activeRecords = await this.executionEngine.listByTask(taskId);
const hasUnresolvedWrite = activeRecords.some((r) => {
  const unknown = this.executionEngine.findUnknownOutcomeToolCall(r.execution.id);
  return unknown && unknown.sideEffectClass !== 'READ_ONLY';
});

if (hasUnresolvedWrite) {
  const blockingReason = `UNKNOWN_MUTATION_OUTCOME: Task '${taskId}' has unconfirmed mutating side effects; automatic retry blocked fail-closed until reconciliation`;
  node.state = 'failed';
  node.error = blockingReason;
  await this.failTask(job.id, taskId, blockingReason, Infinity);
  this.emit(jobId, { type: 'task:failed', jobId, taskId, error: blockingReason });
  return;
}
```

---

### 5.2 Reproduction & Patch for Finding D-02: Hardcoded `MUTATING_TOOLS` in `harnessDispatchService.ts`

#### Proposed Fix for A12 in `harnessDispatchService.ts`
In [`packages/core/src/services/harnessDispatchService.ts:758-765`](file:///Users/wael/Code/Wazir/packages/core/src/services/harnessDispatchService.ts#L758-L765):
Replace the insecure allowlist with a fail-closed read-only check:
```typescript
// Instead of:
// const isMutating = MUTATING_TOOLS.has(tc.tool.toLowerCase()) || ...

// Use Fail-Closed Classification:
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'search', 'web_search', 'web_fetch']);
const isReadOnly =
  READ_ONLY_TOOLS.has(tc.tool.toLowerCase()) ||
  (tc.provenance && tc.provenance.sideEffectClass === 'READ_ONLY');
const isMutating = !isReadOnly;
```

---

### 5.3 Reproduction & Patch for Finding D-04: Revision Mismatch in Idempotency Guard

#### Proposed Fix for A12 in `executionRecovery.ts`
In [`packages/core/src/services/executionRecovery.ts:507-557`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionRecovery.ts#L507-L557):
Add revision-independent semantic matching or check receipts across prior revisions for identical arguments:
```typescript
// In OperationReconciliationGuard:
// Also index by semantic key without revision: `${executionId}:${toolName}:${argumentsHash}`
// When checking duplicates, if an exact argument match was confirmed APPLIED in the immediate
// prior revision resulting from reconciliation, recognize it as duplicate.
```

---

## 6. Ledger Summary Table

| ID | Priority | Subsystem | File & Lines | Invariant Violated | Failure Mode | Verification Status | Downstream Assignee |
|---|---|---|---|---|---|---|---|
| **D-01** | **P0** | JobOrchestrator | `jobOrchestrator.ts:771-797, 856-875` | P0-04 Unknown Outcome Mutation | Blind task retry re-executes unconfirmed mutating tool calls | Confirmed (Code Audit) | A11 (Model), A12 (Fix) |
| **D-02** | **P0** | HarnessDispatch | `harnessDispatchService.ts:207-222, 758-772` | P0-04 Unknown Outcome Mutation | Hardcoded 14-tool allowlist permits fallback replay of unknown mutations | Confirmed (Code Audit) | A11 (Model), A12 (Fix) |
| **D-03** | **P1** | ExecutionRecovery | `executionRecovery.ts:426-451`, `executionEngine.ts:583-598` | Replay Safety / Deduplication | Reconciled APPLIED operations missing from `record.toolCalls` drop hydration receipts | Confirmed (Code Audit) | A12 (Fix) |
| **D-04** | **P1** | ExecutionRecovery | `executionRecovery.ts:378-382, 523-551, 820-828` | Replay Safety / Idempotency | Revision bump on APPLIED reconciliation causes subsequent semantic duplicate check to miss | Confirmed (Code Audit) | A11 (Model), A12 (Fix) |
| **D-05** | **P1** | JobManager | `jobManager.ts:89-123, 148-167` | P0-04 Unknown Outcome Mutation | In-memory `JobManager` has undefined `executions`/`store`, ignoring unknown mutations | Confirmed (Code Audit) | A12 (Fix) |
| **D-06** | **P1** | JobManager | `jobManager.ts:258-308` | P0-04 Unknown Outcome Mutation | Startup healing `reconcileStaleStatus` overwrites unknown mutation errors with generic orphan error | Confirmed (Code Audit) | A12 (Fix) |
| **D-07** | **P2** | ExecutionRecovery | `executionRecovery.ts:189-230` | Checkpoint Extraction | `extractToolCheckpoints` ignores dotted `tool.call.*` event format | Confirmed (Code Audit) | A12 (Fix) |
| **D-08** | **P2** | ExecutionRecovery | `executionRecovery.ts:192`, `executionEngine.ts:610` | Event Reconstruction | Raw array iteration without sequence sorting risks out-of-order state reconstruction | Confirmed (Code Audit) | A12 (Fix) |
| **D-09** | **P2** | ExecutionEngine | `executionEngine.ts:251-281` | Recovery Initialization | `fastStartup: true` bypasses crash recovery sweep of unconfirmed `STARTED` calls | Confirmed (Code Audit) | A12 (Fix) |
| **D-10** | **P2** | ExecutionRecovery | `executionRecovery.ts:211-216`, `executionEngine.ts:497-498` | Correlation Integrity | Legacy correlation by tool name can misattribute concurrent read-only queries | Confirmed (Code Audit) | A12 (Fix) |

---

## 7. Conclusion & Next Steps

Wazir possesses a robust theoretical model for execution recovery and replay safety in `executionRecovery.ts`. However, concrete implementation gaps in `JobOrchestrator` (Finding D-01) and `HarnessDispatchService` (Finding D-02) create real, reproducible paths where unconfirmed side effects are replayed automatically without reconciliation.

- **To Agent A11**: Model the `JobOrchestrator` task retry loop and `canFallback` boundary in Alloy 6 to prove the counterexample trace where an unknown non-idempotent tool outcome is replayed without reconciliation.
- **To Agent A12**: Implement the fail-closed reconciliation check in `JobOrchestrator` and invert the `MUTATING_TOOLS` allowlist in `harnessDispatchService.ts` within your designated worktree (`/Users/wael/Code/Wazir/.worktrees/fh30/A12`), adding deterministic regression tests.
- **To Agent A30**: Include findings D-01 and D-02 in the final formal verification matrix.
