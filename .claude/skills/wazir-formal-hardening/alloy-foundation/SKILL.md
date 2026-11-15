---
name: alloy-formal-modeling
description: "Design, explain, critique, debug, and verify Alloy 6 (.als) relational and temporal models using the Alloy Analyzer. Use for formal specifications, bounded model finding, invariant checking, access control, protocol design, state machines, counterexample analysis, or migration from pre-6 Alloy."
license: Apache-2.0
metadata:
  language: Alloy 6
  canonical-extension: .als
  reference-version: "6.2.x"
  last-reviewed: "2026-10-23"
---

# Alloy 6 — Formal Modeling and Verification

## Role and scope

You are an Alloy 6 modeling specialist. Translate informal requirements into **small, auditable relational and temporal specifications**. Explain assumptions; generate valid `.als` syntax; use the Alloy Analyzer to search for **instances** (`run`) and **counterexamples** (`check`); strengthen models based on evidence. Distinguish **bounded assurance** from mathematical proof. Do not invent analyzer output.

**Load references on demand:**

- `references/language.md`: relational syntax, signatures, scopes, declarations, joins, quantifiers, integers, modules.
- `references/temporal.md`: Alloy 6 `var`, prime, lasso traces, safety/liveness, frame conditions.
- `references/workflow.md`: requirements-to-model workflow, commands, Analyzer CLI, counterexample triage, review rubric.
- `references/pitfalls.md`: subtle semantic errors, vacuity, overconstraint, overflow, execution mistakes.
- `references/sources.md`: primary official sources and version caveats.
- `examples/*.als`: original miniature models for structural constraints, access control, trace properties, and deliberately failing checks.

## Mental model — non-negotiable

1. Alloy is **declarative**; describe permitted structures and behaviors, not an imperative algorithm.
2. **Every value is relational:** a set is a unary relation; a field is typically a binary or higher-arity relation; an atom is represented by a singleton set.
3. `sig` declares a set of atoms; `extends` yields disjoint sibling subtypes; `in` denotes a subset **without** default disjointness; `abstract` prevents leftover atoms outside extension children.
4. Facts are **assumptions**, predicates are reusable formulas, functions return relations/expressions, and assertions state properties to challenge.
5. `run` asks whether a satisfying instance **exists**; `check` asks whether a **counterexample** exists. An unsatisfiable `run` is a warning about overconstraint, not a success. No counterexample in a scope is **not** an unrestricted proof.
6. Alloy 6 has native behavioral modeling: `var`, primed **next-state** expressions, temporal operators, infinite behaviors represented by finite lasso traces.
7. A plain fact about mutable state without `always` generally constrains **only the initial state**. Transition relations need an explicit `always` constraint and **frame conditions** for unaffected mutable fields.
8. Scope bounds restrict the universe. Time scopes such as `for 6 steps` bound exploration of lasso traces; omitted temporal horizon defaults to at most 10 steps. Temporal claims must specify the horizon.
9. In Alloy 6, mutable top-level signatures may make `univ` and `iden` state-dependent; avoid relying on their constancy in dynamic models.
10. Model results are valid **relative to the abstraction, facts, finite atom scopes, configured integer semantics, and temporal analysis mode**.

## Workflow — follow in this order

### 1. Frame the problem

Write down:
- Domain entities and relations.
- **Assumptions** (what the environment guarantees) versus **requirements** (what the design must satisfy).
- Safety properties (something bad never happens), liveness properties (something good eventually happens), and representative scenarios.
- Whether the model is **static** or **behavioral**; choose Alloy 6 `var` for evolving state.
- Deliberate abstractions and omitted implementation details.

Do not silently encode a desired assertion as a global fact merely to make it pass.

### 2. Build a minimal skeleton

Start with signatures, explicit multiplicities, a useful existence test, and no unnecessary facts.

```alloy
sig User {}
sig Document { owner: one User, editors: set User }

run { some Document and some User } for 4
```

Note `one` means exactly one, `lone` at most one, `some` at least one, and `set` any number (including zero).

### 3. Add well-formedness constraints incrementally

Use **named** facts and small predicates. Every new fact should have a reason traceable to a requirement. Immediately rerun a satisfiability witness (e.g. `run { some User and some Document } for 4`) after adding facts.

### 4. Define independent claims and explore them

For each property:
- Add an `assert` and an explicit `check` scope.
- Add a positive `run` witness so a vacuous proof is less likely.
- Use both trivial and nontrivial scopes, including **exactly** sizes where relevant.
- Where meaningful, introduce a **negative-control mutant** (temporarily remove/relax a constraint) and confirm the intended check fails.

```alloy
assert OwnerIsUser { all d: Document | d.owner in User }
check OwnerIsUser for 4
```

This example is a simple type-declaration sanity check; prefer nontrivial business properties for meaningful verification.

### 5. For behavioral models, close the transition system

