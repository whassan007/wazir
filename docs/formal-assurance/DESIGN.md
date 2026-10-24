# Wazir Formal Assurance — Design Note (`DESIGN.md`)

> **Author**: Agent 08 (`fa/08-design-doc`)
> **Inputs**: [`FORMAL_ASSURANCE.md`](./FORMAL_ASSURANCE.md) (build spec), [`REPO_MAP.md`](./REPO_MAP.md) (repo cartography), [`packages/assurance/src/contracts.ts`](../../packages/assurance/src/contracts.ts) (C0 contracts) and [`verdict.ts`](../../packages/assurance/src/verdict.ts).
> **Status**: Phase 0 deliverable. Maps every WFA component onto an existing Wazir mechanism or onto `@wazir/assurance`. Line references follow `REPO_MAP.md`; the code is the source of truth.

**Governing rule.** Formal specifications are first-class artifacts, independent of implementation agents and of the tests those agents write. Agents may change any implementation; they may never change a requirement to make it pass. Every mechanism below exists to enforce that rule or to keep evidence honest (fail closed, no fabricated results, no averaging).

---

## Section 1 — Architecture, Package Home, Verdicts, Spec Registry, Write Fencing

### 1.1 Architecture overview and pipeline

```
requirement ─► reviewed formal properties ─► generated implementation
            ─► formal verification + falsification ─► counterexample ─► repair ─► re-verify
            ─► evidence-backed release record
```

Each arrow maps to an existing Wazir mechanism. WFA adds no second orchestrator.

| Pipeline stage | Wazir mechanism reused | WFA addition |
|---|---|---|
| requirement → formal properties | `TaskPlanner` emits a `spec-author` task; humans approve through the existing approval path (`approvalQueue` / `resolveAsk`, `supervisor` nodes) | `SpecRegistry` (`specs/<ID>/manifest.yaml` + encodings), content hashing, promotion rules |
| → generated implementation | Normal `coding` task in an isolated worktree (`WorktreeManager`), `CodingAgent` turn loop | Spec dir mounted read-only; policy write-fence on `specs/` |
| → verification + falsification | Obligation tasks are ordinary `JobNode`s in the DAG, placed by `Scheduler`, run by `ExecutionEngine` | `SolverAdapter`s (z3, alloy, dafny, scenic, verifai, gam), vacuity probes, verdict normalization |
| → counterexample → repair | `JobOrchestrator` `TaskReplanner` hook + `JobManager.addTasksToJob(..., { replacesTaskId })` | `AssuranceReplanner` builds a repair task carrying the witness; regression obligations |
| → re-verify | `EvidencePolicy` binds evidence to `workspaceRevision`; stale evidence is rejected | Every obligation (incl. regressions) re-runs on the new commit |
| → release record | `VerifiedIntegrationCoordinator` merge qualification | Hash-chained `EvidenceLedger`, `AssuranceRecord`, weakest-link `evaluateReleaseGate` |

Data flow for one component:

```
specs/<ID>/manifest.yaml (approved, sha256)      refinement/<component>.yaml
            │                                                │
            ▼                                                ▼
  ObligationPlanner ──► JobNode(type:'task', taskType:'verification', tool:z3|alloy|…)
            │                     │  Scheduler.plan (F(t) ∩ toolCapabilities)
            │                     ▼
            │            SolverAdapter.verify(obligation, workspaceRev) → VerificationResult
            │                     │  vacuity probe · trusted-base gaps · NOT_FALSIFIED guard
            │                     ▼
            │            EvidenceLedger.append(entry, fencingToken)   (hash chain)
            │                     │
            ├── COUNTEREXAMPLE/FALSIFIED ─► AssuranceReplanner ─► repair task (witness, spec RO)
            │                                  └─► regression obligation persisted
            ▼
  RecordBuilder ─► AssuranceRecord (weakest link, capped by refinement) ─► release gate PASS|FAIL
```

### 1.2 Package home: `packages/assurance` (`@wazir/assurance`)

