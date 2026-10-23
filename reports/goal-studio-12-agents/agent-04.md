# Agent 04 Report — Independent Verification and Evidence (`feat/parallel-verification`)

## 1. Executive Summary

Workstream 04 implements **Independent Verification and Evidence** across `@wazir/goals` (`packages/goals/src/verification/**`), `@wazir/core` (`packages/core/src/services/{verificationEngine,verificationIntegrity,verificationOracles,verificationEvidenceInspector,evidencePolicy,provenanceManager}.ts`), and the Goal Studio API route surface (`apps/api/src/goalStudio/verificationRoutes.ts`).

Every design decision enforces the constitutional invariant from `nobel_goal_graph.yaml` and `packages/goals/src/contracts.ts`:
> *Never equate LLM claims, submitted documents, or hoped-for external adoption with verified outcomes. Only `completed` unlocks dependents, and `completed` requires an `AcceptanceGateDecision` of `completed` whose criteria all have `PASS` evidence produced by an independent validator.*

---

## 2. Owned Files Touched

### `@wazir/goals` — Verification & Acceptance Gate
- [`packages/goals/src/verification/index.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/goals/src/verification/index.ts) — Barrel exporting `createVerificationService`, `evaluateGate`, digest helpers, check runners, and verification types.
- [`packages/goals/src/verification/types.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/goals/src/verification/types.ts) — Types for `VerificationServiceDeps`, `GoalVerificationService`, `DeclaredCheck`, `CheckRunner`, `AdversarialReviewer`, `WorkspaceState`, `GateInput`, and `SignoffInput`.
- [`packages/goals/src/verification/digest.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/goals/src/verification/digest.ts) — Workspace-confined path normalization (`normalizeArtifactPath`, `resolveInside`), real-byte SHA-256 artifact and directory digesting (`digestArtifact`), and content-addressed workspace revision (`workspaceRevisionOf`, `snapshotArtifacts`).
- [`packages/goals/src/verification/checks.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/goals/src/verification/checks.ts) — Sandboxed command execution via `@wazir/tools` (`createSandboxedCheckRunner`), timeout clamping, output sanitization (`sanitizeUntrustedOutput`), deterministic JSON-schema subset validator (`validateSchema`), and declared check runner (`runDeclaredCheck`).
- [`packages/goals/src/verification/gate.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/goals/src/verification/gate.ts) — Pure deterministic acceptance gate (`evaluateGate`, `referenceState`, `isSelfReport`, `isFresh`, `resolveCriterion`).
- [`packages/goals/src/verification/service.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/goals/src/verification/service.ts) — `createVerificationService(deps)` implementing `verify`, `gate`, `evidence`, `snapshot`, `gateCurrent`, and `recordSignoff` with append-only persistence under `GOAL_STORE_KEYS.evidence(runId, evidenceId)`.

### `@wazir/core` — Core Verification Hardening
- [`packages/core/src/services/verificationEngine.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/core/src/services/verificationEngine.ts) — Raw `Buffer` hashing on physical mutations (fixes UTF-8 replacement-char masking on binary files) and future-revision evidence rejection.
- [`packages/core/src/services/evidencePolicy.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/core/src/services/evidencePolicy.ts) — Rejects self-reported evidence (`validatorIdentity === executorIdentity` or `SELF_REPORT` method) in `evidencePassed`.
- [`packages/core/src/services/verificationEvidenceInspector.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/core/src/services/verificationEvidenceInspector.ts) — Marks any evidence not matching `currentWorkspaceRevision` (`!==`) as `STALE`.
- [`packages/core/src/services/verificationOracles.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/core/src/services/verificationOracles.ts) — Confines `AcceptanceOracle` paths inside `workspaceDir` (`realpath` check) and returns `UNKNOWN` (never `PASS`) on empty, malformed, or unsupported criteria.
- [`packages/core/src/services/provenanceManager.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/core/src/services/provenanceManager.ts) — SHA-256 normalizes content hashes when generating deterministic artifact IDs so `sha256:`-prefixed digests never collide.

### API Route Surface
- [`apps/api/src/goalStudio/verificationRoutes.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/apps/api/src/goalStudio/verificationRoutes.ts) — Mounts Goal Studio verification routes under `/api/v1/goal-studio`:
  - `GET /api/v1/goal-studio/runs/:runId/evidence` (`requireViewerOrOperator`)
  - `GET /api/v1/goal-studio/runs/:runId/targets/:targetId/evidence` (`requireViewerOrOperator`)
  - `POST /api/v1/goal-studio/runs/:runId/targets/:targetId/verify` (`requireOperator`)
  - `POST /api/v1/goal-studio/runs/:runId/targets/:targetId/external-evidence` (`requireOperator`)

