; Negated property A ^ impl ^ ~P is SAT -> Verdict.COUNTEREXAMPLE
(set-logic QF_LIA)
(declare-const v Int)
(declare-const dist Int)
(assert (> v 10))
(assert (< dist 5))
(check-sat)
(get-model)
