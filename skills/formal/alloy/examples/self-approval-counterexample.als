// Alloy 6 — Intentionally flawed authorization system.
// NO fact prevents self-approval. A check SHOULD find a counterexample.
// This is an example of verification detecting a missing policy control.

sig User {}
sig Request {
  submittedBy: one User,
  approvedBy: lone User
}

assert NoSelfApproval {
  all r: Request |
    some r.approvedBy implies r.submittedBy != r.approvedBy
}

run { some Request.approvedBy } for 3
check NoSelfApproval for 3
