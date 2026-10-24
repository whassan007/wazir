# Wazir Formal-Assurance Skills — Install Bundle

Every skill in the **Wazir** Claude project, compiled into one file so it can live in the repo and be re-installed anywhere. It contains 28 files across 6 skills, embedded verbatim.

Compiled 2026-10-23 from the project's skill docs and its two skill archives (`alloy-formal-modeling-skill.zip`, `wazir-formal-assurance-skills.zip`). The project's four `SKILL.md` docs and `SKILL (1).md` are the same files as the zipped `z3`/`dafny`/`scenic`/`verifai` and `alloy-formal-modeling` skills; `gam-skill.md` and `gal-json.md` are the GAM skill and its reference.

## The skills

| Skill (frontmatter `name`) | Folder | Priority | What it does |
|---|---|---|---|
| `alloy-formal-modeling` | `alloy-formal-modeling/` | — | Author, debug and check Alloy 6 relational and temporal models (`run`/`check`, counterexample triage) |
| `wazir-z3-constraint-verification` | `wazir-formal-assurance-skills/skills/z3/` | P0 | SMT encoding of arithmetic, Boolean and finite-state constraints; counterexample search |
| `wazir-dafny-program-verification` | `wazir-formal-assurance-skills/skills/dafny/` | P1 | Contracts, invariants and termination proofs for selected decision functions |
| `wazir-scenic-scenario-generation` | `wazir-formal-assurance-skills/skills/scenic/` | P0 | Constrained, reproducible AV and robot scenario families |
| `wazir-verifai-falsification` | `wazir-formal-assurance-skills/skills/verifai/` | P0 | Guided simulation search for property violations (falsification, not proof) |
| `gam` | `gam/` | — | GAM / GAL-JSON compliance modeling: Φ_L vs Φ_E consistency, ontology and scenario checks, Alloy emission |

## Install

### 1. Extract the files

Save the script below as `extract_skills.py` next to this file and run it. It finds every `<!-- FILE: path -->` block and writes it to the target folder, keeping the relative paths.

```python
#!/usr/bin/env python3
"""Recreate every skill file embedded in SKILLS_INSTALL.md.
Usage: python3 extract_skills.py SKILLS_INSTALL.md <target-dir>"""
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
dest = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "skills")
pat = re.compile(r"<!-- FILE: (?P<path>[^ ]+) -->\n````[^\n]*\n(?P<body>.*?)\n````\n", re.S)
n = 0
for m in pat.finditer(src):
    p = dest / m["path"]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(m["body"] + "\n", encoding="utf-8")
    if p.suffix == ".sh":
        p.chmod(0o755)
    n += 1
    print("wrote", p)
print(f"{n} files written under {dest}")
```

```bash
cd docs/formal-assurance
python3 extract_skills.py SKILLS_INSTALL.md ./skills
```

### 2. Register with your agent

**Claude Code.** Each skill must sit directly under `.claude/skills/<skill>/SKILL.md`:

```bash
REPO=$(git rev-parse --show-toplevel)
mkdir -p "$REPO/.claude/skills"
cp -R skills/alloy-formal-modeling                        "$REPO/.claude/skills/"
cp -R skills/gam                                          "$REPO/.claude/skills/"
for s in z3 dafny scenic verifai; do
  cp -R "skills/wazir-formal-assurance-skills/skills/$s"  "$REPO/.claude/skills/wazir-$s"
done
# shared assets the four Wazir skills refer to
cp skills/wazir-formal-assurance-skills/evidence.schema.json "$REPO/.claude/skills/"
```

For a user-wide install, use `~/.claude/skills/` in place of `$REPO/.claude/skills/`.

**Wazir / Rook or any host without skill discovery.** Point the agent at the `SKILL.md` first, then the `references/*.md` it names. The bundle README notes that native Wazir skill registration hasn't been set up yet, so these files don't add `wa` subcommands or solver adapters on their own.

**claude.ai.** Re-zip each skill folder (with `SKILL.md` at the folder root) and upload it as a custom skill.

### 3. Tool dependencies

These are not embedded and need installing separately, ideally pinned in an isolated venv.

| Tool | Install | Used by |
|---|---|---|
| Alloy Analyzer 6.2.0 (Java 17+) | `org.alloytools.alloy.dist.jar` is in the Wazir project files (Bundle-Version 6.2.0.202501090817, SHA-256 `6b8c1cb5bc93bedfc7c61435c4e1ab6e688a242dc702a394628d9a9801edb78d`), or download from https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0 | `alloy-formal-modeling`, `gam` (`npm run alloy:check`) |
| Z3 | `python -m pip install z3-solver` | `z3` |
| Dafny | https://dafny.org/ | `dafny` |
| Scenic | `python -m pip install scenic` | `scenic`, `verifai` |
| VerifAI | `python -m pip install verifai` plus a validated simulator bridge | `verifai` |

### 4. Verify the install

```bash
python skills/wazir-formal-assurance-skills/scripts/validate_skills.py
python skills/wazir-formal-assurance-skills/skills/z3/examples/check_stopping_rule.py --candidate buggy
python skills/wazir-formal-assurance-skills/skills/z3/examples/check_stopping_rule.py --candidate guarded
bash skills/alloy-formal-modeling/scripts/run-examples.sh /path/to/org.alloytools.alloy.dist.jar
```

## File inventory

| Path | Bytes | SHA-256 (first 12) |
|---|---|---|
| `alloy-formal-modeling/SKILL.md` | 10,359 | `9f775205ee06` |
| `alloy-formal-modeling/README.md` | 3,675 | `05ebbb1f47ce` |
| `alloy-formal-modeling/evals/challenges.md` | 3,411 | `93e7a16c80aa` |
| `alloy-formal-modeling/examples/access-control.als` | 909 | `68a6b89e278a` |
| `alloy-formal-modeling/examples/filesystem-tree.als` | 630 | `ca62104ed468` |
| `alloy-formal-modeling/examples/mutex-temporal.als` | 1,024 | `6d1318272620` |
| `alloy-formal-modeling/examples/self-approval-counterexample.als` | 453 | `3ad6ba38def3` |
| `alloy-formal-modeling/examples/self-approval-fixed.als` | 551 | `e915a543998c` |
| `alloy-formal-modeling/references/language.md` | 9,148 | `d291304005df` |
| `alloy-formal-modeling/references/pitfalls.md` | 6,632 | `30c4c373c032` |
| `alloy-formal-modeling/references/sources.md` | 2,675 | `7571f7a94da1` |
| `alloy-formal-modeling/references/temporal.md` | 5,814 | `5a77aaf8fdf2` |
| `alloy-formal-modeling/references/workflow.md` | 6,389 | `487a9b8ffe86` |
| `alloy-formal-modeling/scripts/run-examples.sh` | 1,320 | `0b0820678398` |
| `wazir-formal-assurance-skills/README.md` | 4,547 | `aafcbf08af79` |
| `wazir-formal-assurance-skills/evidence.schema.json` | 2,503 | `9878732e3fb7` |
| `wazir-formal-assurance-skills/scripts/validate_skills.py` | 1,439 | `eba8fbc46cd3` |
| `wazir-formal-assurance-skills/skills/dafny/SKILL.md` | 5,212 | `b6fdd56c9aec` |
| `wazir-formal-assurance-skills/skills/dafny/examples/stop_command.dfy` | 360 | `319d1ebe735b` |
| `wazir-formal-assurance-skills/skills/scenic/SKILL.md` | 5,155 | `38f8f6ed3411` |
| `wazir-formal-assurance-skills/skills/scenic/examples/approach_scene.scenic` | 243 | `aa0a6ec60184` |
| `wazir-formal-assurance-skills/skills/scenic/examples/sample_scenes.py` | 954 | `2a6f57b345b3` |
| `wazir-formal-assurance-skills/skills/verifai/SKILL.md` | 5,938 | `8d1f5fe53265` |
| `wazir-formal-assurance-skills/skills/verifai/examples/falsify_with_scenic.py` | 1,411 | `0dcf15cd0f8b` |
| `wazir-formal-assurance-skills/skills/z3/SKILL.md` | 5,768 | `ba2713ec9ed8` |
| `wazir-formal-assurance-skills/skills/z3/examples/check_stopping_rule.py` | 2,147 | `2e48913876ee` |
| `gam/SKILL.md` | 14,103 | `6c09e4590650` |
| `gam/references/gal-json.md` | 7,509 | `dd7b78af2c76` |

---

## Bundle: `alloy-formal-modeling/`

### `alloy-formal-modeling/SKILL.md`

<!-- FILE: alloy-formal-modeling/SKILL.md -->
````markdown
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
````

### `alloy-formal-modeling/README.md`

<!-- FILE: alloy-formal-modeling/README.md -->
````markdown
# Alloy Formal Modeling — portable LLM skill

A reusable **Alloy 6** skill to teach Claude Code, Codex, Wazir, and other tool-using LLMs to generate, interpret, and verify `.als` formal models.

## Contents

```text
alloy-formal-modeling/
  SKILL.md
  README.md
  references/
    language.md
    temporal.md
    workflow.md
    pitfalls.md
    sources.md
  examples/
    access-control.als
    filesystem-tree.als
    mutex-temporal.als
    self-approval-counterexample.als
    self-approval-fixed.als
  scripts/
    run-examples.sh
  evals/
    challenges.md
```

## Install in an agent

- **Claude Code:** copy the `alloy-formal-modeling/` directory under your project's `.claude/skills/`, preserving `SKILL.md` and relative reference paths. Activate with `Use the alloy-formal-modeling skill to ...`; Claude's skill discovery depends on the host configuration.
- **Other compatible agent skill hosts:** copy the directory into the host's `skills/` discovery path. Keep references/examples together so the agent can load them as needed.
- **Wazir or a generic LLM without automatic skill discovery:** instruct the model to read `SKILL.md` first, then relevant `references/*.md`; optionally provide examples as few-shot demonstrations. This bundle does **not** assume or claim a specific Wazir skill installation API.
- **Prompt-only LLM:** provide the contents of `SKILL.md` as an instruction layer and attach the corresponding reference documents when needed.

## Quick start prompt

> Use the Alloy 6 formal-modeling skill. Model this authorization workflow as an `.als` specification. Start with assumptions, include one satisfiable nontrivial scenario, state at least two independently checked invariants, declare scopes, and report any unexecuted analysis honestly. Do not convert assertions into facts to make them pass.

## Analyzer installation and validation

Use the official binary from https://alloytools.org/download.html or https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0. The upstream project requires Java 17 or later.

```bash
java -jar /path/to/org.alloytools.alloy.dist.jar help
bash scripts/run-examples.sh /path/to/org.alloytools.alloy.dist.jar
```

**Expected intent (not locally executed in this authoring session):**

