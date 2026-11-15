// ==============================================================================
// Wazir Formal Hardening — A11: Replay Safety & Recovery Idempotency
// Model: a11-recovery-replay.als
//
// Target: Wazir executionRecovery.ts & executionEngine.ts
// Invariant P0-04: "An operation with an unknown side-effect outcome must not
//                  be replayed until it is safely reconciled."
//
// Description:
// Behavioral (var) Alloy 6 temporal model of tool dispatch, physical execution,
// process crash before completion checkpoint (undetermined outcome), reconciliation
// from physical evidence (APPLIED vs NOT_APPLIED), and safe resumption/replay.
// ==============================================================================

module a11_recovery_replay

// Tool classification: Read-only queries vs mutating side effects
abstract sig ToolKind {}
one sig ReadOnly, SideEffecting extends ToolKind {}

// Durable checkpoint states for tool calls in Wazir
// Corresponds to ToolCallCheckpoint.state and ClassifiedToolOutcome in executionRecovery.ts
abstract sig CheckpointState {}
one sig Unstarted, Dispatched, OutcomeUnknown, ReconciledApplied, ReconciledNotApplied, Completed extends CheckpointState {}

// Tool call entity
sig ToolCall {
  kind: one ToolKind,
  var status: one CheckpointState
}

// In-memory dispatch obligation: pending execution of side effect
var sig PendingSideEffect in ToolCall {}

// Physical reality: whether the side effect landed in external system/disk/git
var sig PhysicallyExecuted in ToolCall {}

// Safety violation oracle: duplicate physical side-effect executions
var sig DuplicateExecutionObserved in ToolCall {}

// Resumption tracking: tool calls replayed/resumed after recovery
var sig Replayed in ToolCall {}

// ------------------------------------------------------------------------------
// Initial State
// ------------------------------------------------------------------------------
pred init {
  all t: ToolCall | t.status = Unstarted
  no PendingSideEffect
  no PhysicallyExecuted
  no DuplicateExecutionObserved
  no Replayed
}

// ------------------------------------------------------------------------------
// Actions & State Transitions
// ------------------------------------------------------------------------------

