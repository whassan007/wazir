---
name: wazir-z3-constraint-verification
description: Use Z3 to encode, solve, and falsify arithmetic, Boolean, and finite-state constraints for generated systems. Invoke for braking envelopes, right-of-way decision logic, resource bounds, and SMT-backed verification obligations when independently reviewed specifications are available.
version: 1.0.0
priority: P0
---

# Z3 Constraint Verification

## Purpose and activation

Use this skill when Wazir must determine whether a concrete **counterexample exists** to a specified safety or correctness property. Prefer Z3 for Boolean combinations with integer/real arithmetic, timing constraints, and bounded program decisions. Do not use an LLM's assertion or an ordinary test result as a solver verdict.

**Typical request:** "Check that no feasible red-signal approach causes the decision function to command proceed, under the given assumptions."

Do not invoke this skill as a substitute for interpreting statutes, validating physical dynamics, or proving generated source code implements the SMT model. Those require separate specification review, refinement evidence, and runtime/simulation validation.

## Inputs required

- `requirement_id`, normative source, jurisdiction/version when rules of the road are involved, and human-reviewed interpretation.
- Precise property `P`, controlled-system contract, units, environmental assumptions `A`, variable domains and quantification.
- Target implementation revision and the specific abstraction or code-to-model mapping being checked.
- Solver timeout, random seed if used, and resource limits approved for the workspace.

If any legally material exception or unit is ambiguous, mark `SPECIFICATION_REVIEW_REQUIRED`; do not silently invent a rule.

## Autonomous workflow

1. **Investigate.** Locate the independently reviewed requirement and existing implementation. Identify decision boundaries, legal exceptions, physical feasibility assumptions, and relevant input ranges.
2. **Formalize.** Write variables with explicit sorts (`Bool`, `Int`, `Real`, or bounded bit vectors). Model `A` separately from desired property `P`. Document any abstraction from physical dynamics, floating-point behavior, sensor uncertainty, or continuous control.
3. **Check consistency.** Solve `A` alone. If it is unsatisfiable, report `INCONSISTENT_ASSUMPTIONS`, not success. Probe for vacuity, e.g., `A ∧ property_precondition` must be satisfiable when applicable.
4. **Find a violation.** Ask Z3 for a model of `A ∧ implementation_model ∧ ¬P`. If SAT, extract an assignment to the physical/decision variables and produce a reproducible counterexample. If UNSAT, report only that no violation exists in the **encoded** model under its assumptions. `unknown` is neither proof nor counterexample.
5. **Repair.** Hand counterexamples back to the implementation agent, never rewrite the approved property merely to pass. Re-run from a clean snapshot after each change.
6. **Verify.** Independently rerun solver commands and validate the correspondence to the **current** workspace revision. Store solver version, SMT-LIB or Z3Py input, output, assumption list, model scope, and hashes.

Execute within Wazir's existing workspace, tool, policy, and verification controls. No routine approval is required for permitted non-destructive work; request authorization for prohibited or destructive operations.

## Example: red-signal stopping envelope

See [examples/check_stopping_rule.py](examples/check_stopping_rule.py). The example uses a toy candidate policy to illustrate counterexample search. The stopping-distance model is `v × reaction_time + v²/(2 × deceleration)` with positive deceleration and a margin. It is **not** a certified braking or traffic-law model.

```bash
# Run from this skill's directory (e.g. skills/formal/z3/ or .Codex/skills/wazir-z3/).
python -m pip install z3-solver
python examples/check_stopping_rule.py --candidate buggy
# Expected: COUNTEREXAMPLE, nonzero exit (if Z3 is installed)
python examples/check_stopping_rule.py --candidate guarded
# Expected: BOUNDED_PASS, exit 0 (if Z3 is installed)
```

Always differentiate:

- `sat` on the **negated property**: `COUNTEREXAMPLE`.
- `unsat` on the **negated property**: `PROVED` for the fully encoded quantified or symbolic domain, otherwise `BOUNDED_PASS` when bounds/abstractions limit the claim.
- `unknown`, timeout, parser error, solver crash: `UNKNOWN` or `ERROR`, fail closed.

Do not use the absence of counterexamples in one subset of the state space to infer universal real-world safety.

## Evidence and acceptance

Write evidence conforming to `../evidence.schema.json` (package-level schema; in the Wazir repo this is `skills/formal/evidence.schema.json`, mirrored at `.Codex/skills/evidence.schema.json`). Mandatory fields include property ID, independent specification revision, source commit, workspace revision, solver version, full model/assumptions, elapsed time, verdict, witness or unsat outcome, and artifact hashes.

**Accept only when:** assumptions are satisfiable; required preconditions are reachable; the solver result is independently reproduced; scope and abstraction limits are attached; model-to-code correspondence is supported by an independent contract, test, or refinement argument. Any code mutation invalidates the old revision's evidence.

## Failure modes

- Vacuous truth from inconsistent assumptions or impossible preconditions.
- Wrong unit conversion, inadequate deceleration dynamics, or missing sensor uncertainty.
- SAT/UNSAT inversion from querying `P` instead of `¬P`.
- Confusing real-arithmetic models with IEEE-754 production calculations.
- Claiming a property of implementation code from a disconnected hand-authored SMT model.

## References

- [Z3 repository](https://github.com/Z3Prover/z3)
- [Z3 Guide](https://microsoft.github.io/z3guide/)
- [Z3Py tutorial](https://ericpony.github.io/z3py-tutorial/guide-examples.htm)