| Example | Expected run | Expected checks |
|---|---|---|
| `access-control.als` | Instance with group access | No counterexample for owner/group authorization |
| `filesystem-tree.als` | Nontrivial rooted tree | No counterexample for reachability |
| `mutex-temporal.als` | Trace that acquires a lock | No counterexample for mutual exclusion and guarded acquisition |
| `self-approval-counterexample.als` | Approved request exists | **Counterexample** to no-self-approval |
| `self-approval-fixed.als` | Valid approved request with 2 users | No counterexample under separation-of-duties assumption |

An assertion can be false while the Alloy CLI exits 0: inspect output and receipts. These expected outcomes are **analytical predictions, not recorded solver observations**.

## Scope of the skill

Focus: Alloy 6 relational logic, finite structural analysis, temporal behavior, common misinterpretations, and model-review discipline. No promise of correctness without Analyzer execution; finite scopes cannot establish unrestricted theorem validity. The skill does not include the Alloy binary (obtain that from the upstream project).

## Source and license note

Instructional content and examples were authored for this bundle, with citations and attribution in `references/sources.md`. This is independent educational material; it does not redistribute the original Alloy manual, book, or application.
````

### `alloy-formal-modeling/evals/challenges.md`

<!-- FILE: alloy-formal-modeling/evals/challenges.md -->
````markdown
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
````

### `alloy-formal-modeling/examples/access-control.als`

<!-- FILE: alloy-formal-modeling/examples/access-control.als -->
````alloy
// Alloy 6 — Static group-based document access control.
// Intended outcomes: an authorized reading scenario exists;
// GroupMembersCanRead and OwnersCanRead have no counterexample in scope.

sig User {}
sig Group { members: set User }
sig Document {
  owner: one User,
  directReaders: set User,
  groupReaders: set Group
}

pred canRead[u: User, d: Document] {
  u = d.owner
  or u in d.directReaders
  or some g: d.groupReaders | u in g.members
}

pred SharedGroupAccess {
  some d: Document, g: d.groupReaders, u: g.members |
    u != d.owner and u not in d.directReaders and canRead[u, d]
}

assert OwnersCanRead {
  all d: Document | canRead[d.owner, d]
}

assert GroupMembersCanRead {
  all d: Document, g: d.groupReaders, u: g.members |
    canRead[u, d]
}

run SharedGroupAccess for 5 but exactly 2 User, exactly 1 Group, exactly 1 Document
check OwnersCanRead for 5
check GroupMembersCanRead for 5
````

### `alloy-formal-modeling/examples/filesystem-tree.als`

<!-- FILE: alloy-formal-modeling/examples/filesystem-tree.als -->
````alloy
// Alloy 6 — Static finite rooted filesystem hierarchy.
// Every nonroot node has one parent; there are no containment cycles.
// Intended outcomes: nontrivial hierarchy SAT, AllReachable has no
// counterexample within scope.

abstract sig Object {}
sig File extends Object {}
sig Directory extends Object {
  children: set Object
}
one sig Root extends Directory {}

fact IsTree {
  no Root.~children
  all o: Object - Root | one d: Directory | o in d.children
  no d: Directory | d in d.^children
}

assert AllReachable {
  Object in Root.*children
}

run { some File and some Directory - Root } for 6
check AllReachable for 6
````

### `alloy-formal-modeling/examples/mutex-temporal.als`

<!-- FILE: alloy-formal-modeling/examples/mutex-temporal.als -->
````alloy
// Alloy 6 — Behavioral lock model with native temporal state.
// Intended outcomes: acquiring a lock is possible; the holder is at
// most one Client in each state. Liveness is NOT guaranteed because
// stuttering forever is allowed.

sig Client {}
one sig Mutex { var holder: lone Client }

pred init {
  no Mutex.holder
}

pred acquire[c: Client] {
  no Mutex.holder
  Mutex.holder' = c
}

pred release[c: Client] {
  Mutex.holder = c
  no Mutex.holder'
}

pred stutter {
  Mutex.holder' = Mutex.holder
}

fact Transitions {
  init
  always (
    (some c: Client | acquire[c] or release[c])
    or stutter
  )
}

assert MutualExclusion {
  always lone Mutex.holder
}