**Decision**: all self-contained WFA logic lives in a new workspace package `packages/assurance`, published as `@wazir/assurance`. Existing packages receive only thin, additive integration hooks.

Rationale:
1. **Dependency direction.** `@wazir/core` owns domain types, the DAG, the policy engine and the scheduler; `@wazir/policies` and `@wazir/scheduler` are facades over it (REPO_MAP §1.1, §1.3). WFA depends on core; core must not depend on WFA. Hooks in core are expressed as generic extension points (role, capability, replanner, evidence kind) that `@wazir/assurance` fills.
2. **Isolation of trust-critical code.** Verdict mapping, the release gate and the ledger form the trusted computing base of the assurance claim. Keeping them in one small package with no model/runtime dependencies makes them auditable and testable in isolation (Vitest, no solver required for the unit suite).
3. **Subprocess boundary.** Solvers run as subprocess adapters in pinned environments (Python venv for z3/scenic/verifai, pinned Alloy 6.2.x JAR + JDK, pinned Dafny binary, GAM engine). That process orchestration code belongs beside the adapters, not in core.
4. **Workspace fit.** The package matches `packages/*` in `pnpm-workspace.yaml`. It is added to the root `tsconfig.json` project references after `packages/policies` and before `apps/cli`, and it is picked up by the root `vitest.config.ts` with no change.

Proposed layout (C0 already landed `contracts.ts`, `verdict.ts`, `index.ts`):

```
packages/assurance/src/
  contracts.ts        # C0: Verdict, Obligation, VerificationResult, SolverAdapter, SpecManifest,
                      #     RefinementMap, LedgerEntry, AssuranceRecord, ReleaseGateResult
  verdict.ts          # C0: native→verdict mapping, vacuity downgrade, trusted-base gaps,
                      #     NOT_VERIFIED capping, weakest-link aggregation, release gate
  registry/           # SpecRegistry: load/validate manifests, content hash, promotion
  fencing/            # spec write-fence rule + role helpers registered into PolicyEngine
  adapters/           # z3.ts alloy.ts dafny.ts scenic.ts verifai.ts gam.ts + probes/
  toolchain/          # pinned-env discovery, `doctor`, capability advertisement
  obligations/        # ObligationPlanner: manifest + regressions → JobTaskInput[]
  repair/             # AssuranceReplanner (TaskReplanner impl), regression store, holdout seeds
  refinement/         # RefinementMap loader, model- vs implementation-level verdicts
  ledger/             # hash-chained EvidenceLedger, verifyLedger()
  record/             # AssuranceRecord builder + evidence.schema.json validation
```

Integration touchpoints in existing packages (all additive):

| Package | Touchpoint | Change |
|---|---|---|
| `packages/core` | `types/task.ts` | Add `'verification'` to `TaskType`; add optional `role?: 'spec-author' \| 'implementation' \| 'repair' \| 'verification'` and `assurance?: { obligationId, propertyId, specHash, tool }` on `Task`; add `toolCapabilities?: FormalTool[]` to `TaskRequirements` (typed as `string[]` in core to avoid a reverse dependency). |
| `packages/core` | `services/policyEngine.ts` | Add a protected-path class `SPEC_DIRS` (`specs/`) with a role-aware rule (§1.5); expose a hook for task-role checks on merge. |
| `packages/core` | `services/worktreeManager.ts` | Option to mount/mark `specs/` read-only for non-`spec-author` tasks (§1.5). |
| `packages/core` | `services/verifiedIntegrationCoordinator.ts` | Treat `specs/` like test oracles: block candidate branches that touch it unless the producing task role is `spec-author`. |
| `packages/core` | `services/jobOrchestrator.ts`, `services/jobManager.ts` | No structural change: WFA plugs in via `options.replanner` and `addTasksToJob`. |
| `packages/core` | `services/evidencePolicy.ts` | New evidence kind `FORMAL` bound to `workspaceRevision`, so stale formal evidence fails `ARTIFACT_CONTRACT_FAILED` like stale `TEST`. |
| `packages/policies` | `src/index.ts` | Re-export `specWriteFenceRule` / `evaluateSpecWrite` helpers; `createPolicyEngine` accepts `{ specDirs, roleOf(executionId) }`. |
| `packages/scheduler` | `src/index.ts` (facade over core `Scheduler`) | Feasibility predicate extended with tool capabilities and host-class preference (§2.2). |
| `apps/cli` | `src/commands/` | New `assure` command group (§2.6); `doctor.ts` gains an assurance section delegating to `@wazir/assurance` `toolchain/doctor`. |

