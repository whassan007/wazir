# Formal Hardening Report: Subagent A6 (Verification Evidence & Revision Truthfulness)

## Executive Summary

- **Subagent ID**: Subagent A6 (Verification Evidence & Revision Truthfulness)
- **Campaign**: Wazir 12-Agent Formal Hardening Campaign
- **Working Tree**: `/Users/wael/Code/Wazir/.worktrees/fh-a6-verification`
- **Git HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Alloy 6 Analyzer JAR**: `/Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar` (Alloy 6.2 CLI, SAT4J solver)
- **Status**: **5 CONFIRMED DEFECTS IDENTIFIED (2 P0, 3 P1), FORMALLY MODELED IN ALLOY 6, REPRODUCED IN DETERMINISTIC VITEST SUITE, AND RESOLVED WITH SURGICAL PRODUCTION FIXES**
- **Test Evidence**:
  - Regression Suite (`packages/core/tests/a6-verification-hardening.test.ts`): Pre-fix 5/5 failed $\to$ Post-fix 5/5 passed.
  - Verification & Core Suite: 75/75 passed across all verification, evidence, and integrity test suites.

---

## 1. Subsystem Scope & Codebase Mapping

Subagent A6 investigated the authoritative verification pipeline that decides whether a workspace revision satisfies requirements for task completion:

1. **`packages/core/src/services/verificationEngine.ts`**:
   - Physical mutation tracking (`trackPhysicalMutation`) advancing workspace revisions $R \to R+1$.
   - Anti-test-theater and oracle weakening detection (`detectOracleWeakening`).
   - Oracle execution against physical workspace (`runOracle`).
   - Evidence registration and history tracking (`recordEvidence`, `getActiveVerificationSet`).
   - Authoritative completion verification (`verifyCompletion`).
2. **`packages/core/src/services/verificationEvidenceInspector.ts`**:
   - Controller-only read projection (`inspectVerificationEvidence`).
   - Completion eligibility gate (`assessCompletionEvidence`).
   - Evidence slot aggregation per oracle (`buildSlot`).
   - Diagnostic and explainability generation (`explainCompletion`).
3. **`packages/core/src/services/evidencePolicy.ts`**:
   - Authoritative receipt ordering and deduplication (`latestEvidenceAtRevision`).
   - Pass/fail predicate evaluation (`evidencePassed`, `oracleSatisfied`).
4. **`packages/core/src/services/verificationIntegrity.ts`**:
   - Verification asset recognition (`isVerificationAsset`, `isExpectedOutput`).
   - Test theater and weakening detection (`detectOracleWeakening`).
5. **`packages/core/src/services/verificationOracles.ts`**:
   - Concrete oracle implementations (`BuildOracle`, `TestOracle`, `StaticOracle`, `AcceptanceOracle`, `BrowserOracle`).

---

## 2. Formal Hardening Methodology & Alloy 6 Models

### Invariants Modeled

1. **`NoStaleCompletion`**:
   $$\forall \text{rev} \in \text{CompletedRevisions}, \forall o \in \text{RequiredOracles} : \exists e \in \text{Evidence}(\text{rev}, o) \land e.\text{outcome} = \text{Pass}$$
   Completion at workspace revision $R$ strictly requires passing evidence bound to revision $R$.
2. **`NoPostMutationFalseSuccess`**:
   $$\forall R, R' : (R \to R' \in \text{Mutations} \land R \in \text{Completed}) \implies R' \notin \text{Completed}$$
   A physical mutation advances the workspace revision and immediately invalidates completion until $R'$ is freshly and independently verified.
3. **`NoRaceEvidencePollution`**:
   $$\forall o \in \text{Oracle}, \forall R, R' : (\text{startedAt}(o) = R \land \text{completedAt}(o) = R' \land R \neq R') \implies \text{evidence}(R', o) \neq \text{Pass}$$
   An oracle whose physical execution spanned a concurrent workspace mutation cannot record a valid `PASS` for the new revision $R'$.
4. **`NoUnrepairedFailureCompletion`**:
   $$\forall R, o : (\text{latest}(R, o) = \text{Fail}) \implies R \notin \text{Completed}$$
   A failed check at the current revision blocks completion unless explicitly repaired by a subsequent passing execution of the same check identity at that revision.

