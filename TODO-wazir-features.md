# Wazir feature work — status

## P0 — DONE, committed

Resource admission, reservations, context-mode control, runtime
reconciliation. Commit `67c0e4f`. 17/17 tests passing.

## P1 item: execution recovery (worker leases) — DONE, committed

Commit `9ef2c42` "feat(recovery): orphan-detection and live retry for
executions on dead workers". `ComputerRegistry.checkHeartbeats()` existed
but was never called by anything — a dead worker's in-flight executions sat
as 'running' forever. Now:
- `ExecutionEngine.listActiveByComputer()` / `.orphan()`
- `JobOrchestrator.reportExecutionOrphaned()` — routes an orphaned task
  through the normal retry path (not the cancelled path)
- `RecoveryManager` — periodic sweep tying the two together

2 new tests, including a full live retry: task starts on computer A, A goes
offline, RecoveryManager detects it, orchestrator retries the task onto
computer B, job completes.

**Remaining for this item:** not wired into `apps/api`/`apps/cli` startup.
Those files already carry unrelated, pre-existing uncommitted changes from
before this session (check `git status` — if still true, don't bundle this
wiring into them without reviewing that other diff first). To wire it up:
construct a `RecoveryManager` alongside wherever the server builds its
`ComputerRegistry`/`ExecutionEngine`/`JobOrchestrator`, then call
`recovery.start(intervalMs)` next to `lifecycle.startReconciliation()` in
`apps/api/src/server.ts` (~line 302).

## P1 item: PTY-backed terminal sessions — DONE, committed

Commit `0b9a273`. `terminal_open`/`terminal_send`/`terminal_close` tools,
real `node-pty` + `@xterm/headless`, three-tier readiness, decoupled
scrollback/pending memory, graceful teardown. 8 new tests, all passing
against a real spawned PTY.

## Not yet done

- **Worker runtime hardening** beyond what already exists (TMPDIR/HOME
  isolation, sandbox wrapping already present in `packages/tools/src/process.ts`)
  — resource limits (CPU/memory caps on spawned children) and structured
  crash-cleanup reporting were not built.
- **JobGraph durability review** — the graph engine itself (dependencies,
  fan-out/fan-in, retries, timeout, cancellation, replan/compensation via
  `options.replanner`) already existed in `jobManager.ts`/`jobOrchestrator.ts`
  before this work and does not need to be built from scratch, contrary to
  the original priority doc's assumption. No further action taken on it.
- Remaining P2/P3 items from the original priority list
  (`/tmp/.../wazir-feature-priorities.txt` from earlier in this
  conversation, or ask for it to be regenerated) were not started this pass.
