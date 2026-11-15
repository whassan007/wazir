# A12 Formal Hardening Report — Independent Red-Team Reviewer & Cross-Module Boundary Auditor

- **Agent ID**: `A12` (Independent Red-Team Reviewer & Cross-Module Boundary Auditor)
- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh-a12-redteam`
- **Base Commit SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Formal Analyzer**: Alloy 6.2.0 (`org.alloytools.alloy.dist.jar`, SAT4J solver)
- **Models**:
  - Positive & temporal invariant model: `/Users/wael/Code/Wazir/docs/formal-hardening/models/a12-redteam.als`
  - Negative-control / pre-fix defect mutant model: `/Users/wael/Code/Wazir/docs/formal-hardening/models/a12-redteam-mutant.als`
- **Alloy Output Receipts**:
  - `/Users/wael/Code/Wazir/docs/formal-hardening/results/a12-redteam/a12-redteam/receipt.json`
  - `/Users/wael/Code/Wazir/docs/formal-hardening/results/a12-redteam/a12-redteam-mutant/receipt.json`
  - `/Users/wael/Code/Wazir/docs/formal-hardening/results/a12-redteam/skill-baseline-task-terminal/receipt.json`
  - `/Users/wael/Code/Wazir/docs/formal-hardening/results/a12-redteam/skill-baseline-task-terminal-mutant/receipt.json`
  - `/Users/wael/Code/Wazir/docs/formal-hardening/results/a12-redteam/skill-baseline-delegated-policy/receipt.json`

---

## 1. Executive Summary

Agent A12 audited Wazir's cross-module transaction boundaries (`Scheduler` ↔ `ExecutionEngine` ↔ `RecoveryManager` ↔ `PolicyEngine` ↔ `MobileApprovalService` ↔ `ToolRegistry`) and formal assurance gate adapters (`packages/assurance/src/{alloy,z3,dafny,verifai,record,cli}.ts`).

Using Alloy 6 temporal state-machine modeling paired with direct TypeScript source inspection, we identified, formally modeled, deterministically reproduced (failing Vitest tests prior to fix), and remediated **3 high-severity (P0/P1) cross-module defects**:

1. **`A12-001` (P0 — Formal Assurance Release Gate Bypass via Stale SpecHash / Commit Evidence & Un-run Spec Artifacts)**:
   - `generateAssuranceRecord()` (`packages/assurance/src/record.ts`) aggregated ledger entries matching `sourceCommit` and `propertyId` without verifying `e.specHash === spec.content_hash`, allowing a modified specification to inherit `PROVED` / `BOUNDED_PASS` verdicts from an older specification hash.
   - `assureRecord()` (`packages/assurance/src/cli.ts`) filtered ledger entries only by `propertyId` (ignoring both `sourceCommit` and `specHash`), failed to check `reviewers.length > 0`, and returned `undefined` instead of `Verdict.NOT_RUN` when required tools declared in `manifest.artifacts` (`alloy`, `z3`, `dafny`, `verifai`/`scenic`) or `manifest.monitors` had no ledger entries—allowing `release_gate.status = 'PASS'` when required formal tools were never executed.
2. **`A12-002` (P0 — Recovery Reconciliation Fails to Advance Workspace Revision on `APPLIED` Mutations, Omits Post-Reconcile Guard Key, and Omits Reconciled Calls from Tool-Call Budget)**:
   - `RecoveryManager.reconcileFromPhysicalState()` (`packages/core/src/services/recoveryManager.ts`) reconciled crash-interrupted mutating tool calls (`APPLIED`) without advancing `workspaceRevision` via `executions.recordFilesChanged(...)`. Consequently, `workspaceRevision` remained at `0` and pre-crash `TEST`/`BUILD` verification checks from revision `0` remained valid (`currentPassing`) instead of being invalidated as `staleChecks`.
   - Both `RecoveryManager.reconcileFromPhysicalState()` and `reconcileBeforeCrossHarnessResume()` (`packages/core/src/services/executionRecovery.ts`) recorded `OperationReconciliationGuard` semantic keys only at the pre-reconcile revision (`0`), allowing duplicate mutation replay once workspace revision advanced to `1`.
   - `ExecutionEngine.reconcileToolCall()` (`packages/core/src/services/executionEngine.ts`) did not append reconciled calls to `record.toolCalls`, causing `reconstructExecutionState()` to omit reconciled calls from `consumed.toolCalls` and `maxToolCalls` budget enforcement.
3. **`A12-003` (P1 — Missing `taskId` Propagation Across `createControlledExecution` → `PolicyEngine` → `MobileApprovalService` Plus Async Approval-Registration Race Leaves Cancelled Tasks' Approvals Pending)**:
   - `createControlledExecution()` (`apps/api/src/toolExecution.ts`) omitted `taskId: request.taskId` when calling `policy.authorize(...)`, and `MobileApprovalService.requestApproval()` (`apps/api/src/mobile/eventHubAndApprovals.ts`) fell back to `const taskId = context?.taskId ?? request.executionId` instead of `context?.taskId ?? request.taskId ?? request.executionId`. When a task was cancelled via `MobileServices.cancelTask(taskId)`, `approvals.pendingForTask(taskId)` failed to find the approval because `record.taskId` held `executionId` (`exec-...`) instead of `taskId` (`task-...`).
   - Additionally, `MobileApprovalService.requestApproval()` inserted the pending record into `this.records` before awaiting `this.store.put` and `this.eventHub.publish`, registering the resolver in `this.resolvers` only afterward—creating an async race window where `resolveApproval()` resolved `record.status = 'rejected'` while `this.resolvers.get(record.id)` was still `undefined`, hanging the awaiting tool execution indefinitely.

---

## 2. Formal Alloy 6 Models & Solver Verdicts

### 2.1 Bundled Skill Baseline Models

Executed with `java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -o ...`:

| Model | Command | Verdict | Receipt Path |
| --- | --- | --- | --- |
| `task-terminal.als` | `00. run PositiveWitness` | `SAT` (`1/1`) | `results/a12-redteam/skill-baseline-task-terminal/receipt.json` |
| `task-terminal.als` | `01. check TerminalIsAbsorbing` | `UNSAT` (`BOUNDED_PASS`) | `results/a12-redteam/skill-baseline-task-terminal/receipt.json` |
| `task-terminal.als` | `02. check CompletedRequiresVerification` | `UNSAT` (`BOUNDED_PASS`) | `results/a12-redteam/skill-baseline-task-terminal/receipt.json` |
| `task-terminal-mutant.als` | `01. check TerminalIsAbsorbing` | `SAT` (`COUNTEREXAMPLE`) | `results/a12-redteam/skill-baseline-task-terminal-mutant/receipt.json` |
| `task-terminal-mutant.als` | `02. check CompletedRequiresVerification` | `UNSAT` | `results/a12-redteam/skill-baseline-task-terminal-mutant/receipt.json` |
| `delegated-policy.als` | `00. run DelegatedExecution` | `SAT` (`1/1`) | `results/a12-redteam/skill-baseline-delegated-policy/receipt.json` |
| `delegated-policy.als` | `01. check ChildCannotExceedParent` | `UNSAT` (`BOUNDED_PASS`) | `results/a12-redteam/skill-baseline-delegated-policy/receipt.json` |
| `delegated-policy.als` | `02. check SensitiveDataNeverReachesHostedOrSubagent` | `UNSAT` (`BOUNDED_PASS`) | `results/a12-redteam/skill-baseline-delegated-policy/receipt.json` |
| `delegated-policy.als` | `03. check NonAuthorNeverWritesSpec` | `UNSAT` (`BOUNDED_PASS`) | `results/a12-redteam/skill-baseline-delegated-policy/receipt.json` |

### 2.2 A12 Cross-Module Invariant Model (`a12-redteam.als`) and Mutant (`a12-redteam-mutant.als`)

| Model | Command | Scope | Verdict | Meaning |
| --- | --- | --- | --- | --- |
| `a12-redteam.als` | `00. run WitnessReconcileReverifyAndComplete` | `for 3 but 8 steps` | `SAT` (`1/1`) | Positive witness: crash during mutating tool call -> reconcile `APPLIED` -> advance revision `R0->R1` -> re-verify at `R1` -> complete |
| `a12-redteam.als` | `01. run WitnessCancelRevokesApproval` | `for 3 but 6 steps` | `SAT` (`1/1`) | Positive witness: approval requested with `taskId` -> task cancelled -> pending approval atomically revoked |
| `a12-redteam.als` | `02. run WitnessAssuranceGatePass` | `for 3 but 4 steps` | `SAT` (`1/1`) | Positive witness: approved spec + reviewer + fresh `Commit0`/`SpecHash0` ledger evidence for all required tools -> `GatePass` |
| `a12-redteam.als` | `03. check NoCompletionWithUnreconciledOrStaleEvidence` | `for 3 but 7 steps` | `UNSAT` (`BOUNDED_PASS`) | Invariant I1: `Completed` never occurs with `OutcomeUnknown` calls or verification evidence from an older `WorkspaceRev` |
| `a12-redteam.als` | `04. check NoPendingApprovalOrToolDispatchAfterCancel` | `for 3 but 6 steps` | `UNSAT` (`BOUNDED_PASS`) | Invariant I2: `Cancelled` task has no `ApprovalPending` and never transitions to `ApprovalApproved` or `ToolStarted` |
| `a12-redteam.als` | `05. check NoSupersededEpochCompletion` | `for 3 but 6 steps` | `UNSAT` (`BOUNDED_PASS`) | Invariant I3: Only the active `WorkerEpoch` can transition a task to `Completed` |
| `a12-redteam.als` | `06. check NoAssuranceReleaseGatePassOnStaleOrMissingEvidence` | `for 3 but 4 steps` | `UNSAT` (`BOUNDED_PASS`) | Invariant I4: `GatePass` requires `specApproved`, `specHasReviewer`, and fresh `Commit0`/`SpecHash0` `Proved`/`BoundedPass` evidence for every required tool |
| `a12-redteam-mutant.als` | `01. check NoCompletionWithUnreconciledOrStaleEvidence` | `for 3 but 6 steps` | `SAT` (`COUNTEREXAMPLE`) | Reproduces `A12-002`: `reconcileMutatingAppliedBuggy` leaves `workspaceRev = R0`, allowing completion on stale `R0` evidence after a reconciled mutation |
| `a12-redteam-mutant.als` | `02. check NoPendingApprovalOrToolDispatchAfterCancel` | `for 3 but 5 steps` | `SAT` (`COUNTEREXAMPLE`) | Reproduces `A12-003`: `cancelTaskBuggy` fails to revoke `ApprovalPending` when `taskId` was not bound on the approval |
| `a12-redteam-mutant.als` | `03. check NoAssuranceReleaseGatePassOnStaleOrMissingEvidence` | `for 3 but 4 steps` | `SAT` (`COUNTEREXAMPLE`) | Reproduces `A12-001`: `evaluateGateBuggy` passes release gate using stale commit/specHash evidence and ignoring un-run required tools |

---

## 3. Confirmed Findings & Reproducer Records

### Finding `A12-001`: Formal Assurance Release Gate Bypass via Stale `specHash` / `sourceCommit` Evidence & Un-run Spec Artifacts

- **Status**: `FIXED`
- **Priority / Severity**: `P0`
- **Category**: `verification-false-positive` / `cross-module-assurance-gate`
- **Subsystem**: `packages/assurance` (`record.ts` ↔ `cli.ts` ↔ `ledger.ts`)
- **Invariant**: `NoAssuranceReleaseGatePassOnStaleOrMissingEvidence` (`docs/formal-hardening/models/a12-redteam.als`)
- **Locations**:
  - `packages/assurance/src/record.ts:218-220` (`generateAssuranceRecord`)
  - `packages/assurance/src/cli.ts:986-1018` (`assureRecord`)
- **Root Cause**:
  1. In `generateAssuranceRecord()` (`packages/assurance/src/record.ts:218`), ledger entries for the target commit were filtered solely by `e.propertyId === propId`, omitting `(!spec?.content_hash || e.specHash === spec.content_hash)`. When a specification manifest was edited and re-approved with a new `content_hash` on the same commit (or working tree), stale `PROVED` / `BOUNDED_PASS` ledger entries from the previous `specHash` were still aggregated into the property verdict.
  2. In `assureRecord()` (`packages/assurance/src/cli.ts:986-1018`), the CLI release-gate builder:
     - Filtered `entries` only by `e.propertyId === manifest.id`, ignoring both `e.sourceCommit === options.sourceCommit` and `e.specHash === manifest.content_hash`.
     - Checked `manifest.status !== 'approved'` without checking `(manifest.reviewers?.length ?? 0) === 0`.
     - Computed `byTool(tool)` as `undefined` when no ledger entries existed for `tool`, and filtered `undefined` out of `propVerdictList` (`[consistency, envelope, contract, monitor].filter((v): v is Verdict => v !== undefined)`), so if a spec declared `alloy`, `z3`, and `dafny` artifacts (or `monitors`) and only 1 tool was run, the un-run obligations were silently dropped instead of contributing `Verdict.NOT_RUN`, yielding `release_gate.status = 'PASS'`.
- **Deterministic Reproduction (Pre-Fix Failure)**:
  - `packages/assurance/src/__tests__/record.test.ts` — test: `rejects ledger entries bound to a stale specHash when generating an AssuranceRecord for an updated spec`
    - Pre-fix output: `AssertionError: expected 'BOUNDED_PASS' to be 'NOT_RUN'` (`record.release_gate.status` was `'PASS'` instead of `'FAIL'`).
  - `packages/assurance/src/__tests__/cli.test.ts` — test: `fails release gate in assureRecord when ledger evidence is from a stale sourceCommit, mismatched specHash, or missing required spec artifacts`
    - Pre-fix output: `AssertionError: expected undefined to be 'NOT_RUN'` (`staleCommitRecord.release_gate.status` was `'PASS'` on stale commit evidence and missing Z3 artifact).
- **Minimal Remediation**:
  - In `packages/assurance/src/record.ts`, required `(!spec?.content_hash || e.specHash === spec.content_hash)` when selecting `propEntries`.
  - In `packages/assurance/src/cli.ts`, filtered `propEntries` by `e.sourceCommit === options.sourceCommit` and `(!manifest.content_hash || e.specHash === manifest.content_hash)`, enforced `(manifest.reviewers?.length ?? 0) === 0` as a release-gate blocker, and returned `Verdict.NOT_RUN` whenever a tool category (`alloy`, `z3`, `dafny`, `verifai`/`scenic`, or `monitors`) is declared in `manifest.artifacts` / `manifest.monitors` but has no matching ledger entries.
- **Post-Fix Verification**:
  - `packages/assurance/src/__tests__/record.test.ts` (11/11 tests passing)
  - `packages/assurance/src/__tests__/cli.test.ts` (7/7 tests passing)

---

### Finding `A12-002`: Reconciled `APPLIED` Tool Mutations Fail to Advance Workspace Revision During Sweep, Omit Post-Reconcile Guard Key, and Omit Reconciled Calls from Tool-Call Budget

- **Status**: `FIXED`
- **Priority / Severity**: `P0`
- **Category**: `recovery-reconciliation-boundary` / `stale-verification-evidence`
- **Subsystem**: `packages/core` (`RecoveryManager` ↔ `ExecutionEngine` ↔ `executionRecovery`)
- **Invariant**: `NoCompletionWithUnreconciledOrStaleEvidence` (`docs/formal-hardening/models/a12-redteam.als`)
- **Locations**:
  - `packages/core/src/services/recoveryManager.ts:224-256` (`reconcileFromPhysicalState`)
  - `packages/core/src/services/executionRecovery.ts:805-845, 909-949` (`reconcileBeforeCrossHarnessResume`)
  - `packages/core/src/services/executionEngine.ts:597-609` (`reconcileToolCall`)
- **Root Cause**:
  1. When `RecoveryManager.reconcileFromPhysicalState()` physically inspected an interrupted mutating tool call (`sideEffectClass !== 'READ_ONLY'`) and proved it `APPLIED`, it called `executions.reconcileToolCall(...)` and `operationGuard.recordConfirmedMutation(...)` at `call.workspaceRevision`, but never called `executions.recordFilesChanged(...)` to advance the execution's `workspaceRevision`. As a result, `workspaceRevision` stayed at `0` and any `TEST`/`BUILD` verification check recorded at revision `0` before the crash-interrupted write remained in `state.verification.currentPassing` instead of being fenced off as `staleChecks`.
  2. Both `RecoveryManager.reconcileFromPhysicalState()` and `reconcileBeforeCrossHarnessResume()` only recorded the `OperationReconciliationGuard` semantic operation key at `call.workspaceRevision` (`0`). Once `workspaceRevision` advanced to `1`, a resumed worker retrying the identical mutation at revision `1` queried `:rev:1` and bypassed duplicate suppression.
  3. `ExecutionEngine.reconcileToolCall()` emitted `tool.completed` and `tool.call.completed`/`tool.call.failed` events without appending a `ToolCallRecord` to `record.toolCalls`. Because `reconstructExecutionState()` computes `consumed.toolCalls = record.toolCalls.length`, reconciled tool calls were ignored by `maxToolCalls` budget enforcement.
- **Deterministic Reproduction (Pre-Fix Failure)**:
  - `packages/core/tests/executionRecovery.test.ts` — test: `advances workspace revision and invalidates prior verification evidence when sweep reconciles a mutation as APPLIED, and counts reconciled calls in toolCall budget`
    - Pre-fix output: `AssertionError: expected +0 to be 1` on `expect(executions.getWorkspaceRevision(id)).toBe(1)`.
- **Minimal Remediation**:
  - In `RecoveryManager.reconcileFromPhysicalState()`, when `outcome === 'APPLIED'` and `call.sideEffectClass !== 'READ_ONLY'`, advance workspace revision via `this.deps.executions.recordFilesChanged(...)` and record the `OperationReconciliationGuard` receipt at both `call.workspaceRevision` and the post-reconcile `effectiveRev`.
  - In `reconcileBeforeCrossHarnessResume()` (`executionRecovery.ts`), also record the `OperationReconciliationGuard` receipt at the post-reconcile workspace revision (`effectiveRev`) when `effectiveRev !== call.workspaceRevision`.
  - In `ExecutionEngine.reconcileToolCall()`, append a `ToolCallRecord` to `record.toolCalls` if one with `callId` is not already present.
- **Post-Fix Verification**:
  - `packages/core/tests/executionRecovery.test.ts` (10/10 tests passing)
  - `packages/core/tests/crossHarnessRecoveryQualification.test.ts` (13/13 tests passing)
  - `packages/core/tests/phase3RecoveryAndTransitions.test.ts` (6/6 tests passing)
  - `packages/core/tests/recoveryManager.test.ts` (4/4 tests passing)

---

### Finding `A12-003`: Missing `taskId` Propagation Across `createControlledExecution` → `PolicyEngine` → `MobileApprovalService` Plus Async Approval-Registration Race Leaves Cancelled Tasks' Approvals Pending

- **Status**: `FIXED`
- **Priority / Severity**: `P1`
- **Category**: `approval-cancellation-boundary` / `concurrency-race`
- **Subsystem**: `apps/api` & `packages/core` (`toolExecution.ts` ↔ `policy.ts` ↔ `server.ts` ↔ `eventHubAndApprovals.ts` ↔ `mobile.ts`)
- **Invariant**: `NoPendingApprovalOrToolDispatchAfterCancel` (`docs/formal-hardening/models/a12-redteam.als`)
- **Locations**:
  - `packages/core/src/types/policy.ts:103-112` (`PolicyActionRequest`)
  - `apps/api/src/toolExecution.ts:82-89` (`createControlledExecution`)
  - `apps/api/src/server.ts:559-562` (`approve` callback wiring)
  - `apps/api/src/mobile/eventHubAndApprovals.ts:280, 311-332` (`MobileApprovalService.requestApproval`)
  - `apps/api/src/mobile.ts:1194-1199` (`MobileServices.cancelTask`)
- **Root Cause**:
  1. `PolicyActionRequest` did not declare `taskId?: string`, and `createControlledExecution()` (`apps/api/src/toolExecution.ts:82`) omitted `taskId: request.taskId` when calling `policy.authorize(...)`.
  2. `MobileApprovalService.requestApproval()` (`apps/api/src/mobile/eventHubAndApprovals.ts:280`) computed `const taskId = context?.taskId ?? request.executionId;` (ignoring `request.taskId`), and `apps/api/src/server.ts:560` called `mobileRef.approvals.requestApproval(request, decision)` without `context`. Consequently, every approval created through `createControlledExecution` stored `executionId` (`exec-...`) in `record.taskId`. When `MobileServices.cancelTask(taskId)` called `this.approvals.pendingForTask(taskId)`, `r.taskId === taskId || r.executionId === taskId` evaluated to `false` because neither field held `task-...`, leaving the cancelled task's approval pending!
  3. Furthermore, `MobileApprovalService.requestApproval()` added `record` to `this.records` before `await this.store.put(...)` and `await this.eventHub.publish(...)`, and only registered `{ resolve, timer }` in `this.resolvers` *after* both `await` points. If `resolveApproval()` was called during that async window (e.g., by an immediate task cancellation or event listener), `resolveApproval()` set `record.status = 'rejected'` while `this.resolvers.get(record.id)` was still `undefined`, causing `requestApproval()`'s returned Promise to hang until the 15-minute TTL expired.
- **Deterministic Reproduction (Pre-Fix Failure)**:
  - `packages/core/tests/executionRecovery.test.ts` — test: `propagates taskId across createControlledExecution -> PolicyEngine -> MobileApprovalService so task cancellation revokes pending approvals`
    - Pre-fix output: `AssertionError: expected [] to have a length of 1 but got +0` on `expect(approvals.pendingForTask('task-cancel-test-1')).toHaveLength(1)`.
- **Minimal Remediation**:
  - Added optional `taskId?: string` to `PolicyActionRequest` in `packages/core/src/types/policy.ts`.
  - Forwarded `taskId: request.taskId` in `createControlledExecution()` (`apps/api/src/toolExecution.ts:86`) and `apps/api/src/server.ts:560`.
  - Updated `MobileApprovalService.requestApproval()` (`apps/api/src/mobile/eventHubAndApprovals.ts:280`) to resolve `const taskId = context?.taskId ?? request.taskId ?? request.executionId;` and register the resolver in `this.resolvers` *before* inserting `record` into `this.records` and awaiting `store.put` / `eventHub.publish`.
  - Updated `MobileServices.cancelTask()` (`apps/api/src/mobile.ts:1194`) to collect pending approvals across both `task.taskId` and `task.executionId`.
- **Post-Fix Verification**:
  - `packages/core/tests/executionRecovery.test.ts` (10/10 tests passing)

---

## 4. Residual Risks & Coverage Boundaries

- **Bounded Model Scope**: Alloy 6 temporal checks in `a12-redteam.als` are bounded up to scope 3 and 4–8 trace steps (`BOUNDED_PASS`, not unbounded theorem proving).
- **Physical Outcome Inspection**: `RecoveryManager.reconcileFromPhysicalState()` relies on the accuracy of the injected `inspectToolOutcome` adapter (`@wazir/tools`). If an external tool performs an out-of-band network mutation that cannot be physically inspected from the workspace, `inspectToolOutcome` returns `UNDETERMINED`, which our invariant `NoCompletionWithUnreconciledOrStaleEvidence` keeps blocked rather than allowing silent completion or blind replay.