### Alloy 6 Specification Model

Saved to [`docs/formal-hardening/models/a6-verification.als`](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/a6-verification.als).

```alloy
// Alloy 6 Temporal Model: Verification Evidence & Revision Truthfulness (Agent A6)
abstract sig Revision { nextRev: lone Revision }
one sig R0, R1, R2 extends Revision {}
fact LinearRevisionOrder { R0.nextRev = R1 and R1.nextRev = R2 and no R2.nextRev }

abstract sig Oracle {}
one sig BuildOracle, TestOracle extends Oracle {}

abstract sig Outcome {}
one sig Pass, Fail extends Outcome {}

one sig Controller {
  var currentRev: one Revision,
  var inFlightOracle: lone Oracle,
  var inFlightRev: lone Revision,
  var evidence: Revision -> Oracle -> Outcome,
  var isCompleted: lone Revision
}

pred init {
  Controller.currentRev = R0
  no Controller.inFlightOracle
  no Controller.inFlightRev
  no Controller.evidence
  no Controller.isCompleted
}

pred mutateWorkspace {
  some Controller.currentRev.nextRev
  Controller.currentRev' = Controller.currentRev.nextRev
  Controller.inFlightOracle' = Controller.inFlightOracle
  Controller.inFlightRev' = Controller.inFlightRev
  Controller.evidence' = Controller.evidence
  no Controller.isCompleted'
}

pred startOracle [o: Oracle] {
  no Controller.inFlightOracle
  no Controller.isCompleted
  Controller.inFlightOracle' = o
  Controller.inFlightRev' = Controller.currentRev
  Controller.currentRev' = Controller.currentRev
  Controller.evidence' = Controller.evidence
  Controller.isCompleted' = Controller.isCompleted
}

pred completeOracle [res: Outcome] {
  some Controller.inFlightOracle
  let o = Controller.inFlightOracle, r = Controller.inFlightRev |
    Controller.evidence' = Controller.evidence + (r -> o -> res)
  no Controller.inFlightOracle'
  no Controller.inFlightRev'
  Controller.currentRev' = Controller.currentRev
  Controller.isCompleted' = Controller.isCompleted
}

pred completeTask {
  no Controller.isCompleted
  no Controller.inFlightOracle
  all o: BuildOracle + TestOracle | (Controller.currentRev -> o -> Pass) in Controller.evidence
  no o: BuildOracle + TestOracle | (Controller.currentRev -> o -> Fail) in Controller.evidence
  Controller.isCompleted' = Controller.currentRev
  Controller.currentRev' = Controller.currentRev
  Controller.inFlightOracle' = Controller.inFlightOracle
  Controller.inFlightRev' = Controller.inFlightRev
  Controller.evidence' = Controller.evidence
}

pred stutter {
  Controller.currentRev' = Controller.currentRev
  Controller.inFlightOracle' = Controller.inFlightOracle
  Controller.inFlightRev' = Controller.inFlightRev
  Controller.evidence' = Controller.evidence
  Controller.isCompleted' = Controller.isCompleted
}

fact traces {
  init
  always (
    mutateWorkspace or
    (some o: Oracle | startOracle[o]) or
    (some res: Outcome | completeOracle[res]) or
    completeTask or
    stutter
  )
}

assert NoStaleCompletion {
  always (some Controller.isCompleted implies
    (all o: BuildOracle + TestOracle | (Controller.isCompleted -> o -> Pass) in Controller.evidence))
}
assert NoPostMutationFalseSuccess {
  always ((some Controller.isCompleted and Controller.currentRev' != Controller.currentRev) implies no Controller.isCompleted')
}
assert NoRaceEvidencePollution {
  always ((some Controller.inFlightOracle and Controller.inFlightRev != Controller.currentRev)
    implies (not ((Controller.currentRev -> Controller.inFlightOracle -> Pass) in Controller.evidence')))
}
assert NoUnrepairedFailureCompletion {
  always (some Controller.isCompleted implies
    no o: BuildOracle + TestOracle | (Controller.isCompleted -> o -> Fail) in Controller.evidence)
}

run ReachCompletedR0 { eventually (Controller.isCompleted = R0) } for 10 steps
run ReachCompletedR1 { eventually (Controller.currentRev = R1 and Controller.isCompleted = R1) } for 10 steps
check NoStaleCompletion for 10 steps
check NoPostMutationFalseSuccess for 10 steps
check NoRaceEvidencePollution for 10 steps
check NoUnrepairedFailureCompletion for 10 steps
```