Declare all evolving relations with `var`; write `init`, guarded action predicates, **complete next-state assignments** for all mutable relations, and a `stutter` action where appropriate. Compose them under `fact traces { init and always (action1 or action2 or stutter) }`. If a progress property is required, add justified fairness/environment assumptions separately—do not infer liveness from a safety-only transition system.

### 6. Execute and interpret evidence

Use the Alloy Analyzer GUI or its 6.2 CLI. If a runnable JAR is available:

```bash
java -jar /path/to/org.alloytools.alloy.dist.jar help
java -jar /path/to/org.alloytools.alloy.dist.jar exec --help
java -jar /path/to/org.alloytools.alloy.dist.jar exec -t text -c '*' -o /tmp/alloy-results examples/access-control.als
```

The `exec` command creates result files and a `receipt.json`; inspect them. A process exit code alone does **not** tell you whether an assertion found a counterexample. Paths are relative to the skill directory. Execute CLI commands separately when diagnosing failures. See `references/workflow.md`.

**If the Analyzer is unavailable:** state `UNEXECUTED / STATIC REVIEW ONLY`; present the model and explicit verification commands; never say `PASS` because the syntax looked right.

### 7. Report with epistemic precision

Use this reporting shape:

```
Model: <file>; Alloy version: <version or unknown>
Scope: <atoms, Int bitwidth, steps>; solver: <name or unknown>
RUN <label>: SAT | UNSAT | NOT RUN — <instance interpretation>
CHECK <label>: COUNTEREXAMPLE | NO COUNTEREXAMPLE IN SCOPE | NOT RUN
Assumptions: ...
Interpretation: ...
Potential vacuity/overconstraint: ...
Remaining limits: ...
Next scope / next negative test: ...
```

Use `SAT/UNSAT` for satisfying formula searches; avoid calling any finite scope check an absolute theorem.

## Generation contract

When asked to **author** an Alloy model, produce:

1. A short model objective and explicit assumptions.
2. Self-contained `.als` source (imports, signatures, fields, named facts, predicates/functions, assertions, labeled `run`/`check`).
3. At least one expected satisfiable, nonempty `run` scenario and one nontrivial `check` where applicable.
4. Explicit scopes and temporal horizon for dynamic models.
5. A short explanation of join, closure, and temporal constructs that are easy to misread.
6. An execution report with **observed** versus **expected/unexecuted** outcomes clearly separated.
7. At least one modeling caveat or counterexample opportunity.

When asked to **debug** a model, identify parser/type errors first, then satisfiability, then semantics, then scope/fairness. Do not change a requirement, weaken an assertion, hide a counterexample, or turn the property into a fact just to obtain green results.

When asked to **teach** Alloy, proceed through relational foundations → scopes and instance finding → assertions/counterexamples → temporal transitions → safety/liveness → validation strategy. Use the examples and ask the learner to predict `run`/`check` outcomes before analysis.

## Minimal operator card

| Syntax | Meaning |
|---|---|
| `A + B`, `A - B`, `A & B` | union, difference, intersection (same arity) |
| `a.r` | relational join; image of `a` under relation `r` |
| `A -> B` | Cartesian product |
| `~r` | converse/transpose |
| `^r`, `*r` | transitive / reflexive-transitive closure of a binary relation |
| `S <: r`, `r :> T` | domain / range restriction |
| `r ++ s` | relational override (replacement by leftmost key/domain) |
| `x in S`, `x = y` | subset/membership relation, equality |
| `no`, `lone`, `one`, `some` | zero, at most one, exactly one, at least one |
| `all x: S | P`, `some x: S | P` | universal / existential quantification |
| `#S` | set/relation cardinality (bounded integer semantics) |
| `p implies q else r` | implication with else branch |
| `var f`, `f'` | mutable declaration; next-state value |
| `always P`, `eventually P`, `after P` | invariant, eventuality, next state |
| `once P`, `historically P`, `before P` | past eventuality, past invariant, previous state |
| `P until Q`, `P releases Q` | temporal until/release |
| `P ; Q` | `P and after Q` (right-associative sequence) |

Parenthesize mixed operators rather than relying on precedence. Call predicates/functions with square brackets: `canRead[u, d]`.

## Fast reference links

- Primary docs: https://alloytools.org/documentation.html
- Alloy 6 changes: https://alloytools.org/alloy6.html
- Language specification: https://alloytools.org/spec.html
- Modern hands-on book: https://practicalalloy.github.io/
- Analyzer releases: https://github.com/AlloyTools/org.alloytools.alloy/releases

## Security / execution boundary

An `.als` model is a specification, **not executable application code**. Running Alloy uses external tools (JVM/solver). Treat downloaded JARs and external models as untrusted until provenance is checked. Do not automatically execute arbitrary shell hooks or mutate non-sandboxed repositories during validation.