// This is a stronger safety check on allowed next-state transitions.
assert NoSpontaneousAcquisition {
  always (
    (no Mutex.holder and some Mutex.holder') implies
    (some c: Client | acquire[c])
  )
}

run { eventually some Mutex.holder } for 3 but 6 steps
check MutualExclusion for 3 but 6 steps
check NoSpontaneousAcquisition for 3 but 6 steps
````

### `alloy-formal-modeling/examples/self-approval-counterexample.als`

<!-- FILE: alloy-formal-modeling/examples/self-approval-counterexample.als -->
````alloy
// Alloy 6 — Intentionally flawed authorization system.
// NO fact prevents self-approval. A check SHOULD find a counterexample.
// This is an example of verification detecting a missing policy control.

sig User {}
sig Request {
  submittedBy: one User,
  approvedBy: lone User
}

assert NoSelfApproval {
  all r: Request |
    some r.approvedBy implies r.submittedBy != r.approvedBy
}

run { some Request.approvedBy } for 3
check NoSelfApproval for 3
````

### `alloy-formal-modeling/examples/self-approval-fixed.als`

<!-- FILE: alloy-formal-modeling/examples/self-approval-fixed.als -->
````alloy
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
````

### `alloy-formal-modeling/references/language.md`

<!-- FILE: alloy-formal-modeling/references/language.md -->
````markdown
# Alloy 6 language — reliable working reference

## 1. Relations, signatures, and types

Alloy formulas constrain **relations over atoms**. Unary relations are sets; binary relations are sets of ordered pairs; n-ary relations are sets of n-tuples. There is no assignment statement and no imperative iteration. `run` and `check` invoke a solver over finite bounds.

```alloy
abstract sig Entity {}
sig User extends Entity {}
sig Group extends Entity { members: set User }
one sig Superuser extends User {}
sig Document { owner: one User, reviewers: set User }
```

- Top-level signatures denote sets that are mutually disjoint from other top-level signatures (except special built-ins and inheritance/subsetting).
- `extends` means an extension subset; sibling extensions are disjoint. `abstract` parents have no atoms outside their direct/indirect extension descendants.
- `sig A in B {}` is a subset signature, possibly overlapping with other subset signatures; it does not create a new disjoint partition.
- `one sig Name`, `lone sig Name`, `some sig Name` constrain signature cardinality. An unqualified signature can be empty.
- A declared `f: one T` makes each source atom have exactly one `T` target; `f: lone T` means zero or one; `f: some T` means one or more; `f: set T` means any number.
- **Field multiplicity is not about global tuple count.** In `sig User { manager: lone User }`, every user has at most one manager. The relation as a whole may contain many pairs.
- Top-level field relations are syntactic declarations associated with their owner signatures, and can be used globally as `User.manager` or from a specific user as `u.manager`.

### `extends` vs `in` — a high-value distinction

```alloy
sig Person {}
sig Student in Person {}
sig Employee in Person {}
```

Here a person may be both a student and an employee. Change to `extends Person` if categories must be disjoint, and consider an abstract parent if they must cover all `Person` atoms.

### Relation product and join

```alloy
sig User {}
sig Document { owner: one User, allowed: set User }

pred canRead[u: User, d: Document] {
  u = d.owner or u in d.allowed
}
```

- `d.owner`: relational join, yielding the owner set (one atom because of the declaration).
- `Document.owner`: all document-to-owner pairs.
- `User -> Document`: all possible user-document pairs.
- `d -> u`: the singleton pair `(d,u)`.
- `~(Document.owner)`: relation with owner first, documents second.
- `r ++ s`: override tuples of `r` whose **first column** appears in `s` with tuples from `s`; prefer domain restriction expressions to make intent explicit on n-ary relations.

### Basic relational algebra

| Operator | Notes |
|---|---|
| `a + b` | Union (same arity). `+` is not integer addition. |
| `a - b` | Difference (same arity). Not numeric subtraction. |
| `a & b` | Intersection (same arity). |
| `a.b` | Join; joins the last column of `a` with the first of `b`. |
| `r[s]` | Relation join in bracket notation; equivalent to `s.r` in relational expressions. |
| `a -> b` | Product; arities add. |
| `~r` | Transpose (requires binary relation). |
| `^r` | One-or-more step transitive closure of binary `r`. |
| `*r` | Zero-or-more step reflexive-transitive closure. |
| `A <: r` | Keep tuples of `r` whose first element is in `A`. |
| `r :> B` | Keep tuples of `r` whose last element is in `B`. |
| `r ++ s` | Override based on first-column keys. |
| `none`, `univ`, `iden` | Empty unary relation, universe, identity binary relation. |
| `#e` | Cardinality; depends on bounded integer encoding. |

Closure example:

```alloy
sig Node { edge: set Node }
assert NoDirectedCycle {
  no n: Node | n in n.^edge
}
check NoDirectedCycle for 5
```

The **check is expected to find a counterexample**, because nothing forbids a directed cycle. This is a pedagogical negative control, not a verified invariant. `^edge` means reachability through one or more edges; `*edge` permits zero edges and includes identity.

## 2. Logic and quantifiers

- `P and Q` / `P or Q` / `not P` / `P implies Q` / `P iff Q`.
- `P implies Q else R` models a conditional (not an imperative branch).
- `some e`, `no e`, `one e`, `lone e` test cardinalities of expressions.
- `all x: S | P`, `some x: S | P`, `no x: S | P`, `one x: S | P`, `lone x: S | P` quantify over **individual atoms**, unless a `set` qualifier intentionally requests sets.
- `all disj x,y: S | ...` quantifies over distinct choices.
- `let x = e | P` aliases an expression locally without changing state.
- `A in B` checks **subset inclusion**. For a singleton `a`, it also reads as membership. It is not a Boolean identity test; use `=` for equality.
- `A = B` is relational equality; `not A = B` means inequality.

Quantifier vacuity: `all x: Empty | P[x]` is true. Always test that relevant signatures and premise conditions can be inhabited.

## 3. Predicates, functions, facts, and assertions

```alloy
sig User {}
sig Document { owner: one User, readers: set User }

fact OwnersCountAsReaders {
  all d: Document | d.owner in d.readers
}

pred directlyReadable[u: User, d: Document] {
  u in d.readers
}

fun ownedBy[u: User]: set Document {
  u.~(Document.owner)
}

assert OwnersCanRead {
  all d: Document | directlyReadable[d.owner, d]
}

run { some Document and some User } for 4
check OwnersCanRead for 4
```

- A `fact` constrains **all** instances; do not use facts to conceal a design flaw.
- A `pred` is a reusable Boolean formula; it does not update mutable state by itself.
- A `fun` returns an Alloy expression, usually a relation; it is not a state-mutating procedure.
- An `assert` is a **claim** to challenge; `check` searches for a counterexample while satisfying facts.
- Function/predicate invocations use brackets, not ordinary function-call parentheses: `directlyReadable[u, d]`.
- Reuse a predicate in multiple assertions without copying its body.

## 4. Scopes

```alloy
run { some Document } for 5 but exactly 2 User
check OwnersCanRead for 5 but exactly 2 User
```

The overall number bounds **each top-level signature**. `exactly N T` forces that number for a scoped top-level/extension signature. An unbounded `run {}` can succeed on empty models and say little.

**Alloy 6 behavioral commands** can also bound the trace horizon:

```alloy
check Property for 4 but 8 steps
run { eventually some Snapshot } for 4 but 6 steps
```

Only use the second snippet if `Snapshot` and `Property` are defined in the same model. `steps` is a special command-scope keyword, not a signature. For true unbounded temporal model checking the syntax is `for 1.. steps`; use an appropriate solver and warn of performance/memory risk.

If a named top-level scope is unusually small, the result may exclude meaningful cases. Increase scopes incrementally and keep a table of exactly what was explored. Satisfiability of `run` proves only the existence of **some** instance within the bound.

## 5. Modules, ordering, integers, and identifiers

- `open util/ordering[State]` supplies a total order on `State`; it makes that ordered signature **exactly** the command-specified scope. Use for static ordered sequences, not as a substitute for Alloy 6 native temporal state in a new behavioral model.
- Module/import declarations come first; names can be qualified with module aliases.
- `Int` is finite in the Analyzer: arithmetic, sums, and `#` depend on bitwidth. Avoid silently equating Alloy's bounded integer encoding with mathematical unbounded integers.
- Integer arithmetic uses functions such as `add[a,b]`, `sub[a,b]`, `mul[a,b]` (see official standard modules); `+`/`-` on sets are set union/difference, not an alternative arithmetic syntax.
- Scope syntax can set bitwidth, e.g. `for 5 but 5 Int` (check Analyzer/version for actual semantics and representable range). Increasing bitwidth increases SAT complexity.
- Use ordinary ASCII punctuation; Alloy 6 reserves `var`, `always`, `eventually`, `after`, `before`, `steps`, and other temporal words. Avoid using new keywords as legacy identifiers.
- `//` and `--` start line comments; `/* ... */` delimits block comments.

## 6. Test expectations and common interpretation errors

`run {}` SAT ⇒ there is **at least one** model instance conforming to facts. The instance may be trivial or empty. `run { some Document }` UNSAT ⇒ no model instance with a document was found **in that scope**, potentially due to inconsistent assumptions.

`check P` finds a counterexample ⇒ `P` is **not entailed** by the facts in that scope. `check P` finds none ⇒ no violation found under analyzed bounds and semantics; not a full general proof. The analyzer shows counterexample valuations; explain the concrete atoms, relation tuples, and (for temporal models) the state and transition.

## Sources

- https://alloytools.org/spec.html
- https://practicalalloy.github.io/chapters/structural-modeling/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/relational-logic/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/commands/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/integers/index.html
````

### `alloy-formal-modeling/references/pitfalls.md`

<!-- FILE: alloy-formal-modeling/references/pitfalls.md -->
````markdown
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
````

### `alloy-formal-modeling/references/sources.md`

<!-- FILE: alloy-formal-modeling/references/sources.md -->
````markdown
# Sources and provenance

This skill is an **original instructional synthesis**, not a reproduction of the upstream book or reference. Code snippets and teaching examples are newly written for this skill. Consult the linked primary sources for exact language semantics and tool-specific behavior.

## Official Alloy project

- Documentation hub: https://alloytools.org/documentation.html
- Alloy 6 temporal semantics, time scopes, lasso traces, and compatibility notes: https://alloytools.org/alloy6.html
- Language reference (grammar, semantics, type system, declarations, functions, commands): https://alloytools.org/spec.html
- Official download: https://alloytools.org/download.html
- Upstream releases (6.2.0 as the site's listed release when reviewed): https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0
- Official project code and build notes: https://github.com/AlloyTools/org.alloytools.alloy

## Practical Alloy (authors: Cunha, Macedo, Brunel, Chemouil)

- Modern open-access book: https://practicalalloy.github.io/
- Structural modeling: https://practicalalloy.github.io/chapters/structural-modeling/index.html
- Relational logic: https://practicalalloy.github.io/chapters/structural-topics/topics/relational-logic/index.html
- Commands and scopes: https://practicalalloy.github.io/chapters/structural-topics/topics/commands/index.html
- Working with integers: https://practicalalloy.github.io/chapters/structural-topics/topics/integers/index.html
- Behavioral modeling: https://practicalalloy.github.io/chapters/behavioral-modeling/index.html
- Temporal logic: https://practicalalloy.github.io/chapters/behavioral-topics/topics/temporal-logic/index.html
- Safety/liveness/fairness: https://practicalalloy.github.io/chapters/behavioral-topics/topics/fairness/index.html

## CLI compatibility notes

- Alloy 6.2 release notes announce `help`, `exec`, and `lsp`: https://github.com/AlloyTools/org.alloytools.alloy/releases/tag/v6.2.0
- Documented Alloy CLI 6.2 `exec` flags: https://alloytools.discourse.group/t/how-do-i-specify-options-to-alloy-6-2-cli-exec-command/538

## Verification status of this skill bundle

- Official language semantics and CLI behavior: **documentation-reviewed**.
- Local file structure, examples, and references: **self-reviewed**.
- Executing `.als` models in the actual Alloy 6.2 Analyzer: **NOT EXECUTED** in this authoring environment because the Alloy JAR was unavailable and external download was inaccessible. The bundled CLI script enables recipient-side validation.
- Versions after 6.2.x: may require revalidation against the upstream grammar and installed `exec --help`.

Last source review: 2026-10-23.
````

### `alloy-formal-modeling/references/temporal.md`

<!-- FILE: alloy-formal-modeling/references/temporal.md -->
````markdown
# Alloy 6 temporal / behavioral modeling reference

## 1. State vs structure

Alloy 6 describes an **infinite execution trace** represented for bounded analysis by a finite **lasso** (finite states with a loop back to an earlier state). A signature or field is **static** by default; add `var` to mark it mutable.

```alloy
sig Client {}
one sig Lock { var holder: lone Client }
```

`Lock` and `Client` are static; `holder` can differ by state. The declaration guarantees no more than one holder at every state, but says nothing about how ownership changes.

`holder'` is the field's **next-state relation**, not a derivative or punctuation. A primed expression is meaningful only when a mutable state interpretation exists. Prime is **not** an imperative assignment: `holder' = ...` is a constraint on adjacent states.

## 2. Initial states, actions, frame conditions

```alloy
pred init { no Lock.holder }

pred acquire[c: Client] {
  no Lock.holder
  Lock.holder' = c
}

pred release[c: Client] {
  Lock.holder = c
  no Lock.holder'
}

pred stutter {
  Lock.holder' = Lock.holder
}

fact Behavior {
  init
  always (
    (some c: Client | acquire[c] or release[c])
    or stutter
  )
}
```

**Read carefully**: a top-level `init` fact constrains only state zero. The enclosing `always` requires each transition along the infinite trace to be an allowed action or stutter. The action predicates provide guards and next-state effects. If you add other mutable fields, every action must constrain unaffected fields as well; otherwise those fields may change arbitrarily at the same time.

`stutter` is intentional nonprogress. A model that permits stuttering forever does **not** establish progress; liveness requires additional justified assumptions (e.g. fairness), and checking such claims without them should often produce a counterexample.

## 3. Temporal operators

| Formula | Meaning at current state |
|---|---|
| `after P` | `P` holds at the immediately next state |
| `always P` | `P` holds now and at every later state |
| `eventually P` | `P` holds at some state now or later |
| `P until Q` | `Q` eventually holds; `P` holds before it |
| `P releases Q` | `Q` holds through first `P` occurrence, or forever if `P` never holds |
| `P ; Q` | `P and after Q`, right-associative |
| `before P` | `P` held at previous state (false at first state) |
| `historically P` | `P` held now and in all preceding states |
| `once P` | `P` held now or at some previous state |
| `P since Q` | `Q` occurred in the past, `P` has held since then |
| `P triggered Q` | Past dual of `releases` |

Temporal operators are interpreted at a state of the trace. A check or run is evaluated beginning at the **first state** unless shifted using a temporal connective. `always` / `eventually` include the current state, so distinguish `eventually P` from `after eventually P`.

## 4. Safety, liveness, and fairness

Safety example:

```alloy
assert NeverTwoHolders {
  always lone Lock.holder
}
check NeverTwoHolders for 3 but 6 steps
```

This particular safety property follows directly from the field's declared `lone` multiplicity; it is a type-level sanity check. Nontrivial properties should test interactions between multiple fields and actions.

Liveness example:

```alloy
assert EveryRequestIsEventuallyGranted {
  always (some Request.pending implies eventually some Request.granted)
}
```

This *illustrative formula* needs `Request.pending` and `Request.granted` declarations; it is **not** a stand-alone compilable model. Whether it holds depends on transition constraints and fairness; an infinite stutter trace may refute it. Use `always (P implies eventually Q)` for per-state response properties; `P implies eventually Q` from initial state alone only covers `P` at the beginning.

Fairness assumptions should be **documented and justified**, not introduced to rescue a failed check. Prefer weak/strong fairness formulas only with a clear environmental scheduling model.

## 5. Temporal scopes and caveats

- `run { eventually some Lock.holder } for 3 but 6 steps`: explore up to six temporal steps.
- `check NeverTwoHolders for 3 but 8 steps`: search for counterexamples on bounded lasso traces.
- `for 1.. steps`: complete/unbounded temporal model checking mode, requiring a supported solver such as nuXmv or NuSMV; may be costly.
- No explicit time scope ⇒ equivalent to `for 10 steps` in Alloy 6.
- Lasso loops mean “next state” also exists at the last visualized state by jumping back to the loop target.
- Only signatures and fields marked `var` can change over time; when a **top-level signature** is mutable, `univ` and `iden` can change accordingly.
- Beware formulas that unintentionally hold only at initial state or only when a zero-length set makes their premises false.

## 6. Behavioral review checklist

1. Are every mutable relation and its meaning explicit?
2. Is the initial condition separately defined?
3. Does each action state a guard and *all* next-state effects, including frames?
4. Does a global temporal fact limit every transition?
5. Is stuttering included (or its exclusion justified)?
6. Is the model satisfiable and does it admit a nontrivial multi-step trace?
7. Are safety and liveness separately checked?
8. Is any fairness assumption stated independently and defensibly?
9. Are state scopes, bitwidth, and `steps` specified in reported checks?
10. Can a deliberately faulty implementation produce the predicted counterexample?

## Sources

- https://alloytools.org/alloy6.html
- https://alloytools.org/spec.html
- https://practicalalloy.github.io/chapters/behavioral-modeling/index.html
- https://practicalalloy.github.io/chapters/behavioral-topics/topics/temporal-logic/index.html
- https://practicalalloy.github.io/chapters/behavioral-topics/topics/fairness/index.html
````

### `alloy-formal-modeling/references/workflow.md`

<!-- FILE: alloy-formal-modeling/references/workflow.md -->
````markdown
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
````

### `alloy-formal-modeling/scripts/run-examples.sh`

<!-- FILE: alloy-formal-modeling/scripts/run-examples.sh -->
````bash
#!/usr/bin/env bash
# Alloy 6.2 verification harness. Requires Java 17+ and official Alloy JAR.
# This is a command runner; do NOT infer property success from shell exit 0.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /absolute/path/to/org.alloytools.alloy.dist.jar [output-dir]" >&2
  exit 2
fi
JAR="$1"
if [[ ! -f "$JAR" ]]; then
  echo "ERROR: Alloy JAR not found: $JAR" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -gt 1 ]]; then
  BASE="$2"
  mkdir -p "$BASE"
else
  BASE="$(mktemp -d "${TMPDIR:-/tmp}/alloy-skill-XXXXXX")"
fi
BASE="$(cd "$BASE" && pwd)"
echo "Alloy results: $BASE"
java -jar "$JAR" help >/dev/null

for model in "$ROOT"/examples/*.als; do
  name="$(basename "${model%.als}")"
  dir="$BASE/$name"
  echo "=== $name ==="
  # -c '*' runs all labeled run/check commands (Alloy 6.2 CLI).
  java -jar "$JAR" exec -c '*' -t text -o "$dir" "$model" 2>&1 | tee "$BASE/$name.log"
  if [[ -f "$dir/receipt.json" ]]; then
    echo "Receipt: $dir/receipt.json"
  else
    echo "WARNING: receipt.json not found at expected location ($dir). Inspect CLI output."
  fi
done

echo
 echo "Completed command invocation. Inspect each receipt.json and corresponding"
 echo "model instance/counterexample before assigning PASS/FAIL."
 echo "Evidence directory: $BASE"
````

---

## Bundle: `wazir-formal-assurance-skills/`

### `wazir-formal-assurance-skills/README.md`

<!-- FILE: wazir-formal-assurance-skills/README.md -->
````markdown
# Wazir Formal Assurance: Four Agent Skills

Four **portable, self-contained `SKILL.md` instructions** for domain-property assurance of AI-generated systems. The use case is to generate an implementation, test it against independently reviewed formal requirements, seek counterexamples, repair it, and preserve reproducible evidence.

| Skill | Priority | Function | Output semantics |
| --- | --- | --- | --- |
| [`skills/z3/SKILL.md`](skills/z3/SKILL.md) | P0 | Arithmetic, symbolic invariants, SMT counterexample search | `COUNTEREXAMPLE`, scoped `PROVED`/`BOUNDED_PASS`, `UNKNOWN` |
| [`skills/dafny/SKILL.md`](skills/dafny/SKILL.md) | P1 | Contracts, functional verification of Dafny code | Proof of Dafny obligations, **not** automatically of non-Dafny production code |
| [`skills/scenic/SKILL.md`](skills/scenic/SKILL.md) | P0 | Constrained geometry/scenario generation | Reproducible scene samples and optional simulation traces |
| [`skills/verifai/SKILL.md`](skills/verifai/SKILL.md) | P0 | Guided search for failing simulations | `FALSIFIED` or `NOT_FALSIFIED`, never proof from search exhaustion |

## Use in Wazir

1. Copy the four folders to the location configured for Wazir's skill loader or agent-instruction discovery. **The current public `whassan007/wazir` checkout was reviewed, but native registration/import of these skills has not been established.** These files alone do not add new `wa` subcommands, installers or solver adapters.
2. Expose these Markdown instructions to the relevant agent, and use existing Wazir PolicyEngine, workspace/tool runtime and verification evidence mechanisms to run external tools.
3. Pin external dependencies and simulation assets in isolated environments before enabling tasks. Never install simulator dependencies unreviewed on the host.
4. Use the **same externally reviewed requirement IDs**, but independent agent roles to formalize properties and implement code. A code-generating agent must not quietly relax requirements to pass verification.
5. Record tool invocations and outcomes in Wazir's existing evidence ledger, including workspace revision fencing. The optional [`evidence.schema.json`](evidence.schema.json) gives a common interchange format that can be mapped to native evidence objects.

### Suggested orchestration

```text
Reviewed traffic requirement (jurisdiction, effective date, exceptions)
  → stable specification and assumption register
     → Z3: check input/transition constraints and find counterexamples
     → Dafny: verify selected implemented decision functions
     → Scenic: generate reproducible, constrained driving scenarios
     → VerifAI: prioritize and replay violating scenarios
  → repair implementation only → rerun all relevant gates
  → evidence bound to same workspace revision → release eligibility decision
```

These skills intentionally do **not** contain statutory text or claim applicability in any jurisdiction. Domain experts must review the actual requirements and exceptions. System-level AV safety requires perception, physical dynamics, simulator validity, integration testing, operational monitors, and a safety case, beyond any single skill.

## Quick checks

```bash
python scripts/validate_skills.py
python -m pip install z3-solver
python skills/z3/examples/check_stopping_rule.py --candidate buggy
python skills/z3/examples/check_stopping_rule.py --candidate guarded
# Optional, if installed: dafny verify skills/dafny/examples/stop_command.dfy
# Optional, if installed: python skills/scenic/examples/sample_scenes.py skills/scenic/examples/approach_scene.scenic --count 5 --seed 42
# VerifAI example needs version-pinned Scenic+VerifAI and a validated simulator bridge.
```

## Important distinctions

- Z3 UNSAT of assumptions alone is **not** proof: detect inconsistent assumptions first.
- Z3 UNSAT of assumptions and negated property establishes the property of that mathematical encoding only.
- Dafny proves the contracts expressed for its verified declarations, subject to the trusted base and actual verification scope.
- Scenic sampling generates constrained scenes; it is not a theorem prover.
- VerifAI falsification is empirical over a chosen space, sampler, simulator and budget; no finding does not mean proved.
- Solver errors, tool timeouts, stale source revisions, and unavailable simulators fail closed.

## Upstream references

- Z3: https://github.com/Z3Prover/z3
- Dafny: https://dafny.org/
- Scenic: https://docs.scenic-lang.org/en/latest/
- VerifAI: https://github.com/BerkeleyLearnVerify/VerifAI
````

### `wazir-formal-assurance-skills/evidence.schema.json`

<!-- FILE: wazir-formal-assurance-skills/evidence.schema.json -->
````json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:wazir:formal-assurance:evidence:1.0",
  "title": "Wazir Formal Assurance Result",
  "description": "Portable evidence exchange schema; adapt to Wazir's native evidence API rather than replacing it.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "evidence_id", "skill", "requirement_id", "property_id", "specification_revision",
    "workspace_id", "workspace_revision", "source_commit", "tool_version",
    "status", "scope", "assumptions", "command", "artifacts"
  ],
  "properties": {
    "evidence_id": {"type": "string", "minLength": 1},
    "skill": {"enum": ["z3", "dafny", "scenic", "verifai"]},
    "requirement_id": {"type": "string", "minLength": 1},
    "property_id": {"type": "string", "minLength": 1},
    "specification_revision": {"type": "string", "minLength": 1},
    "specification_approval": {"enum": ["REVIEWED", "PENDING", "REJECTED"]},
    "jurisdiction": {"type": ["string", "null"]},
    "normative_sources": {"type": "array", "items": {"type": "string"}},
    "workspace_id": {"type": "string", "minLength": 1},
    "workspace_revision": {"type": ["integer", "string"]},
    "source_commit": {"type": "string", "minLength": 1},
    "tool_version": {"type": "string", "minLength": 1},
    "simulator_version": {"type": ["string", "null"]},
    "status": {
      "enum": [
        "PROVED", "BOUNDED_PASS", "COUNTEREXAMPLE", "FALSIFIED",
        "NOT_FALSIFIED", "INCONSISTENT_ASSUMPTIONS", "SPECIFICATION_REVIEW_REQUIRED",
        "NOT_VERIFIED", "UNKNOWN", "ERROR", "NOT_RUN"
      ]
    },
    "scope": {"type": "string", "minLength": 1},
    "assumptions": {"type": "array", "items": {"type": "string"}},
    "limitations": {"type": "array", "items": {"type": "string"}},
    "command": {"type": "string", "minLength": 1},
    "exit_code": {"type": ["integer", "null"]},
    "elapsed_ms": {"type": ["number", "null"], "minimum": 0},
    "counterexample": {"type": ["object", "null"]},
    "seed": {"type": ["integer", "null"]},
    "sample_counts": {
      "type": "object",
      "additionalProperties": {"type": "integer", "minimum": 0}
    },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["path", "sha256"],
        "properties": {
          "path": {"type": "string"},
          "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"}
        },
        "additionalProperties": false
      }
    }
  }
}
````

### `wazir-formal-assurance-skills/scripts/validate_skills.py`

<!-- FILE: wazir-formal-assurance-skills/scripts/validate_skills.py -->
````python
"""No-dependency static validation for four portable Wazir skill documents."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "z3": "P0", "dafny": "P1", "scenic": "P0", "verifai": "P0"
}


def main():
    for name, priority in EXPECTED.items():
        path = ROOT / "skills" / name / "SKILL.md"
        content = path.read_text(encoding="utf-8")
        assert content.startswith("---\n"), f"{path}: missing frontmatter"
        frontmatter, body = content.split("---\n", 2)[1:]
        fields = {}
        for line in frontmatter.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                fields[key.strip()] = value.strip()
        for key in ("name", "description", "priority", "version"):
            assert fields.get(key), f"{path}: missing {key}"
        assert fields["priority"] == priority, f"{path}: incorrect priority"
        assert "## " in body, f"{path}: no sections"
        assert "## References" in body, f"{path}: missing sources"
        for reference in ("examples", "workflow", "evidence"):
            assert reference in body.lower(), f"{path}: missing {reference}"
        print(f"OK {name} ({priority})")
    schema = json.loads((ROOT / "evidence.schema.json").read_text())
    assert schema["title"] == "Wazir Formal Assurance Result"
    print("OK evidence.schema.json")


if __name__ == "__main__":
    main()
````

### `wazir-formal-assurance-skills/skills/dafny/SKILL.md`

<!-- FILE: wazir-formal-assurance-skills/skills/dafny/SKILL.md -->
````markdown
---
name: wazir-dafny-program-verification
description: Use Dafny to implement and verify precise functional contracts, invariants, preconditions, postconditions, and termination claims for selected generated algorithms. Invoke for safety-critical decision functions and code whose behavior must be connected to approved requirements.
version: 1.0.0
priority: P1
---

# Dafny Program Verification

## Purpose and activation

Use this skill to produce or validate **contract-based proofs about Dafny program declarations**. It is appropriate for finite decision policies, state updates, parser invariants, authorization logic, and selected algorithmic kernels. It does not establish correctness of an unrelated TypeScript/C++/Python implementation merely because an equivalent-looking Dafny function verifies.

**Typical request:** "Implement the red-signal decision kernel with a verified postcondition: when a stop is legally required and feasible, `stop` is true."

## Inputs required

- Independently reviewed property and source, requirement ID, scope, jurisdiction and dated legal interpretation for road rules.
- Explicit preconditions, desired postconditions, frame conditions, invariants, and termination obligations.
- Interface mapping to production code, compiler target, source revision, dependencies, and approved assumptions.
- Dafny version, timeout, backend options, and workspace path.

Never strengthen preconditions simply to make an otherwise failing verification pass without an approved requirement change. Record use of `assume`, `{:axiom}`, `{:extern}`, opaque definitions, or trusted modules as assurance gaps requiring review.

## Autonomous workflow

1. **Investigate.** Find the current component, its interface, and the approved rule. Identify which small deterministic core can realistically be implemented/verified in Dafny.
2. **Specify.** Express `requires`, `ensures`, invariants, decreases clauses, and, where relevant, state transition/frame properties. Keep the specification stable independently of implementation repair.
3. **Implement.** Build the smallest readable verified kernel. Prefer proven libraries and direct logic over large proof scaffolding.
4. **Verify.** Run `dafny verify FILE.dfy` and capture exact output and toolchain version. Inspect all warnings, trusted assumptions, excluded files, and unsupported features; run `dafny audit` if supported by the installed version.
5. **Bridge to production.** Either compile the **verified Dafny source** to an allowed target with documented toolchain assumptions, or establish a separately checked refinement link to production code. Test integration, interfaces, and boundary conversions. Generated code cannot silently diverge from the proof source.
6. **Repair and reverify.** On counterexample, assertion failure, or timeout, fix code or strengthen legitimate loop invariants; do not weaken the property or add unreviewed axioms.
7. **Deliver.** Archive source, source commit, proof commands, solver/Dafny versions, verification logs, trusted base, and independent review notes bound to the current Wazir workspace revision.

Perform permitted edits, build, test, and verify autonomously. Respect existing workspace permissions and release approval gates. Do not allow a model's self-attestation to substitute for `dafny verify` evidence.

## Example: narrow decision contract

See [examples/stop_command.dfy](examples/stop_command.dfy). The input `mustStop` is an **already legally resolved** stop obligation and `stopFeasible` is an externally validated feasibility judgment. This example intentionally does not attempt to determine law or physical feasibility.

```bash
dafny --version
dafny verify skills/dafny/examples/stop_command.dfy
```

A successful proof establishes only the stated Dafny contracts (under any documented assumptions). It does not prove that the planner, sensors, simulator, or entire AV behaves safely.

## Verification and release criteria

- The selected declarations verify on the version-pinned toolchain.
- All trusted assumptions and interface mappings are documented; no unnoticed `assume` or axioms.
- The exact verified source revision matches the deliverable, and implementation/tests reference the same revision.
- Each property has a requirement trace and a documented coverage boundary.
- If the production implementation is not the verified Dafny artifact or independently proven refinement, classify the integration claim as `NOT_VERIFIED`.
- `UNKNOWN`, timeout, compiler or solver failure block the proof gate.

## Common failure modes

- Proving a function with an overly narrow precondition (vacuous safety claim).
- Hiding a broken implementation behind an `assume` or uninterpreted external function.
- Not proving loop invariants, termination, or callers' preconditions.
- Treating verification of a Dafny reference model as proof of a hand-translated C++/TS module.
- Confusing the legal `mustStop` interpretation with the mechanically verified decision function.

## References

- [Dafny language and verifier](https://dafny.org/)
- [Dafny reference manual](https://dafny.org/latest/DafnyRef/DafnyRef.html)
- [Dafny GitHub](https://github.com/dafny-lang/dafny)
````

### `wazir-formal-assurance-skills/skills/dafny/examples/stop_command.dfy`

<!-- FILE: wazir-formal-assurance-skills/skills/dafny/examples/stop_command.dfy -->
````dafny
// Illustrative contract, not a complete road-rule or AV safety model.
method SelectStopCommand(mustStop: bool, stopFeasible: bool) returns (stop: bool)
  ensures mustStop && stopFeasible ==> stop
  ensures !mustStop ==> !stop
{
  stop := mustStop && stopFeasible;
}

method ContractCaller()
{
  var result := SelectStopCommand(true, true);
  assert result;
}
````

### `wazir-formal-assurance-skills/skills/scenic/SKILL.md`

<!-- FILE: wazir-formal-assurance-skills/skills/scenic/SKILL.md -->
````markdown
---
name: wazir-scenic-scenario-generation
description: Use Scenic to define constrained, reproducible geometric and dynamic scenario families for autonomous vehicles or robots. Invoke for intersection interactions, road-user variation, sensor occlusion, obstacle placement, and simulator scenario creation.
version: 1.0.0
priority: P0
---

# Scenic Scenario Generation

## Purpose and activation

Use this skill when Wazir needs **structured families of test situations**, not isolated hand-written simulation cases. Scenic is a probabilistic scenario language: its sampled scenes and simulation traces provide test inputs, **not formal proof that all possible scenarios satisfy a rule**.

**Typical request:** "Generate diverse red-signal intersection approaches varying speed, road-user position, visibility, and reaction time within a specified operating domain."

## Inputs required

- Scenario-family ID, road-rule/property ID, normative reference, reviewed assumptions, operating design domain (ODD), and scenario coverage goals.
- Map/road geometry, coordinate frame, units, actor models, parameter domains, required legal exceptions, and forbidden or mandatory initial-state conditions.
- Chosen Scenic version, simulator adapter, simulation time horizon, seeded sampling budget, and reproducibility requirements.

Do not infer statutory obligations from synthetic scenes. Associate each scenario with separately reviewed formal properties and monitor definitions.

## Autonomous workflow

1. **Investigate.** Identify a minimal scenario matrix derived from the property and ODD: nominal cases, boundaries, near-violations, uncertainty, and adversarial-but-physically-plausible cases.
2. **Model.** Choose `scenic.domains.driving` or a simulator-specific model only where supported. Define actors, geometry, probabilistic ranges, `require` constraints, and optional dynamic behaviors/temporal records. Prefer native Scenic constructs over bespoke scene generators.
3. **Check satisfiability empirically.** Generate samples. Report rejection counts and generation time. An inability to sample may indicate inconsistent constraints; do not silently relax hard requirements.
4. **Sample reproducibly.** Pin Scenic and adapter versions, map assets, seeds, scenario files, parameters, and sampling budgets. Save canonical scene serializations when supported.
5. **Execute where applicable.** Bind to approved simulator, record actual trajectory/state, and run independent property monitors. Track scenarios that fail due to simulator defects separately from behavioral failures.
6. **Prioritize coverage gaps.** Enumerate legal exception cases, ODD boundaries, rare conditions, and combinations omitted by the sampling distribution; hand difficult regions to VerifAI for falsification.
7. **Verify and package.** Keep source, seeds, scenes, simulation traces, code revision, and statistical results bound to the current Wazir workspace revision.

Work autonomously within current policy limits. Do not claim proof based on N passing simulations, and do not run untrusted simulator plugins outside the approved sandbox.

## Headless starter example

[examples/approach_scene.scenic](examples/approach_scene.scenic) describes a *toy* static two-actor approach, not a map-aware intersection or physically accurate driving model. [examples/sample_scenes.py](examples/sample_scenes.py) uses Scenic's documented Python API to sample without opening a GUI.

```bash
python -m pip install scenic
python skills/scenic/examples/sample_scenes.py \
  skills/scenic/examples/approach_scene.scenic --count 5 --seed 42
```

For simulator-backed dynamics, use a compatible Scenic simulator model and verify the adapter with a small pinned scenario before attempting bulk sampling. `scenic --simulate` requires a scenario backed by a supported simulator.

## Coverage and evidence requirements

Emit `scenario_id`, requirement/property IDs, Scenic and simulator versions, asset checksums, seed and sampling distribution, ODD, number attempted/generated/rejected, per-scene state, monitor verdict, replay pointer, and failure details. Use `NOT_FALSIFIED` only for actual monitored executions and **never** translate it to `PROVED`.

Acceptance: the scenario compiles and generates within the configured budget; sampled scenes satisfy *scenario constraints*; replay is supported or limitations are clearly stated; invalid and rejected samples are counted; runs target the exact tested code revision.

## Failure modes

- Sampling an irrelevant subset of the ODD and claiming general coverage.
- Automatically excluding dangerous scenes through an over-constrained `require` clause.
- Unrecorded random seeds or changing map/simulator versions.
- Mismatched coordinate frames, world models, or Scenic 2/3 syntax.
- Treating a scene's syntactic constraints as traffic-law compliance of the tested vehicle.

## References

- [Scenic](https://scenic-lang.org/)
- [Current Scenic documentation](https://docs.scenic-lang.org/en/latest/)
- [Scenic CLI](https://docs.scenic-lang.org/en/latest/options.html)
- [Scenic Python API](https://docs.scenic-lang.org/en/latest/api.html)
````

### `wazir-formal-assurance-skills/skills/scenic/examples/approach_scene.scenic`

<!-- FILE: wazir-formal-assurance-skills/skills/scenic/examples/approach_scene.scenic -->
````python
# Toy 2D static scenario, not a map or traffic-law interpretation.
ego = new Object at (0, 0), with width 2, with length 4
lead = new Object at (Range(12, 40), Range(-1, 1)), with width 2, with length 4
require (distance from ego to lead) > 8
````

### `wazir-formal-assurance-skills/skills/scenic/examples/sample_scenes.py`

<!-- FILE: wazir-formal-assurance-skills/skills/scenic/examples/sample_scenes.py -->
````python
"""Sample Scenic scenes headlessly with reproducible Python/NumPy seeds."""
import argparse
import json
import random
import scenic


def main():
    p = argparse.ArgumentParser()
    p.add_argument("path")
    p.add_argument("--count", type=int, default=5)
    p.add_argument("--seed", type=int, default=42)
    opts = p.parse_args()
    if opts.count < 1 or opts.count > 1000:
        p.error("count must be 1..1000")
    random.seed(opts.seed)
    try:
        import numpy as np
        np.random.seed(opts.seed)
    except ImportError:
        pass
    scenario = scenic.scenarioFromFile(opts.path, mode2D=True)
    for i in range(opts.count):
        scene, iterations = scenario.generate()
        print(json.dumps({
            "scene_index": i,
            "seed": opts.seed,
            "rejection_iterations": iterations,
            "objects": [str(obj.position) for obj in scene.objects],
        }))


if __name__ == "__main__":
    main()
````

### `wazir-formal-assurance-skills/skills/verifai/SKILL.md`

<!-- FILE: wazir-formal-assurance-skills/skills/verifai/SKILL.md -->
````markdown
---
name: wazir-verifai-falsification
description: Use VerifAI with defined input spaces, simulator bridges, and property monitors to search for counterexamples to desired autonomous-system behavior. Invoke for robustness-guided scenario exploration, temporal-specification falsification, and regression counterexample campaigns.
version: 1.0.0
priority: P0
---

# VerifAI Property Falsification

## Purpose and activation

Use this skill to **find executions that violate a specified property**, particularly when system behavior depends on environment uncertainty, learned perception, and simulation. Unlike exhaustive formal model checking, VerifAI's sampling and falsification workflows do not prove correctness when they fail to find a counterexample.

**Typical request:** "Find intersection scenarios that cause the tested planner to cross the stop line while a reviewed stop obligation is in force."

## Inputs required

- Independently reviewed property, monitor semantics and threshold; requirement/source/jurisdiction if traffic law is implicated.
- Search space, variable units and ranges, available Scenic scenario or feature-space model, simulator bridge and execution command.
- Objective direction, robustness metric semantics, search method, iteration/time budget, stopping criteria and deterministic seed(s).
- Tested system's version, binaries/configuration, ODD, simulator version and resource constraints.

Separate a negative robustness score (a violated specification) from a good outcome. Document tolerance and boundary conventions. Monitor failures, missing sensor signals, and simulator crashes are not passing tests.

## Autonomous workflow

1. **Investigate.** Locate an approved property and a reproducible simulator/test target. Determine whether the monitor can actually observe a violation.
2. **Define space.** Model actor behavior, velocity, visibility, road geometry, policy inputs, and constraint domains via Scenic or VerifAI feature APIs. Specify legal exemptions independently.
3. **Implement the monitor.** Encode the rule as a custom `specification_monitor` or appropriate temporal logic expression. Unit-test it on known passing and failing traces **before** starting the expensive search.
4. **Select sampling.** Begin with a reproducible random/Halton baseline, then consider cross-entropy, simulated annealing, or other VerifAI samplers appropriate to the monitor and API version.
5. **Run.** Launch `generic_falsifier` or `mtl_falsifier` with an approved simulator bridge, bounded budget, and saved error table. For dynamic Scenic scenarios, use VerifAI's `ScenicServer` where supported by the pinned stack.
6. **Minimize and replay.** Capture every violating seed, input assignment, simulator trace, monitor value, and target binary revision. Re-run witnesses independently; minimize parameters without losing the violation.
7. **Repair and regress.** Send reproducible counterexamples to Wazir's implementation agent. Re-run the same witnesses and an independent holdout campaign on the revised program; do not alter the approved monitor to manufacture a pass.
8. **Deliver.** Report discovered violations, explored coverage, search budget, untested regions, tool/runtime failures, and replay/evidence links tied to the current source revision.

Autonomously investigate, execute, reproduce and verify within authorized tool and workspace bounds. Never treat search exhaustion as formal proof.

## Reference integration pattern

See [examples/falsify_with_scenic.py](examples/falsify_with_scenic.py), adapted from VerifAI's documented `ScenicSampler` + `ScenicServer` + `specification_monitor` workflow. This is an **integration template**; run it only after verifying Scenic/VerifAI API compatibility and installed simulator dependencies. Do not assume it is portable across unpinned versions.

```bash
python -m pip install verifai
# Validate API compatibility in your isolated environment:
python -c 'import verifai, scenic; print("imports ok")'
# Only after binding to the selected tested-system/simulator combination:
python skills/verifai/examples/falsify_with_scenic.py
```

Use a dedicated sandbox or virtual environment and dependency lock file. Keep optional simulator services out of release startup paths.

## Verdicts and evidence

- `FALSIFIED`: a reproducible simulation trace violates the property, with concrete witness and monitored output.
- `NOT_FALSIFIED`: completed campaign found no violation **within searched budget and distribution**. Not a proof.
- `UNKNOWN`: monitoring unavailable, incomplete campaign, solver/search uncertainty, or unsupported result.
- `ERROR`: tool, simulator, bridge, or trace-processing failure. Fail closed.

Capture coverage profile, search strategy, sampler hyperparameters, random seeds, sample counts, robustness distribution, all error-table entries, replay results, simulator/model versions, and hashes of source and configuration. Store findings in Wazir's existing evidence ledger. Any code mutation invalidates prior proof/compliance claims about the current revision, but preserve historical counterexamples as regression tests.

## Failure modes

- No actual integration to the tested vehicle controller, only a simulator model.
- Incorrect monitor polarity (treating a violation as a pass).
- A monitor reading the desired command instead of the vehicle's actual motion.
- Misreported coverage from one sampler, or data leakage from tuning on the same scenarios used for acceptance.
- Python/Scenic/VerifAI version skew; long-running socket-based falsifiers with no attached simulator.

## References

- [VerifAI repository](https://github.com/BerkeleyLearnVerify/VerifAI)
- [VerifAI documentation](https://verifai.readthedocs.io/)
- [VerifAI basic usage](https://verifai.readthedocs.io/en/latest/basic_usage.html)
- [Scenic external samplers](https://docs.scenic-lang.org/en/latest/modules/scenic.core.external_params.html)
````

### `wazir-formal-assurance-skills/skills/verifai/examples/falsify_with_scenic.py`

<!-- FILE: wazir-formal-assurance-skills/skills/verifai/examples/falsify_with_scenic.py -->
````python
"""VerifAI integration template adapted from upstream basic-usage documentation.

Version-sensitive: first test on the selected VerifAI + Scenic + simulator stack.
This example tests a toy separation property, not a traffic-law requirement.
"""
from dotmap import DotMap
from verifai.falsifier import generic_falsifier
from verifai.monitor import specification_monitor
from verifai.samplers import ScenicSampler
from verifai.scenic_server import ScenicServer

SCENIC_CODE = """\
model scenic.simulators.newtonian.model
ego = new Object with velocity (0, Range(5, 15))
other = new Object at (5, 0), with velocity (-10, 10)
terminate after 2 seconds
record final (distance to other) as dist
"""


class SeparationMonitor(specification_monitor):
    def __init__(self):
        def property_holds(simulation):
            return simulation.result.records["dist"] > 1
        super().__init__(property_holds)


def main():
    sampler = ScenicSampler.fromScenicCode(SCENIC_CODE)
    falsifier = generic_falsifier(
        sampler=sampler,
        monitor=SeparationMonitor(),
        falsifier_params=DotMap(n_iters=5, save_error_table=True),
        server_class=ScenicServer,
    )
    falsifier.run_falsifier()
    # Export error table, traces and configuration through the selected version's
    # documented API before drawing any conclusion from this experimental run.


if __name__ == "__main__":
    main()
````

### `wazir-formal-assurance-skills/skills/z3/SKILL.md`

<!-- FILE: wazir-formal-assurance-skills/skills/z3/SKILL.md -->
````markdown
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
python -m pip install z3-solver
python skills/z3/examples/check_stopping_rule.py --candidate buggy
# Expected: COUNTEREXAMPLE, nonzero exit (if Z3 is installed)
python skills/z3/examples/check_stopping_rule.py --candidate guarded
# Expected: BOUNDED_PASS, exit 0 (if Z3 is installed)
```

Always differentiate:

- `sat` on the **negated property**: `COUNTEREXAMPLE`.
- `unsat` on the **negated property**: `PROVED` for the fully encoded quantified or symbolic domain, otherwise `BOUNDED_PASS` when bounds/abstractions limit the claim.
- `unknown`, timeout, parser error, solver crash: `UNKNOWN` or `ERROR`, fail closed.

Do not use the absence of counterexamples in one subset of the state space to infer universal real-world safety.

## Evidence and acceptance

Write evidence conforming to `../../evidence.schema.json` (package-level schema). Mandatory fields include property ID, independent specification revision, source commit, workspace revision, solver version, full model/assumptions, elapsed time, verdict, witness or unsat outcome, and artifact hashes.

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
````

### `wazir-formal-assurance-skills/skills/z3/examples/check_stopping_rule.py`

<!-- FILE: wazir-formal-assurance-skills/skills/z3/examples/check_stopping_rule.py -->
````python
"""Demonstrate symbolic counterexample search; not an AV safety assurance."""
import argparse
import json
import sys

from z3 import And, BoolVal, Not, Real, RealVal, Solver, sat, unsat


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", choices=("buggy", "guarded"), required=True)
    args = parser.parse_args()

    speed = Real("speed_m_per_s")
    distance = Real("distance_to_stopline_m")
    reaction = RealVal("1")
    deceleration = RealVal("4")
    margin = RealVal("2")
    stopping_distance = speed * reaction + speed * speed / (2 * deceleration)
    red = BoolVal(True)  # This demonstration considers red-signal states only.

    solver = Solver()
    solver.set(timeout=5000)
    solver.add(speed >= 0, speed <= 30, distance >= 0, distance <= 200)
    # A stop is feasible under this simplified physical model.
    can_stop = distance >= stopping_distance + margin
    solver.add(can_stop)
    if args.candidate == "buggy":
        proceed = speed < 4  # Deliberately incorrect policy.
    else:
        proceed = Not(red)  # Simplified corrected red-signal guard.
    # Find A and implementation and NOT P (P = cannot proceed when red and can stop).
    solver.add(And(red, proceed))

    outcome = solver.check()
    result = {
        "candidate": args.candidate,
        "property": "red_and_can_stop_implies_not_proceed",
        "scope": "0 <= speed <= 30 m/s; 0 <= distance <= 200 m; toy dynamics",
        "solver_result": str(outcome),
    }
    if outcome == sat:
        m = solver.model()
        result.update(status="COUNTEREXAMPLE", witness={
            "speed_m_per_s": str(m.eval(speed, model_completion=True)),
            "distance_to_stopline_m": str(m.eval(distance, model_completion=True)),
        })
        print(json.dumps(result, indent=2))
        return 2
    if outcome == unsat:
        result["status"] = "BOUNDED_PASS"
        print(json.dumps(result, indent=2))
        return 0
    result.update(status="UNKNOWN", reason=solver.reason_unknown())
    print(json.dumps(result, indent=2))
    return 3


if __name__ == "__main__":
    sys.exit(main())
````

---

## Bundle: `gam/`

### `gam/SKILL.md`

<!-- FILE: gam/SKILL.md -->
````markdown
---
name: gam
description: Model, check, and explain legal/policy compliance with GAM (Governance Analysis Model). Use when writing or reviewing GAL-JSON law or enterprise models, running the consistency/ontology/scenario checkers, interpreting violations, emitting Alloy (.als) from GAL-JSON, or changing the engine in src/core. Covers the Φ formalism, polarity split, closure semantics, edge-direction conventions, and the pitfalls that silently produce wrong verdicts.
---

# GAM — Governance Analysis Model

GAM decides whether an **enterprise configuration** (Φ_E) is consistent with a **law or written policy** (Φ_L). Both are expressed in GAL-JSON over one shared vocabulary, merged into a single model, and checked over the **closure** of their relations — never over the declared relations alone.

It implements W. A. Hassan, *Validating Legal Compliance — Governance Analysis Method* (Ph.D., Ottawa, 2009), with the formal corrections in `docs/CORRECTIONS.md`. Formerly named *Regentic*; the deployed UI and README still say *GAT* in places — same project.

## The three ideas you must not get wrong

1. **One vocabulary.** Law and enterprise facts land in the *same* relations. Origin (`law` / `enterprise` / `both`) is kept only for provenance in reports. Never namespace identifiers by origin (`law:CPO` vs `enterprise:CPO`) — two formulas over disjoint variables are always jointly satisfiable, so no cross-model conflict can ever be found. This was the 1.x defect.
2. **Polarity.** Every policy relation has a permitted (+) and prohibited (−) part: `RA±, RU±, UP±, RP±, D±`. `Deny` is a fact, distinct from silence.
3. **Closure.** Conflicts are computed over *effective* access — role inheritance (`RR*`), process composition (`PP*`), and delegation. The interesting conflicts exist only there.

The canonical example (thesis Ch.7 Ex.2, `test/thesis-cases.test.js`): the law forbids `PrivDiv` from `AccessPI`; the enterprise grants it to `FinAdminAssistants`; one user acts in both roles. No role holds both permit and deny, so a per-relation diff finds nothing. `Con` fails with `ACTIVITY_CONFLICT` for `AdminAssistant1`.

## Formalism

```
Φ = ⟨P, A, R, U ; PP, PA, RR, S, X, RA±, RU±, UP±, RP±, D±⟩
```

| Symbol | Meaning | GAL-JSON |
|---|---|---|
| P, A, R, U | sorts: Process (trust zone), Activity (capability), Role (identity), User (principal) | `entities[].type` |
| PP | process composition, parent → child | `ComposedOf` |
| PA | process contains activity | `Contains` |
| RR | role inclusion, senior → junior (senior inherits junior) | `Includes` |
| S | activity succession | `Next` |
| X | separation of concerns, symmetric | `Separate` |
| RA± | role may / must not perform activity | `AssignedTo` (+) or policy `CanAssignTo` |
| RU± | user may / must not act in role | `Acts` (+) or policy `CanAct` |
| UP± | user may / must not enter process | `Assumes` (+) or policy `CanAssume` |
| RP± | role may / must not reach process | `Reaches` (+) or policy `CanReach` |
| D± | role may / must not delegate (activity, process, or ⊤) | policy `CanDelegate` |

`Con` is the conjunction of five checks (mirrors `pred Con` in `alloy/gam_core.als`):

| # | Condition | Violation type |
|---|---|---|
| 1 | RA* ∩ RA⁻ = ∅ | `ACTIVITY_CONFLICT` |
| 2 | RU⁺ ∩ RU⁻ = ∅ | `ROLE_OCCUPANCY_CONFLICT` |
| 3 | UP* ∩ UP⁻ = ∅ | `PROCESS_ACCESS_CONFLICT` |
| 4 | no user effectively reaches both sides of an X pair | `SEPARATION_VIOLATION` |
| 5 | no D⁺/D⁻ clash; delegation doesn't confer a prohibited activity | `DELEGATION_CONFLICT`, `DELEGATION_LAUNDERS_PROHIBITION` |

A user's effective activities `effAct(u)` = activities of every role in the downward closure of the roles they act in, plus activities delegated to those roles, plus activities inside every process they reach (via `Assumes`, `Reaches`, or delegation) at any composition depth.

## Three techniques — not interchangeable

| Technique | Module | Finds | Cannot find |
|---|---|---|---|
| Consistency `Con` | `src/core/consistency-checker.js` | permit/deny conflicts, separation breaches, unsound delegation | missing structure |
| Ontology check | `src/core/ontology-checker.js` | required activity/sub-role/sub-process absent at any depth (`ONTOLOGY_GAP`) | contradictions |
| Scenario check | `src/core/ontology-checker.js` | required or forbidden precedence over `Next⁺` (`SCENARIO_VIOLATION`) | structural gaps |

**Consistency is necessary, not sufficient, for compliance.** An absent safety step contradicts nothing — `Con` holds and only the ontology check reports it (Appendix B finding B2, thesis Ex.1b). Never claim "compliant" from a passing `Con` alone. Scope stance: consistency is validated; completeness is defined but not validated.

## Edge directions — the most common source of wrong models

Relations and policies do **not** use the same argument order. `src/core/model.js` `_ingest` is authoritative.

**Relations** (`relations[]`, all positive facts):

| type | source → target |
|---|---|
| `ComposedOf` | parent Process → child Process |
| `Contains` | Process → Activity |
| `Includes` | senior Role → junior Role |
| `Next` | Activity → following Activity |
| `Separate` | Process ↔ Process (order irrelevant) |
| `Acts` | **Role → User** |
| `Assumes` | User → Process |
| `AssignedTo` | Role → Activity |
| `Reaches` | Role → Process |

**Policies** (`policies[]`, carry polarity in `modality` or `allow_deny`: `"Allow"` | `"Deny"`):

| type | source | target | extra |
|---|---|---|---|
| `CanAssignTo` | **Activity** | **Role** | — |
| `CanAct` | **User** | **Role** | — |
| `CanAssume` | User | Process | — |
| `CanReach` | Role | Process | — |
| `CanDelegate` | from Role | to Role | `parameters.activity_or_process` (omit = unrestricted ⊤) |

So "role `PrivDiv` must not access PI" is
`{ "type": "CanAssignTo", "modality": "Deny", "source": "AccessPI", "target": "PrivDiv" }`
while "role `FinAdmin` may access PI" as a relation is
`{ "type": "AssignedTo", "source": "FinAdmin", "target": "AccessPI" }`.

## Minimal model

```js
import { ConsistencyChecker } from './src/core/consistency-checker.js';
import { OntologyChecker } from './src/core/ontology-checker.js';

const law = {                                    // Φ_L
  entities: [{ id: 'AccessPI', type: 'Activity' }, { id: 'PrivDiv', type: 'Role' }],
  policies: [{ type: 'CanAssignTo', modality: 'Deny', source: 'AccessPI', target: 'PrivDiv' }],
  ontologyRequirements: [                        // structural duties, read by OntologyChecker only
    { id: '4.1.2', process: 'Privacy', activity: 'ProvideCPOIdentity', rationale: '…' },
  ],
  scenarioRequirements: [                        // kind: 'precedence' | 'forbidden-precedence'
    { id: 'S1', kind: 'precedence', from: 'Collect', to: 'Notify', rationale: '…' },
  ],
};

const enterprise = {                             // Φ_E
  entities: [/* … */],
  relations: [
    { type: 'Includes',   source: 'FinDiv', target: 'FinAdmin' },
    { type: 'AssignedTo', source: 'FinAdmin', target: 'AccessPI' },
    { type: 'Acts',       source: 'PrivDiv',  target: 'Alice' },
    { type: 'Acts',       source: 'FinAdmin', target: 'Alice' },
  ],
  policies: [],
};

const r = new ConsistencyChecker().check(law, enterprise);
// r.consistent, r.violations[], r.minimalConflict (MUS labels), r.stats, r.model (GamModel)
const o = new OntologyChecker().check(law, enterprise);
// o.satisfied, o.violations[]
```

Each consistency violation carries a **witness**: `user`, the object (`activity` / `process` / `process1`+`process2` / `role`), and derivation paths (`grantedVia`, `prohibitedVia`, `reachedVia`) with provenance. When reporting a finding, cite the path, not just the verdict.

Ontology requirement shapes: `{process, activity}`, `{parentRole, childRole}`, `{parentProcess, childProcess}`.

For the full enum lists (entity/relation/policy types, Hohfeldian modalities, check types) and the larger worked case study, read `references/gal-json.md`.

## Pitfalls that silently give the wrong answer

- **A user is only analysed if they `Acts` in at least one role.** `GamModel.users` is drawn from RU⁺. A principal with only `Assumes` edges is never checked. Give every principal a role.
- **Reversed policy arguments.** `CanAssignTo` is Activity→Role and `CanAct` is User→Role — the opposite of `AssignedTo`/`Acts`. A reversed edge doesn't error; it just never matches.
- **Use engine sort names** `Process | Activity | Role | User` for anything the checker or Alloy emitter must see. `schema.js` also lists richer types (`DepartmentRole`, `DataObject`, `Vehicle`, …) for the extraction pipeline; the emitter infers sorts from relations when the entity type isn't one of the four, but be explicit.
- **`CanReach` and `Reaches` exist in `model.js` but not in `schema.js`'s `PolicyTypes`/`RelationTypes` lists.** `validateModel` will reject `CanReach`; the checker accepts it. Don't "fix" a model by removing them.
- **Unknown relation types are ignored by the checker**, not rejected. Run `validateModel` (`src/core/schema.js`) when you need errors.
- **Hierarchies must be acyclic** (`ComposedOf`, `Includes`). Alloy's `WellFormed` fact forbids cycles; a cyclic GAL-JSON model will be vacuous in Alloy.
- **`ENGINE_DISAGREEMENT` is a bug, not a finding.** The SAT layer (`sat-solver.js`, DPLL + deletion-based MUS) is a cross-check over the same propositions. If it disagrees with closure analysis, fix the engine.
- **Trace operators aren't propositional.** `Activity-Trace` / `Activity-Process-Trace` need transitive closure; they live in the closure engine and in Alloy (`^next`), never in the SAT encoding.
- **Defeasibility order is LexSuperior → LexSpecialis → LexPosterior → ValuePreference → JurisdictionalPrimacy** (`DEFAULT_RESOLUTION_ORDER`, overridable via `context.resolutionOrder`). A specific lower norm must not defeat a higher one.
- **Factual corrections to keep.** MI 52-111 was never adopted (CSA Notice 52-313, 2006) — illustration only. SOX §404 mandates ICFR assessment, not segregation of duties (SOD is a COSO practice applied under §404). "Privacy Act" ≠ PIPEDA. PHIPA, not PHIPPA.

## Alloy

`alloy/gam_core.als` is the metamodel: sorts, ± fields, closures (`act`, `proc`, `effAct`, …), `pred Con`. Chapter models (`ch07_*`, `ch08*`, `appendixB_*`) open it. `ch08a/b` are reconstructions (thesis pp. 226–234 missing).

```js
import { emitAlloy, containsAssertion, traceAssertion } from './src/core/alloy-emitter.js';
const als = emitAlloy(law, enterprise, {
  moduleName: 'my_case', scope: 30,
  assertions: [
    containsAssertion('SafetyStepPresent', 'EvalHarness', 'SafetyClassification'),
    { name: 'NoEgress', expr: 'PublicNetworkEgress not in effAct[EvalAgent]', comment: '…' },
  ],
});
```

```bash
npm run alloy:emit    # Appendix B GAL-JSON → alloy/generated/*.als
npm run alloy:check   # fetch Alloy 6.2.0, compile tools/RunAlloy.java, check every model (needs a JDK)
```

When you add a GAL-JSON case study with an Alloy twin, add a test asserting they agree (see `test/appendixB.test.js`).

## Natural-language pipeline

`readLawToGAM(text, jurisdiction, options)` (`src/functions/read-law.js`) runs:
1. `phase1-extractor.js` — keyword pattern extraction; `detectPolarity` and `splitClauses` so `shall not disclose` ≠ `shall disclose`.
2. `phase2-translator.js` — patterns → GAL operators (`GALOperators`, `PolicyOperators`).
3. `phase3-validator.js` — generates `validation_checks`.

`readPolicyToGAM` does the same for enterprise text. The extractor is heuristic: **treat its output as a draft and review every polarity and edge direction** before running checks. For anything that matters, hand-write GAL-JSON.

`validateCompliance(law, enterprise)` (`src/functions/validate-compliance.js`) produces one report with sections `consistency`, `ontology`, `scenario`, `potestative`, `defeasibility`, `completeness`. Its ontology section is an entity-coverage audit over `validation_checks`, **not** `OntologyChecker` — `ontologyRequirements` are only enforced by `OntologyChecker` (and by `/api/models/validate`, which runs it). Also: `generateComplianceMatrix`, `compareJurisdictions`, `deprecateRule`.

## HTTP API (`server.js`, port 3001)

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/health` | — | status |
| `GET /api/libraries/laws` / `/policies` | — | built-in libraries (incl. Appendix B configs) |
| `POST /api/models/validate` | `{lawModel, enterpriseModel}` | consistency + ontology results, explanations |
| `POST /api/models/alloy` | `{lawModel, enterpriseModel, moduleName}` | `{alloyCode}` |
| `POST /api/models/explain` | `{violation}` | plain-language explanation |
| `POST /api/models/matrix` | `{enterpriseModel, selectedLaws[]}` | cross-jurisdiction matrix |

## Repository map

```
alloy/            gam_core.als + verified chapter/case models; generated/ from emitter
src/core/         model.js (closures) · consistency-checker · ontology-checker · sat-solver
                  defeasibility · alloy-emitter · schema (GAL-JSON enums/validators) · ontology
src/pipeline/     phase1 extract → phase2 translate → phase3 validate
src/functions/    read-law · read-policy · validate-compliance · compliance-matrix · …
src/data/         legal-library · policy-library · agent-intrusion (Appendix B)
src/components/   React 19 + Vite UI
test/             vitest: thesis-cases · appendixB · engine · case-studies · api · lkrl-compliance
docs/             APPENDIX_B.md · CORRECTIONS.md · DEPLOYMENT.md
thesis/           revised dissertation chapters (markdown)
```

## Working on the engine

- `npm test` (vitest) must stay green; every engine defect fix gets a regression test named for the case it reproduces.
- Keep `model.js` closures and `gam_core.als` in lock-step. A change to one without the other is a bug.
- Detect conflicts only by derivation from closures. Never compare policy keys as strings, and never inject synthetic clauses to force UNSAT.
- Appendix B (`src/data/agent-intrusion.js`) is governance-layer only — zones, capabilities, identities. Keep it that way; don't add exploit detail.
````

### `gam/references/gal-json.md`

<!-- FILE: gam/references/gal-json.md -->
````markdown
# GAL-JSON reference

GAL-JSON (Governance Analysis Language) is the interchange format for Φ_L and Φ_E. Enumerations below are copied from `src/core/schema.js`; re-check that file if they look stale.

## Model shape

```jsonc
{
  "model_type": "Law_Model" | "Enterprise_Model",   // required by validateModel, ignored by the checker
  "context": "PIPEDA Schedule 1, Principle 4.1",
  "jurisdiction": { "country": "CA", "level": "Federal", "name": "Canada" },
  "effective_date": "2026-01-01",
  "domains": ["Privacy"],
  "entities":  [{ "id": "AccessPI", "type": "Activity", "name": "Access personal information" }],
  "relations": [{ "type": "Contains", "source": "Privacy", "target": "AccessPI", "parameters": {} }],
  "policies":  [{
    "type": "CanAssignTo", "allow_deny": "Deny",          // or "modality": "Deny"
    "deontic_status": "Prohibited", "hohfeldian_modality": "No-Right", "power_subtype": "None",
    "source": "AccessPI", "target": "PrivDiv",
    "parameters": { "activity_or_process": null, "legal_basis": "PIPEDA 4.1" }
  }],
  "validation_checks": [],                                 // generated by phase3
  "theory_construction": { "cases": [], "factors": [], "value_preferences": [], "rule_preferences": [] },

  // law-side only, read by OntologyChecker:
  "ontologyRequirements": [{ "id": "B2", "process": "EvalHarness", "activity": "SafetyClassification", "rationale": "…" }],
  "scenarioRequirements": [{ "id": "S1", "kind": "precedence", "from": "Collect", "to": "Notify", "rationale": "…" }]
}
```

The checker needs only `entities`, `relations`, `policies` (plus the two requirement arrays for the ontology checker). The other fields matter for `validateModel`, the UI, and the pipeline. Factories: `createModel`, `createEntity`, `createRelation`, `createPolicy`, `createCheck`; merge with `mergeModels`.

## Enumerations

- **EntityTypes**: User, Activity, Process, DepartmentRole, LegalEntity, DataObject, Vehicle, InfrastructureZone, LegalInstrument, Constraint, Value, Factor, Rule, Sanction. *(The checker's sorts are Process, Activity, Role, User — use `Role` for identities in checker-facing models.)*
- **RelationTypes**: Includes, Acts, AssignedTo, Contains, Next, Assumes, ComposedOf, Separate, Delegate, CountsAs, EquRole, EquActivity, EquProcess, ActsOn, HasConstraint, RequiresCondition, MustReport, AppliesIn, HasThreshold, Undercuts, Rebuts, Prefers, TriggersSanction, Obligation, Prohibition, Permission, Exception, Overrides, RiskProfile, MitigationControl, Provenance, Reaches. *Only the nine in SKILL.md's direction table affect `Con`.*
- **PolicyTypes**: CanAssignTo, CanAssume, CanAct, CanDelegate, CanAccess, CanCollect, CanUse, CanDisclose, CanRetain, CanTransfer, CanDelete, CanProcess. *The checker reads CanAct, CanAssignTo, CanAssume, CanReach, CanDelegate; the rest are pipeline/UI vocabulary.*
- **AllowDeny**: Allow, Deny
- **DeonticStatuses**: Obligatory, Permitted, Prohibited
- **HohfeldianModalities**: Duty, Claim-Right, Privilege, No-Right, Power, Liability, Immunity, Disability, None
- **PowerSubTypes**: Action-Power, Enabling-Power, Potestative-Right, Declarative-Power, None
- **ConflictResolutionPrinciples**: LexSpecialis, LexPosterior, LexSuperior, Value-Preference, JurisdictionalPrimacy
- **DefeatMechanisms**: Rebutting, Undercutting, Defeater
- **CheckTypes**: Process-Parent, Process-Activity, Dep-Parent, checkInstance, checkActs, checkDelegate, Activity-Predecessor, Activity-Trace, Activity-Process-Pred, Activity-Process-Trace, checkAssignedTo, checkAssumes, Check-Separation, Check-Object-Access, Check-Constraint, Check-Reporting, Check-Potestative, Check-Jurisdiction, Check-Threshold, Check-Defeat, Check-MultiJurisdiction, Group-Assert, Check-Obligation, Check-Prohibition, Check-Exception, Check-Mitigation
- **Quantifiers**: ALL, SOME, NONE · **Severities**: Critical, Major, Minor
- **ModelTypes**: Law_Model, Enterprise_Model
- **Countries**: CA, US, UK, DE, EU, CN, JP, SG, KR, AE, UNECE, OTHER
- **JurisdictionLevels**: Federal, State, Provincial, Municipal, Supranational, Emirate
- **Domains**: Privacy, Traffic, AV, Financial, All
- **RuleTypes**: Prescriptive, Constitutive, Technical, Teleological · **InferentialStrengths**: Strict, Defeasible

## Worked case: Appendix B (July 2026 agent intrusion)

Source: `src/data/agent-intrusion.js`, Alloy twins `alloy/appendixB_asbuilt.als` / `appendixB_remediated.als`, write-up `docs/APPENDIX_B.md`. It is the best template for modelling infrastructure as governance: **trust zones are Processes, capabilities are Activities, identities/service accounts are Roles, the agent is a User.**

Φ_L (containment policy) is small — three `Separate` pairs and four `Deny` policies, plus one ontology requirement:

```js
relations: [
  { type: 'Separate', source: 'EvalHarness', target: 'PublicInternet' },
  { type: 'Separate', source: 'K8sClusterA', target: 'K8sClusterB' },
  { type: 'Separate', source: 'CISubnet',    target: 'SourceControl' },
],
policies: [
  { type: 'CanAssignTo', modality: 'Deny', source: 'PublicNetworkEgress',  target: 'EvalAgentIdentity' },
  { type: 'CanAssignTo', modality: 'Deny', source: 'ReadInstanceMetadata', target: 'WorkerSA' },
  { type: 'CanAssignTo', modality: 'Deny', source: 'CreatePrivilegedPod',  target: 'WorkerSA' },
  { type: 'CanAssignTo', modality: 'Deny', source: 'ReadClusterSecrets',   target: 'WorkerSA' },
],
ontologyRequirements: [{ id: 'B2', process: 'EvalHarness', activity: 'SafetyClassification' }],
```

Φ_E (as-built config) has no policies at all — only positive structure. Every finding is derived:

| ID | Type | How the closure produces it |
|---|---|---|
| B1 | ACTIVITY_CONFLICT | `EvalHarness ⊃ PackageProxy ⊃ PublicInternet ∋ PublicNetworkEgress`; the agent `Assumes EvalHarness` and acts as `EvalAgentIdentity`, which is denied egress |
| B1b | SEPARATION_VIOLATION | same composition puts the agent in both `EvalHarness` and `PublicInternet` |
| B2 | ONTOLOGY_GAP | `EvalHarness` contains no `SafetyClassification` at any depth — `Con` is silent |
| B3 | ACTIVITY_CONFLICT | `WorkerSA ⊃ CSIDriverRole ⊃ NodeRole`, and `NodeRole` is assigned `ReadInstanceMetadata` |
| B4 | ACTIVITY_CONFLICT | `CSIDriverRole` is assigned `CreatePrivilegedPod`, inherited by `WorkerSA` |
| B5 | SEPARATION_VIOLATION | `ConnectorIdentity` includes both `ClusterAdminA` and `ClusterAdminB`, which `Reaches` each cluster |
| B6 | SEPARATION_VIOLATION | `CIAutomationTag Reaches MeshNetwork`, which composes both `CISubnet` and `SourceControl` |

The remediated config removes the `PackageProxy → PublicInternet` edge, adds `SafetyClassification`, drops the `WorkerSA → CSIDriverRole` inclusion, drops `ClusterAdminB` from the connector, and narrows the CI tag to `CISubnet`. All seven checks pass. `expectedFindings` in the data file is the oracle the tests assert against.

### Modelling recipe

1. List zones, capabilities, identities, principals. Pick one sort for each; don't mix.
2. Write Φ_L as *prohibitions* (`Deny` policies, `Separate`) plus *structural duties* (`ontologyRequirements`, `scenarioRequirements`).
3. Write Φ_E as the configuration actually deployed — composition, containment, role inclusion, grants, who acts as what.
4. Make sure every principal `Acts` in some role.
5. Run both checkers. For each violation, report the witness path and the origin of each fact.
6. Model the fix as a second Φ_E and show the same checks pass — a finding without a remediated model that clears it is unfinished.
````
