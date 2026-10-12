# Wazir Remaining Risks

## Release blockers (owner decision needed)

1. **Acceptance gates G97–G100 are undefined.** Tests 80–83 (semantic strategy
   retrieval) reference gates missing from `tests/acceptance/acceptanceData.json`.
   The harness now reports this instead of crashing, and still returns a
   **NOT READY** verdict. The underlying suites pass. Someone needs to define the
   gate entries (name, prerequisite). I did not invent them.

## Open defects

| Sev | Risk | Location | Recommendation |
|---|---|---|---|
| P2 | Dispatch records are never pruned. Every keep-alive tick (5 s per connected worker) re-reads every `dispatch/` record, so cost and storage grow without bound. | `apps/api/src/server.ts:71` (`refresh`), `redeliver` | Add a retention policy for records with an outcome. This changes durability semantics, so it needs an owner decision. |
| P2 | The ACP child inherits the full `process.env`, including provider keys and tokens, unlike tool subprocesses (`childEnvironment`). Delegated CLIs may legitimately need their own keys. | `packages/agents/src/acp/acpClient.ts:98` | Use an allow-list plus explicit `options.env` when ACP is wired in. |
| P2 | ACP delegation is not wired into any runtime path and has no live test (Workflow 9 NOT TESTED). | `packages/agents/src/acp/` | Wire it behind a flag together with an operator permission resolver (required by F1), then add a live test. |
| P2 | `JobManager.updateTaskStatus` / `setJobStatus` still accept any transition. F7 guards the one demonstrated misuse (`cancelTask`), and the orchestrator's own paths are guarded. | `packages/core/src/services/jobManager.ts` | Add an explicit transition table once all callers are audited. Retry paths legitimately move `failed → pending`. |
| P3 | No oscillation detection (A→B→A diagnostics) in repair. Bounded in practice because every failing check increments `cycle`, capped by `maxRepairCycles` (default 2, ≤2 in every complexity tier). | `packages/agents/src/codingAgent.ts:1511` | Hash recent diagnostics and stop on recurrence if the cap is ever raised. |
| P3 | Checks with no configured script are emitted as `ok:false` (0 ms) while the summary says "all checks passed". Misleading in logs, though the verdict is correct. | verify phase in `codingAgent.ts` | Emit `NOT_CONFIGURED` / skipped. |
| P3 | `LMStudioAdapter` defaults to port 1235, while LM Studio and the CLI use 1234. Only affects direct library use. | `packages/runtimes/lmstudio/src/index.ts:86` | Align the default to 1234. |
| P3 | `why model/worker/tool` now honestly report `UNKNOWN` for routing confidence, placement and policy decisions, because those decisions are not persisted where the TUI can read them. | `apps/cli/src/tui/fleetTui.ts:1142` | Persist the scheduler/policy decision records and project them here. |

## Environmental limitations of this audit

- Tool sandbox (bwrap) is unavailable on this host, so all live tool calls ran unsandboxed and the 6 sandbox tests were skipped.
- Ollama was not running; PostgreSQL was not available; no hosted provider was authenticated.
- Not tested live: concurrent tasks, restart during an active run, multimodal, ACP.
- Live sample size is small (n=6). The success rate is indicative only.

## Process notes

- The branch's first commit is the pre-existing uncommitted work from
  `feat/qwen-live-harness-integration`, committed unchanged. Review the repair
  commits on top of it separately.
