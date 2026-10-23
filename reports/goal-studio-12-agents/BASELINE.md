# Baseline

| Item | Value |
|---|---|
| Repository | /Users/wael/Code/Wazir (github.com/whassan007/wazir) |
| Base branch / commit | `main` @ `f7a4077` — Wazir v0.2.13, clean working tree |
| Contract commit (all 12 branches start here) | `e20355e` on `integration/goal-studio-12-agents` |
| Node / toolchain | Node >=22.13, npm workspaces, TypeScript 5.6 project references, vitest 2.1 |
| Machine | macOS (Darwin 27), 18 cores, 24 GB RAM |
| Build at contract commit | `npx tsc --build` — passes, no errors |
| Full test-suite baseline | Agent 12 is recording it in `docs/goal-studio/baseline-test-results.md` on its branch |

## Inputs
* **Feature spec:** the "Build Goal Studio: Autonomous Goal Execution Platform" document was
  referenced as attached but was **not** in the request. The coordinator prompt's own requirements
  (sections 2, 6, 7) are used as the spec.
* **Strategic goal graph:** `~/Downloads/nobel_goal_graph_bundle/nobel_goal_graph.yaml`, copied to
  `packages/goals/fixtures/nobel_goal_graph.yaml` (10 targets Y1.1–Y3.3, a separate prompt/execution
  graph, constitution with `hosted_spend_usd: 0`).

## Relevant existing architecture
* `packages/core` — ExecutionEngine (leases with epoch fencing, StaleWorkerLeaseError), execution
  recovery, checkpoints, status transitions, JobGraph/JobOrchestrator, Scheduler (model/computer
  routing), PolicyEngine, ApprovalQueue, verification engine/oracles, failure intelligence.
* `packages/shared` — KeyValueStore (MemoryStore, JsonFileStore with cross-process lock), audit.
* `apps/api` — Express control plane with ApiAuth (operator/viewer/computer), SSE streams.
* `apps/web` — **vanilla** single-page dashboard (`public/index.html`) behind a proxy `server.js`.
  There is no React app; Goal Studio UI follows the existing vanilla style.
* `apps/cli` — `wa` CLI and TUI.

## Scaffold added at the contract commit
* New workspace package `@wazir/goals` with `src/contracts.ts` (typed contract v1) and one stub
  module per workstream.
* `apps/api/src/goalStudio/` route composition point wired into `createApp` (services empty → 503).