// Dispatch an unstarted tool call
pred dispatch[t: ToolCall] {
  t.status = Unstarted

  // Fail-closed gate: if any side-effecting call currently has an unknown outcome,
  // recovery must reconcile it before dispatching new work (Wazir planRecovery)
  no unrec: ToolCall | unrec.kind = SideEffecting and unrec.status = OutcomeUnknown

  all tc: ToolCall | tc = t implies tc.status' = Dispatched else tc.status' = tc.status
  t.kind = SideEffecting implies (PendingSideEffect' = PendingSideEffect + t) else (PendingSideEffect' = PendingSideEffect)
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

// Physical execution of the tool side effect in workspace / external API
pred executeSideEffect[t: ToolCall] {
  t.status = Dispatched
  t.kind = SideEffecting
  t in PendingSideEffect

  // If already physically executed, flag duplicate side effect!
  t in PhysicallyExecuted implies {
    DuplicateExecutionObserved' = DuplicateExecutionObserved + t
    PhysicallyExecuted' = PhysicallyExecuted
  } else {
    PhysicallyExecuted' = PhysicallyExecuted + t
    DuplicateExecutionObserved' = DuplicateExecutionObserved
  }

  PendingSideEffect' = PendingSideEffect - t
  all tc: ToolCall | tc.status' = tc.status
  Replayed' = Replayed
}

// Checkpoint tool completion to durable store
pred checkpointCompleted[t: ToolCall] {
  t.status = Dispatched
  // Mutating tool cannot checkpoint completion while physical execution is still pending
  t.kind = SideEffecting implies t not in PendingSideEffect

  all tc: ToolCall | tc = t implies tc.status' = Completed else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

// Process or worker failure before completion checkpoint is written
pred crash {
  // Crash occurs while at least one tool call is in-flight (Dispatched)
  some t: ToolCall | t.status = Dispatched

  // In-flight calls transition to OutcomeUnknown; completed or unstarted retain state
  all tc: ToolCall | tc.status = Dispatched implies tc.status' = OutcomeUnknown else tc.status' = tc.status

  // Transient in-memory state is lost on crash
  PendingSideEffect' = PendingSideEffect - { t: ToolCall | t.status = Dispatched }
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

// Physical inspection confirms the side effect WAS applied in the workspace
// Corresponds to inspectToolOutcome returning APPLIED in reconcileBeforeCrossHarnessResume
pred reconcileApplied[t: ToolCall] {
  t.kind = SideEffecting
  t.status = OutcomeUnknown
  // Authoritative physical evidence check
  t in PhysicallyExecuted

  all tc: ToolCall | tc = t implies tc.status' = ReconciledApplied else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

// Physical inspection confirms the side effect was NOT applied
// Corresponds to inspectToolOutcome returning NOT_APPLIED
pred reconcileNotApplied[t: ToolCall] {
  t.kind = SideEffecting
  t.status = OutcomeUnknown
  // Authoritative physical evidence check
  t not in PhysicallyExecuted

  all tc: ToolCall | tc = t implies tc.status' = ReconciledNotApplied else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

// Read-only tool calls have no external side effects and may be replayed directly
pred replayReadOnly[t: ToolCall] {
  t.kind = ReadOnly
  t.status in OutcomeUnknown + ReconciledNotApplied

  all tc: ToolCall | tc = t implies tc.status' = Dispatched else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  Replayed' = Replayed + t
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
}

// Side-effecting tool proven NOT_APPLIED can be safely re-dispatched for execution
pred replayReconciledNotApplied[t: ToolCall] {
  t.kind = SideEffecting
  t.status = ReconciledNotApplied

  all tc: ToolCall | tc = t implies tc.status' = Dispatched else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect + t
  Replayed' = Replayed + t
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
}

// Side-effecting tool proven APPLIED: OperationReconciliationGuard serves cached
// receipt, advancing to Completed WITHOUT re-executing the physical action
pred resumeReconciledApplied[t: ToolCall] {
  t.kind = SideEffecting
  t.status = ReconciledApplied

  all tc: ToolCall | tc = t implies tc.status' = Completed else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  Replayed' = Replayed + t
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
}

// Stutter step for infinite lasso traces
pred stutter {
  all tc: ToolCall | tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

// ------------------------------------------------------------------------------
// Trace Specification
// ------------------------------------------------------------------------------
fact traces {
  init
  always (
    (some t: ToolCall | dispatch[t]) or
    (some t: ToolCall | executeSideEffect[t]) or
    (some t: ToolCall | checkpointCompleted[t]) or
    crash or
    (some t: ToolCall | reconcileApplied[t]) or
    (some t: ToolCall | reconcileNotApplied[t]) or
    (some t: ToolCall | replayReadOnly[t]) or
    (some t: ToolCall | replayReconciledNotApplied[t]) or
    (some t: ToolCall | resumeReconciledApplied[t]) or
    stutter
  )
}

// ------------------------------------------------------------------------------
// Invariants & Safety Assertions
// ------------------------------------------------------------------------------

// Core Invariant 1: An unresolved side-effecting operation must NEVER be replayed/redispatched
assert NoUnreconciledSideEffectReplay {
  always (all t: ToolCall |
    (t.kind = SideEffecting and t.status = OutcomeUnknown) implies after (t.status != Dispatched)
  )
}

// Core Invariant 2: Any replay of a side-effecting call requires prior reconciliation
assert ReplayRequiresReconciliationForSideEffects {
  always (all t: ToolCall |
    (t in Replayed' - Replayed and t.kind = SideEffecting) implies (
      t.status in ReconciledApplied + ReconciledNotApplied
    )
  )
}

// Core Invariant 3: No duplicate execution of physical side effects under any failure/recovery interleaving
assert NoDuplicateSideEffectExecution {
  always no DuplicateExecutionObserved
}

// ------------------------------------------------------------------------------
// Witness Runs (Non-Vacuity Assurance)
// ------------------------------------------------------------------------------

run WitnessNormalExecution {
  eventually (some t: ToolCall | t.kind = SideEffecting and t.status = Completed and no Replayed)
} for 2 ToolCall, 6 steps

run WitnessCrashAndReconcileApplied {
  eventually (some t: ToolCall | t.kind = SideEffecting and t.status = Completed and t in Replayed and t in PhysicallyExecuted)
} for 2 ToolCall, 8 steps

run WitnessCrashAndReconcileNotAppliedAndReplay {
  eventually (some t: ToolCall | t.kind = SideEffecting and once (t.status = ReconciledNotApplied) and t.status = Completed)
} for 2 ToolCall, 8 steps

run WitnessReadOnlyReplayWithoutReconciliation {
  eventually (some t: ToolCall | t.kind = ReadOnly and once (t.status = OutcomeUnknown) and t.status = Completed)
} for 2 ToolCall, 8 steps

// ------------------------------------------------------------------------------
// Verification Checks
// ------------------------------------------------------------------------------

check NoUnreconciledSideEffectReplay for 3 ToolCall, 10 steps
check ReplayRequiresReconciliationForSideEffects for 3 ToolCall, 10 steps
check NoDuplicateSideEffectExecution for 3 ToolCall, 10 steps
