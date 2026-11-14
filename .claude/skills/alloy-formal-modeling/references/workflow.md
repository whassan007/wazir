# Workflow: formal requirements → Alloy → evidence

## Requirement decomposition

Create a traceable table before coding:

| ID | Natural-language requirement | Role | Alloy location | Analysis |
|---|---|---|---|---|
| R1 | Every request has exactly one submitter | structural assumption | `Request.submitter: one User` | `run` witness |
| R2 | A submitter cannot approve their own request | business invariant | `assert NoSelfApproval` | `check` counterexample search |
| R3 | An approval cannot occur unless a request is pending | transition guard | `pred approve` | scenario `run`, invariant `check` |
| R4 | Requests can remain pending | environmental possibility | stutter transition | `run` trace |

Do not translate a requirement directly into a fact by default: decide whether the **model assumes** it or the **design must establish** it. To test an implementation's guarantees, model transitions and derive assertions from them.

## Iterative modeling protocol

1. Decide smallest useful atom classes and relationships.
2. Add signatures and appropriate multiplicity.
3. `run {}` once for parser/type sanity, then `run { some relevantSignature }` to avoid trivial empty instances.
4. Add constraints one at a time. Record which additions change SAT to UNSAT.
5. Add at least one adversarial shape or negative-control violation.
6. `check` important claims at multiple atom bounds and temporal horizons.
7. Classify findings: genuine design violation, omitted assumption, invalid abstraction, unintended nondeterminism, vacuity, solver/bitwidth artifact.
8. Apply only the narrowest justified correction, then rerun the relevant witnesses and assertions.

## Running the Analyzer

**GUI:** Download Alloy 6 from https://alloytools.org/download.html; Java 17+ is required for the current release described by its upstream README. Open `.als` in the Analyzer and choose the model's labeled `run` / `check` commands. Inspect the generated instance or counterexample in the graph/table/text views, including lasso loops in behavioral models.

**CLI (Alloy 6.2):**

```bash
java -jar org.alloytools.alloy.dist.jar help
java -jar org.alloytools.alloy.dist.jar exec --help
java -jar org.alloytools.alloy.dist.jar exec \
  -c '*' -t text -o ./alloy-evidence ./examples/access-control.als
```

The CLI has been documented upstream as `exec [-c command] [-o output] [-t text|table|json|xml|none] [-s solver] [-f force] <file>`. Some versions may differ; always inspect `exec --help` first. Its output folder includes `receipt.json`. The tool may exit **successfully** even when a `check` has found a counterexample: the assertion result is an **analysis outcome**, not a CLI crash. Read the receipt/instances and report the actual finding.

If using the script in this skill: `bash scripts/run-examples.sh /path/to/org.alloytools.alloy.dist.jar` from the skill root. It runs commands against all examples and preserves output in a temporary directory, but **does not declare semantic PASS/FAIL** without analyzing the receipt.

**Version note:** Alloy's website's documentation page may still link to the Alloy 6.0.0 tag even though the download page lists 6.2.0. Prefer version-matched CLI help. Complete/unbounded temporal checking with `for 1.. steps` may require NuSMV/nuXmv and appropriate configuration. Avoid claiming that the GUI's configured backend matches the CLI backend by default.

## Analysis report template

```markdown
### Model verification
- Objective:
- Model file / commit:
- Alloy version / solver:
- Structure scope / Int bitwidth / time steps:
- Explicit domain assumptions:
- `run <scenario>`: SAT | UNSAT | NOT RUN; witness summary:
- `check <property>`: COUNTEREXAMPLE | NONE IN BOUND | NOT RUN; trace/violation summary:
- Negative control (constraint removed):
- Potential vacuity or unreachable states:
- Remaining omissions and confidence boundary:
```

A counterexample report should identify precisely **which relation tuples** or **which state transition** falsify the property, not merely say “Alloy failed.” If the property is genuinely violated, minimize the counterexample to a small scope and determine whether it is an omitted requirement or model error.

## Modeling enterprise systems

For privacy, authorization, consent, compliance, and audit workflows, model *subject*, *resource*, *operation*, *purpose*, *authority*, and *time* only if the requirement depends on them. Distinguish:

- **Policy state:** which grants/roles/consents are active.
- **Enforcement decision:** permit/deny; often a predicate.
- **System behavior:** a transition that issues, revokes, or consumes a capability.
- **Security invariants:** e.g., every access event is preceded by or accompanied by authorization.
- **Environment assumptions:** e.g., no actor can bypass the enforcement point.

A positive outcome (`run`) checks feasibility; an assertion (`check`) searches for policy gaps. A deliberately broken access-control variant should provide a counterexample so that the check's discriminatory power is demonstrated. Alloy's finite bounded scope is **not** evidence of regulatory compliance on its own.

## Multi-agent handoff contract

If several agents collaboratively model and verify the same system, require:

- **Modeler:** owns signature declarations and domain assumptions.
- **Property author:** writes claims independently from global facts.
- **Verifier:** runs the Analyzer and maintains evidence, scope, solver, and outcomes.
- **Counterexample analyst:** attempts a minimally constrained violating instance.

No agent may report success by relying on another's unexecuted assumptions. One integration owner merges `.als` files and guarantees no duplicate signature/module names.

## Quality gate

A production-grade Alloy modeling result requires: parse/type acceptance; SAT existence witness; nontrivial witness; bounded `check`; explicit scope; inspected counterexample or justified absence; fairness and framing audit for temporal models; integer overflow review; no fabricated tool results.

## Sources

- https://alloytools.org/documentation.html
- https://alloytools.org/spec.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/commands/index.html
- https://alloytools.discourse.group/t/how-do-i-specify-options-to-alloy-6-2-cli-exec-command/538
- https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0
