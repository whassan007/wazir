# Wazir code navigation (GitHub inspection, 2026-10-25)

Repository: https://github.com/whassan007/wazir
Examined via connected GitHub public repository file reads. These paths and descriptions are a **snapshot**, not guarantees about later commits. At execution, read the current HEAD before making claims.

| File | Observed cues | Formal analysis target |
|---|---|---|
| `packages/core/src/services/policyEngine.ts` | Tool policy evaluation, OS isolation declarations, shell command classifications, output/path restrictions | Delegated authorization, dispatch-time validation, path containment, approvals |
| `packages/core/src/services/jobManager.ts` | Atomic-store requirement when persistence enabled, owner IDs and leases, stale-job reconciliation | Exactly-one live owner, recovery/cancellation races |
| `packages/core/src/services/executionEngine.ts` | Execution lease with worker ID, epoch, token; status and evidence; persistence | Stale commits, event log consistency, evidence/lease TOCTOU |
| `packages/core/src/services/executionRecovery.ts` | Reconstructs workspace revision, tool checkpoints, last results; unknown non-read-only outcomes intended to block replay | Side effect, crash, restart, replay counterexample |
| `packages/core/src/services/statusTransitions.ts` | Terminal-job/task/node/execution transition policy; explicit failed-task retries; cancelled job -> failed finalization exception | Terminal-state monotonicity under late writes |
| `packages/core/src/services/verificationEvidenceInspector.ts` | Completion evidence intended to come from controller-written fields, latest workspace revision, not model narration | No false completion on stale/missing evidence |
| `packages/core/src/services/modelLifecycleService.ts` | Resource reservation, capacity and model readiness | Concurrent load admission, pinning, eviction races |

Other code to discover in current tree before modeling: provider/governed adapters, sandbox tools, updater service, model router, task dispatchers, TUI, persistence implementations and tests. Do not assume a path exists merely because an older report named it.

Illustrative high-value boundary: `executionEngine.ts` lease identity/epoch/token + `executionRecovery.ts` unknown outcomes + `jobManager.ts` stale-state reconciliation. Test the entire transaction across modules: unit-level checks may pass separately while an interleaving violates an invariant.
