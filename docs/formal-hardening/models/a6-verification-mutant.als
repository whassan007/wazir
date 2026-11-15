// Alloy 6 Negative Control Mutant: Buggy Raced Revision Stamping (Agent A6 Mutant)
// Domain: packages/core/src/services/verificationEngine.ts, evidencePolicy.ts
//
// In this mutant, when an oracle completes, instead of binding strictly to the dispatch
// revision (inFlightRev), it stamps evidence with the current workspace revision (currentRev),
// simulating a race where a test dispatched before a mutation completes after the mutation
// and erroneously validates the post-mutation revision.
//
// Expected: Check NoRaceEvidencePollution FAILS with counterexample.

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

// BUGGY IMPLEMENTATION: stamps evidence with currentRev instead of inFlightRev!
pred completeOracleBuggy [res: Outcome] {
  some Controller.inFlightOracle
  let o = Controller.inFlightOracle, r = Controller.currentRev |
    Controller.evidence' = Controller.evidence + (r -> o -> res)
  no Controller.inFlightOracle'
  no Controller.inFlightRev'
  Controller.currentRev' = Controller.currentRev
  Controller.isCompleted' = Controller.isCompleted
}

pred completeTask {
  no Controller.isCompleted
  no Controller.inFlightOracle
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
    (some res: Outcome | completeOracleBuggy[res]) or
    completeTask or
    stutter
  )
}

// Invariant 3: Raced oracle does not pollute next revision with PASS
assert NoRaceEvidencePollution {
  always (
    (some Controller.inFlightOracle and Controller.inFlightRev != Controller.currentRev)
      implies (not ((Controller.currentRev -> Controller.inFlightOracle -> Pass) in Controller.evidence'))
  )
}

// Witness: demonstrate race scenario where test starts at R0, workspace mutates to R1, test completes and binds to R1
run WitnessRacedPollution {
  eventually (
    some Controller.inFlightOracle and
    Controller.inFlightRev = R0 and
    Controller.currentRev = R1 and
    after ((R1 -> Controller.inFlightOracle -> Pass) in Controller.evidence)
  )
} for 10 steps

check NoRaceEvidencePollution for 10 steps
