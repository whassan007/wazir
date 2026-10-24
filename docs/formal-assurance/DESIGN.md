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
- **Trusted base.** `applyTrustedBaseGaps` downgrades `PROVED` to `BOUNDED_PASS` when Dafny reports `assume`, `{:axiom}`, `{:extern}`, opaque or trusted declarations, so `PROVED` is blocked. The gaps are listed in the record's `trusted_base`.
- **Refinement cap.** `capImplementationVerdict` caps implementation-level claims at `NOT_VERIFIED` unless the production mode is `compiled_from_dafny` or `refinement_proof`.
- **Weakest link.** `aggregateVerdictsWeakestLink` folds with `weakerVerdict` over `VERDICT_WEAKEST_LINK_ORDER`. Verdicts are never averaged or counted.
- **Fail closed.** `evaluateReleaseGate(verdicts, specApproved)` returns `FAIL` when the spec is not `approved`, when the verdict set is empty, when any verdict is unrecognised, when any `RELEASE_BLOCKING_VERDICTS` member is present (`COUNTEREXAMPLE`, `FALSIFIED`, `INCONSISTENT_ASSUMPTIONS`, `ERROR`, `SPECIFICATION_REVIEW_REQUIRED`, `UNKNOWN`, `NOT_RUN`, `NOT_VERIFIED`), or when there is no formal `PROVED`/`BOUNDED_PASS` at all (`NOT_FALSIFIED` alone is not enough).

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

## Section 2 — Adapters, Probes, Scheduling, Repair, Refinement, Ledger, CLI

### 2.1 Solver adapters and vacuity probes (§2.3)

Every adapter implements `SolverAdapter` from `contracts.ts`: `checkAvailability() → ToolAvailability` and `verify(obligation, workspaceRev, options) → VerificationResult`. Shared rules:
- **Subprocess only.** Each tool runs as a child process via a common `runPinned(tool, argv, { cwd, timeoutMs, memoryLimitMb, env })` helper, inside the OS sandbox wrappers from `packages/tools` (`bwrap` / `sandbox-exec`). Network is off and the worktree is mounted read-only except for a per-run output dir. Timeout and memory limits come from config (`.wazir/assurance.yaml`), overridable per `Obligation`.
- **Pinned toolchain.** `toolchain/` resolves `~/.wazir/assurance/venv` (z3-solver, scenic, verifai at pinned versions), `org.alloytools.alloy.dist.jar` 6.2.x (downloaded by a setup script, checked against its sha256, never committed), and a pinned `dafny` binary. The resolved version goes into `toolVersion`; a version mismatch is `NOT_RUN`.
- **Never fabricate.** Tool absent → `NOT_RUN`. Crash, parse failure or bridge failure → `ERROR`. Timeout or solver `unknown` → `UNKNOWN`. Exit code alone never produces a pass; the adapter must parse a positive result artifact.
- **Recorded inputs.** `inputHash = sha256(artifact bytes ‖ command ‖ scope ‖ seed ‖ toolVersion)`. Stdout and stderr are stored as content-addressed blobs (`stdoutRef`/`stderrRef`), and seeds are always recorded.
- **Fixture tests.** Each adapter has Vitest fixtures for every verdict it can emit, including `NOT_RUN` with the tool hidden from `PATH`. Tests that need a real tool are skipped with `describe.skipIf(!available)` and are reported as unexecuted. They are never counted as passes.

