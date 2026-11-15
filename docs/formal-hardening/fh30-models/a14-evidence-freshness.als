module a14_evidence_freshness

/*
 * ==============================================================================
 * A14: Evidence Freshness & Completion Eligibility Formal Model
 * ==============================================================================
 * System: Wazir Durable Execution & Verification Subsystem
 * Group: GROUP E (P0) — Verification Freshness & False-Success Elimination
 * Reference Commit: 4661c33a6caeaca0639853463e4ccbbe3ebc63d8
 * Source Files:
 *   - packages/core/src/services/verificationEvidenceInspector.ts
 *   - packages/core/src/services/executionEngine.ts
 *   - packages/core/src/services/evidencePolicy.ts
 *
 * Critical Invariant:
 *   "Wazir must never report verified completion without sufficient trusted
 *    controller evidence corresponding to the current workspace revision and
 *    reconciliation of all dispatched tool side effects."
 * ==============================================================================
 */

open util/ordering[Revision]

// Workspace revision sequence: R0 (first), R1, R2...
sig Revision {}

// Origin of verification records
abstract sig Provenance {}
one sig Controller extends Provenance {}      // Trusted physical oracle / controller execution
one sig ModelNarration extends Provenance {}  // Untrusted agent / LLM narrative output

// Verification outcome
abstract sig Verdict {}
one sig Pass, Fail extends Verdict {}

// Dispatched tool calls tracking potential side effects
sig ToolCall {}

// Immutable verification evidence record
sig Evidence {
  provenance: one Provenance,
  testedRevision: one Revision,
  verdict: one Verdict
}

// Lifecycle status of execution
abstract sig ExecutionStatus {}
one sig Running, Completed, Failed extends ExecutionStatus {}

// Dynamic state of the execution
one sig Execution {
  var status: one ExecutionStatus,
  var currentRevision: one Revision,
  var recordedEvidence: set Evidence,
  var unresolvedSideEffects: set ToolCall
}

// ------------------------------------------------------------------------------
// Initial State
// ------------------------------------------------------------------------------
pred init {
  Execution.status = Running
  Execution.currentRevision = first
  no Execution.recordedEvidence
  no Execution.unresolvedSideEffects
}

// ------------------------------------------------------------------------------
// State Transitions
// ------------------------------------------------------------------------------

/**
 * Workspace file mutation (e.g. recordFileMutations, git patch, user edit).
 * Advances workspace revision, rendering previously recorded evidence STALE.
 */
