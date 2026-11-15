# A09 — Codex Task Lifecycle & Terminal Monotonicity Repairs Report

- **Agent ID**: A09
- **Provider**: Codex (`gpt-6-sol`)
- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh30/A09` (`fh30/A09`, commit `923864a`)
- **Critical Invariant**: *"Completed or cancelled work must not silently re-enter execution or be reported under a contradictory terminal status."*

## 1. Defects Repaired

1. **`JobOrchestrator` Cancelled Task Job Finalization (`packages/core/src/services/jobOrchestrator.ts`)**:
   - Fixed `doPump` step 4 (`allFinished`) to inspect `anyCancelled = job.graph.nodes.some((n) => n.state === 'cancelled' && !supersededTaskIds.has(n.taskId ?? n.id))` and finish the job as `'cancelled'` instead of `'completed'` whenever any required task was cancelled.
2. **Execution Finalization on Task/Job Cancellation (`packages/core/src/services/jobOrchestrator.ts`)**:
   - Ensured `cancelTask` and `cancelJob` finalize running `ExecutionEngine` records to `'cancelled'` so cancelled tasks never leave orphaned `'running'` executions.
3. **Retry & Terminal Monotonicity Guards (`packages/core/src/services/jobOrchestrator.ts`, `jobManager.ts`)**:
   - Blocked `retryTask` in both `JobOrchestrator` and `JobManager` when the parent job is in a terminal state (`cancelled` or `completed`).
   - Enforced `assertTaskTransition` / `assertExecutionTransition` on in-memory task and execution status updates to prevent terminal resurrection.

## 2. Verification & Regression Suite

- **Test File**: `packages/core/tests/formalHardeningGroupC.test.ts` (6/6 tests passing in `415ms`):
  - `finishes a mixed completed and cancelled job as cancelled`
  - `task cancellation finalizes its running execution`
  - `job cancellation finalizes its running execution`
  - `rejects retry through both APIs when the job is cancelled`
  - `rejects retry through both APIs when the job is completed`
  - `rejects terminal task and execution resurrection`
