// Alloy 6 Negative-Control Mutant: Q5 Blind Batch Replay After Crash
// Defect modeled: On crash recovery, unfinished StartedAmbiguous calls are reset to NotStarted
// and auto-replayed even when non-idempotent, causing duplicate side effects (physicalSideEffects = 2).

open util/boolean

abstract sig JournalState {}
one sig NotStarted, StartedAmbiguous, CommittedDone extends JournalState {}

abstract sig EngineRecoveryMode {}
one sig NormalRunning, Crashed, ResumedSafe extends EngineRecoveryMode {}

one sig MutatingShellItem {}

one sig BatchRuntime {
  var mode: one EngineRecoveryMode,
  var journal: MutatingShellItem -> one JournalState,
  var physicalSideEffects: one Int
}

pred init {
  BatchRuntime.mode = NormalRunning
  BatchRuntime.journal[MutatingShellItem] = NotStarted
  BatchRuntime.physicalSideEffects = 0
}

pred startMutatingWithSideEffect {
  BatchRuntime.mode in (NormalRunning + ResumedSafe)
  BatchRuntime.journal[MutatingShellItem] = NotStarted
  BatchRuntime.physicalSideEffects < 3
  BatchRuntime.mode' = BatchRuntime.mode
  BatchRuntime.journal' = BatchRuntime.journal ++ (MutatingShellItem -> StartedAmbiguous)
  BatchRuntime.physicalSideEffects' = plus[BatchRuntime.physicalSideEffects, 1]
}

pred workerCrash {
  BatchRuntime.mode = NormalRunning
  BatchRuntime.mode' = Crashed
  BatchRuntime.journal' = BatchRuntime.journal
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

// DEFECT: Resets StartedAmbiguous to NotStarted and resumes automatically!
pred buggyPlanTaskResume {
  BatchRuntime.mode = Crashed
  BatchRuntime.mode' = ResumedSafe
  BatchRuntime.journal' = BatchRuntime.journal ++ (MutatingShellItem -> NotStarted)
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

pred stutter {
  BatchRuntime.mode' = BatchRuntime.mode
  BatchRuntime.journal' = BatchRuntime.journal
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

fact Trace {
  init
  always (startMutatingWithSideEffect or workerCrash or buggyPlanTaskResume or stutter)
}

assert NeverDuplicateNonIdempotentSideEffect {
  always (BatchRuntime.physicalSideEffects <= 1)
}

run WitnessCrashAndResume {
  eventually (BatchRuntime.mode = ResumedSafe)
} for 4 Int, 4 steps

check NeverDuplicateNonIdempotentSideEffect for 4 Int, 5 steps
