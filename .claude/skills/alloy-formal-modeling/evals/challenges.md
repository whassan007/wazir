# Alloy skill evaluation tasks for a receiving LLM

Ask the learner to respond to these before consulting the answer key. Scoring: 1 point per correct answer (10 points total). Require concrete Alloy syntax where requested, and distinguish `EXPECTED` versus **EXECUTED** claims.

## Questions

1. What is the difference between `sig Student in Person {}` and `sig Student extends Person {}`? When are sibling classes guaranteed disjoint?
2. For `sig User { manager: lone User }`, does Alloy guarantee at most one manager total, or at most one per user?
3. What is the difference between `u.manager` and `User.manager`?
4. Explain what `^edge`, `*edge`, and `~edge` mean for a binary relation `edge`.
5. Given `sig Account {}` and `assert Exists { some Account }`, can `check Exists for 3` yield a counterexample? Why?
6. Is `check NoSelfApproval {}` necessarily checking a declared `assert NoSelfApproval`? Explain.
7. In Alloy 6, does `fact { no Online }` require `Online` to be empty for all future states if `Online` is mutable?
8. Write a transition for a mutable `var flag: set Thing` that adds one `Thing` while preserving a second mutable relation `other` unchanged; assume both fields are declared on singleton `State`.
9. A model allows `stutter` on every step. Does a successful mutual-exclusion `check` entail eventual acquisition? Explain.
10. Alloy says `check P for 5 but 8 steps` found no counterexample. What exactly may the LLM claim? List two necessary reporting limitations.

## Answer key (for evaluator)

1. `in` is arbitrary subset and sibling subsets can overlap; `extends` creates disjoint extension signatures. `abstract` parent only inhabited by extensions.
2. Zero or one manager **for each** user; many users may each have one.
3. `u.manager` is the image of user `u`; `User.manager` is the entire `User -> User` manager relation.
4. `^` is transitive closure (one or more edges), `*` is reflexive-transitive closure (zero or more), `~` transposes the relation.
5. Yes. Empty `Account` is allowed unless something forces population. `check` searches for an instance where `some Account` is false.
6. No. `check Label {}` is a new labeled inline assertion with empty (true) constraint; `check NoSelfApproval` invokes the named assertion.
7. No, only the initial state unless enclosed under `always` or an equivalent temporal constraint.
8. For example `pred add[t: Thing] { t not in State.flag; State.flag' = State.flag + t; State.other' = State.other }` (requires valid field declarations and syntax).
9. No. Safety (never two holders) and liveness (eventual progress) differ; infinite stuttering can prevent eventual acquisition.
10. No counterexample was found **within the given atom scope and bounded lasso time horizon**, with specific solver/bitwidth/settings. It is not an unbounded proof and might be vacuous/overconstrained. Report assumptions and witness sanity checks.

## Practical rubric

A skilled LLM should also be able to:

- Write a valid `sig`, `fact`, `pred`, `assert`, `run`, `check` model.
- Explain the source of a counterexample in `examples/self-approval-counterexample.als`.
- Predict that adding only a policy fact can make a check pass without establishing implementation enforcement.
- Produce a transition model with frame conditions and deliberate stuttering.
- State `NOT RUN` when no Analyzer execution occurred, rather than inventing proof results.
