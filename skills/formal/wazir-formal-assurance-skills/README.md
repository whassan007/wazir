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
