# Critical recovery fixes — 2026-10-19

Base: `14813e3326773ab0622aa260b348e4efa94447cf`, branch
`agy/autonomous-remediation-supervisor`, plus the current uncommitted changes.
Existing user deletions, the `tests/` → `test/` relocation, mobile app work, and
`packages/core/src/stringUtils.ts` were preserved. No commit or publication was made.

## Implemented behavior

1. The production API runs an overlapping-sweep guard and one-second recovery timer.
   A worker missing the normal 60-second heartbeat deadline becomes offline. Safe
   abandoned work persists as `orphaned`; opaque expired attempts terminate as
   `UNKNOWN_OUTCOME`. Restored offline computers require a real heartbeat or
   registration to become online again.
2. Opaque work defaults to no replay. Lease expiry, direct claim, reconnection, and
   controller restart cannot replay it. Opaque distributed provider requests also
   disable connect retries, since HTTP 500 can follow an external mutation. An
   already-committed result remains idempotently acknowledged after its lease expires.
3. Operators can explicitly reassign unclaimed or expired read-only requests through
   `POST /api/v1/tasks/:requestId/reassign`. Live leases cannot be stolen. New attempts
   fence old credentials/tokens. Workers cannot reassign their own ownership.
4. `POST /api/v1/tasks/:requestId/cancel` atomically commits cancellation. SSE notifies
   the worker, with lease-renewal rejection as fallback. A worker requires a successful
   started-event acknowledgment before entering the provider. Completion/cancellation
   races preserve the first terminal outcome across restart.
5. Verified prior fresh dead-PID lock recovery, non-mutating completion, model startup,
   planner, and LM Studio regression tests. Removed the earlier repair's fabricated
   `google/gemma-4-12b-qat` → `gemma-4-26b-a4b-it-qat` substitution: inventory and generation
   now preserve actual/requested model identity. Performance tests assert this behavior.

Test commands and executable fixture references were updated for the existing `test/`
relocation. Characterization tests for unsafe replay and missing recovery now require
safe production behavior. Test worker credentials satisfy the production 16-character
minimum; an early cancellation run exposed and corrected shorter fixture credentials.

## Validation

- `npm run build`: passed, including the standalone CLI bundle.
- `npm run typecheck`: passed.
- `npm run test:distributed:typecheck`: passed.
- `node scripts/check-dist-fresh.mjs`: all packages/apps fresh.
- Focused API/worker/registry/planner/LM Studio/lock/performance tests: 93 passed in
  15 files. Output: `/tmp/wazir-focused-final.log`. The exact selection is recorded below.
- Provider retry/cancellation fixtures: 10 passed after updating expectations for
  the existing `attempt_started` and `GENERATION_CANCELLED` event contract. Fetch-count
  and no-retry/cancellation assertions remain enforced. Output: `/tmp/wazir-retry-final.log`.
- `npm run test:postgres`: 20 passed against an isolated disposable PostgreSQL 16
  database (`wazir_recovery_test`). Output: `/tmp/wazir-postgres.log`.
- Initial distributed qualification: 17 passed across six files. Subsequent real-process
  cancellation qualification: 2 passed, including actual provider transport abort.
- Final distributed run: pending at report creation; see appended final result below.
- Live rebuilt CLI, isolated homes/workspaces, resident LM Studio model
  `gemma-4-26b-a4b-it-qat`: arithmetic completed correctly in 1,326 ms; Python snippet
  completed in 2,219 ms, parsed successfully, and returned 42 for inputs 18 and 24.
  Both exited 0 and changed no workspace files. See `live-cli-recovery-verification.json`.

Distributed tests use actual API and worker binaries with a controlled Ollama-compatible
HTTP fixture, not neural inference. Every cluster has a separate PostgreSQL schema.
Final process evidence is under `test-results/recovery-final/`; output is
`/tmp/wazir-distributed-final.log`. Credentials and lease tokens are redacted by the harness.

## Limits and historical evidence

Reassignment is an explicit operator action, not an automatic placement policy.
`replayPolicy: "read-only"` is an operator assertion that the request has no external
side effects. Unknown external outcomes require external reconciliation; cancellation
cannot undo effects already committed or force an uncooperative provider to stop.
There is no universal exactly-once claim.

The older execution reports refer to other commits/worktrees and one reports a 12B
model while admitting a 26B substitution. They are historical evidence, not verification
of this tree. This report uses the current source and actual resident model ID. The
previously cited `packages/core/src/services/__tests__/modelLifecycleService.test.ts`
is absent here; validation uses the existing model lifecycle admission and performance
suites instead.

The broad suite is not claimed green. Known failures were reproduced separately in
fleet TUI error presentation, mobile GPU telemetry (expects null, observes 0), a scheduler
reason-string assertion, and a job-recovery fixture attempting the forbidden
`failed → completed` transition. Packaging expectations also fail in the broad run.
The archived supervisor script reads an expired persisted 45-minute budget and fails
`STOP-01`; it also is not a Vitest suite. These were not changed to make this work appear
fully green. The new dispatch authorization/replay fixture failures from the first
broad run were corrected and passed the final focused run.

## Exact focused commands

```sh
npx vitest run apps/api/tests/dispatchRecovery.test.ts apps/api/tests/durableDispatch.test.ts apps/api/tests/dispatchIndex.test.ts apps/api/tests/taskDispatch.test.ts apps/api/tests/p0Remediation.test.ts packages/workers/tests/dispatchCancellation.test.ts packages/workers/tests/retryTelemetry.test.ts packages/core/tests/computerHeartbeatRecovery.test.ts packages/core/tests/modelLifecycleAdmission.test.ts packages/core/tests/planner.test.ts apps/cli/tests/executionPerformance.test.ts packages/shared/tests/storeLockOwnership.test.ts packages/runtimes/lmstudio/tests
npx vitest run test/runtime/providerRetryPolicy.test.ts
WAZIR_TEST_DATABASE_URL=postgres://postgres:disposable-test-only@127.0.0.1:55432/wazir_recovery_test WAZIR_REQUIRE_DATABASE=1 WAZIR_DISTRIBUTED_EVIDENCE=test-results/recovery-final npm run test:distributed
```

The intermediate broad run (`npx vitest run --exclude 'test/distributed/**'`)
reported 2,456 passed, 23 failed, 28 skipped, plus the archived supervisor loader
error. Four failures involved dispatch tests edited while that run was in progress;
all passed in the final focused run. Eight retry fixture failures were stale event
expectations and passed after the fixture correction above. Remaining observed test
failures concern the unrelated UI, telemetry, scheduling, job fixture, and packaging
items described above. A fully green broad run is not claimed.
