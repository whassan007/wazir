# Task: Add Wazir Formal Assurance (WFA) to Wazir

You are working in the Wazir repository (github.com/whassan007/wazir), checked out at `/Users/wael/Code/Wazir`. It is a TypeScript pnpm/npm workspace tested with Vitest: `apps/` (cli, api, worker, desktop, web, mobile, …) and `packages/` (core, scheduler, policies, agents, runtimes, registry, database, evaluation, tools, workers, …). The CLI binary is `wa`. Wazir is a local-first AI meta-harness and distributed control plane: task engine (DAG of tasks), policy engine, model router, hardware-aware scheduler, runtime adapters (Ollama, LM Studio), external agent adapters (e.g. OpenCode), an MCP client, isolated git worktrees per task, durable state with lease fencing, and the `wa` CLI. Treat this description as orientation only; the code is the source of truth.

Companion specs in this folder: `SKILLS_INSTALL.md` (how the skills in §1 are found and installed; run it first) and, if present, `ORCHESTRATION.md` (how the work is split across agents).

Today Wazir's pipeline is: requirement → generated code → tests → merge. Your job is to add a subsystem that makes it:

```
requirement → reviewed formal properties → generated implementation
           → formal verification + falsification → counterexample → repair → re-verify
           → evidence-backed release record
```

The single most important design rule: **formal specifications are first-class artifacts, independent of both the implementation agents and the tests those agents write. Agents may explore any implementation, but they can never change a requirement to make their implementation pass.**

---

## 0. Ground rules for you (the implementing agent)

- Investigate before you write code. Read the task engine, policy engine, scheduler, worktree manager, state store, lease fencing, and CLI. Write a short design note (`docs/formal-assurance/DESIGN.md`) mapping each WFA component below onto existing modules **before** implementing. Reuse existing mechanisms; don't build parallel ones.
- Follow the repo's existing language, layout, test framework, and style. Run solver tools as **subprocess adapters** in pinned, isolated environments (Python venv for z3/scenic/verifai, a pinned JAR for Alloy, a pinned Dafny binary), regardless of the host language.
- Never fabricate solver, prover, or simulator output. If a tool is missing or fails, the result is `NOT_RUN` or `ERROR` — never a pass. In your final report, separate **observed** results from **expected/unexecuted** ones.
- Never weaken an assertion, add an `assume`/axiom, narrow a precondition, relax a `require` clause, or turn a property into a fact to get a green result. If you think a spec is wrong, raise it as `SPECIFICATION_REVIEW_REQUIRED`.
- Keep the repo's test suite (`npm test` / Vitest) and typecheck green after every phase. Commit per phase. New code goes in a new workspace package (e.g. `packages/assurance`) unless DESIGN.md argues for another home.

## 1. Skills to install

These are installed by `SKILLS_INSTALL.md`; don't reinstall them here. Vendor these skill packages into the repo under `skills/formal/` and make them loadable by Wazir's agents (whatever skill/prompt-pack mechanism Wazir has; if none, add a minimal one that injects a skill's `SKILL.md` into a worker's context by task type):

| Skill | Path | Use |
|---|---|---|
| `alloy-formal-modeling` | `skills/formal/alloy/` | relational + temporal models, bounded checks, state machines, right-of-way logic |
| `wazir-z3-constraint-verification` | `skills/formal/z3/` | arithmetic/Boolean obligations, braking envelopes, bounded decisions |
| `wazir-dafny-program-verification` | `skills/formal/dafny/` | verified decision kernels, contracts, invariants, termination |
| `wazir-scenic-scenario-generation` | `skills/formal/scenic/` | reproducible scenario families |
| `wazir-verifai-falsification` | `skills/formal/verifai/` | counterexample search against monitors |
| `gam` | `skills/formal/gam/` | legal/policy compliance (GAL-JSON → `Con`, ontology, scenario checks, Alloy emission) |

If the `wazir-formal-assurance-skills` bundle includes `evidence.schema.json` and `examples/`, keep them and build on that schema rather than inventing a competing one. The Alloy Analyzer JAR (`org.alloytools.alloy.dist.jar`, 6.2.x) should be fetched by a setup script with a pinned version and checksum, not committed.

