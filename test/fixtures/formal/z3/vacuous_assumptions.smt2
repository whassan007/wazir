; Assumptions A alone are UNSAT -> Verdict.INCONSISTENT_ASSUMPTIONS
(set-logic QF_LIA)
(declare-const a Int)
(assert (and (> a 10) (< a 5)))
(check-sat)
