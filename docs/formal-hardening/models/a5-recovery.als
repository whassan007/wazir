// Alloy 6 Temporal Specification: Unknown-Outcome Recovery & Durable Checkpoints (A5)
//
// Target System: Wazir Durable Checkpoint, RecoveryManager & Cross-Harness Resume
// Subagent: A5 (Unknown-Outcome Recovery & Durable Checkpoints)
//
// Invariants modeled:
// 1. Inv_NoResumeWithUnknownOutcome: Non-idempotent tool with unknown outcome blocks resume
// 2. Inv_NoDoubleSideEffect: Mutating side effect is never applied more than once
// 3. Inv_NoMutatingReplayWhenApplied: Guard ledger prevents replay of APPLIED mutations
// 4. Inv_TerminalExecutionMonotonicity: Completed terminal execution never reverts

abstract sig ToolType {}
one sig ReadOnlyTool, MutatingTool extends ToolType {}

abstract sig ToolCallState {}
one sig CallUnstarted, CallStarted, CallCompleted, CallFailed, CallOutcomeUnknown extends ToolCallState {}

abstract sig PhysicalSideEffect {}
one sig EffectNone, EffectApplied extends PhysicalSideEffect {}

abstract sig ExecutionStatus {}
one sig ExecRunning, ExecCrashed, ExecRecovering, ExecResumed, ExecCompleted extends ExecutionStatus {}

sig ToolCall {
  toolType: one ToolType,
  var callState: one ToolCallState,
  var physicalState: one PhysicalSideEffect
}

one sig GuardLedger {
  var recordedApplied: set ToolCall
}

one sig Execution {
  tools: some ToolCall,
  var status: one ExecutionStatus
}

pred init {
  Execution.status = ExecRunning
  Execution.tools = ToolCall
  all t: ToolCall {
    t.callState = CallUnstarted
    t.physicalState = EffectNone
  }
  no GuardLedger.recordedApplied
}

pred startTool [t: ToolCall] {
  t in Execution.tools
  Execution.status in ExecRunning + ExecResumed
  t.callState = CallUnstarted

  // Concurrency & recovery safety precondition:
  // Cannot dispatch a mutating tool if another mutating tool is already in-flight/unresolved
  t.toolType = MutatingTool implies (
    all other: Execution.tools - t |
      other.toolType = MutatingTool implies other.callState not in CallStarted + CallOutcomeUnknown
  )

  callState' = callState ++ (t -> CallStarted)
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
  Execution.status' = Execution.status
}

pred applyPhysicalEffect [t: ToolCall] {
  t in Execution.tools
  Execution.status in ExecRunning + ExecResumed
  t.callState = CallStarted
  t.toolType = MutatingTool
  t.physicalState = EffectNone

  physicalState' = physicalState ++ (t -> EffectApplied)
  callState' = callState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
  Execution.status' = Execution.status
}

pred recordToolCompletion [t: ToolCall] {
  t in Execution.tools
  Execution.status in ExecRunning + ExecResumed
  t.callState = CallStarted
  (t.toolType = ReadOnlyTool) or (t.physicalState = EffectApplied)

  callState' = callState ++ (t -> CallCompleted)
  physicalState' = physicalState
  GuardLedger.recordedApplied' = (t.toolType = MutatingTool => GuardLedger.recordedApplied + t else GuardLedger.recordedApplied)
  Execution.status' = Execution.status
}

pred recordToolFailure [t: ToolCall] {
  t in Execution.tools
  Execution.status in ExecRunning + ExecResumed
  t.callState = CallStarted
  t.physicalState = EffectNone

  callState' = callState ++ (t -> CallFailed)
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
  Execution.status' = Execution.status
}

pred crashWorker {
  Execution.status in ExecRunning + ExecResumed
  Execution.status' = ExecCrashed

  callState' = callState ++ ((callState.CallStarted) -> CallOutcomeUnknown)
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
}

pred sweepAndOrphan {
  Execution.status = ExecCrashed
  Execution.status' = ExecRecovering

  callState' = callState
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
}

pred reconcileApplied [t: ToolCall] {
  t in Execution.tools
  Execution.status = ExecRecovering
  t.callState in CallStarted + CallOutcomeUnknown
  t.physicalState = EffectApplied

  callState' = callState ++ (t -> CallCompleted)
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied + t
  physicalState' = physicalState
  Execution.status' = Execution.status
}