### Tests
- [`packages/goals/tests/verification/verificationService.test.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/goals/tests/verification/verificationService.test.ts)
- [`packages/core/tests/verificationEngine.evidenceHardening.test.ts`](file:///Users/wael/Code/Wazir-gs/agent-04/packages/core/tests/verificationEngine.evidenceHardening.test.ts)

---

## 3. Factory Signature & Composition Contract (for Coordinator)

In `apps/api/src/goalStudio/services.ts`, wire the verification service using:

```ts
import { createVerificationService, type VerificationServiceDeps } from '@wazir/goals';

const verification = createVerificationService({
  store: deps.store,
  workspaceRoot: deps.workspaceRoot,
  clock: deps.clock,
  events: services.events,
  audit: (event) => services.governance.audit(event),
});
```

`createVerificationService(deps: VerificationServiceDeps)` accepts `GoalStudioDeps` (`{ store, clock?, workspaceRoot }`) plus optional `checks`, `reviewer`, `plan`, `validatorIdentity`, `events`, `audit`, `gateOptions`, and `limits`.

---

## 4. Verification & Gate Semantics

1. **Artifact Byte Binding (`verify`)**:
   - Normalizes each declared path in `target.artifacts`, rejects absolute paths, `..` traversal, and symlink escapes outside `workspaceRoot`.
   - Computes `sha256:<64-hex>` over exact file bytes (or sorted directory manifests) and rejects missing or 0-byte files / empty directories with `verdict: 'FAIL'`.
   - Re-snapshots artifacts after running declared checks; if a check mutated any verified artifact during verification, records a `FAIL` checksum record.
2. **Independence Enforcement (`validatorIdentity !== executorIdentity`)**:
   - In `verify()`, if `validatorIdentity === executorIdentity` (or a reviewer's identity matches the executor), any `PASS` is downgraded to `UNKNOWN` with an explicit limitation (`validator identity equals executor identity; self-verification is not evidence`).
   - In `gate()`, `isSelfReport()` rejects any `PASS` record whose `validatorIdentity === executorIdentity`, matches any executor seen on the attempt, or uses a self-report method (`self-report`, `model-claim`, `executor-claim`).
   - In `recordSignoff()`, throws `GoalStudioFailure('FORBIDDEN', ...)` if the signing principal matches the attempt's `executorIdentity`.
3. **Stale Evidence Rejection (`gate`)**:
   - Filters evidence strictly to `(run.runId, target.id, attempt.id, run.graphRevision)` and rejects attempts superseded by `run.targets[target.id].lastAttemptId`.
   - Verifies that every `EvidenceRecord` matches the reference `workspaceRevision` and exact `sha256:` artifact digests (`isFresh`).
4. **Gate Precedence (`evaluateGate`)**:
   - Any failed/cancelled attempt, missing/empty/invalid-digest artifact, or fresh `FAIL` evidence $\rightarrow$ `decision: 'repair'`.
   - Missing or stale verification state $\rightarrow$ `decision: 'repair'`.
   - `target.externalDependency === true` without an independent `external-record` or `human-signoff` `PASS` $\rightarrow$ `decision: 'awaiting_external'`.
   - `target.requiresApproval === true` (or zero acceptance criteria) without `human-signoff` `PASS` $\rightarrow$ `decision: 'needs_approval'`.
   - Any acceptance criterion with `UNKNOWN` or `NOT_RUN` verdict $\rightarrow$ `decision: 'repair'`.
   - All acceptance criteria `PASS` with independent evidence and valid `sha256:` digests $\rightarrow$ `decision: 'completed'`.

---

## 5. Verification Evidence

### Build Check
- **Command**: `npx tsc --build`
- **Working Directory**: `/Users/wael/Code/Wazir-gs/agent-04`
- **Exit Code**: `0`

### Unit & Adversarial Test Suites
- **Command**: `npx vitest run packages/goals/tests/verification packages/core/tests/verificationEngine.evidenceHardening.test.ts`
- **Working Directory**: `/Users/wael/Code/Wazir-gs/agent-04`
- **Exit Code**: `0`
- **Summary**: 2 test files passed, 18 tests passed (9 in `packages/goals/tests/verification/verificationService.test.ts`, 9 in `packages/core/tests/verificationEngine.evidenceHardening.test.ts`).

---

## 6. Integration Notes

- No changes to `packages/goals/src/contracts.ts` were required.
- `packages/goals/src/verification/checks.ts` dynamically imports `@wazir/tools` (`runShell`) at runtime when executing shell commands so `@wazir/goals` does not require editing `packages/goals/package.json`. When the coordinator updates `packages/goals/package.json`, adding `"@wazir/tools": "*"` to `dependencies` is optional and compatible.
