# A12 — Codex Failure Recovery & Replay Safety Repairs Report

- **Agent ID**: A12
- **Provider**: Codex (`gpt-6-sol`)
- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh30/A12` (`fh30/A12`, commit `230690f`)
- **Critical Invariant**: *"An operation with an unknown side-effect outcome must not be replayed until it is safely reconciled."*

## 1. Defects Repaired

1. **D-01: Block Automatic Task Retry on Unresolved Non-Read-Only Tool Calls (`packages/core/src/services/jobOrchestrator.ts`)**:
   - Added `unknownMutationError(taskId)` checking `this.executionEngine.findUnknownOutcomeToolCall(record.execution.id)` across all four failure/orphan retry branches in `JobOrchestrator`. When an unresolved non-read-only mutation exists, automatic retry is blocked and the task transitions to `failed` with `[TOOL_OUTCOME_UNKNOWN]`.
2. **D-02: Fail-Closed Tool Classification in `HarnessDispatchService` Fallback (`packages/core/src/services/harnessDispatchService.ts`)**:
   - Replaced the permissive 14-tool `MUTATING_TOOLS` allowlist with a strict `READ_ONLY_TOOLS` allowlist (`read`, `read_file`, `glob`, `search`, `web_search`, `web_fetch`, `compaction`) so custom/unknown tools with `TOOL_OUTCOME_UNKNOWN` fail closed and block fallback with `UNCONFIRMED_SIDE_EFFECT_BLOCKS_FALLBACK`.
3. **D-03 & D-04: Durable `APPLIED` Proof Retention & Cross-Revision Semantic Deduplication (`packages/core/src/services/executionRecovery.ts`)**:
   - Updated `OperationReconciliationGuard.fromExecutionRecord` to extract reconciled `APPLIED` proof from `tool.completed` events.
   - Added `byRevisionIndependentKey` (`executionId:toolName:argumentsHash`) so that after `reconcileBeforeCrossHarnessResume` advances `workspaceRevision` from $R$ to $R+1$, subsequent retries of the already-applied operation at $R+1$ are caught as `DUPLICATE_SEMANTIC_OPERATION`.

## 2. Verification & Regression Suite

- **Test File**: `packages/core/tests/formalHardeningGroupD.test.ts` (4/4 tests passing in `291ms`):
  - `D-01 blocks retry after returned failure with an unknown mutation`
  - `D-01 blocks retry after thrown failure with an unknown mutation`
  - `D-02 blocks fallback for an unknown tool with no provenance`
  - `D-03 retains APPLIED proof after durable reload and D-04 deduplicates across revisions`