| Adapter | Invocation | Native parse | Vacuity probe (same run) |
|---|---|---|---|
| `z3` (P0) | `venv/bin/python <obligation>.py` or `z3 -smt2 <file>`; the harness asserts `A ∧ impl ∧ ¬P` itself | `sat` → model witness; `unsat`; `unknown`. **Inversion test:** a fixture with a known-true P must give `unsat`, and a known-false P must give `sat` | `check(A)` and `check(A ∧ pre)` both `sat` |
| `alloy` (P1) | `java -jar <pinned jar> exec -t text -c '*' -o <dir> <file>` | Per-command result files + `receipt.json`; record scope, Int bitwidth, steps | The spec's nonempty `run` witness over the same facts is SAT |
| `dafny` (P1) | `dafny verify <file>`; then `dafny audit` if available | Verified / failing assertion (location → witness); scan for `assume`, `{:axiom}`, `{:extern}`, `{:opaque}`, trusted declarations → `trustedBaseGaps` | A generated caller lemma shows each `requires` is satisfiable |
| `scenic` (P0, headless) | `venv/bin/python -m scenic --headless --count N --seed S` | attempted / generated / rejected counts, serialized scenes | Rejection rate ≤ configured threshold |
| `verifai` (P0, adapter + template) | `ScenicSampler` / `ScenicServer` / `specification_monitor`; simulator runs gated by the `verifai.simulator` capability | Violation → seed + trace (`FALSIFIED`); budget exhausted → `NOT_FALSIFIED`; incomplete → `UNKNOWN`. Monitors are unit-tested on known pass/fail traces before any campaign | Sampler produces ≥1 valid scene |
| `gam` | `ConsistencyChecker` **and** `OntologyChecker` on GAL-JSON Φ_L/Φ_E; emit the Alloy twin | `consistent && satisfied` → `BOUNDED_PASS`; violation → `COUNTEREXAMPLE` with witness path; ontology skipped → `UNKNOWN` (Con passing ≠ compliant) | Φ_E is nonempty and the Alloy twin's `run` is SAT |

After parsing, the adapter calls `verdict.ts` in a fixed order: `mapNativeOutcomeToVerdict` → `applyTrustedBaseGaps` → `applyVacuityProbe`. A failed or missing probe yields `INCONSISTENT_ASSUMPTIONS`.

### 2.2 Scheduler and feasibility integration (§2.4)

Obligations are ordinary `JobNode`s (`type: 'task'`, `TaskType 'verification'`) added to the job DAG with `dependencies: [<implementation task id>]`. `JobOrchestrator.doPump` dispatches them like any other node. There is no separate WFA queue.

- **Extended feasibility `F(t)`.** A host `c` is feasible for obligation `t` iff the existing constraints hold (OS/arch, `allowedComputers`, policy) **and** `t.requirements.toolCapabilities ⊆ c.capabilities`. Capability strings are `tool:z3`, `tool:alloy` (implies a JDK), `tool:dafny`, `tool:scenic`, `tool:verifai`, `tool:verifai.simulator`, and `tool:gam`. The worker daemon (`packages/workers`) advertises them in its heartbeat from `wa assure doctor` probes, and they land in `Computer.capabilities`. A missing tool makes the host infeasible. If no host is feasible, the obligation completes as `NOT_RUN`; it is never silently skipped.
- **Host-class preference.** Heavy obligations (`verifai` campaigns, `alloy` with scope above a configured threshold, Dafny modules above a size threshold) carry `preferHostClass: 'dgx'`. The scorer prefers `Computer`s whose `hardware.gpu.vendor === 'nvidia'` with unified memory (DGX Spark / GX10-class GB10 hosts) and falls back to any feasible host. Small Z3 checks have no preference and can run anywhere, including the local host.
- **Model-router bypass.** `Scheduler.plan` is model-first (it routes a model, then calls `scheduleComputer`). WFA adds a branch: when `task.type === 'verification'`, the scheduler skips `routeModel` and calls a new `scheduleToolHost(task)`, which reuses the computer filter and scoring but has no model, runtime or KV-cache terms. The decision carries no `modelId`, and `ExecutionEngine` dispatches to the assurance executor instead of an agent. Solver tasks never consume model capacity or hosted-provider eligibility.
- The `packages/scheduler` facade re-exports `scheduleToolHost` and the capability helpers; the implementation sits next to `scheduleComputer` in `packages/core/src/services/scheduler.ts` so it shares one feasibility code path.

