# Wazir Functional Tests

Live runs used the real CLI bundle (`bin/wa.js`), LM Studio on `localhost:1234`
(model selected by Wazir: `nvidia/nemotron-3-nano-omni`), and a throwaway git repo
containing `math.js` with an `add` that subtracts, plus `npm test` asserting
`add(2,3) === 5`. Each run's outcome was checked **independently** with `npm test`
afterwards, not only from Wazir's own report.

| # | Workflow | Status | Evidence |
|---|---|---|---|
| 1 | Simple task | **PASS (live)** | Plan → read → edit → test → verify; `success:true`, 1 file changed, independent `npm test` ok, 31 s |
| 2 | Multi-step task | PASS (offline suites only) | G2/G5 acceptance gates; job-graph dependency tests in `packages/core/tests`. Not run live. |
| 3 | Multi-agent delegation | PASS (offline suites only) | G5 Multi-Agent gate (5/5). Not run live. |
| 4 | Agent failure | **PASS (fault-injected)** | `externalAgent.lifecycle.test.ts`: a hung harness and its child are killed on cancel in ≈360 ms; timeout reported as a timeout. Orchestrator orphan handling covered by existing core tests. |
| 5 | Model interruption | **PASS (live, endpoint down)** | `WAZIR_LMSTUDIO_URL=http://127.0.0.1:1/v1`: exit 1 in 2.4 s, `success:false`, "No models are registered", no files touched. (Before F12 this override was silently ignored and the run used the real server.) Mid-stream interruption covered only by unit tests (`codingAgent.turnTimeout`, F9). |
| 6 | Tool failure | PASS (offline suites only) | `packages/tools/tests`, `codingAgent.circuitBreaker`, G10 ToolDepth gate. |
| 7 | Session recovery | PASS (offline suites only) | G12 SessionHardening, G94 ControlPlaneCrashRecovery, `jobManager` stale-job reconciliation tests. Restart during a live run: **NOT TESTED**. |
| 8 | Self-repair | **PASS (live)** | Workflow 1 is a controlled failing test. Failure detected → file inspected → targeted one-line fix → test re-run → verification of the current revision. The repo has only one test, so the regression run is that same test. |
| 9 | Qwen / ACP integration | **NOT TESTED (live)** | `AcpClientAdapter` is exported but not wired into any CLI path, and no ACP agent binary was configured. Covered by unit tests only (`acpClient*.test.ts`, 9 cases). Multimodal: NOT TESTED. |

## Repeatability (bounded soak)

Workflow 1 run 5 times sequentially, plus 1 run under `/usr/bin/time -v`:

| Run | `wa` exit | Wall time | Independent `npm test` |
|---|---|---|---|
| 1 | 0 | 37.8 s | pass |
| 2 | 1 | 27.7 s | fail |
| 3 | 0 | 45.4 s | pass |
| 4 | 0 | 34.9 s | pass |
| 5 | 0 | 55.6 s | pass |
| 6 (timed) | 0 | 45.6 s | pass |

- Task success: **5/6 (83%)**.
- Reporting accuracy: **6/6**. Wazir's verdict matched the independent check every time.
- Run 2 failure class: **model error**. The model declared completion without editing; verification rejected it with "Agent declared completion but produced no code modifications" and the failing test output. The harness behaved correctly.
- Latency (n=6): P50 ≈ 41.6 s, max 55.6 s. P95 is not meaningful at n=6.

## Not tested

Ollama paths (daemon not running), hosted providers (none authenticated), the
sandboxed tool path (bwrap unavailable on this host), PostgreSQL store, a
restart during an active live run, and concurrent live tasks.