## 2. Components to build

### 2.1 Verdict model (build first)

One normalized enum used everywhere, with a documented mapping from each tool's native output:

| Verdict | Meaning | Native sources |
|---|---|---|
| `PROVED` | property holds over the full encoded symbolic domain | Z3 `unsat` on ¬P with no bounding; Dafny verified with empty trusted base |
| `BOUNDED_PASS` | no violation within stated scope/bounds | Alloy `check` with no counterexample in scope; Z3 `unsat` on bounded encoding |
| `COUNTEREXAMPLE` | concrete violating assignment/instance/trace | Z3 `sat` on ¬P; Alloy counterexample; Dafny failing assertion |
| `FALSIFIED` | reproducible simulated execution violates the monitor | VerifAI |
| `NOT_FALSIFIED` | search budget exhausted without violation — **not a proof** | VerifAI, Scenic runs |
| `INCONSISTENT_ASSUMPTIONS` | assumptions alone are UNSAT — any "pass" would be vacuous | vacuity probe |
| `SPECIFICATION_REVIEW_REQUIRED` | spec ambiguous or under-reviewed | spec registry |
| `UNKNOWN` | timeout, solver `unknown`, incomplete campaign | any |
| `ERROR` | parse/type error, crash, bridge failure | any |
| `NOT_RUN` | tool unavailable or not executed | any |
| `NOT_VERIFIED` | no refinement link between verified artifact and shipped code | refinement layer |

Hard rules, enforced in code and covered by tests:
- `NOT_FALSIFIED` can never be promoted to `PROVED` or `BOUNDED_PASS`.
- `UNKNOWN`, `ERROR`, `NOT_RUN` fail the release gate (fail closed).
- Every `PROVED`/`BOUNDED_PASS` requires a passing **vacuity probe** in the same run: Z3 — `A` alone and `A ∧ precondition` are SAT; Alloy — a nonempty `run` witness for the same facts is SAT; Dafny — callers can satisfy the `requires`; Scenic — rejection rate below a configured threshold. A failed probe downgrades the verdict to `INCONSISTENT_ASSUMPTIONS`.
- Aggregate per property and per component by **weakest link**; never average.

### 2.2 Specification registry

A versioned store (e.g. `specs/` at the repo root, or wherever the design note decides) holding one manifest per property:

```yaml
id: RED_SIGNAL_COMPLIANCE
version: 2.1
status: draft | reviewed | approved | retired
source: { normative_ref: "...", jurisdiction: configured, interpretation_date: ... }
assumptions: [signal_state_available, braking_limits_valid, ...]   # A
guarantee: "vehicle does not cross stop line while stop obligation active"  # P
artifacts:                        # formal encodings of the same property
  - { tool: alloy, file: red_signal.als, commands: [...] , scope: "for 5 but 8 steps" }
  - { tool: z3,    file: stopping_envelope.py }
  - { tool: dafny, file: stop_command.dfy }
monitors: [ { tool: verifai, file: red_signal_monitor.py } ]
reviewers: [ ... ]                # humans who approved this revision
content_hash: sha256:...
```

- Only `approved` specs can gate a release. Spec agents may create `draft` specs; promotion to `approved` requires an explicit human approval through Wazir's existing approval gate.
- **Write fencing:** implementation and repair workers get the spec directory read-only in their worktrees, and the policy engine rejects merges that touch `specs/` from any task whose role is not `spec-author`. A test must prove an implementation task's spec edit is rejected.
- Spec revisions are content-hashed; evidence binds to the hash.

### 2.3 Solver adapters

A common interface, e.g. `verify(obligation, workspace_rev) → Result{verdict, witness, tool, tool_version, scope, assumptions, elapsed, stdout/stderr refs, input hash}`. Implement in this order:

