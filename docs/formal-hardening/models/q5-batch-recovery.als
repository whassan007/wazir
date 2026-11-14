// Alloy 6 Formal Hardening Model: Q5 Multi-Tool Batch Crash & Durable Recovery (FH-A5-01)
// Subsystem: packages/agents/src/qwenCore/coreToolScheduler.ts & packages/core/src/services/executionRecovery.ts
// Verifies:
//   1. If a worker crashes while a non-idempotent mutating tool call is in Started (OutcomeUnknown),
//      durable recovery halts for manual review and NEVER auto-replays the ambiguous side-effecting call.
//   2. If a worker crashes while ONLY pure idempotent read calls were Started, recovery can safely
//      resume and execute without duplicating side effects.

open util/boolean

abstract sig JournalState {}
one sig NotStarted, StartedAmbiguous, CommittedDone extends JournalState {}

abstract sig EngineRecoveryMode {}
one sig NormalRunning, Crashed, ResumedSafe, HaltedManualReview extends EngineRecoveryMode {}

abstract sig BatchTool {
  isIdempotentRead: one Bool
}

one sig ReadBatchItem, MutatingShellItem extends BatchTool {}

fact ToolProperties {
  ReadBatchItem.isIdempotentRead = True
  MutatingShellItem.isIdempotentRead = False
}

one sig BatchRuntime {
  var mode: one EngineRecoveryMode,
  var journal: BatchTool -> one JournalState,
  var physicalSideEffects: one Int
}

pred init {
  BatchRuntime.mode = NormalRunning
  all t: BatchTool | BatchRuntime.journal[t] = NotStarted
  BatchRuntime.physicalSideEffects = 0
}

pred startReadItem {
  BatchRuntime.mode in (NormalRunning + ResumedSafe)
  BatchRuntime.journal[ReadBatchItem] in (NotStarted + StartedAmbiguous)
  BatchRuntime.mode' = BatchRuntime.mode
  BatchRuntime.journal' = BatchRuntime.journal ++ (ReadBatchItem -> StartedAmbiguous)
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

pred finishReadItem {
  BatchRuntime.mode in (NormalRunning + ResumedSafe)
  BatchRuntime.journal[ReadBatchItem] = StartedAmbiguous
  BatchRuntime.mode' = BatchRuntime.mode
  BatchRuntime.journal' = BatchRuntime.journal ++ (ReadBatchItem -> CommittedDone)
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

// Starting non-idempotent shell item writes StartedAmbiguous BEFORE physical side effect may occur
pred startMutatingWithSideEffect {
  BatchRuntime.mode in (NormalRunning + ResumedSafe)
  BatchRuntime.journal[MutatingShellItem] = NotStarted
  BatchRuntime.physicalSideEffects < 3
  BatchRuntime.mode' = BatchRuntime.mode
  BatchRuntime.journal' = BatchRuntime.journal ++ (MutatingShellItem -> StartedAmbiguous)
  BatchRuntime.physicalSideEffects' = plus[BatchRuntime.physicalSideEffects, 1]
}

pred commitMutatingItem {
  BatchRuntime.mode in (NormalRunning + ResumedSafe)
  BatchRuntime.journal[MutatingShellItem] = StartedAmbiguous
  BatchRuntime.mode' = BatchRuntime.mode
  BatchRuntime.journal' = BatchRuntime.journal ++ (MutatingShellItem -> CommittedDone)
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

pred workerCrash {
  BatchRuntime.mode = NormalRunning
  BatchRuntime.mode' = Crashed
  BatchRuntime.journal' = BatchRuntime.journal
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

// planTaskResume: refuses automatic replay if any non-idempotent tool is StartedAmbiguous!
pred planTaskResume {
  BatchRuntime.mode = Crashed
  BatchRuntime.journal' = BatchRuntime.journal
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
  (some t: BatchTool | BatchRuntime.journal[t] = StartedAmbiguous and t.isIdempotentRead = False) implies
    BatchRuntime.mode' = HaltedManualReview
  else
    BatchRuntime.mode' = ResumedSafe
}

pred stutter {
  BatchRuntime.mode' = BatchRuntime.mode
  BatchRuntime.journal' = BatchRuntime.journal
  BatchRuntime.physicalSideEffects' = BatchRuntime.physicalSideEffects
}

fact Trace {
  init
  always (
    startReadItem or
    finishReadItem or
    startMutatingWithSideEffect or
    commitMutatingItem or
    workerCrash or
    planTaskResume or
    stutter
  )
}

assert NeverDuplicateNonIdempotentSideEffect {
  always (BatchRuntime.physicalSideEffects <= 1)
}

assert AmbiguousMutatingCrashForcesManualReview {
  always (
    (BatchRuntime.mode = Crashed and BatchRuntime.journal[MutatingShellItem] = StartedAmbiguous) implies
      after (BatchRuntime.mode != ResumedSafe)
  )
}

run WitnessSafeResumeAfterReadCrash {
  eventually (
    BatchRuntime.mode = ResumedSafe and
    BatchRuntime.journal[ReadBatchItem] = CommittedDone and
    BatchRuntime.journal[MutatingShellItem] = CommittedDone
  )
} for 4 Int, 7 steps

run WitnessAmbiguousMutatingHaltsSafely {
  eventually (
    BatchRuntime.mode = HaltedManualReview and
    BatchRuntime.physicalSideEffects = 1
  )
} for 4 Int, 5 steps

check NeverDuplicateNonIdempotentSideEffect for 4 Int, 7 steps
check AmbiguousMutatingCrashForcesManualReview for 4 Int, 7 steps