pred reconcileNotApplied [t: ToolCall] {
  t in Execution.tools
  Execution.status = ExecRecovering
  t.callState in CallStarted + CallOutcomeUnknown
  t.physicalState = EffectNone

  callState' = callState ++ (t -> CallFailed)
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
  Execution.status' = Execution.status
}

pred resumeExecution {
  Execution.status = ExecRecovering
  // Guard condition: No mutating tool call is in STARTED or OUTCOME_UNKNOWN
  all t: Execution.tools |
    t.toolType = MutatingTool implies t.callState not in CallStarted + CallOutcomeUnknown

  Execution.status' = ExecResumed
  callState' = callState
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
}

pred reDispatchTool [t: ToolCall] {
  t in Execution.tools
  Execution.status = ExecResumed
  t.callState in CallFailed + CallUnstarted
  t not in GuardLedger.recordedApplied
  t.physicalState = EffectNone

  callState' = callState ++ (t -> CallStarted)
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
  Execution.status' = Execution.status
}

pred completeExecution {
  Execution.status in ExecRunning + ExecResumed
  all t: Execution.tools |
    t.toolType = MutatingTool implies t.callState = CallCompleted

  Execution.status' = ExecCompleted
  callState' = callState
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
}

pred stutter {
  Execution.status' = Execution.status
  callState' = callState
  physicalState' = physicalState
  GuardLedger.recordedApplied' = GuardLedger.recordedApplied
}

fact traces {
  init
  always (
    (some t: Execution.tools |
      startTool[t] or
      applyPhysicalEffect[t] or
      recordToolCompletion[t] or
      recordToolFailure[t] or
      reconcileApplied[t] or
      reconcileNotApplied[t] or
      reDispatchTool[t]
    ) or
    crashWorker or
    sweepAndOrphan or
    resumeExecution or
    completeExecution or
    stutter
  )
}

// ----------------------------------------------------------------------------
// Safety Invariants (P0-04 Unknown Outcome Mutation & Recovery Hardening)
// ----------------------------------------------------------------------------

// Invariant 1: An execution cannot resume when any mutating tool has unknown outcome
assert Inv_NoResumeWithUnknownOutcome {
  always (
    (Execution.status = ExecRecovering and (some t: Execution.tools | t.toolType = MutatingTool and t.callState in CallStarted + CallOutcomeUnknown))
      implies not resumeExecution
  )
}

// Invariant 2: Once a physical side effect is applied, it cannot be re-applied or cleared
assert Inv_NoDoubleSideEffect {
  always (
    all t: Execution.tools |
      t.physicalState = EffectApplied implies always (t.physicalState = EffectApplied)
  )
}

// Invariant 3: A tool recorded in the GuardLedger can never be re-dispatched
assert Inv_NoMutatingReplayWhenApplied {
  always (
    all t: Execution.tools |
      t in GuardLedger.recordedApplied implies not reDispatchTool[t]
  )
}

// Invariant 4: Terminal status monotonicity: ExecCompleted never reverts
assert Inv_TerminalExecutionMonotonicity {
  always (
    Execution.status = ExecCompleted implies always (Execution.status = ExecCompleted)
  )
}

// ----------------------------------------------------------------------------
// Positive Run Witnesses (Vacuity Guards)
// ----------------------------------------------------------------------------

pred showHappyPath {
  eventually (Execution.status = ExecCompleted and (some t: Execution.tools | t.toolType = MutatingTool and t.physicalState = EffectApplied))
}
run showHappyPath for 2 ToolCall, 8 steps

pred showCrashReconcileResume {
  eventually (Execution.status = ExecCrashed and (some t: Execution.tools | t.callState = CallOutcomeUnknown))
  eventually (Execution.status = ExecCompleted and (some t: Execution.tools | t.physicalState = EffectApplied))
}
run showCrashReconcileResume for 2 ToolCall, 12 steps

// ----------------------------------------------------------------------------
// Bounded Verification Checks
// ----------------------------------------------------------------------------

check Inv_NoResumeWithUnknownOutcome for 3 ToolCall, 10 steps
check Inv_NoDoubleSideEffect for 3 ToolCall, 10 steps
check Inv_NoMutatingReplayWhenApplied for 3 ToolCall, 10 steps
check Inv_TerminalExecutionMonotonicity for 3 ToolCall, 10 steps