1. **Z3** (P0): run Z3Py scripts or SMT-LIB in the pinned venv. Always query `A ∧ impl ∧ ¬P` — test explicitly against SAT/UNSAT inversion.
2. **Alloy** (P1): drive `java -jar org.alloytools.alloy.dist.jar exec -t text -c '*' -o <dir> <file>`; parse result files and `receipt.json` per command. Exit code alone is not a verdict. Record scope, Int bitwidth, steps.
3. **Dafny** (P1): `dafny verify`; run `dafny audit` if available; record any `assume`, `{:axiom}`, `{:extern}`, opaque or trusted declarations as assurance gaps that block `PROVED`.
4. **Scenic** (P0, headless): sample with pinned seeds; report attempted/generated/rejected counts and serialized scenes.
5. **VerifAI** (P0, adapter + template only): wire `ScenicSampler`/`ScenicServer`/`specification_monitor`; unit-test monitors on known passing and failing traces before any campaign. Do not require a simulator for the test suite — gate simulator-backed runs behind a capability flag.
6. **GAM** (governance domain): call the GAM checkers (`ConsistencyChecker`, `OntologyChecker`) on GAL-JSON Φ_L/Φ_E and emit Alloy twins. Remember `Con` passing ≠ compliant — the ontology check must also run. Map `consistent && satisfied` → `BOUNDED_PASS`, any violation → `COUNTEREXAMPLE` with the witness path.

Each adapter: version-pinned, timeout and memory limits from config, runs in a sandbox, deterministic seeds recorded, and has fixture tests for each verdict it can produce (including `NOT_RUN` when the tool is absent).

### 2.4 Scheduler and feasibility integration

Verification obligations are ordinary task nodes in the job DAG, so the existing scheduler places them. Extend the feasibility set F(t) with tool capabilities: a host is feasible for an obligation only if it has the pinned tool (JDK + Alloy, Dafny, z3 venv, simulator). Heavy campaigns (VerifAI, large Alloy scopes) should prefer the DGX/GX10-class host; small Z3 checks can run anywhere. Solver tasks need no model — they bypass the model router.

### 2.5 Counterexample-guided repair loop

Extend Wazir's existing test–repair loop so acceptance is defined by the spec's obligations, not by agent-written tests:

1. Implementation task produces code in its worktree.
2. Obligation tasks run against that exact commit.
3. On `COUNTEREXAMPLE`/`FALSIFIED`: create a repair task carrying the witness (Z3 model, Alloy instance, Dafny failing assertion, or replayable seed + trace). The spec is frozen and visible read-only.
4. Each counterexample is saved permanently as a **regression obligation** for that property.
5. Repeat up to `k` attempts (configurable); after `k`, stop and report with all witnesses.
6. Any code change invalidates all prior evidence for the new revision; re-run every obligation, including regressions.
7. For VerifAI campaigns, re-check the final revision on a **holdout** seed set not used during repair.

### 2.6 Refinement / implementation mapping

A per-component file linking verified artifacts to shipped code:

```yaml
component: intersection_behavior_planner
mappings:
  - property: RED_SIGNAL_COMPLIANCE
    verified_artifact: specs/red_signal/stop_command.dfy
    production: compiled_from_dafny | refinement_proof | contract_tests | none
    production_path: src/planner/stop_command.*
```

Rules: if production code is compiled from the verified Dafny source (same revision, pinned compiler), implementation-level claim may be `PROVED`. If linked only by contract tests or a hand translation, the implementation-level claim is capped at `NOT_VERIFIED` for proof purposes (tests still recorded). Model-level and implementation-level verdicts are reported separately.

### 2.7 Evidence ledger and assurance records