pred mutateWorkspace {
  Execution.status = Running
  some Execution.currentRevision.next
  Execution.currentRevision' = Execution.currentRevision.next
  Execution.status' = Execution.status
  Execution.recordedEvidence' = Execution.recordedEvidence
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

/**
 * Tool call dispatch: begins a tool operation that may incur physical side effects.
 * Enters STARTED / OUTCOME_UNKNOWN state in toolCheckpoints.
 */
pred dispatchToolCall[t: ToolCall] {
  Execution.status = Running
  t not in Execution.unresolvedSideEffects
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects + t
  Execution.status' = Execution.status
  Execution.currentRevision' = Execution.currentRevision
  Execution.recordedEvidence' = Execution.recordedEvidence
}

/**
 * Tool call reconciliation: confirms completion or rollback of tool action.
 */
pred reconcileToolCall[t: ToolCall] {
  Execution.status = Running
  t in Execution.unresolvedSideEffects
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects - t
  Execution.status' = Execution.status
  Execution.currentRevision' = Execution.currentRevision
  Execution.recordedEvidence' = Execution.recordedEvidence
}

/**
 * Controller-recorded verification evidence (build, test, acceptance).
 * The controller executes physical checks against the workspace at the current revision.
 */
pred recordControllerEvidence[e: Evidence] {
  Execution.status = Running
  e.provenance = Controller
  e.testedRevision = Execution.currentRevision
  e not in Execution.recordedEvidence
  Execution.recordedEvidence' = Execution.recordedEvidence + e
  Execution.status' = Execution.status
  Execution.currentRevision' = Execution.currentRevision
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

/**
 * Model narration claim: the LLM outputs narrative prose claiming test pass/fail.
 * Untrusted; stored in record.result or event logs, but never elevates to controller evidence.
 */
pred recordModelNarration[e: Evidence] {
  Execution.status = Running
  e.provenance = ModelNarration
  e not in Execution.recordedEvidence
  Execution.recordedEvidence' = Execution.recordedEvidence + e
  Execution.status' = Execution.status
  Execution.currentRevision' = Execution.currentRevision
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

/**
 * Execution completion transition (ExecutionEngine.setStatus(id, 'completed')).
 * Gated by:
 *  1. Zero unresolved tool side effects (TOOL_OUTCOME_UNKNOWN barrier).
 *  2. Fresh Controller Pass evidence matching current workspace revision.
 *  3. No unrectified Fail evidence at current revision.
 */
pred completeExecution {
  Execution.status = Running
  no Execution.unresolvedSideEffects
  some e: Execution.recordedEvidence |
    e.provenance = Controller and
    e.testedRevision = Execution.currentRevision and
    e.verdict = Pass
  no e: Execution.recordedEvidence |
    e.provenance = Controller and
    e.testedRevision = Execution.currentRevision and
    e.verdict = Fail
  Execution.status' = Completed
  Execution.currentRevision' = Execution.currentRevision
  Execution.recordedEvidence' = Execution.recordedEvidence
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

/**
 * Execution failure transition (e.g. fatal error or unrecoverable verification failure).
 */
pred failExecution {
  Execution.status = Running
  Execution.status' = Failed
  Execution.currentRevision' = Execution.currentRevision
  Execution.recordedEvidence' = Execution.recordedEvidence
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

/**
 * Stuttering step to allow infinite lasso traces in terminal or idle states.
 */
pred stutter {
  Execution.status' = Execution.status
  Execution.currentRevision' = Execution.currentRevision
  Execution.recordedEvidence' = Execution.recordedEvidence
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

// ------------------------------------------------------------------------------
// Trace Specification
// ------------------------------------------------------------------------------
fact traces {
  init
  always (
    mutateWorkspace or
    (some t: ToolCall | dispatchToolCall[t]) or
    (some t: ToolCall | reconcileToolCall[t]) or
    (some e: Evidence | recordControllerEvidence[e]) or
    (some e: Evidence | recordModelNarration[e]) or
    completeExecution or
    failExecution or
    stutter
  )
}

// ------------------------------------------------------------------------------
// Witnesses (Sanity / Non-Vacuity Checks)
// ------------------------------------------------------------------------------

// Witness 1: Valid task completes normally with fresh controller evidence
run WitnessNormalCompletion {
  eventually Execution.status = Completed
} for 3 Revision, 4 Evidence, 2 ToolCall, 7 steps

// Witness 2: Mutation occurs, invalidating old evidence; new fresh evidence passes and completes
run WitnessMutationThenFreshVerification {
  eventually (Execution.status = Completed and Execution.currentRevision != first)
} for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps

// Witness 3: Tool dispatch and reconciliation lifecycle occurs before completion
run WitnessToolLifecycleBeforeCompletion {
  eventually (
    some t: ToolCall |
      once (t in Execution.unresolvedSideEffects) and
      Execution.status = Completed
  )
} for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps

// ------------------------------------------------------------------------------
// Invariant Assertions
// ------------------------------------------------------------------------------

/**
 * Critical Invariant (P0):
 * Completed execution always has Controller provenance Pass evidence matching currentRevision
 * and no unresolved side effects.
 */
assert NoFalseVerifiedCompletion {
  always (
    Execution.status = Completed implies (
      (some e: Execution.recordedEvidence |
        e.provenance = Controller and
        e.verdict = Pass and
        e.testedRevision = Execution.currentRevision) and
      (no Execution.unresolvedSideEffects)
    )
  )
}

/**
 * Stale evidence from prior revisions can never authorize completion.
 */
assert StaleEvidenceNeverAuthorizesCompletion {
  always (
    (Execution.status = Completed) implies
      not (all e: Execution.recordedEvidence | e.testedRevision != Execution.currentRevision)
  )
}

/**
 * Model narration alone can never authorize completion.
 */
assert ModelNarrationNeverAuthorizesCompletion {
  always (
    (Execution.status = Completed) implies
      (some e: Execution.recordedEvidence | e.provenance = Controller and e.verdict = Pass)
  )
}

/**
 * Unresolved tool calls strictly block completion.
 */
assert UnresolvedSideEffectsBlockCompletion {
  always (
    (some Execution.unresolvedSideEffects) implies (Execution.status != Completed)
  )
}

// ------------------------------------------------------------------------------
// Check Commands
// ------------------------------------------------------------------------------
check NoFalseVerifiedCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
check StaleEvidenceNeverAuthorizesCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
check ModelNarrationNeverAuthorizesCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
check UnresolvedSideEffectsBlockCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
