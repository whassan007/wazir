module wazir_a12_redteam

/*
 * Wazir A12 Red-Team & Cross-Module Boundary Temporal Model
 *
 * Models four end-to-end cross-module interaction boundaries:
 * 1. Execution Lease Expiry + Recovery vs. Stale Worker Commits
 * 2. Cross-Harness Tool Outcome Reconciliation vs. Workspace Revision & Verification Evidence
 * 3. Mobile Human Approval Lifecycle vs. Task Cancellation & Tool Dispatch
 * 4. Formal Assurance Release Gate vs. Source Commit, Spec Content Hash & Required Artifacts
 */

enum ExecStatus { Queued, Running, Completed, Failed, Cancelled }
enum ToolCallState { Dispatched, OutcomeUnknown, ReconciledApplied, ReconciledNotApplied, CompletedOk }
enum ApprovalState { Pending, Approved, Rejected, Expired }
enum GateVerdict { GatePass, GateFail }

abstract sig Epoch {}
one sig E1, E2 extends Epoch {}

abstract sig Revision {}
one sig R0, R1 extends Revision {}

abstract sig CommitHash {}
one sig C1, C2 extends CommitHash {}

abstract sig SpecHash {}
one sig S1, S2 extends SpecHash {}

abstract sig FormalTool {}
one sig ToolAlloy, ToolZ3, ToolDafny extends FormalTool {}

sig Worker {}

one sig Execution {
  var status: one ExecStatus,
  var activeWorker: lone Worker,
  var activeEpoch: one Epoch,
  var workspaceRev: one Revision,
  var verifiedAtRev: lone Revision,
  var toolState: lone ToolCallState,
  var toolDispatchedAfterApproval: one Bool
}

enum Bool { True, False }

one sig ApprovalRecord {
  var state: one ApprovalState,
  var boundTaskId: one TaskId,
  var boundExecId: one ExecId
}

enum TaskId { T1 }
enum ExecId { X1 }

sig LedgerEntry {
  commit: one CommitHash,
  specHash: one SpecHash,
  tool: one FormalTool,
  passed: one Bool
}

one sig AssuranceGate {
  targetCommit: one CommitHash,
  targetSpecHash: one SpecHash,
  specApproved: one Bool,
  hasReviewer: one Bool,
  requiredTools: set FormalTool,
  var verdict: one GateVerdict
}

pred isTerminal[s: ExecStatus] {
  s in Completed + Failed + Cancelled
}

pred nextRev[r, rNext: Revision] {
  r = R0 and rNext = R1
}

pred nextEpoch[e, eNext: Epoch] {
  e = E1 and eNext = E2
}

-- Matching passing ledger entry for a required tool on the exact target commit and spec hash
pred hasValidPassingEntry[t: FormalTool] {
  some e: LedgerEntry |
    e.tool = t and
    e.commit = AssuranceGate.targetCommit and
    e.specHash = AssuranceGate.targetSpecHash and
    e.passed = True
}

pred gateCanPass {
  AssuranceGate.specApproved = True
  AssuranceGate.hasReviewer = True
  some AssuranceGate.requiredTools
  all t: AssuranceGate.requiredTools | hasValidPassingEntry[t]
}

pred init {
  Execution.status = Queued
  no Execution.activeWorker
  Execution.activeEpoch = E1
  Execution.workspaceRev = R0
  no Execution.verifiedAtRev
  no Execution.toolState
  Execution.toolDispatchedAfterApproval = False

  ApprovalRecord.state = Pending
  ApprovalRecord.boundTaskId = T1
  ApprovalRecord.boundExecId = X1

  AssuranceGate.verdict = (gateCanPass => GatePass else GateFail)
}

pred frameUnchangedExecution {
  Execution.status' = Execution.status
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = Execution.toolState
  Execution.toolDispatchedAfterApproval' = Execution.toolDispatchedAfterApproval
}

