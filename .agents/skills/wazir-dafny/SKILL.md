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
# Run from this skill's directory (e.g. skills/formal/dafny/ or .Codex/skills/wazir-dafny/).
dafny --version
dafny verify examples/stop_command.dfy
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
