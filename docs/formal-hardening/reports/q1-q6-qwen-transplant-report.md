# Formal Hardening Report: Qwen Code 1.0 Brain Transplant & Governed Harness² (`Q1`–`Q6`)

> **Epistemic Status:** **Bounded Model Checking (`NO_COUNTEREXAMPLE_IN_SCOPE`)** verified live with Alloy 6 CLI (`./tools/alloy/org.alloytools.alloy.dist.jar`, SAT4J temporal trace solver) on Apple M5 Pro. Every model includes positive `run` witnesses (`WITNESS_SAT`) and paired negative-control mutant models (`q1..q6-*-mutant.als`) that deterministically produce `COUNTEREXAMPLE_FOUND` witnesses, guarding against vacuous truth. Finite-scope checks establish bounded assurance within the stated scopes and temporal step bounds, not unrestricted mathematical proof over unbounded traces.

## 1. Executive Ledger

| Model ID | Target Subsystem | Positive `run` Witnesses | Safety `check` Assertions | Scope & Trace Bound | Verdict (`sat4j`) | Negative-Control Mutant |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **[q1-parallel-policy.als](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/q1-parallel-policy.als)** | `CoreToolScheduler` + `PolicyEngine` (`packages/agents/src/qwenCore/coreToolScheduler.ts`) | `2/2` `WITNESS_SAT` | `4/4` `NO_COUNTEREXAMPLE_IN_SCOPE` | `5 ToolCall`, `7 steps` | **BOUNDED PASS** | `q1-parallel-policy-mutant.als` (`2/2` `COUNTEREXAMPLE_FOUND`) |
| **[q2-edit-sandbox.als](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/q2-edit-sandbox.als)** | `computeSmartEdit`, `multi_edit`, `read_many_files`, `SPEC_WRITE_FENCE` (`@wazir/tools`) | `2/2` `WITNESS_SAT` | `3/3` `NO_COUNTEREXAMPLE_IN_SCOPE` | `4 TargetNode`, `4 HunkBatch`, `6 steps` | **BOUNDED PASS** | `q2-edit-sandbox-mutant.als` (`2/2` `COUNTEREXAMPLE_FOUND`) |
| **[q3-proportional-verify.als](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/q3-proportional-verify.als)** | `ProportionalVerifier` + `EvaluationService` (`packages/agents/src/qwenCore/proportionalVerifier.ts`) | `3/3` `WITNESS_SAT` | `2/2` `NO_COUNTEREXAMPLE_IN_SCOPE` | `3 Revision`, `4 Evidence`, `6 steps` | **BOUNDED PASS** | `q3-proportional-verify-mutant.als` (`1/1` `COUNTEREXAMPLE_FOUND`) |
| **[q4-compose-governance.als](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/q4-compose-governance.als)** | Harness² `GovernanceFence` + `HarnessAssembler` (`packages/evaluation/src/editors/governanceFence.ts`) | `2/2` `WITNESS_SAT` | `3/3` `NO_COUNTEREXAMPLE_IN_SCOPE` | `3 EditorProposal`, `4 Int`, `5 steps` | **BOUNDED PASS** | `q4-compose-governance-mutant.als` (`2/2` `COUNTEREXAMPLE_FOUND`) |
| **[q5-batch-recovery.als](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/q5-batch-recovery.als)** | Batch crash & `planTaskResume` (`OUTCOME_UNKNOWN` / `FH-A5-01`) | `2/2` `WITNESS_SAT` | `2/2` `NO_COUNTEREXAMPLE_IN_SCOPE` | `2 BatchTool`, `4 Int`, `7 steps` | **BOUNDED PASS** | `q5-batch-recovery-mutant.als` (`1/1` `COUNTEREXAMPLE_FOUND`) |
| **[q6-privacy-routing.als](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/q6-privacy-routing.als)** | `WorkloadDistributor` + `checkAcpPrivacyEligibility` (`FH-A8-02`) | `3/3` `WITNESS_SAT` | `2/2` `NO_COUNTEREXAMPLE_IN_SCOPE` | `6 ExecutionTarget`, `3 TaskRequest`, `5 steps` | **BOUNDED PASS** | `q6-privacy-routing-mutant.als` (`1/1` `COUNTEREXAMPLE_FOUND`) |

---

## 2. Detailed Model & Counterexample Analysis

### Q1 — Parallel Tool Batch & Policy Serialization (`q1-parallel-policy.als`)
- **Invariants Checked (`7 steps`):**
  - `NeverExecuteDenied`: `Deny` tool calls remain `Rejected` and never enter `Executing` or `Completed`.
  - `NeverExecuteUnapprovedAsk`: `Ask` tool calls never enter `Executing` or `Completed` without prior `grantApproval`.
  - `MutatingCallsStrictlySerialized`: Whenever a mutating call (`edit`, `write`, `multi_edit`, `shell`) is `Executing`, zero other tool calls are `Executing`.
  - `NoConcurrentMutationAndUnapprovedAsk`: Parallel read batching never overlaps with mutating or unapproved `Ask` calls.
- **Mutant Control (`q1-parallel-policy-mutant.als`):** Models a naive `Promise.all` batch dispatcher without the `Ask` barrier or mutation lock; Alloy finds a 2-step counterexample executing `EditCall` concurrently with unapproved `AskShellCall`.

### Q2 — Smart Edit, Transactional Multi-Edit & Sandbox Realpath Containment (`q2-edit-sandbox.als`)
- **Invariants Checked (`6 steps`):**
  - `RealpathContainmentOnReadAndWrite`: Symlinks lexically inside the workspace whose `realpath` resolves outside `projectRoot` (`SymlinkToHostSecret`) are neither observed by `read_many_files` nor modified by `edit` / `multi_edit`.
  - `FrozenSpecsImmutable`: Protected formal specification files (`specs/**`) remain at `V0` across all edit batches.
  - `MultiEditTransactionalAtomicity`: Failed multi-hunk batches (`allHunksMatch = False`) never leave partial `VPartial` mutations on disk; target content stays identical to its pre-batch revision.
