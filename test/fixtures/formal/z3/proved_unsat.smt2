; Negated property A ^ impl ^ ~P is UNSAT (and A is SAT) -> Verdict.PROVED
(set-logic QF_LIA)
(declare-const x Int)
(assert (> x 0))
(assert (<= x 0))
(check-sat)
