# @wazir/core

The domain model and orchestration services every other package builds on. No I/O of its own beyond what's injected (a `KeyValueStore`, a `PolicyEngine.approveCallback`) — this package is pure logic and types.

## Services

| Service | Responsibility |
| --- | --- |
| `Scheduler` | Two-phase, deterministic task placement: model routing (capability match, context fit, explicit pins) then computer routing (hardware headroom, locality, load) — every decision carries human-readable reasons, never a silent fallback |
| `PolicyEngine` | 3-tier (`allow`/`ask`/`deny`) authorization for every tool call. Shell commands are parsed with `shell-quote` and every sub-command/pipe/redirect is classified independently; filesystem paths are containment-checked against the project root |
| `ExecutionEngine` | Durable record of one task's full lifecycle — status, tool calls, policy decisions, checks, files changed, token usage, event stream |
| `JobOrchestrator` | Runs a `Job`'s full task DAG concurrently, respecting `concurrencyLimit` and dependency edges, with retries, cancellation, and mid-run steering |
| `JobManager` | The underlying `Job`/`JobGraph` store `JobOrchestrator` sits on top of |
| `ApprovalQueue` | Non-blocking approval requests — an `ask` policy decision suspends only the task that triggered it, not the whole fleet |
| `WorktreeManager` | Git worktree isolation for concurrent fleet agents |
| `ContextCompiler` | Deterministic token budgeting and compaction for a task's context parts |
| `ComputerRegistry` / `RuntimeRegistry` / `ModelRegistry` / `AgentRegistry` | In-memory registries the Scheduler and CLI both read |

## A note on scope

Two fields exist in the type model without corresponding enforcement yet, found by writing real tests rather than assumed from reading the code:

- `ModelRecord.runtimeCompatibility` is never read by `Scheduler` — setting it has no effect on placement today.
- `ComputerRegistry` has no method that can ever set a computer's `health` to `'degraded'` — `Scheduler`'s degraded-computer scoring penalty is real, working code with nothing that can currently reach it.

Both are documented rather than silently patched, since fixing them means deciding what should actually set that state (a health-check poll? a heartbeat field?) — a design decision, not a mechanical one.
