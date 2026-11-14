// Alloy 6 — A business assumption forbidding self-approval.
// Here the rule is intentionally a global fact: this is a POLICY MODEL,
// not a proof that an implemented approval workflow enforces it.

sig User {}
sig Request {
  submittedBy: one User,
  approvedBy: lone User
}

fact SeparationOfDuties {
  all r: Request |
    r.approvedBy != r.submittedBy
}

assert NoSelfApproval {
  all r: Request |
    some r.approvedBy implies r.submittedBy != r.approvedBy
}

run { some Request.approvedBy } for 3 but exactly 2 User
check NoSelfApproval for 3
