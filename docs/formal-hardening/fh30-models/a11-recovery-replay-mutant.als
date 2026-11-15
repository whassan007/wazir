// ==============================================================================
// Wazir Formal Hardening — A11: Negative-Control Mutant
// Model: a11-recovery-replay-mutant.als
//
// Target: Wazir executionRecovery.ts & executionEngine.ts
// Negative Control: Deliberately broken worker recovery that replays tool calls
//                   with unknown outcome without prior physical reconciliation.
//
// Expected Result: Alloy Analyzer produces concrete counterexample traces
//                  violating NoUnreconciledSideEffectReplay and
//                  NoDuplicateSideEffectExecution.
// ==============================================================================

module a11_recovery_replay_mutant

abstract sig ToolKind {}
one sig ReadOnly, SideEffecting extends ToolKind {}

abstract sig CheckpointState {}
one sig Unstarted, Dispatched, OutcomeUnknown, ReconciledApplied, ReconciledNotApplied, Completed extends CheckpointState {}

sig ToolCall {
  kind: one ToolKind,
  var status: one CheckpointState
}

var sig PendingSideEffect in ToolCall {}
var sig PhysicallyExecuted in ToolCall {}
var sig DuplicateExecutionObserved in ToolCall {}
var sig Replayed in ToolCall {}

pred init {
  all t: ToolCall | t.status = Unstarted
  no PendingSideEffect
  no PhysicallyExecuted
  no DuplicateExecutionObserved
  no Replayed
}

pred dispatch[t: ToolCall] {
  t.status = Unstarted
  all tc: ToolCall | tc = t implies tc.status' = Dispatched else tc.status' = tc.status
  t.kind = SideEffecting implies (PendingSideEffect' = PendingSideEffect + t) else (PendingSideEffect' = PendingSideEffect)
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

pred executeSideEffect[t: ToolCall] {
  t.status = Dispatched
  t.kind = SideEffecting
  t in PendingSideEffect

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

pred checkpointCompleted[t: ToolCall] {
  t.status = Dispatched
  t.kind = SideEffecting implies t not in PendingSideEffect
  all tc: ToolCall | tc = t implies tc.status' = Completed else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

pred crash {
  some t: ToolCall | t.status = Dispatched
  all tc: ToolCall | tc.status = Dispatched implies tc.status' = OutcomeUnknown else tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect - { t: ToolCall | t.status = Dispatched }
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

// ------------------------------------------------------------------------------
// MUTANT FLAW: Blind Replay Without Physical Reconciliation
// ------------------------------------------------------------------------------
// In this mutant, when a worker recovers, it blindly re-dispatches calls left in
// OutcomeUnknown assuming they didn't happen, bypassing physical reconciliation!
pred replayBlindlyWithoutReconciliation[t: ToolCall] {
  t.status = OutcomeUnknown
  all tc: ToolCall | tc = t implies tc.status' = Dispatched else tc.status' = tc.status
  t.kind = SideEffecting implies (PendingSideEffect' = PendingSideEffect + t) else (PendingSideEffect' = PendingSideEffect)
  Replayed' = Replayed + t
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
}

pred stutter {
  all tc: ToolCall | tc.status' = tc.status
  PendingSideEffect' = PendingSideEffect
  PhysicallyExecuted' = PhysicallyExecuted
  DuplicateExecutionObserved' = DuplicateExecutionObserved
  Replayed' = Replayed
}

fact traces {
  init
  always (
    (some t: ToolCall | dispatch[t]) or
    (some t: ToolCall | executeSideEffect[t]) or
    (some t: ToolCall | checkpointCompleted[t]) or
    crash or
    (some t: ToolCall | replayBlindlyWithoutReconciliation[t]) or
    stutter
  )
}

assert NoUnreconciledSideEffectReplay {
  always (all t: ToolCall |
    (t.kind = SideEffecting and t.status = OutcomeUnknown) implies after (t.status != Dispatched)
  )
}

assert NoDuplicateSideEffectExecution {
  always no DuplicateExecutionObserved
}

// Concrete counterexample witness showing duplicate side effect under mutant
run WitnessDuplicateSideEffectInMutant {
  eventually some DuplicateExecutionObserved
} for 2 ToolCall, 8 steps

check NoUnreconciledSideEffectReplay for 2 ToolCall, 8 steps
check NoDuplicateSideEffectExecution for 2 ToolCall, 8 steps