### Alloy 6 CLI Execution & Analysis

Executed via:
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a6-verification /Users/wael/Code/Wazir/docs/formal-hardening/models/a6-verification.als
```

**Results (`receipt.json`)**:
```
00. run   ReachCompletedR0                 SAT (instance found in 93ms)
01. run   ReachCompletedR1                 SAT (instance found in 46ms)
02. check NoStaleCompletion                UNSAT (no counterexample in scope 10 steps)
03. check NoPostMutationFalseSuccess       UNSAT (no counterexample in scope 10 steps)
04. check NoRaceEvidencePollution          UNSAT (no counterexample in scope 10 steps)
05. check NoUnrepairedFailureCompletion    UNSAT (no counterexample in scope 10 steps)
```

### Negative Control Mutant Analysis

Saved to [`docs/formal-hardening/models/a6-verification-mutant.als`](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/a6-verification-mutant.als).
In this mutant, `completeOracleBuggy` stamps evidence with `Controller.currentRev` instead of `Controller.inFlightRev`, modeling the race where a test dispatched before a mutation completes after the mutation and binds to the mutated revision.

Execution output:
```bash
00. run   WitnessRacedPollution            SAT (instance found in 46ms)
01. check NoRaceEvidencePollution          SAT (COUNTEREXAMPLE FOUND in 20ms)
```

**Minimal Counterexample Trace (`receipt.json`)**:
- State 0: Initial state ($R_0$, no oracle in-flight).
- State 1: `startOracle[BuildOracle]` dispatches at $R_0$.
- State 2: `mutateWorkspace` advances workspace $R_0 \to R_1$ while `BuildOracle` is running.
- State 3: `completeOracleBuggy[Pass]` stamps evidence `(R1, BuildOracle, Pass)`.
$\implies$ `NoRaceEvidencePollution` violated! Evidence bound to $R_1$ despite the build executing against $R_0$.

---

## 3. Confirmed Defects & Detailed Findings

### FH-A6-01 (P0): Future Revision Evidence Pre-seeding / Forgery

- **Subsystem**: `VerificationEngine.recordEvidence`
- **File**: `packages/core/src/services/verificationEngine.ts:200-205`
- **Severity**: **P0 (Loss of Integrity / Verification Bypass)**
- **Defect Description**:
  `recordEvidence` accepted any caller-supplied `workspaceRevision` without checking whether it was in the future (`params.workspaceRevision > this.currentRevision`). An agent, model tool, or adversarial script could pre-seed a passing evidence record for an unreached revision $R=5$ when the workspace was only at $R=0$. After physical mutations subsequently advanced the workspace to $R=5$, `verifyCompletion` found the pre-seeded evidence and declared completion verified without ever running oracles against the mutated files.
- **Fix**:
  Enforce `if (params.workspaceRevision !== undefined && params.workspaceRevision > this.currentRevision) throw new Error(...)` with code `FUTURE_REVISION_FORBIDDEN`.

### FH-A6-02 (P0): Concurrent Mutation Race during Oracle Verification

- **Subsystem**: `VerificationEngine.runOracle`
- **File**: `packages/core/src/services/verificationEngine.ts:161-179`
- **Severity**: **P0 (Race Condition / False PASS on Inconsistent State)**
- **Defect Description**:
  `runOracle` captured `workspaceRevision = this.currentRevision` and then `await oracle.verify(params)`. If a file mutation occurred while the child process or asynchronous test was running, `this.currentRevision` incremented. When `oracle.verify` finished with code 0, `runOracle` silently returned `status: 'PASS'`, binding compromised test results to the start revision and leaving the caller unaware that the filesystem mutated while tests were executing.
- **Fix**:
  Detect `this.currentRevision !== workspaceRevision` upon completion of `oracle.verify`. Mark `status = 'ERROR'`, set `exitCode = 1` if 0, and inject `WORKSPACE_MUTATED_DURING_VERIFICATION` into reasons.

### FH-A6-03 (P1): Failure on Current Revision Masked as Stale

- **Subsystem**: `VerificationEngine.verifyCompletion`
- **File**: `packages/core/src/services/verificationEngine.ts:331-348`
- **Severity**: **P1 (Diagnostic Inversion / False Telemetry)**
- **Defect Description**:
  When a test passed on revision $R_1$, the workspace mutated to $R_2$, and the test ran on $R_2$ and failed, `verifyCompletion` evaluated `if (earlierSuccess)` before checking `failedAtCurrent`. Because $R_1$ had a passing run in `staleEvidence`, it reported `TEST_EVIDENCE_STALE: TEST evidence is stale for revision 2 (latest successful run was revision 1)`. The actual test failure on $R_2$ was completely hidden from the user and controller.
- **Fix**:
  Check `failedAtCurrent` first. If an oracle ran and failed on the current revision, emit `${oracle}_FAILED` immediately.

### FH-A6-04 (P1): Unrepaired Failure on Current Revision with Empty / Default Requirements

- **Subsystem**: `VerificationEngine.verifyCompletion`
- **File**: `packages/core/src/services/verificationEngine.ts:318-354`
- **Severity**: **P1 (False Success / Unsound Completion)**
- **Defect Description**:
  If an oracle check failed on the current revision, but `verifyCompletion` was invoked with empty requirements (`{}` or `{ mutationRequired: true }`), the `for (const oracle of requiredOracles)` loop was skipped entirely. The engine proceeded to line 352 and returned `complete: true` with `VERIFICATION_COMPLETE`, completely ignoring the recorded failed check on the current revision.
- **Fix**:
  Query `latestEvidenceAtRevision(this.evidenceHistory, currentRev)` and check `!evidencePassed(e)`. Any check that remains failed at the current revision immediately forces `complete = false` and emits `${o}_FAILED`.

### FH-A6-05 (P1): Multi-command Oracle Failure in Evidence Slots and Explanations

- **Subsystem**: `verificationEvidenceInspector.buildSlot`
- **File**: `packages/core/src/services/verificationEvidenceInspector.ts:121-135`
- **Severity**: **P1 (Contradictory UI Telemetry / Explainability Corruption)**
- **Defect Description**:
  When multiple commands for an oracle executed on the current revision (e.g. `npm test -- unit` failing and `npm test -- e2e` passing), `buildSlot` took only `all[all.length - 1]` (the e2e test) and marked `slot.status = 'PASS'`. `assessCompletionEvidence` correctly recognized that the oracle was not satisfied, but `explainCompletion` reported `missing: ["TEST: PASS at R1 (exit 0)"]`—a contradictory statement telling the user that a passing check was missing.
- **Fix**:
  Evaluate all latest checks for the oracle at `currentRevision` via `latestEvidenceAtRevision` and `evidencePassed`. If any check failed at `currentRevision`, the slot is marked `FAIL` with the failing item's exit code, and `explainCompletion` outputs `TEST: FAIL at R1`.

---

## 4. Deterministic Vitest Reproduction Suite

Saved to [`packages/core/tests/a6-verification-hardening.test.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh-a6-verification/packages/core/tests/a6-verification-hardening.test.ts).

