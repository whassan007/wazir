# High-impact Alloy modeling failure modes

## 1. Vacuous assertions and trivial witnesses

`assert Good { all a: A | P[a] }` passes when `A` is empty. `run {}` can find an empty instance and conceal domain inconsistencies. Add `run { some A } for 5`; where needed force `exactly` atom counts in scopes or use a scenario requiring both sides of a relation.

`check SomeProperty {}` is **not** equivalent to `check SomeProperty` for a named assertion; a labeled inline check with empty braces checks `true`, silently dropping the assertion. Prefer `check PropertyName for N` or `check label { actualFormula } for N`.

## 2. Mistaking `check` outcomes

- A found counterexample is **useful evidence** of a permitted bad instance.
- “No counterexample found” means only no counterexample in explored bounds/solver configuration, not mathematical certainty.
- “No instance found” for a `run` is an alarming possibility of overconstraint.
- Asserted postconditions inserted as global facts no longer test whether your behavioral design guarantees those properties.

## 3. Missing frame conditions

A transition that defines `x'` but does not constrain `y'` allows `y` to change **arbitrarily** even if the action is conceptually “only update x.” Require a before/after inventory for every mutable field and each action. Frame unaffected state explicitly:

```alloy
pred updateX {
  State.x' = State.x + Item
  State.y' = State.y
}
```

This snippet assumes compatible declarations for `State`, `x`, `y`, and `Item`; it is an explanatory fragment, not a full `.als` file.

## 4. Initial-state-only facts

`fact { no Store.used }` constrains state 0. It does **not** ensure future states are empty. For an invariant use `fact { always no Store.used }` (only when that is truly an assumption), or preferably write `assert { always ... }` and check whether your transition semantics imply it.

## 5. `extends` versus `in`

`A in B` and `C in B` can overlap. `A extends B` and `C extends B` are disjoint siblings. `abstract sig B {}` with `extends` children enforces coverage. Choose based on domain, not syntax preference.

## 6. Multiplicity traps

- `one sig Manager` = exactly one manager atom.
- `sig Department { manager: one Employee }` = one manager **per department**, which need not be unique across departments.
- `lone` = zero or one; it does not imply existence.
- A `set`-valued field need not be inhabited.
- `one x: Set | P` quantifies over atoms satisfying `P`; it is not `one Set` unless formulated so.

## 7. Relation algebra confusion

- `+` and `-` are **set** union and subtraction, not arithmetic operators.
- `^r` excludes the identity unless a nonempty cycle creates one; `*r` includes zero-length reachability (identity).
- `A in B` is subset; `a in B` is membership only when `a` is singleton.
- `a.b` is relational join, **not object mutation**; joining a missing key produces `none`, not a runtime exception.
- `r ++ s` overwrites based on first-column keys; it is not simple union.
- Mix `.` / `[]` / `'` with parentheses if there is any parsing ambiguity.

## 8. Temporal lasso and progress illusions

Infinite traces are represented with lasso loops. Without a `stutter` transition, a model may force unnatural perpetual activity or dead-end behaviors that have no infinite extension. With stutter, **liveness** can fail due to indefinite nonprogress. Do not use an unjustified fairness fact to force an expected result. Check safety and liveness separately.

`eventually P` may hold **now**; use `after eventually P` if you explicitly require occurrence after the current instant.

`P implies eventually Q` tested at the first state is not the same as `always (P implies eventually Q)`.

## 9. Integer semantics

The Analyzer uses bounded-width integers and encodes them for solving. Arithmetic may overflow or be excluded when overflow prevention is enabled. `#Set`, `sum`, and numeric constraints can be distorted by overly small bitwidths; increase width deliberately and report it. Overflow-prevention settings may eliminate instances entirely, resulting in spurious confidence if not checked for vacuity.

## 10. Overmodeling and false implementation confidence

Smallest useful abstractions are a strength, but omitting an adversarial capability (e.g., bypassing authorization) will make that threat invisible. Clearly state what lies outside the model. Do not claim an Alloy model validates source code, production behavior, or legal compliance without a separate traceability/implementation-validation bridge.

## 11. Pre-6 and 6.x compatibility

Alloy 6 added reserved identifiers, `'`, `;`, and native temporal features. Pre-6 idioms using explicit ordered `State` signatures remain valid in some contexts but do **not** automatically gain Alloy 6 temporal semantics. Distinguish ordering of a static signature from built-in lasso traces. Check ambiguous old-model identifiers such as `var`, `after`, `always`, and `steps` before migrating.

## 12. Command-line misinterpretation

CLI success is not property success. Distinguish:

1. Shell process/Java invocation succeeded.
2. Model parsed/typechecked.
3. Solver found a satisfying instance for `run` (or not).
4. Solver found a counterexample for `check` (or not).
5. The evidence corresponds to the intended command/scope/solver.

Inspect `receipt.json` and model outputs rather than using shell exit 0 as a proof oracle.

## Debugging decision tree

| Symptom | First action |
|---|---|
| Syntax/parser error | Check version keywords, brackets, semicolon, apostrophe, operator precedence |
| Type error | Inspect relation arity and join column types; ensure function outputs match declarations |
| `run` UNSAT | Remove facts one at a time; require a minimal witness; inspect `exactly` scope |
| `check` unexpected counterexample | Examine atom tuples and temporal sequence; distinguish requirement from missing fact |
| `check` passes suspiciously | Attempt negative mutant; force nonempty signatures; review vacuity |
| Liveness fails | Inspect stutter loop, scheduler constraints, missing fairness |
| Performance collapses | Reduce scope, relation arity, integer bitwidth, steps; inspect solver choice |
| GUI/CLI discrepancy | Compare versions, solvers, scopes, options, command selection, overflows |

## Sources

- https://alloytools.org/spec.html
- https://alloytools.org/alloy6.html
- https://practicalalloy.github.io/chapters/behavioral-modeling/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/integers/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/commands/index.html