### 2.3 Counterexample-guided repair loop and regression obligations (§2.5)

Built on the existing replan path (`JobOrchestrator` → `options.replanner` → `JobManager.addTasksToJob(..., { replacesTaskId })`), not on a new loop. Acceptance is defined by spec obligations, not by agent-written tests. `CodingAgent`'s in-loop build/test repair still runs inside each implementation attempt, but its `VERIFICATION_PASSED` is necessary, not sufficient.

1. An `implementation` task produces commit `C` in its worktree (spec dir read-only, §1.5).
2. `ObligationPlanner` expands every artifact/monitor of each `approved` spec bound to the component, plus all stored regression obligations, into verification nodes pinned to `workspaceRevision = C`.
3. When a verification node yields `COUNTEREXAMPLE`/`FALSIFIED`, it is marked failed with `errorKind: 'verification'` and the witness on the outcome. `AssuranceReplanner` (an implementation of the core `TaskReplanner` type) returns a `repair` task whose prompt carries the witness (Z3 model, Alloy instance, Dafny failing assertion + location, or VerifAI seed + trace) and the read-only spec path, plus fresh verification nodes depending on it.
4. Before the repair task is created, the witness is written as a **regression obligation** under `.wazir/assurance/regressions/<property_id>/<inputHash>.json` (and its ledger entry). It is keyed by property and spec hash and is never deleted, only retired with the spec version.
5. The attempt count per `(component, property)` is bounded by `assurance.maxRepairAttempts` (`k`, default 3, overriding `Task.maxRepairCycles` for repair tasks). After `k`, the replanner returns no tasks, the job fails, and the report lists every witness.
6. **Invalidation.** Formal evidence is a new `EvidencePolicy` kind bound to `workspaceRevision`. Any new commit makes all prior evidence stale (`ARTIFACT_CONTRACT_FAILED` on reuse), so every obligation, including regressions, re-runs on the new revision.
7. **Holdout.** VerifAI seeds are partitioned deterministically from the spec hash into a repair set and a holdout set. Repair tasks only see repair-set witnesses. The final revision must also be `NOT_FALSIFIED` on the holdout set, and a holdout `FALSIFIED` re-enters the loop as a new regression.
8. Repair tasks are policy-checked like implementation tasks. A repair that edits `specs/` is denied at tool level and rejected at merge (§1.5), so the only way to pass is to change the implementation.

### 2.4 Refinement / implementation mapping (§2.6)

- **File**: `refinement/<component>.yaml` (repo root, `RefinementMap` shape), outside `specs/`, so implementation tasks may propose mappings but cannot alter properties. `production_path` globs are resolved and hashed at `C`.
- **Two levels, reported separately.** The model-level verdict for each property comes from the spec encodings (Alloy consistency, Z3 envelope, Dafny kernel). The implementation-level verdict is `capImplementationVerdict(modelVerdict, production)`:
  - `compiled_from_dafny`: requires the same `verified_artifact` hash and a pinned Dafny compiler. The obligation re-compiles and byte-compares against `production_path`; a mismatch counts as no link. The claim may then be `PROVED`.
  - `refinement_proof`: requires a passing refinement obligation in the same run. The claim may be passing.
  - `contract_tests` / `none`: capped at `NOT_VERIFIED`. Contract-test results are still recorded as notes in the record.
- A property with no mapping has implementation level `NOT_VERIFIED`. Because `NOT_VERIFIED` is release-blocking, the gate fails until a mapping exists.

### 2.5 Hash-chained evidence ledger, lease fencing, assurance record (§2.7)

