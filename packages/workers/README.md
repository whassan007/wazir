# @wazir/workers

The library behind `apps/worker`'s daemon binary (and the in-process worker every `wa` CLI invocation also starts for itself, in local mode). Not to be confused with `@wazir/core`'s `WorkerRegistry` — this package is about *executing on* a computer, `core` is about *tracking* computers.

## `Worker`

Registers with a control plane, heartbeats, discovers local runtimes/hardware, and — the part that used to not exist — holds an SSE connection open (`GET /computers/:id/tasks/stream`) to actually receive dispatched tasks, executing them via `taskExecutor.ts`'s `executeRequest()` against whichever local runtime adapter serves the requested model, and reporting events/outcome back over plain HTTP POST.

A `Worker` never schedules — it only executes exactly what it's handed.

## `dispatchRemote()`

The other side of that transport: given a `computerId` and a `WorkerExecutionRequest`, dispatches to the control plane and polls for the worker-reported result, yielding each event as it arrives. This is what a scheduler-side caller (`apps/cli/src/run.ts`, when the `Scheduler` picks a non-local computer) uses instead of running in-process.

## `hardwareDiscovery` / `runtimeDiscovery`

Real, no-fallback hardware and runtime probing — CPU/RAM/GPU via platform-specific commands, Ollama/LM Studio via their real HTTP APIs. An unreachable runtime is reported `unavailable`, never invented.
