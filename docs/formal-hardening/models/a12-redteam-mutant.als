module wazir_a12_redteam_mutant

/*
 * Wazir A12 Negative-Control Mutant Model
 *
 * Intentionally introduces the cross-module bugs found during the A12 audit:
 * 1. Buggy Assurance Gate (`gateCanPassMutant`): ignores `commit` and `specHash` mismatches
 *    and ignores un-run required tools if at least one tool passed (matching the unpatched
 *    behavior in `packages/assurance/src/record.ts` and `packages/assurance/src/cli.ts`).
 * 2. Buggy Task Cancel (`cancelTaskMutant`): fails to revoke pending approval when
 *    `ApprovalRecord` was keyed only by `executionId` instead of `taskId` (matching the
 *    unpatched `server.ts` -> `MobileApprovalService.requestApproval` taskId omission).
 * 3. Buggy Reconciled Completion (`completeExecutionMutant`): allows completion using
 *    verification evidence from revision R0 after `reconcileToolApplied` advances workspace
 *    revision to R1.
 */

enum ExecStatus { Queued, Running, Completed, Failed, Cancelled }
enum ToolCallState { Dispatched, OutcomeUnknown, ReconciledApplied, ReconciledNotApplied, CompletedOk }
enum ApprovalState { Pending, Approved, Rejected, Expired }
enum GateVerdict { GatePass, GateFail }
enum Bool { True, False }

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
  var toolState: lone ToolCallState
}

one sig ApprovalRecord {
  var state: one ApprovalState,
  var hasTaskIdBinding: one Bool
}

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

pred hasValidPassingEntry[t: FormalTool] {
  some e: LedgerEntry |
    e.tool = t and
    e.commit = AssuranceGate.targetCommit and
    e.specHash = AssuranceGate.targetSpecHash and
    e.passed = True
}

-- MUTANT BUG: matches `cli.ts` assureRecord & `record.ts` generateAssuranceRecord before fix:
-- accepts any passing ledger entry regardless of specHash/commit mismatch and only checks
-- tools that have entries rather than requiring all `requiredTools` to have run.
pred gateCanPassMutant {
  AssuranceGate.specApproved = True
  some e: LedgerEntry | e.tool in AssuranceGate.requiredTools and e.passed = True
  all e: LedgerEntry | e.tool in AssuranceGate.requiredTools implies e.passed = True
}

pred init {
  Execution.status = Running
  some Execution.activeWorker
  Execution.activeEpoch = E1
  Execution.workspaceRev = R0
  Execution.verifiedAtRev = R0
  Execution.toolState = OutcomeUnknown

  ApprovalRecord.state = Pending
  ApprovalRecord.hasTaskIdBinding = False

  AssuranceGate.verdict = (gateCanPassMutant => GatePass else GateFail)
}

-- MUTANT BUG: Reconciling an OutcomeUnknown tool call as APPLIED advances workspaceRev to R1,
-- and completion checks `some Execution.verifiedAtRev` without enforcing `verifiedAtRev = workspaceRev`.
pred reconcileAndCompleteStale {
  Execution.status = Running
  Execution.toolState = OutcomeUnknown
  Execution.workspaceRev = R0
  some Execution.verifiedAtRev
  Execution.status' = Completed
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = R1
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = ReconciledApplied
  ApprovalRecord.state' = ApprovalRecord.state
  ApprovalRecord.hasTaskIdBinding' = ApprovalRecord.hasTaskIdBinding
  AssuranceGate.verdict' = AssuranceGate.verdict
}

-- MUTANT BUG: Cancelling a task only revokes pending approvals where `hasTaskIdBinding = True`,
-- leaving approvals created without `context.taskId` in `Pending` state after task cancellation!
pred cancelTaskMutant {
  Execution.status = Running
  Execution.status' = Cancelled
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = Execution.toolState
  ApprovalRecord.state' = (ApprovalRecord.hasTaskIdBinding = True => Rejected else ApprovalRecord.state)
  ApprovalRecord.hasTaskIdBinding' = ApprovalRecord.hasTaskIdBinding
  AssuranceGate.verdict' = AssuranceGate.verdict
}

pred stutter {
  Execution.status' = Execution.status
  Execution.activeWorker' = Execution.activeWorker
  Execution.activeEpoch' = Execution.activeEpoch
  Execution.workspaceRev' = Execution.workspaceRev
  Execution.verifiedAtRev' = Execution.verifiedAtRev
  Execution.toolState' = Execution.toolState
  ApprovalRecord.state' = ApprovalRecord.state
  ApprovalRecord.hasTaskIdBinding' = ApprovalRecord.hasTaskIdBinding
  AssuranceGate.verdict' = AssuranceGate.verdict
}

fact Traces {
  init
  always (reconcileAndCompleteStale or cancelTaskMutant or stutter)
}

assert NoCompletionWithUnreconciledOrStaleEvidence {
  always (
    Execution.status = Completed implies (
      (no Execution.toolState or Execution.toolState not in Dispatched + OutcomeUnknown) and
      Execution.verifiedAtRev = Execution.workspaceRev
    )
  )
}

assert NoPendingApprovalOrToolDispatchAfterCancel {
  always (
    Execution.status = Cancelled implies ApprovalRecord.state != Pending
  )
}

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

run WitnessMutantInit {
  Execution.status = Running
} for 3 but 3 steps

check NoCompletionWithUnreconciledOrStaleEvidence for 3 but 4 steps
check NoPendingApprovalOrToolDispatchAfterCancel for 3 but 4 steps
check NoAssuranceReleaseGatePassOnStaleOrMissingEvidence for 4 but 3 steps
