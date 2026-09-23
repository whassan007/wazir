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

## P1 item: worker resource-limit hardening — DONE, committed

Commit `2d40897` "feat(tools): rlimit-based resource caps for tool
subprocesses". Neither bwrap nor sandbox-exec applied resource limits —
only namespace/filesystem isolation. `resourceLimits.ts` wraps every
`runShell`/`runFile` call in a portable `bash -c 'ulimit ...; exec "$@"'`
prefix, composing with the existing sandbox wrapping.

Default-enabled: `maxCpuSeconds` (600s), `maxFileSizeMB` (4096MB) — both
verified with real integration tests (a CPU-spin loop killed via
RLIMIT_CPU, a 20MB write capped to ~1MB via RLIMIT_FSIZE).

**Deliberately NOT default-enabled** (opt-in only, via
`WAZIR_MAX_MEMORY_MB`/`WAZIR_MAX_PROCESSES` or a per-call `resourceLimits`
option) — both broke real commands when tested against this repo's own
suite:
- `maxMemoryMB` (RLIMIT_AS) breaks anything that spawns Node — V8 reserves
  large virtual address space regardless of actual usage.
- `maxProcesses` (RLIMIT_NPROC) counts ALL processes/threads for the UID
  *system-wide*, not the command's own subprocess tree — this dev machine
  already had 1300+ processes/threads under its UID, so a "512" default
  tripped immediately on every `npm run`, unrelated to what the tool
  command actually did.

Structured crash-cleanup reporting (surfacing *why* a subprocess was
killed — OOM vs. CPU cap vs. file-size cap — back into the tool result
rather than just a nonzero exit code) was not built; `CommandResult.code`
and the shell's own stderr (`Killed`, `File size limit exceeded`, etc.)
are what's available today.

## Not yet done

- **JobGraph durability review** — the graph engine itself (dependencies,
  fan-out/fan-in, retries, timeout, cancellation, replan/compensation via
  `options.replanner`) already existed in `jobManager.ts`/`jobOrchestrator.ts`
  before this work and does not need to be built from scratch, contrary to
  the original priority doc's assumption. No further action taken on it.
- Remaining P2/P3 items from the original priority list
  (`/tmp/.../wazir-feature-priorities.txt` from earlier in this
  conversation, or ask for it to be regenerated) were not started this pass.
