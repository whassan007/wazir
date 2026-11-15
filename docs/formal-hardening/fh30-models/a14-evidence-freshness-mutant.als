module a14_evidence_freshness_mutant

/*
 * ==============================================================================
 * A14: Evidence Freshness & Completion Eligibility — Negative Control Mutant
 * ==============================================================================
 * System: Wazir Durable Execution & Verification Subsystem
 * Group: GROUP E (P0) — Negative Control Verification Mutant
 * Reference Commit: 4661c33a6caeaca0639853463e4ccbbe3ebc63d8
 *
 * Flaw Injected:
 *   In `completeExecutionMutant`, the completion gate:
 *   1. Ignores revision freshness (accepts Pass evidence from an older revision
 *      prior to a workspace mutation, i.e. stale revision).
 *   2. Ignores provenance (accepts untrusted ModelNarration prose as Pass evidence).
 *   3. Ignores tool side effects (permits completion while unresolved tool calls exist).
 *
 * Counterexamples Expected:
 *   All safety invariants (`NoFalseVerifiedCompletion`, etc.) MUST fail and
 *   produce concrete violation traces.
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
 * Advances workspace revision.
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
 * DEFECTIVE COMPLETION GATE (MUTANT):
 * Allows completing when ANY Pass evidence exists in history, regardless of:
 *  - whether the workspace was subsequently mutated (stale revision),
 *  - whether the evidence was generated by ModelNarration vs Controller,
 *  - whether outstanding unresolved tool calls exist.
 */
pred completeExecutionMutant {
  Execution.status = Running
  // DEFECT 1: e.testedRevision is NOT checked against Execution.currentRevision!
  // DEFECT 2: e.provenance is NOT checked for Controller!
  // DEFECT 3: Execution.unresolvedSideEffects is NOT checked!
  some e: Execution.recordedEvidence | e.verdict = Pass
  Execution.status' = Completed
  Execution.currentRevision' = Execution.currentRevision
  Execution.recordedEvidence' = Execution.recordedEvidence
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

/**
 * Execution failure transition.
 */
pred failExecution {
  Execution.status = Running
  Execution.status' = Failed
  Execution.currentRevision' = Execution.currentRevision
  Execution.recordedEvidence' = Execution.recordedEvidence
  Execution.unresolvedSideEffects' = Execution.unresolvedSideEffects
}

/**
 * Stuttering step.
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
    completeExecutionMutant or
    failExecution or
    stutter
  )
}

// ------------------------------------------------------------------------------
// Targeted Violation Witnesses
// ------------------------------------------------------------------------------

// Witness 1: False completion using stale revision (mutation occurred after test pass)
run WitnessStaleRevisionFalseCompletion {
  eventually (
    Execution.status = Completed and
    (some e: Execution.recordedEvidence | e.provenance = Controller and e.verdict = Pass) and
    (no e: Execution.recordedEvidence | e.provenance = Controller and e.testedRevision = Execution.currentRevision)
  )
} for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps

// Witness 2: False completion using model narration alone (no controller evidence)
run WitnessModelNarrationFalseCompletion {
  eventually (
    Execution.status = Completed and
    (all e: Execution.recordedEvidence | e.provenance = ModelNarration)
  )
} for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps

// Witness 3: False completion with unresolved tool side effect outstanding
run WitnessUnresolvedSideEffectFalseCompletion {
  eventually (
    Execution.status = Completed and
    (some Execution.unresolvedSideEffects)
  )
} for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps

// ------------------------------------------------------------------------------
// Invariant Assertions (Expected to FAIL with Counterexamples)
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
// Check Commands (Alloy will report counterexamples for all checks)
// ------------------------------------------------------------------------------
check NoFalseVerifiedCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
check StaleEvidenceNeverAuthorizesCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
check ModelNarrationNeverAuthorizesCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
check UnresolvedSideEffectsBlockCompletion for 3 Revision, 4 Evidence, 2 ToolCall, 8 steps