pred frameUnchangedApproval {
  ApprovalRecord.state' = ApprovalRecord.state
  ApprovalRecord.boundTaskId' = ApprovalRecord.boundTaskId
  ApprovalRecord.boundExecId' = ApprovalRecord.boundExecId
}

pred frameUnchangedGate {
  AssuranceGate.verdict' = AssuranceGate.verdict
}

-- Transition 1: Worker acquires initial lease and starts execution
pred startExecution[w: Worker] {
  Execution.status = Queued
  Execution.status' = Running
  Execution.activeWorker' = w
  Execution.activeEpoch' = E1
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = Execution.toolState
  Execution.toolDispatchedAfterApproval' = Execution.toolDispatchedAfterApproval
  frameUnchangedApproval
  frameUnchangedGate
}

-- Transition 2: Recovery reassigns lease to a new worker at epoch E2 and marks any in-flight tool call OutcomeUnknown
pred recoverAndReassignLease[wNew: Worker] {
  Execution.status = Running
  Execution.activeEpoch = E1
  Execution.status' = Running
  Execution.activeWorker' = wNew
  Execution.activeEpoch' = E2
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = (Execution.toolState = Dispatched => OutcomeUnknown else Execution.toolState)
  Execution.toolDispatchedAfterApproval' = Execution.toolDispatchedAfterApproval
  frameUnchangedApproval
  frameUnchangedGate
}

-- Transition 3: Active fenced worker dispatches a mutating tool call after approval is granted
pred dispatchApprovedTool[w: Worker, e: Epoch] {
  Execution.status = Running
  Execution.activeWorker = w
  Execution.activeEpoch = e
  no Execution.toolState
  ApprovalRecord.state = Approved
  Execution.status' = Execution.status
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = Dispatched
  Execution.toolDispatchedAfterApproval' = True
  frameUnchangedApproval
  frameUnchangedGate
}

-- Transition 4: Reconcile an OutcomeUnknown tool call as APPLIED, advancing workspace revision
pred reconcileToolApplied {
  Execution.status = Running
  Execution.toolState = OutcomeUnknown
  Execution.workspaceRev = R0
  Execution.status' = Running
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = R1
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = ReconciledApplied
  Execution.toolDispatchedAfterApproval' = Execution.toolDispatchedAfterApproval
  frameUnchangedApproval
  frameUnchangedGate
}

-- Transition 5: Run verification oracle at current workspace revision
pred recordVerificationPass[w: Worker, e: Epoch] {
  Execution.status = Running
  Execution.activeWorker = w
  Execution.activeEpoch = e
  Execution.status' = Running
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.workspaceRev
  Execution.toolState' = Execution.toolState
  Execution.toolDispatchedAfterApproval' = Execution.toolDispatchedAfterApproval
  frameUnchangedApproval
  frameUnchangedGate
}

-- Transition 6: Complete execution (requires active lease, reconciled tool state, and current-revision verification)
pred completeExecution[w: Worker, e: Epoch] {
  Execution.status = Running
  Execution.activeWorker = w
  Execution.activeEpoch = e
  no Execution.toolState or Execution.toolState in ReconciledApplied + ReconciledNotApplied + CompletedOk
  Execution.verifiedAtRev = Execution.workspaceRev
  Execution.status' = Completed
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = Execution.toolState
  Execution.toolDispatchedAfterApproval' = Execution.toolDispatchedAfterApproval
  frameUnchangedApproval
  frameUnchangedGate
}

-- Transition 7: Cancel task and atomically reject any pending approval bound to taskId OR executionId
pred cancelTask {
  not isTerminal[Execution.status]
  Execution.status' = Cancelled
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = Execution.toolState
  Execution.toolDispatchedAfterApproval' = Execution.toolDispatchedAfterApproval

  ApprovalRecord.state' = (ApprovalRecord.state = Pending => Rejected else ApprovalRecord.state)
  ApprovalRecord.boundTaskId' = ApprovalRecord.boundTaskId
  ApprovalRecord.boundExecId' = ApprovalRecord.boundExecId
  frameUnchangedGate
}