### 1.3 Verdict model (§2.1)

The single verdict enum is `Verdict` in `contracts.ts` (`PROVED`, `BOUNDED_PASS`, `COUNTEREXAMPLE`, `FALSIFIED`, `NOT_FALSIFIED`, `INCONSISTENT_ASSUMPTIONS`, `SPECIFICATION_REVIEW_REQUIRED`, `UNKNOWN`, `ERROR`, `NOT_RUN`, `NOT_VERIFIED`). No other module defines verdict strings. Native outcomes are normalized only through `mapNativeOutcomeToVerdict` / `NATIVE_VERDICT_MAPPING` in `verdict.ts`:

| Tool | Native outcome → Verdict |
|---|---|
| z3 (query `A ∧ impl ∧ ¬P`) | `unsat` → `PROVED` (unbounded) or `BOUNDED_PASS` (`obligation.bounded`); `sat` → `COUNTEREXAMPLE`; `unknown`/timeout → `UNKNOWN` |
| alloy | `no_counterexample` → `BOUNDED_PASS` (never `PROVED`; scope recorded); `counterexample` → `COUNTEREXAMPLE` |
| dafny | `verified` → `PROVED` only with an empty trusted base, else downgraded; `assertion_violation` → `COUNTEREXAMPLE`; `parse_error`/`type_error` → `ERROR` |
| scenic | `violation` → `FALSIFIED`; `sampled`/`sampling_exhausted` → `NOT_FALSIFIED` |
| verifai | `violation` → `FALSIFIED`; `exhausted` → `NOT_FALSIFIED`; `incomplete` → `UNKNOWN` |
| gam | `consistent_satisfied` (Con **and** ontology) → `BOUNDED_PASS`; `violation` → `COUNTEREXAMPLE`; `ontology_not_checked` → `UNKNOWN` |
| any | `timeout` → `UNKNOWN`; `error` → `ERROR`; `not_run` → `NOT_RUN` |

Hard rules, each a pure function in `verdict.ts` with Vitest coverage:
- **No promotion of falsification.** `preventNotFalsifiedPromotion` throws `VerdictPromotionError` on any attempt to turn `NOT_FALSIFIED` into `PROVED`/`BOUNDED_PASS`.
- **Vacuity.** `applyVacuityProbe` downgrades `PROVED`/`BOUNDED_PASS` to `INCONSISTENT_ASSUMPTIONS` when the probe is missing or failed. A pass without a probe from the same run does not count.
- **Trusted base.** `applyTrustedBaseGaps` blocks `PROVED` when Dafny reports `assume`, `{:axiom}`, `{:extern}`, opaque or trusted declarations.
- **Refinement cap.** `capImplementationVerdict` caps implementation-level claims at `NOT_VERIFIED` unless the production mode is `compiled_from_dafny` or `refinement_proof`.
- **Weakest link.** `aggregateVerdictsWeakestLink` folds with `weakerVerdict` over `VERDICT_WEAKEST_LINK_ORDER`. Verdicts are never averaged or counted.
- **Fail closed.** `evaluateReleaseGate(verdicts, specApproved)` returns `FAIL` for any `RELEASE_BLOCKING_VERDICTS` member (`UNKNOWN`, `ERROR`, `NOT_RUN`, counterexamples, inconsistency, review-required, `NOT_VERIFIED` at the implementation level) or when the spec is not `approved`.