- **Mutant Control (`q2-edit-sandbox-mutant.als`):** Checks lexical containment only and flushes hunk 1 before hunk 2 fails; Alloy finds counterexamples for both symlink escape and `VPartial` file corruption in 2 steps.

### Q3 — Proportional Verification & Anti-Stale-Evidence Gate (`q3-proportional-verify.als`)
- **Invariants Checked (`4 Evidence, 6 steps`):**
  - `ReadOnlyZeroVerificationTax`: Read-only Q&A turns (`R0`) finalize as `ReadOnlyAnswered` with zero spawned build/test checks and never claim `PhysicalVerified`.
  - `NoFalseVerifiedWithoutCurrentRevisionOracle`: Workspace mutations (`R1 -> R2`) invalidate stale `R1` passing checks; `PhysicalVerified` requires `e.atRevision = TurnState.currentRev and e.passed = True`.
- **Mutant Control (`q3-proportional-verify-mutant.als`):** Checks `some e | e.passed = True` without revision equality; Alloy produces the 4-step stale-evidence false-success trace (`R0 -> R1 -> OraclePass(R1) -> R2 -> PhysicalVerified`).

### Q4 — Governed Harness² `Propose → Probe → Compose` (`q4-compose-governance.als`)
- **Invariants Checked (`3 EditorProposal, 4 Int, 5 steps`):**
  - `MonotonicCapabilityContainment`: Editor proposals can narrow `activeTools` (`activeTools & requestedTools`), never add capabilities outside `BaseHarness.ceilingTools` or escalate `ceilingNetwork`.
  - `GuardrailsSpecsAndOraclesNeverMutated`: Proposals touching `PolicyGuardrail`, `FrozenSpec`, `ProtectedOracle`, or `ExternalRubricUrl` transition deterministically to `RejectedGovernance` with zero target mutations; domain recipes require `verifiedCount >= 3`.
  - `ContrastiveNeverMasqueradesAsVerifiedWithoutOracle`: Rubric-sparse contrastive selection without physical oracle confirmation is strictly classified `UnverifiedContrastive`.
- **Mutant Control (`q4-compose-governance-mutant.als`):** Models raw ungoverned Harness² self-editing (`activeTools + requestedTools` and unfiltered target writes); Alloy finds immediate capability-escalation and rubric-tampering counterexamples.

### Q5 — Multi-Tool Batch Crash & Durable Recovery (`q5-batch-recovery.als`)
- **Invariants Checked (`4 Int, 7 steps`):**
  - `NeverDuplicateNonIdempotentSideEffect`: `BatchRuntime.physicalSideEffects <= 1` across arbitrary crash/recovery interleavings.
  - `AmbiguousMutatingCrashForcesManualReview`: Crashing while `MutatingShellItem` is `StartedAmbiguous` (`OUTCOME_UNKNOWN`) transitions `planTaskResume` to `HaltedManualReview`, never `ResumedSafe`.
- **Mutant Control (`q5-batch-recovery-mutant.als`):** Resets `StartedAmbiguous` to `NotStarted` on crash recovery; Alloy finds a 4-step trace where `physicalSideEffects = 2`.

### Q6 — Privacy-Preserving Workload Distribution & ACP Routing (`q6-privacy-routing.als`)
- **Invariants Checked (`3 TaskRequest, 5 steps`):**
  - `NoCloudExfiltrationForSensitiveOrLocalOnly`: Tasks with `localOnlyFlag = True`, `routingModeLocalOnly = True`, or `classification in (Sensitive + Secret)` only dispatch to targets with `endpointIsLocalLoopback = True` (`LocalOllama` or loopback-verified `LocalQwenAcp`).
  - `PinnedExternalNeverOverridesLocalOnly`: Explicit `--agent` pinning (`some req.pinnedTarget`) to `AntigravityCli`, `CodexCli`, `CloudQwenAcp`, or `HostedCloudApi` is rejected (`req in rejectedPrivacy`) whenever strict local privacy applies. *(Note: During modeling, Alloy caught a vacuous `lone` subset pitfall where `none in (...)` held for unpinned tasks; tightening the guard to `some req.pinnedTarget and req.pinnedTarget in (...)` eliminated the modeling bug.)*
- **Mutant Control (`q6-privacy-routing-mutant.als`):** Honors `pinnedTarget` before privacy checks and conflates local child-process spawn (`spawnsLocalProcess`) with loopback endpoint locality; Alloy finds immediate cloud-leak counterexamples.

---

## 3. Assumptions & Out-of-Scope Boundaries

1. **OS Kernel & Filesystem Primitives:** Models abstract POSIX `fs.realpathSync` and `fs.renameSync` as atomic operations; OS-level race windows between `realpath` check and file descriptor open are covered empirically by `tests/security/qwenFsToctou.test.ts`.
2. **External Binary Honesty under Loopback Env:** `Q6` assumes that when `qwen --acp` is launched with sanitized env (`OPENAI_BASE_URL=http://127.0.0.1:...` and cloud keys stripped), the child binary honors `OPENAI_BASE_URL` and does not open hardcoded external sockets; OS sandbox enforcement (`sandbox-exec` / Landlock) provides the physical network fence.
3. **Machine-Verified Receipts:** Raw SAT4J receipts and witness traces are archived under `docs/formal-hardening/results/q1-parallel-policy/` through `docs/formal-hardening/results/q6-privacy-routing/`.