### Pre-Fix Failure Output

```
 FAIL  packages/core/tests/a6-verification-hardening.test.ts
   × Defect 1: rejects pre-seeding evidence for future workspace revisions
     AssertionError: expected [Function] to throw error matching /FUTURE_REVISION_FORBIDDEN/i but got undefined
   × Defect 2: test failure on current revision must be reported as FAILED, not masked as STALE
     AssertionError: expected false to be true (reasons contained TEST_EVIDENCE_STALE, missing TEST_FAILED)
   × Defect 3: detects workspace mutation racing during asynchronous oracle execution
     AssertionError: expected 'PASS' not to be 'PASS' (evidence.status was PASS despite workspace mutating during run)
   × Defect 4: unrepaired check failure on current revision blocks completion even with empty requirements
     AssertionError: expected true to be false (evalResult.complete was true despite failed BUILD check)
   × Defect 5: multi-command oracle failure is correctly reflected as FAIL in buildSlot and explainCompletion
     AssertionError: expected 'PASS' to be 'FAIL' (slot status was PASS, explainCompletion emitted "TEST: PASS at R1 in missing")

Test Files  1 failed (1)
Tests       5 failed (5)
```

### Post-Fix Success Output

```
 ✓ packages/core/tests/a6-verification-hardening.test.ts (5)
   ✓ Defect 1: rejects pre-seeding evidence for future workspace revisions
   ✓ Defect 2: test failure on current revision must be reported as FAILED, not masked as STALE
   ✓ Defect 3: detects workspace mutation racing during asynchronous oracle execution
   ✓ Defect 4: unrepaired check failure on current revision blocks completion even with empty requirements
   ✓ Defect 5: multi-command oracle failure is correctly reflected as FAIL in buildSlot and explainCompletion

Test Files  1 passed (1)
Tests       5 passed (5)
```