- **Storage**: append-only JSONL at `.wazir/assurance/ledger.jsonl`, one `LedgerEntry` per line. Witness and stdout blobs go in `.wazir/assurance/blobs/<sha256>` and are referenced by hash in `artifactHashes`. The file is never rewritten.
- **Chaining**: `entryHash = sha256(canonicalJSON(entry without entryHash))`. That content includes `prevHash` (the previous `entryHash`, `null` for index 0) and `index`. Canonical JSON uses sorted keys and no whitespace.
- **Lease fencing**: appends go through `EvidenceLedger.append(entry, lease)`. The existing `ExecutionEngine` lease (`epoch`, `token`; `StaleWorkerLeaseError` on renew) is validated first. The append is rejected when the lease is not current, or when `entry.workspaceRev` differs from the execution's current `workspaceState.revision`. `fencingToken = epoch` is stored in the entry. Appends are serialized by a file lock (or a `KeyValueStore` CAS on the head hash under Postgres), so a stale worker cannot append evidence for a superseded revision.
- **`verifyLedger()`** recomputes every `entryHash`, checks `prevHash` linkage and contiguous `index`, and re-hashes referenced blobs. It returns the first broken index. Tests cover tampering by edited verdict, deleted line, reordered lines and altered blob, and each must fail.
- **Assurance record**: `RecordBuilder` selects the ledger entries for `(component, source_commit)`, maps tool → record level (alloy → `specification_consistency`, z3 → `decision_envelope`, dafny + refinement cap → `implementation_contract`, verifai/scenic → `simulation_falsification`), computes `overall` per property by weakest link, collects `trusted_base` from Dafny gaps, and sets `release_gate = evaluateReleaseGate(...)`. `coverage_limits` always lists what is **not** claimed: perception correctness, physical-dynamics fidelity, real-world safety, legal interpretation, and bounds/scopes used. The record is validated against `skills/formal/.../evidence.schema.json` when the bundle provides it (Ajv), and against a `@wazir/assurance` JSON Schema generated from `AssuranceRecord` otherwise. Schema failure is an error, not a warning.

### 2.6 `wa assure` CLI (§2.8)

A new command group in `apps/cli/src/commands/assureCommands.ts`, registered from `apps/cli/src/index.ts` with the same `commander` pattern as `updateCmd`. Each subcommand is a thin wrapper over `@wazir/assurance`, and all support `--json`.

| Command | Behavior |
|---|---|
| `wa assure spec add <dir>` | Validate the manifest, compute `content_hash`, register as `draft` |
| `wa assure spec list` / `show <ID> [--version V]` | List or show the manifest, status, hash and reviewers |
| `wa assure spec approve <ID> --version V` | Requires a human: goes through `PolicyEngine` `ask` → approval queue/TTY prompt; denied in non-interactive or agent sessions; records the reviewer and an audit event |
| `wa assure run <component> [--property ID] [--tools z3,alloy,…]` | Build obligations at `HEAD` (or `--rev`), submit them as a job through `JobOrchestrator`, print per-obligation verdicts |
| `wa assure record <component> [--out file]` | Build and validate the assurance record for the current commit; non-zero exit on gate `FAIL` |
| `wa assure verify-ledger` | Run `verifyLedger()`; non-zero exit and first broken index on tampering |
| `wa assure doctor` | Probe each pinned tool (present / version / checksum), list host capabilities advertised to `F(t)`, and list the verdicts achievable on this host (e.g. "no Dafny → implementation_contract can only be NOT_RUN") |

Exit codes: `0` success / gate PASS, `1` gate FAIL or verification failure, `2` usage or configuration error.

### 2.7 Phase mapping

| Phase | Lands in |
|---|---|
| 1 | `verdict.ts` (C0), `registry/`, `fencing/` + core policy/worktree/coordinator hooks, `ledger/` |
| 2 | `adapters/z3.ts`, `adapters/alloy.ts`, probes |
| 3 | `adapters/dafny.ts`, `refinement/` |
| 4 | `obligations/`, `repair/` (replanner, regressions), `EvidencePolicy` FORMAL kind |
| 5 | `adapters/scenic.ts`, `adapters/verifai.ts`, `adapters/gam.ts`, scheduler capability/host-class |
| 6 | `apps/cli` `assure` group, `record/`, red-signal demo + integration test |
