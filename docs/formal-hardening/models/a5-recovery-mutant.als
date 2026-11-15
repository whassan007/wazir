// Alloy 6 Negative-Control Mutant: Unknown-Outcome Recovery Bug (A5-Mutant)
//
// In this mutant, resumeExecution omits the check for unresolved mutating calls.
// Counterexample EXPECTED for Inv_NoResumeWithUnknownOutcome.

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

// MUTANT: Does not guard resume against unresolved mutating tool calls
pred resumeExecutionMutant {
  Execution.status = ExecRecovering
  // Missing safety guard: all t: Execution.tools | t.toolType = MutatingTool implies t.callState not in CallStarted + CallOutcomeUnknown

  Execution.status' = ExecResumed
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
      recordToolCompletion[t]
    ) or
    crashWorker or
    sweepAndOrphan or
    resumeExecutionMutant or
    stutter
  )
}

assert Inv_NoResumeWithUnknownOutcome {
  always (
    (Execution.status = ExecRecovering and (some t: Execution.tools | t.toolType = MutatingTool and t.callState in CallStarted + CallOutcomeUnknown))
      implies not resumeExecutionMutant
  )
}

// Counterexample expected: worker crashes mid-mutating-call -> sweepAndOrphan -> resumeExecutionMutant fires despite unknown outcome
check Inv_NoResumeWithUnknownOutcome for 2 ToolCall, 6 steps
