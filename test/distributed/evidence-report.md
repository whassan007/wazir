# Workstream 2 verification report

Candidate base: `cdea8aa125731765ca789dd6de13f35a0aa8b61f` (v0.1.61).
Local branch: `hardening/postgres-worker-recovery`.
Repository worktree: `/home/wael/Code/Wazir-pg-worker`.
No external publication or merge was performed.

Implemented a mandatory Ubuntu PostgreSQL 16 service workflow, dedicated test
commands, extended PostgreSQL integration coverage, and a Linux process harness
using the production API/worker binaries. The deterministic Ollama HTTP service
controls execution and mutation/acknowledgment barriers without replacing workers
or the controller with mock objects. Process schemas, computer credentials, and
worker homes are isolated. API dispatcher/protocol implementations are unchanged.

Reproduction commands and bounded guarantee definitions are in [README.md](README.md).
Process evidence is retained under `evidence/`. Each cluster contains a structured
HTTP/state timeline and a separate log for every child PID, including killed and
restarted processes. Lease tokens and credentials are redacted.

Validation:

- `npm run build`: passed (including workspace builds and standalone CLI bundle).
- `npm run typecheck`: passed.
- `npm run test:distributed:typecheck`: passed.
- `npm run test:postgres`: 20 passed against PostgreSQL 16.15 on Linux ARM64,
  using a dedicated disposable Docker database.
- Mandatory database negative checks: missing URL and refused connection each
  exited 1; the dedicated job cannot succeed by silently skipping the database.
- `npm run test:distributed`: 17 passed across six files in 298.99 seconds
  (15 process/protocol scenarios and two RecoveryManager unit regressions).
  Subsequent strengthened surviving-worker reconnect tests passed 3/3, and the
  beyond-original-deadline long task passed its focused rerun.
  Exact output is in `evidence/validation.txt`.
- Existing regression run: 295 files passed, one file failed, one skipped;
  2,210 tests passed, seven failed, 27 skipped. All seven failures were missing
  `node-pty` native bindings after `npm ci --ignore-scripts`. `npm rebuild node-pty`
  succeeded and the affected file rerun passed all eight tests. The full regression
  suite was not repeated after that environment repair. CI uses ordinary `npm ci`.
- Default-suite isolation: distributed process scenarios remain opt-in, and a
  default-config reconnect-file invocation confirmed three intentional skips.

Investigation failures and corrections:

- Initial crash injection waited only for lease acquisition; the provider request
  had not started. The assertion exposed this race. Injection now waits for the
  actual provider HTTP request before SIGKILL.
- Invalid result credential expected 403; production authentication returns 401.
  Corrected that status expectation and reran all three rounds of claim contention.
- Imported RecoveryManager fixtures used outdated constructor arguments. Corrected
  them to supply actual persistence callbacks/options and checked test types.

Actual safety blockers:

- After SIGKILL and the real 60-second offline threshold, the API still reports the
  dead computer online and retains an expired dispatch without a failed/orphaned
  outcome. Same-computer replacement can recover it; unattended reconciliation is
  missing in this API process.
- Worker B with another computer identity cannot take over; the real authenticated
  claim is rejected with 403. Computer-bound ownership needs an explicit integration
  design for reassignment.
- Mutation-before-acknowledgment yields two executions. External idempotency keeps
  the observable external effect at one; without it, effects reach two. Both cases
  retain one authoritative result. Automatic physical reconciliation of opaque
  dispatch is absent. Unit coverage preserves known-tool `UNKNOWN_OUTCOME` handling,
  but this must not be presented as process-level opaque-dispatch replay safety.
- There is no public distributed-task cancellation API to test simultaneous
  cancellation/completion. Completion/renewal and competing result races are tested.

Acceptance is **partially established and blocked on API recovery integration**.
Real process tests establish lease fencing, durable dispatch/credential restart,
same-computer recovery, duplicate result suppression, heartbeat/renewal, and bounded
claim races. They do not establish automatic offline recognition, cross-computer
failover, universal exactly-once execution, or prevention of uncoordinated external
side effects. The dedicated suite includes explicit characterization of these gaps;
a green suite is not a declaration that the full safety acceptance criteria passed.
GitHub workflow execution has not been claimed; the new workflow is unpushed.
