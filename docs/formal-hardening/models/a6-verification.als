// Alloy 6 Temporal Model: Verification Evidence & Revision Truthfulness (Agent A6)
// Domain: packages/core/src/services/verificationEngine.ts, verificationEvidenceInspector.ts, evidencePolicy.ts
//
// Invariants modeled:
// 1. NoStaleCompletion: completion at revision R strictly requires passing evidence bound to R.
// 2. NoPostMutationFalseSuccess: mutation R -> R' invalidates completion until R' is independently re-verified.
// 3. NoRaceEvidencePollution: an oracle dispatched at R that resolves after mutation to R' cannot bind to R'.
// 4. NoUnrepairedFailureCompletion: a failed check at current revision blocks completion.

abstract sig Revision {
  nextRev: lone Revision
}
one sig R0, R1, R2 extends Revision {}

fact LinearRevisionOrder {
  R0.nextRev = R1
  R1.nextRev = R2
  no R2.nextRev
}

abstract sig Oracle {}
one sig BuildOracle, TestOracle extends Oracle {}

abstract sig Outcome {}
one sig Pass, Fail extends Outcome {}

one sig Controller {
  var currentRev: one Revision,
  var inFlightOracle: lone Oracle,
  var inFlightRev: lone Revision,
  var evidence: Revision -> Oracle -> Outcome,
  var isCompleted: lone Revision
}

pred init {
  Controller.currentRev = R0
  no Controller.inFlightOracle
  no Controller.inFlightRev
  no Controller.evidence
  no Controller.isCompleted
}

pred mutateWorkspace {
  some Controller.currentRev.nextRev
  Controller.currentRev' = Controller.currentRev.nextRev
  Controller.inFlightOracle' = Controller.inFlightOracle
  Controller.inFlightRev' = Controller.inFlightRev
  Controller.evidence' = Controller.evidence
  no Controller.isCompleted'
}

pred startOracle [o: Oracle] {
  no Controller.inFlightOracle
  no Controller.isCompleted
  Controller.inFlightOracle' = o
  Controller.inFlightRev' = Controller.currentRev
  Controller.currentRev' = Controller.currentRev
  Controller.evidence' = Controller.evidence
  Controller.isCompleted' = Controller.isCompleted
}

pred completeOracle [res: Outcome] {
  some Controller.inFlightOracle
  // Sound specification: evidence must be stamped with inFlightRev (dispatch revision),
  // NEVER with currentRev if a race/mutation occurred in between.
  let o = Controller.inFlightOracle, r = Controller.inFlightRev |
    Controller.evidence' = Controller.evidence + (r -> o -> res)
  no Controller.inFlightOracle'
  no Controller.inFlightRev'
  Controller.currentRev' = Controller.currentRev
  Controller.isCompleted' = Controller.isCompleted
}

pred completeTask {
  no Controller.isCompleted
  no Controller.inFlightOracle
  // Authoritative completion requires ALL required oracles (Build + Test) to pass on current revision,
  // and no un-repaired failure on the current revision.
  all o: BuildOracle + TestOracle | (Controller.currentRev -> o -> Pass) in Controller.evidence
  no o: BuildOracle + TestOracle | (Controller.currentRev -> o -> Fail) in Controller.evidence
  Controller.isCompleted' = Controller.currentRev
  Controller.currentRev' = Controller.currentRev
  Controller.inFlightOracle' = Controller.inFlightOracle
  Controller.inFlightRev' = Controller.inFlightRev
  Controller.evidence' = Controller.evidence
}

pred stutter {
  Controller.currentRev' = Controller.currentRev
  Controller.inFlightOracle' = Controller.inFlightOracle
  Controller.inFlightRev' = Controller.inFlightRev
  Controller.evidence' = Controller.evidence
  Controller.isCompleted' = Controller.isCompleted
}

fact traces {
  init
  always (
    mutateWorkspace or
    (some o: Oracle | startOracle[o]) or
    (some res: Outcome | completeOracle[res]) or
    completeTask or
    stutter
  )
}

// Invariant 1: Completion requires all required oracles passing at the completed revision
assert NoStaleCompletion {
  always (
    some Controller.isCompleted implies (
      all o: BuildOracle + TestOracle | (Controller.isCompleted -> o -> Pass) in Controller.evidence
    )
  )
}

// Invariant 2: Mutation after completion invalidates completed status
assert NoPostMutationFalseSuccess {
  always (
    (some Controller.isCompleted and Controller.currentRev' != Controller.currentRev)
      implies no Controller.isCompleted'
  )
}

// Invariant 3: Raced oracle does not pollute next revision with PASS
assert NoRaceEvidencePollution {
  always (
    (some Controller.inFlightOracle and Controller.inFlightRev != Controller.currentRev)
      implies (not ((Controller.currentRev -> Controller.inFlightOracle -> Pass) in Controller.evidence'))
  )
}

// Invariant 4: No completion with un-repaired failure at completed revision
assert NoUnrepairedFailureCompletion {
  always (
    some Controller.isCompleted implies
      no o: BuildOracle + TestOracle | (Controller.isCompleted -> o -> Fail) in Controller.evidence
  )
}

// Non-vacuity witness 1: Reach completed task at R0
run ReachCompletedR0 {
  eventually (Controller.isCompleted = R0)
} for 10 steps

// Non-vacuity witness 2: Reach mutation and completed task at R1
run ReachCompletedR1 {
  eventually (Controller.currentRev = R1 and Controller.isCompleted = R1)
} for 10 steps

// Verification checks
check NoStaleCompletion for 10 steps
check NoPostMutationFalseSuccess for 10 steps
check NoRaceEvidencePollution for 10 steps
check NoUnrepairedFailureCompletion for 10 steps