- Append-only, hash-chained ledger (each entry includes the previous entry's hash). Writes go through the existing lease-fencing path so a stale worker can't append evidence for a superseded revision.
- Each entry: property id + spec hash, source commit, workspace revision, tool + version, full input hash, scope/bounds/steps, assumptions, verdict, witness or unsat outcome, elapsed time, seeds, artifact hashes.
- `wa assure verify-ledger` recomputes the chain and fails on tampering (test this).
- Generate a machine-readable assurance record per component (validate against `evidence.schema.json` if present):

```yaml
component: intersection_behavior_planner
version: <semver>
source_commit: <sha>
properties:
  RED_SIGNAL_COMPLIANCE:
    spec_version: 2.1 (sha256:...)
    specification_consistency: BOUNDED_PASS   # Alloy, scope ...
    decision_envelope: PROVED                  # Z3
    implementation_contract: PROVED            # Dafny, compiled_from_dafny
    simulation_falsification: NOT_FALSIFIED    # VerifAI, N samples, seeds ...
    runtime_monitor: ENABLED | NOT_DEPLOYED
assumptions: [...]
trusted_base: [...]
coverage_limits: [...]
counterexamples_found: <n>, regression_obligations: <n>
release_gate: PASS | FAIL (<reason>)
```

The record must state what is **not** claimed (e.g. perception correctness, physical dynamics fidelity, real-world safety).

### 2.8 CLI

Under the existing `wa` CLI (`apps/cli`):
- `assure spec add|list|show|approve` (approve requires a human)
- `assure run <component> [--property ID] [--tools ...]`
- `assure record <component>` → prints/writes the assurance record
- `assure verify-ledger`
- `assure doctor` → reports which tools are installed, versions, and which verdicts are therefore achievable on this host

## 3. Demonstration (required end-to-end test)

Build a small, discrete red-signal / intersection right-of-way example, clearly labeled as a toy (not a certified braking or traffic-law model):

1. An approved spec `RED_SIGNAL_COMPLIANCE` with: an Alloy 6 temporal state machine (approach → at-line → stopped/crossed, with `var` state, frame conditions, a `stutter` action, a nonempty `run` witness, and a `check` that the vehicle never crosses while the obligation is active); a Z3 stopping-envelope obligation (`v·t_react + v²/(2·decel)` with margin); a Dafny decision kernel where `mustStop && stopFeasible ⇒ stop`.
2. Have Wazir's implementation agent generate the controller, seeded with a known bug (or start from the skill's `buggy` candidate).
3. Show the pipeline finds a `COUNTEREXAMPLE`, files a repair task with the witness, the repair agent fixes the controller **without touching the spec**, and all obligations re-run to pass on the new commit.
4. Include a **negative-control mutant**: relax one guard and confirm the check fails again.
5. Produce the ledger entries and the assurance record for the final commit.
6. Add an integration test that runs steps 2–5 with whatever tools are present and asserts the correct verdicts (or `NOT_RUN` when tools are missing — never a silent pass).

Optional second demo showing domain-independence: run the GAM Appendix B governance case (as-built vs remediated) through the same ledger and record format.

## 4. Non-goals

- Do not automate legal interpretation. Spec agents may draft; humans approve.
- Do not claim any real-world vehicle or system is safe.
- Do not add exploit detail to governance/security case studies.
- Do not build a new solver, simulator, or scenario language.

## 5. Phases and acceptance

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | `DESIGN.md` mapping WFA onto existing modules | reviewed by Waël before Phase 1 code lands (unless an orchestration prompt sets a different review mode) |
| 1 | verdict enum, spec registry, write fencing, ledger | fencing and ledger-tamper tests pass; promotion rules tested |
| 2 | Z3 + Alloy adapters, vacuity probes | fixture tests for every verdict incl. SAT/UNSAT inversion and `NOT_RUN` |
| 3 | Dafny adapter, refinement map | trusted-base detection blocks `PROVED`; `NOT_VERIFIED` capping tested |
| 4 | repair loop + regression obligations | counterexample → repair → re-verify works on the demo |
| 5 | Scenic + VerifAI adapters (headless), GAM adapter | monitor unit tests on pass/fail traces; `NOT_FALSIFIED` never promoted |
| 6 | CLI, assurance record, end-to-end demo | demo test passes; record validates against schema |

## 6. Final report format

For each phase, report:

```
Changed files: ...
Tests: <command> → <observed result>
Tools present: <name version> / missing: ...
Demo verdicts (observed): RUN ...: SAT | CHECK ...: COUNTEREXAMPLE → BOUNDED_PASS ...
Unexecuted (expected only): ...
Assumptions / trusted base: ...
Known gaps and next steps: ...
```
