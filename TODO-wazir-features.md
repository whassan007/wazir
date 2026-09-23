# Wazir feature work — status and next instruction

## Where P0/P1 work stood when interrupted (2026-09-22)

P0 (resource admission, reservations, context-mode control, runtime
reconciliation) is DONE and committed — commit `67c0e4f`
"feat(models): resource admission, atomic reservations, context-mode
control, and runtime reconciliation". 17/17 tests passing
(tests/modelLifecycleAdmission.test.ts, tests/modelResources.test.ts).

P1 execution recovery (worker leases) was IN PROGRESS, UNCOMMITTED, in:
- packages/core/src/services/executionEngine.ts — added `listActiveByComputer()`
  and `orphan(executionId, reason)` to mark a non-terminal execution failed
  when its worker stops heartbeating.
- packages/core/src/services/jobOrchestrator.ts — added `orphanedTaskIds` to
  `ActiveJobHandle`, and orphan-branches in both the success-path and
  catch-path of the per-task executor IIFE inside `runJob()`, so an orphaned
  task retries (up to `job.maxRetries`) instead of being marked "cancelled".
- STILL TODO when resumed: a public `JobOrchestrator.reportExecutionOrphaned(jobId, taskId, reason)`
  method that aborts the task's AbortController after marking it in
  `orphanedTaskIds` (was about to be added when interrupted), plus a new
  `RecoveryManager` service that periodically calls
  `ComputerRegistry.checkHeartbeats()` (exists, already implemented, but
  **never called from anywhere** — confirmed via repo-wide grep) and, for any
  computer that just went offline, walks `ExecutionEngine.listActiveByComputer()`
  and calls the new orphan-reporting path. Needs wiring into apps/api/apps/cli
  startup and a test.
- NOT yet done: worker runtime hardening (TMPDIR/HOME isolation, resource
  limits, crash cleanup) and JobGraph durability review — JobGraph itself
  (dependencies, fan-out/fan-in, retries, timeout, cancellation, replan/
  compensation via `options.replanner`) already exists in
  `jobManager.ts`/`jobOrchestrator.ts` and does not need to be built from
  scratch, contrary to the original priority doc's assumption.

Typecheck was clean as of the last `tsc --noEmit` run on packages/core before
this was interrupted. Nothing in this partial state has been committed.

## Next instruction (given by user, verbatim) — implement this instead

> Zero-Scrollback Headless PTY: The harness consumes raw pseudo-terminal data
> through a headless @xterm/headless instance. This isolates the agent from
> terminal protocol complexities, allowing a dedicated streaming line
> sanitizer to normalize control sequences and prevent ANSI escape codes
> from corrupting the model's context window.
>
> Three-Tier Readiness Polling: To prevent the agent from issuing commands
> while the shell is still executing or starting up, the CLI relies on a
> strict readiness model to settle a send command:
>
> Exact stdin-wait evidence directly from the subprocess provider (on Linux).
>
> A verified private prompt marker injected securely (e.g., via PS1 and
> PROMPT_COMMAND in bash) with an exact printable tail.
>
> An absolute output silence bound (inferred_idle) to ensure processes have
> fully settled without infinite hanging.
>
> Decoupled Memory & Scrollback Management: Unread send outputs and
> scrollback are retained as independently owned strings with incremental
> byte and newline counts. This ensures that sanitized string slices do not
> accidentally retain memory-heavy discarded control sequences, keeping
> memory consumption strictly proportional to incoming text.
>
> Plugin-Driven Lifecycle (Cordis Kernel): Every component, including the
> terminal subsystem, is a hot-swappable plugin. Terminal registrations act
> as reversible effects. If a session crashes, the plugin unloads, cleanly
> unwinding its effects rather than leaving orphaned PTY processes.
>
> Graceful Escalation Teardown: The session machinery utilizes bounded
> timeouts on send operations and an explicit disposeGraceMs window. It
> attempts to clean up the process tree gracefully before escalating to a
> hard SIGKILL, preventing zombie processes from consuming system resources.

Note: grepped the repo for "cordis", "xterm", "headless" + "pty" — zero
matches anywhere in Wazir. This describes a terminal/shell subsystem that
does not exist in this codebase yet (there is no "Cordis Kernel" plugin
architecture here). Treating this as a spec for a new, real PTY-backed shell
tool to replace/upgrade whatever Wazir's coding agents currently use for the
`shell` tool — investigate the current shell tool implementation before
building, and scope realistically rather than attempting the full plugin
kernel in one pass if the current architecture doesn't already have a
plugin/effect system to hang it off of.