Full neighboring verification suites re-verified:
```bash
npx vitest run packages/core/tests/a6-verification-hardening.test.ts packages/core/tests/executionAccuracy.v1.test.ts packages/core/tests/executionBranching.test.ts packages/core/tests/verificationEngine.test.ts packages/core/tests/verificationEvidenceInspector.test.ts packages/core/tests/verificationIntegrity.test.ts
```
**Outcome: 6 test files passed, 75/75 tests passed.**

---

## 5. Scope Controls & Limitations

1. **Physical Mutation Source**: Detection of concurrent mutation races in `runOracle` relies on mutations being registered via `VerificationEngine.trackPhysicalMutation`. Unmonitored external filesystem edits (e.g. external processes modifying files without tool hooks) should be paired with pre/post execution directory hash fingerprinting.
2. **Oracle Identity**: Check deduplication and repair tracking in `latestEvidenceAtRevision` index by `[oracle, command, criterionId, target]`. Distinct sub-commands (e.g. `npm test -- unit` vs `npm test -- e2e`) are tracked as distinct check obligations.
3. **Branch & Worktree Boundary**: Fixes are scoped to `/Users/wael/Code/Wazir/.worktrees/fh-a6-verification` and documentation in `docs/formal-hardening/`. No production releases or main-branch pushes performed.

---

## 6. Deliverables & Artifact Index

| Artifact | Location |
|---|---|
| Alloy 6 Specification Model | [`docs/formal-hardening/models/a6-verification.als`](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/a6-verification.als) |
| Alloy 6 Negative Control Mutant | [`docs/formal-hardening/models/a6-verification-mutant.als`](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/a6-verification-mutant.als) |
| Alloy 6 Execution Results | [`docs/formal-hardening/results/a6-verification/receipt.json`](file:///Users/wael/Code/Wazir/docs/formal-hardening/results/a6-verification/receipt.json) |
| Alloy 6 Mutant Results | [`docs/formal-hardening/results/a6-verification-mutant/receipt.json`](file:///Users/wael/Code/Wazir/docs/formal-hardening/results/a6-verification-mutant/receipt.json) |
| Deterministic Reproduction Suite | [`packages/core/tests/a6-verification-hardening.test.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh-a6-verification/packages/core/tests/a6-verification-hardening.test.ts) |
| Hardened Production Files | [`packages/core/src/services/verificationEngine.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh-a6-verification/packages/core/src/services/verificationEngine.ts)<br>[`packages/core/src/services/verificationEvidenceInspector.ts`](file:///Users/wael/Code/Wazir/.worktrees/fh-a6-verification/packages/core/src/services/verificationEvidenceInspector.ts) |
| Issue Ledger CSV | [`docs/formal-hardening/reports/a6-ledger.csv`](file:///Users/wael/Code/Wazir/docs/formal-hardening/reports/a6-ledger.csv) |
| Complete Findings Report | [`docs/formal-hardening/reports/a6-verification.md`](file:///Users/wael/Code/Wazir/docs/formal-hardening/reports/a6-verification.md) |