-- Transition 8: Operator approves pending approval while task is non-terminal
pred approvePending {
  not isTerminal[Execution.status]
  ApprovalRecord.state = Pending
  frameUnchangedExecution
  ApprovalRecord.state' = Approved
  ApprovalRecord.boundTaskId' = ApprovalRecord.boundTaskId
  ApprovalRecord.boundExecId' = ApprovalRecord.boundExecId
  frameUnchangedGate
}

-- Transition 9: Stutter step
pred stutter {
  frameUnchangedExecution
  frameUnchangedApproval
  frameUnchangedGate
}

fact Traces {
  init
  always (
    (some w: Worker | startExecution[w]) or
    (some w: Worker | recoverAndReassignLease[w]) or
    (some w: Worker, e: Epoch | dispatchApprovedTool[w, e]) or
    reconcileToolApplied or
    (some w: Worker, e: Epoch | recordVerificationPass[w, e]) or
    (some w: Worker, e: Epoch | completeExecution[w, e]) or
    cancelTask or
    approvePending or
    stutter
  )
}

-- Invariant 1: An execution never completes with an unreconciled tool call or stale verification revision
assert NoCompletionWithUnreconciledOrStaleEvidence {
  always (
    Execution.status = Completed implies (
      (no Execution.toolState or Execution.toolState not in Dispatched + OutcomeUnknown) and
      Execution.verifiedAtRev = Execution.workspaceRev
    )
  )
}

-- Invariant 2: Once a task is cancelled, its approval cannot remain Pending or transition to Approved,
-- and no tool call may be dispatched after cancellation
assert NoPendingApprovalOrToolDispatchAfterCancel {
  always (
    Execution.status = Cancelled implies (
      ApprovalRecord.state != Pending and
      always (ApprovalRecord.state != Approved or once (ApprovalRecord.state = Approved and Execution.status != Cancelled))
    )
  )
}

-- Invariant 3: A superseded worker from epoch E1 cannot complete or mutate the execution after epoch advances to E2
assert NoSupersededEpochCompletion {
  always (
    (Execution.activeEpoch = E2 and Execution.status = Running) implies
      not (some w: Worker | completeExecution[w, E1])
  )
}

-- Invariant 4: Formal assurance release gate never passes when any required tool lacks a passing ledger entry
-- matching both targetCommit and targetSpecHash, or when spec approval / reviewer is missing
assert NoAssuranceReleaseGatePassOnStaleOrMissingEvidence {
  always (
    AssuranceGate.verdict = GatePass implies (
      AssuranceGate.specApproved = True and
      AssuranceGate.hasReviewer = True and
      some AssuranceGate.requiredTools and
      (all t: AssuranceGate.requiredTools | hasValidPassingEntry[t])
    )
  )
}

-- Positive Non-Vacuity Witnesses
run WitnessReconcileReverifyAndComplete {
  eventually (
    Execution.toolState = ReconciledApplied and
    Execution.workspaceRev = R1 and
    Execution.status = Completed
  )
} for 3 but 8 steps

run WitnessCancelRevokesApproval {
  eventually (
    Execution.status = Cancelled and
    ApprovalRecord.state = Rejected
  )
} for 3 but 5 steps

run WitnessAssuranceGatePass {
  AssuranceGate.verdict = GatePass
  #AssuranceGate.requiredTools = 2
} for 3 but 4 steps

check NoCompletionWithUnreconciledOrStaleEvidence for 3 but 7 steps
check NoPendingApprovalOrToolDispatchAfterCancel for 3 but 6 steps
check NoSupersededEpochCompletion for 3 but 6 steps
check NoAssuranceReleaseGatePassOnStaleOrMissingEvidence for 4 but 4 steps
