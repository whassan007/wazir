# @wazir/cli

The `wa` command — the primary way to use Wazir. Full command reference and usage examples live in the [repo root README](../../README.md#cli-command-reference); this file is about the CLI's own internal layout, for anyone working on it rather than just using it.

## Layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Commander command tree — every `wa <command>` is wired here |
| `src/engine.ts` | `createEngine()` builds the `RookEngine` object every command runs against: registries (computers/runtimes/models/agents), `PolicyEngine`, `Scheduler`, `ContextCompiler`, `ExecutionEngine`, `JobOrchestrator`, `ApprovalQueue`, `WorktreeManager`, and the persistence `store` |
| `src/run.ts` | `planTask()`/`executeTask()` — the single-task plan → schedule → execute → evaluate pipeline behind `wa ask`/`wa task run`/`wa task plan` |
| `src/commands.ts` | Rendering functions (tables, detail views, `--json` output) that the Commander actions in `index.ts` call into |
| `src/blocks.ts` | Persisted command history (`Block`) and active-context storage, behind `wa history`/`wa context` |
| `src/references.ts` | Deterministic `@ref` resolution behind `wa explain` |
| `src/fleetRunner.ts` | The `JobTaskExecutor` that runs a `CodingAgent` per fleet task, with optional git worktree isolation |
| `src/tui/` | The interactive fleet TUI (`wa chat`/`wa fleet`) — `screen.ts` (raw terminal control), `fleetTui.ts` (views/state/rendering), `inputHarness.ts` (a mock terminal stream so the TUI is testable without a real TTY) |
| `src/config.ts` | Loads `~/.wazir/config.json` + `WAZIR_*` env vars |

## Persistence

Every command that goes through `engine.store` (a `KeyValueStore`) — Blocks, active context, executions, jobs — picks its backend at `createEngine()` time: `WAZIR_DATABASE_URL` (Postgres) > `WAZIR_IN_MEMORY=1` > the default `~/.wazir/wazir.json` file. See `apps/cli/src/engine.ts`'s `createStore()`.

## Testing

`apps/cli/tests/` mirrors the source layout (`blocks.test.ts`, `context.test.ts`, `fleetTui.test.ts`, `executeTask.e2e.test.ts`, ...). The end-to-end tests build a real `RookEngine` (real `PolicyEngine`/`Scheduler`/`ExecutionEngine`/`ToolRegistry`) and only fake the model itself — see `executeTask.e2e.test.ts` for the pattern to copy for new ones.
