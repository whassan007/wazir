// Alloy 6 Negative-Control Mutant: Q3 Stale-Evidence False-Success Defect
// Defect modeled: ProportionalVerifier checks `some e: collectedEvidence | e.passed = True`
// without binding `e.atRevision = TurnState.currentRev`, allowing R1 test pass to greenlight R2 edit!

open util/boolean

abstract sig Revision {}
one sig R0, R1, R2 extends Revision {}

abstract sig VerdictState {}
one sig InProgress, PhysicalVerified, UnverifiedEdited extends VerdictState {}

sig Evidence {
  atRevision: one Revision,
  passed: one Bool
}

one sig TurnState {
  var currentRev: one Revision,
  var collectedEvidence: set Evidence,
  var verdict: one VerdictState
}

pred init {
  TurnState.currentRev = R0
  no TurnState.collectedEvidence
  TurnState.verdict = InProgress
}

pred editToR1 {
  TurnState.verdict = InProgress and TurnState.currentRev = R0
  TurnState.currentRev' = R1
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  TurnState.verdict' = InProgress
}

pred editToR2 {
  TurnState.verdict = InProgress and TurnState.currentRev = R1
  TurnState.currentRev' = R2
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  TurnState.verdict' = InProgress
}

pred runOracle[e: Evidence] {
  TurnState.verdict = InProgress and TurnState.currentRev != R0
  e.atRevision = TurnState.currentRev
  TurnState.currentRev' = TurnState.currentRev
  TurnState.collectedEvidence' = TurnState.collectedEvidence + e
  TurnState.verdict' = InProgress
}

// DEFECT: Checks any historical passing evidence without revision equality!
pred buggyFinalize {
  TurnState.verdict = InProgress and TurnState.currentRev != R0
  TurnState.currentRev' = TurnState.currentRev
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  (some e: TurnState.collectedEvidence | e.passed = True) implies
    TurnState.verdict' = PhysicalVerified
  else
    TurnState.verdict' = UnverifiedEdited
}

pred stutter {
  TurnState.currentRev' = TurnState.currentRev
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  TurnState.verdict' = TurnState.verdict
}

fact Trace {
  init
  always (editToR1 or editToR2 or (some e: Evidence | runOracle[e]) or buggyFinalize or stutter)
}

assert NoFalseVerifiedWithoutCurrentRevisionOracle {
  always (
    TurnState.verdict = PhysicalVerified implies
      (some e: TurnState.collectedEvidence | e.atRevision = TurnState.currentRev and e.passed = True)
  )
}

run WitnessAnyVerified {
  eventually (TurnState.verdict = PhysicalVerified)
} for 3 Evidence, 6 steps

check NoFalseVerifiedWithoutCurrentRevisionOracle for 3 Evidence, 6 steps
