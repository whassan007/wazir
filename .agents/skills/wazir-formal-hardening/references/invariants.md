# Hardening hypotheses and proof obligations

These are deliberate attack/failure scenarios; **none is an assertion that the current release is broken**.

## P0-01 Effective policy at execution time
Invariant: Every mutating tool execution must have a valid, current authorization for its actual principal, effective isolation, resource and arguments. Challenge: parent approves a read, child executes a shell command; symlink target changes after approval; queued tool executes after revocation; option parsing hides executor flags. Test no external path writes or secret disclosure.

## P0-02 Fenced lease commit
Invariant: An execution mutation may commit only if the writer's lease token and epoch match the atomic durable current owner when the mutation commits. Challenge: worker A claims; lease expires; B claims; A's Promise resolves late; A emits terminal event or workspace mutation. Test with injected clock and deferred write barrier.

## P0-03 Terminal monotonicity
Invariant: cancelled/completed jobs cannot return to active states; task/exec retries must respect explicitly permitted restart targets. Challenge: complete vs cancel race, stale UI status update, retry queued after cancellation, timeout-abort finalizer. Account for documented `cancelled job -> failed` exception when finalizer reconciles and documented failed-task retry targets.

## P0-04 Unknown outcome mutation
Invariant: Non-idempotent tool calls whose outcome cannot be determined must never automatically replay. Challenge: mutate disk or external API; crash after physical side effect but before success checkpoint; restart and retry. Require evidence-backed reconciliation: APPLIED, NOT_APPLIED, UNDETERMINED.

## P0-05 Truthful completion
Invariant: A `completed` execution requires all mandatory acceptance oracles passing for the **current** workspace revision, no unresolved side effects, and no model-narration-only result. Challenge: tests PASS at revision 4; patch produces revision 5; late success callback tries to finalize using revision 4 checks.

## P1-06 Workspace conflict
Invariant: Concurrent agents applying overlapping patches must detect workspace revision conflict, serialize, or reconcile deterministically; no silent lost update. Challenge: A and B both read v1, A writes v2, B applies v1-based patch and overwrites A.

## P1-07 Provider fallback boundaries
Invariant: On failure, selected fallback must satisfy privacy, data locality, context, tools, modality and budget constraints. Challenge: local-only workflow silently falls back to hosted provider when a model disappears. Provider capabilities may be stale or unavailable.

## P1-08 Resource reservation
Invariant: Sum of active model reservations never exceeds applicable capacity, and active/pinned models are not evicted mid-use. Challenge: simultaneous admission checks using stale free GPU memory, double admission, unload vs generation race.

## P1-09 Atomic update and rollback
Invariant: Executable activated after upgrade must be complete, checksum/signature-valid when configured, compatible with persisted state, and restorable on failure. Challenge: download partially succeeds, process terminates between staging and swap, rollback concurrently with active tool calls.

## P1-10 Budget conservation
Invariant: Total committed token/tool/time consumption across retry/restart/fallback cannot exceed hard declared budget unless explicitly authorized. Challenge: timeout occurs after provider charged but before usage persistence; retry reinitializes spent budget.

## Recommended exploration sequence
1. Single-agent happy path + witness run.
2. Two agents, one shared resource, 3–5 event steps.
3. Delayed callback, cancellation, crash/restart, lease-expiry injection.
4. 3 agents with competing writes and out-of-order event persistence.
5. Larger bounds after counterexamples are minimized and mapped to code.

## Model abstraction checklist
Explicitly say whether simulated atomicity, time, file system, network, scheduler, leases, and tool outcomes accurately correspond to production semantics. Treat any omitted behavior as a limitation, not implicit proof of correctness.
