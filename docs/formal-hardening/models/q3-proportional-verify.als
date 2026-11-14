// Alloy 6 Formal Hardening Model: Q3 Proportional Verification & Anti-Stale-Evidence Gate
// Subsystem: packages/agents/src/qwenCore/proportionalVerifier.ts & evaluationService.ts
// Verifies:
//   1. Read-only Q&A turns (revision = R0) finish as ReadOnlyAnswered with 0 verification runs,
//      and NEVER claim PhysicalVerified.
//   2. Mutated workspaces (revision = R1 or R2) NEVER reach PhysicalVerified unless passing oracle
//      evidence exists at the EXACT current revision (stale R1 evidence invalidated on R2 edit!).

open util/boolean

abstract sig Revision {}
one sig R0, R1, R2 extends Revision {}

abstract sig VerdictState {}
one sig InProgress, ReadOnlyAnswered, PhysicalVerified, UnverifiedEdited extends VerdictState {}

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

pred editWorkspaceToR1 {
  TurnState.verdict = InProgress
  TurnState.currentRev = R0
  TurnState.currentRev' = R1
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  TurnState.verdict' = InProgress
}

pred editWorkspaceToR2 {
  TurnState.verdict = InProgress
  TurnState.currentRev = R1
  TurnState.currentRev' = R2
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  TurnState.verdict' = InProgress
}

pred runVerificationOracle[e: Evidence] {
  TurnState.verdict = InProgress
  TurnState.currentRev != R0
  e.atRevision = TurnState.currentRev
  TurnState.currentRev' = TurnState.currentRev
  TurnState.collectedEvidence' = TurnState.collectedEvidence + e
  TurnState.verdict' = InProgress
}

// ProportionalVerifier Tier 0: zero mutations -> clean ReadOnlyAnswered, never PhysicalVerified
pred finalizeReadOnlyTurn {
  TurnState.verdict = InProgress
  TurnState.currentRev = R0
  no TurnState.collectedEvidence
  TurnState.currentRev' = TurnState.currentRev
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  TurnState.verdict' = ReadOnlyAnswered
}

// ProportionalVerifier Tier 1/2: mutated workspace -> PhysicalVerified IFF passing evidence at currentRev
pred finalizeMutatedTurn {
  TurnState.verdict = InProgress
  TurnState.currentRev != R0
  TurnState.currentRev' = TurnState.currentRev
  TurnState.collectedEvidence' = TurnState.collectedEvidence
  (some e: TurnState.collectedEvidence | e.atRevision = TurnState.currentRev and e.passed = True) implies
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
  always (
    editWorkspaceToR1 or
    editWorkspaceToR2 or
    (some e: Evidence | runVerificationOracle[e]) or
    finalizeReadOnlyTurn or
    finalizeMutatedTurn or
    stutter
  )
}

assert NoFalseVerifiedWithoutCurrentRevisionOracle {
  always (
    TurnState.verdict = PhysicalVerified implies (
      TurnState.currentRev != R0 and
      (some e: TurnState.collectedEvidence | e.atRevision = TurnState.currentRev and e.passed = True)
    )
  )
}

assert ReadOnlyZeroVerificationTax {
  always (
    TurnState.verdict = ReadOnlyAnswered implies (
      TurnState.currentRev = R0 and no TurnState.collectedEvidence
    )
  )
}

run WitnessZeroTaxReadOnlyAnswer {
  eventually (TurnState.verdict = ReadOnlyAnswered)
} for 4 Evidence, 5 steps

run WitnessEditVerifyReEditInvalidatesStale {
  eventually (
    TurnState.currentRev = R2 and
    (some e: TurnState.collectedEvidence | e.atRevision = R1 and e.passed = True) and
    TurnState.verdict = UnverifiedEdited
  )
} for 4 Evidence, 6 steps

run WitnessMutatedVerifiedAtLatestRev {
  eventually (TurnState.currentRev = R2 and TurnState.verdict = PhysicalVerified)
} for 4 Evidence, 6 steps

check NoFalseVerifiedWithoutCurrentRevisionOracle for 4 Evidence, 6 steps
check ReadOnlyZeroVerificationTax for 4 Evidence, 6 steps
