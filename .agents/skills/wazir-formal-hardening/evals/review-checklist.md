# Review checklist for each candidate finding

- [ ] Current commit SHA captured and source locations verified.
- [ ] Safety invariant is independently articulated, not assumed in a fact.
- [ ] At least one satisfiable nontrivial witness run.
- [ ] Negative-control mutant produces an expected counterexample.
- [ ] Alloy CLI version, scope, and counterexample trace saved.
- [ ] Counterexample event trace corresponds to reachable Wazir operations.
- [ ] Guard placement checked across modules, not only within the target function.
- [ ] Deterministic Vitest repro fails on unpatched HEAD.
- [ ] Severity grounded in actual impact/reachability.
- [ ] Minimal patch resolves repro without disabling policy/checks.
- [ ] Nearby tests, build, and typecheck pass.
- [ ] Result recorded as confirmed/fixed/blocked/abstract-only/false-positive.