Adapters return raw native outcomes plus metadata. Only `verdict.ts` produces a final `Verdict`, so no adapter can claim a pass on its own.

### 1.4 Specification registry (§2.2)

- **Location**: `specs/` at the repo root, one directory per property: `specs/<property_id>/manifest.yaml` plus the formal encodings it names (`*.als`, `*.py`/`*.smt2`, `*.dfy`, Scenic `*.scenic`, VerifAI monitors, GAL-JSON). The `SpecManifest` shape is the one in `contracts.ts`.
- **Content hash**: `content_hash = sha256` over a canonical serialization of the manifest (with `content_hash` and `reviewers` removed) concatenated with the bytes of every referenced artifact and monitor file, in sorted path order. `SpecRegistry.load()` recomputes it and rejects a mismatch with `SPECIFICATION_REVIEW_REQUIRED`. Every `Obligation.specHash` and `LedgerEntry.specHash` carries this value.
- **Versioning**: `version` is monotone per `id`. Any change to the manifest or an artifact requires a version bump, and the registry rejects a hash change under an unchanged version. Retired versions stay readable so older evidence remains verifiable.
- **Status lifecycle**: `draft → reviewed → approved → retired`.
  - `spec-author` tasks (agents) may create and edit only `draft` specs, and may move them to `reviewed`.
  - `reviewed → approved` happens only through `wa assure spec approve`, which goes through the existing approval path (`PolicyEngine.resolveAsk` → `approvalQueue`/`approveCallback`). Non-interactive sessions escalate `ask` → `deny`, so an agent cannot approve. The approver identity goes into `reviewers` and the event goes to the audit log (`appendAuditEvent`).
  - Only `approved` specs can gate a release. An obligation built from a non-approved spec yields `SPECIFICATION_REVIEW_REQUIRED` at the gate (`evaluateReleaseGate(..., specApproved=false)`).

### 1.5 Policy-engine write fencing

Two independent layers. Either one alone blocks a spec edit by an implementation task.

**Layer A — worktree read-only (prevent).** When `WorktreeManager` creates a worktree for a task whose `role` is `implementation`, `repair` or `verification`, it makes `specs/` read-only:
- strips write bits recursively on `<worktree>/specs` (`chmod -R a-w`); and, when an OS sandbox is active (`bwrap` / `seatbelt` wrappers in `packages/tools`), adds a read-only bind (`--ro-bind specs specs`) or a seatbelt `deny file-write*` sub-path rule;
- registers `specs/` as a protected path for that `executionId` in `PolicyEngine`, so `write`/`edit` tool calls and shell redirects into `specs/` are classified `deny` (rule `spec-write-fence-deny`). This is stricter than the existing `filesystem-protected-ask`. It is `deny`, not `ask`, because no approver may override it inside an implementation task.

**Layer B — merge fence (enforce).** `VerifiedIntegrationCoordinator.validateManifest` / `plan` already block test-oracle changes (`protectTestOracles`). WFA adds `specs/**` to that protected class with one exception: the change is allowed only when the producing task's `role === 'spec-author'`. The role is read from the persisted `Task` record, never from the agent-supplied manifest. Any other role produces the blocker `SPEC_WRITE_FENCE: task <id> (role <r>) modified specs/...`, and the merge is rejected. Even a `spec-author` merge leaves the spec in `draft`/`reviewed`; it still needs human approval to gate anything.

**Required test** (`packages/assurance/src/__tests__/fencing.test.ts` + a core integration test): an `implementation` task commits an edit to `specs/RED_SIGNAL_COMPLIANCE/red_signal.als`. Assert that (1) the `edit` tool call is `deny` with rule `spec-write-fence-deny`, and (2) if the file is changed out of band, the coordinator rejects the candidate branch with `SPEC_WRITE_FENCE`. A `spec-author` task making the same change passes both layers, and the spec is still `draft`.

---
