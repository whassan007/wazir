# Wazir Self-Improvement Recovery, Qualification, and Operations Report

- **Timestamp (UTC)**: `2026-10-17T05:06:00Z`
- **Host**: `dgx-spark` (Ubuntu Linux 6.17.0-1014-nvidia, `aarch64`, Node `v22.22.3` at `/home/wael/.nvm/versions/node/v22.22.3/bin`)
- **Primary repository**: `/home/wael/Code/Wazir` (`main` @ `f9600303b25483745158c383a96604176158bdcf`, untouched)
- **Candidate worktree**: `/home/wael/Code/Wazir-self-improvement-candidate`
- **Candidate branch**: `feat/native-continuous-self-improvement`
- **Previous candidate commit**: `f59d380737c30d30abcbf21132473cf4cac71871`
- **Builder script**: `/home/wael/.local/share/wazir-self-improvement-builder/builder.sh`
- **Systemd user unit**: `~/.config/systemd/user/wazir-self-improvement-builder.service`

---

## 1. Original Failure Diagnosis & Root Causes

### 1.1 Initial Phase 1 Failure (`exec-mv91b9as-1`)
- **Model**: `qwen2.5-7b-instruct` (`local-lmstudio`)
- **Failure**: `NO_PROGRESS` after 6 consecutive failed/unproductive tool calls (`documentSymbols`, `findReferences`, `code_mode`), 0 files changed, 0 checks run.
- **Root Causes**:
  1. **Tool Registry vs Policy Surface Mismatch**: `packages/tools/src/index.ts` registered code-intelligence and `code_mode` schemas in `ToolRegistry` even though `PolicyEngine` had no handler for them (`Unsupported tool in PolicyEngine`). Repaired by filtering advertised tools through `getPolicySupportedTools(registry.list())` across root, planning, and nested CLI execution surfaces while preserving fail-closed policy enforcement (`apps/cli/src/commands.ts`, `packages/agents/src/codingAgent.ts`).
  2. **Search Tool Content Pattern vs File Glob Precedence**: When a model passed both `pattern` (regex) and `glob` (file filter) to `search`, `searchTool` previously discarded `pattern` and matched file lines against `glob`. Repaired in `packages/tools/src/search.ts` so `glob`/`include` filters files while `pattern`/`query`/`regex` searches file contents.
  3. **Model Context Ceiling Propagation**: Discovered LM Studio model context ceiling was not forwarded into `AgentRunRequest`, preventing proactive context compaction before hitting the 8192-token context window. Repaired in `apps/cli/src/commands.ts` and `packages/agents/src/codingAgent.ts`.

### 1.2 Subsequent Builder v3 Regression & Phase 1 Failure (`exec-mvaluysp-1`)
- **What Happened**:
  - At `2026-10-15T23:06:11-07:00`, commit `f59d380737c30d30abcbf21132473cf4cac71871` had already implemented Phases 1–3 (`packages/evaluation/src/metaOptimizerService.ts`, `packages/evaluation/src/regressionGuard.ts`, `packages/evaluation/src/selfImprovementSupervisor.ts`, `apps/cli/src/improvementSupervisor.ts`, `apps/cli/src/improvementRepair.ts`, `scripts/self-improvement-builder.sh`).
  - At `2026-10-15T23:47:28-07:00`, an older "Builder v3" script overwrote `/home/wael/.local/share/wazir-self-improvement-builder/builder.sh`, ignored existing phase completion state, and re-launched Phase 1 from scratch under `nvidia/nemotron-3-nano-omni` (`exec-mvaluysp-1`, 1,284,415 tokens across 36 model requests and 32 tool calls).
- **Root Causes of `exec-mvaluysp-1` (`MODEL_PROTOCOL_BUDGET_EXHAUSTED`)**:
  1. **Cumulative vs Consecutive Protocol Correction Counter**: In `packages/agents/src/codingAgent.ts`, `correctionCount` was incremented on any malformed turn (`INVALID_JSON_ACTION`) and never reset after valid turns (`acceptAttempt`). Consequently, 3 isolated malformed turns across 36 otherwise valid turns tripped `correctionCount >= 3` (`MODEL_PROTOCOL_BUDGET_EXHAUSTED`).
  2. **Missing Native Control Schemas (`plan` / `done`)**: When `selectedProtocol === 'native_tool_call'`, `CodingAgent` only exposed workspace tools (`read`, `write`, `edit`, `search`, `list`, `test`, `build`, `git`) in the OpenAI `tools` array and omitted `plan` and `done`. Models using strict native tool calling either called `build({"script":"plan"})`, emitted text alongside parallel tool calls (`PARALLEL_TOOL_CALLS_REJECTED`), or failed to transition out of `plan`/`implement` phases cleanly.
  3. **Multi-Tool Call Batching in LM Studio**: `LMStudioAdapter` (`packages/runtimes/lmstudio/src/index.ts`) did not pass `parallel_tool_calls: false` when `tools` were provided, allowing models to emit multiple tool calls in a single turn that `NativeToolCallAdapter` rejected with `PARALLEL_TOOL_CALLS_REJECTED`.
  4. **JSON-Encoded Glob Arrays in `search`**: `nvidia/nemotron-3-nano-omni` passed `glob: "[\"**/*.test.ts\", \"**/*.ts\"]"` to `search`, which `matchesInclude` treated as a literal string with brackets and quotes, returning 0 files.

---

## 2. Recovery Checkpoints

1. **`/home/wael/.local/state/wazir-self-improvement-builder/recovery-checkpoints/20261015T214552Z`**: Initial snapshot prior to Phase B repairs.
2. **`/home/wael/.local/state/wazir-self-improvement-builder/recovery-checkpoints/20261017T035800Z`**: Pre-repair snapshot capturing `candidate-HEAD` (`f59d380737c30d30abcbf21132473cf4cac71871`), `candidate-status.txt`, `candidate-log.txt`, `primary-HEAD`, `primary-status.txt`, `builder-share/`, and `builder-state/`.

---

## 3. Repairs Implemented

1. **Execution Engine Native Control Tools & Consecutive Retry Accounting (`packages/agents/src/codingAgent.ts`, `packages/agents/src/protocolAdapters.ts`)**:
   - Exposed `plan` (during `plan` phase) and `done` (during `implement` and `repair` phases) in the native `tools` schema array when `selectedProtocol === 'native_tool_call'`.
   - Updated `normalizeToActionEnvelope` to normalize native `plan` and `done` tool calls (as well as fallback `build({ script: 'plan' | 'done' })` invocations) directly into `plan` and `done` action envelopes.
   - Reset `correctionCount = 0` inside `acceptAttempt` so the 3-attempt protocol correction budget bounds *consecutive* malformed model responses rather than failing long-running tasks on isolated hiccups.
2. **LM Studio Sequential Tool Calling (`packages/runtimes/lmstudio/src/index.ts`)**:
   - Added `parallel_tool_calls: false` whenever `request.tools?.length` is non-empty so LM Studio enforces single-action turns compatible with `CodingAgent`.
3. **Search Tool Glob Array & Brace Expansion (`packages/tools/src/search.ts`, `packages/tools/tests/searchScope.test.ts`)**:
   - Added `expandIncludePatterns` to parse JSON-encoded string arrays (e.g., `'["**/*.test.ts", "**/*.ts"]'`), comma-separated globs, and brace expansions (`**/*.{test.ts,ts}`).
4. **Strategy Learning & Anti-Strategy Persistence (`packages/evaluation/src/selfImprovementSupervisor.ts`, `apps/cli/src/improvementSupervisor.ts`)**:
   - Integrated `StrategyLearningService` and `MemoryService` into the supervisor lifecycle via `recordLearning`: verified `STAGED`/`PROMOTED` attempts persist `VERIFIED_STRATEGY` records and failed attempts persist `ANTI_STRATEGY` records under `supervisor/strategies/<attemptId>`.
5. **Real `OPTIMIZE` Mode Verification & Reversible Config Promotion (`apps/cli/src/improvementRepair.ts`)**:
   - Implemented full baseline vs candidate verification and latency/token comparison for `mode === 'optimize'`, rejecting any optimization candidate that fails correctness checks even if latency/tokens decrease, and supporting reversible config promotion to `promoted-config.json`.
6. **Durable `MetaOptimizerService` Plan Persistence (`packages/evaluation/src/metaOptimizerService.ts`)**:
   - Serialized plan persistence through `this.pendingPersistence` so `designExperiment` never leaves unawaited `JsonFileStore` lock operations dangling across test teardown.
7. **Hardened Builder & Phase Verification (`scripts/self-improvement-builder.sh`, `/home/wael/.local/share/wazir-self-improvement-builder/builder.sh`)**:
   - Restored the receipt-verified builder script to `/home/wael/.local/share/wazir-self-improvement-builder/builder.sh` with `doctor`, `resume`, `run-worker`, `status`, `logs`, and `stop` subcommands, `flock` singleton protection, systemd `KillMode=control-group` lifecycle, and `apps/cli/tests/improveSupervisorE2E.test.ts` in the default verification test gate.

---

## 4. Coding Runtime Selection & Validation (Phase C)

### 4.1 Discovered Local Runtimes on DGX Spark
- **LM Studio (`http://127.0.0.1:1234/api/v0/models`)**:
  - `qwen/qwen3.8-27b`: **LOADED**, `arch: qwen35`, `quantization: Q4_K_M`, `max_context_length: 262144`, `loaded_context_length: 8192`, `capabilities: ["tool_use"]`.
  - `nvidia/nemotron-3-nano-omni`: **LOADED**, `arch: nemotron_h`, `loaded_context_length: 8192`, `capabilities: ["tool_use"]`.
  - `qwen/qwen3-coder-next`: unloaded (`state: not-loaded`), previously rejected (`exec-mv97qchi-1`, `exec-mv98rsxz-1`) for emitting unsupported `run` tool calls.
  - `qwen2.5-7b-instruct`: unloaded (`state: not-loaded`), rejected (`exec-mv91b9as-1`) for emitting unregistered code-intelligence tools.
- **Ollama (`127.0.0.1:11434`)**: Not running / unreachable.
- **External CLIs**: Not used; local inference on DGX Spark was prioritized and validated.

### 4.2 Disposable Coding Smoke Test (`exec-mvbwysw8-1`)
- **Model**: `qwen/qwen3.8-27b` (`--agent wazir-coding --model qwen/qwen3.8-27b`)
- **Workspace**: `/home/wael/.local/state/wazir-self-improvement-builder/recovery-evidence/wazir-coding-smoke-qwen38-1792212355`
- **Outcome**: **PASS (`VERIFICATION_PASSED`)** in 60.1s:
  - `modelRequests`: 7
  - `toolCalls`: 6 (`read`, `test`, `edit`, `test`, `build`, `done`)
  - `invalidActions`: 0
  - `duplicatesBlocked`: 0
  - `retries`: 0
  - `filesChanged`: `["sum.js"]` (`sum.test.js` oracle byte-identical before and after)
  - `checks`: `test` (`exitCode: 0`) and `build` (`exitCode: 0`)

---

## 5. Phase-by-Phase Outcomes & Verification Evidence

### Phase 1: Improvement Integrity — **PASS**
- **Implemented in**:
  - `apps/cli/src/commands.ts` (fabricated `"28%"` token savings and `"Prompt compression + AST caching"` strings removed; real `MetaOptimizerService` evaluation path wired)
  - `packages/evaluation/src/metaOptimizerService.ts` (fail-closed `VerificationEngine` oracle checks, git worktree SHA-256 tamper fingerprinting before and after verification, persisted state under `meta/*` in `JsonFileStore`, promotion gate requiring verified candidate + qualified `RegressionGuard`, reversible `rollback()`)
  - `packages/evaluation/src/regressionGuard.ts` (`ZERO_REAL_EXECUTIONS` and runner error detection returning `INCONCLUSIVE`)
- **Verification**:
  - `npx vitest run packages/evaluation` -> **16 test files passed, 126 tests passed**.

### Phase 2: Persistent Supervisor — **PASS**
- **Implemented in**:
  - `packages/evaluation/src/selfImprovementSupervisor.ts` (explicit state machine `IDLE -> OBSERVING -> DIAGNOSING -> SELECTING -> EXPERIMENTING -> VERIFYING -> BENCHMARKING -> STAGED | PROMOTED | REJECTED | ROLLED_BACK | PAUSED | STOPPED | BLOCKED | FAILED`, interrupted-attempt recovery on startup, incident deduplication, secret redaction)
  - `apps/cli/src/improvementSupervisor.ts` (headless CLI `wa improve start|run|status|logs|pause|resume|stop|failures|recommendations|history|doctor`, atomic PID/instance lease file with `/proc/<pid>/cmdline` validation, load-average circuit breaker, non-mutating `wa improve doctor`)
- **Verification**:
  - `npx vitest run packages/evaluation/tests/selfImprovementSupervisor.test.ts apps/cli/tests/improveSupervisorE2E.test.ts` -> **9 tests passed**.

### Phase 3: Harden, Optimize, Evolve — **PASS**
- **Implemented in**:
  - `apps/cli/src/improvementSupervisor.ts` + `apps/cli/src/improvementRepair.ts`:
    - **HARDEN**: Scans execution failures (`INVALID_JSON_ACTION`, `NO_PROGRESS`, `REPEATED_ACTION`) and crash logs (`crash-*.log`), deduplicates by signature, redacts secrets, creates isolated candidate git worktree, runs baseline failing test check, dispatches coding agent (`wazir-coding` with `qwen/qwen3.8-27b` or `scoped-patch`), runs post-edit independent checks, enforces test-file immutability unless `allowTestChanges: true`, and stages verified repairs (`STAGED`).
    - **OPTIMIZE**: Measures real execution latency/token telemetry, applies scoped configuration/source mutations in an isolated worktree, runs correctness checks + latency/token comparison against baseline, rejects any optimization candidate that fails correctness checks even when tokens/latency decrease, and supports reversible config promotion (`promoted-config.json`).
    - **EVOLVE**: Fails closed (`BLOCKED`) unless an explicit authorized feature scope (`mode: "evolve"`) is supplied, rejects disqualified models (`nvidia/nemotron-3-nano-omni`, `qwen2.5-7b-instruct`, `qwen/qwen3-coder-next`), and verifies feature additions in an isolated worktree.
    - **LEARNING**: Records `VERIFIED_STRATEGY` and `ANTI_STRATEGY` entries via `StrategyLearningService` + `MemoryService` and persists them under `supervisor/strategies/<attemptId>`.

### Phase 4: Integration and Qualification — **PASS**
- **Live End-to-End DGX Spark Proof**:
  - **Evidence directory**: `/home/wael/.local/state/wazir-self-improvement-builder/recovery-evidence/phase4-live-proof`
  - **Attempt ID**: `28d2fd17-2300-4feb-89a4-e630aea7714e`
  - **Runtime**: `agent: "wazir-coding"`, `model: "qwen/qwen3.8-27b"` on local LM Studio (`http://127.0.0.1:1234`)
  - **Observed Crash**: `crash-clamp.log` -> deduplicated incident signature `037c1d6b3cf551dc5fe4fdb4` with `api_key=[REDACTED]`.
  - **Isolated Worktree**: `/home/wael/.local/state/wazir-self-improvement-builder/recovery-evidence/phase4-live-proof/wazir-config/self-improvement/11d19ca4044903a2eca2/candidates/improve-28d2fd17-2300-4feb-89a4-e630aea7714e` (`branch: wazir/improve-28d2fd17-2300-4feb-89a4-e630aea7714e`, `baseSha: f152ccac9bed2f1f2aafa4cf6c7ab5ae3414f12e`).
  - **Independent Checks**: Baseline `node --test clamp.test.js` exited `1` (`83ms`); after `qwen/qwen3.8-27b` repaired `clamp.js`, candidate check exited `0` (`61ms`), `clamp.test.js` remained unmodified, primary repo remained unmodified, attempt transitioned to `STAGED`, and `VERIFIED_STRATEGY` `strat-28d2fd17-2300-4feb-89a4-e630aea7714e` was persisted.

---

## 6. Test Commands & Results

All commands executed in `/home/wael/Code/Wazir-self-improvement-candidate` with Node `v22.22.3`:

1. `npm run build`
   - **Result**: PASS (all 22 workspaces built cleanly; standalone CLI bundled to `bin/wa.js`).
2. `npx vitest run packages/evaluation/tests/selfImprovementSupervisor.test.ts apps/cli/tests/improveSupervisorE2E.test.ts packages/tools/tests/searchScope.test.ts packages/agents/tests/codingAgent.surfaceRecovery.test.ts`
   - **Result**: PASS (`4 passed (4)`, `19 passed (19)`, `0 errors`).
3. `npx vitest run packages/evaluation`
   - **Result**: PASS (`16 passed (16)`, `126 passed (126)`).
4. `node --test scripts/self-improvement-builder.test.mjs`
   - **Result**: PASS (`6 passed (6)`).

---

## 7. Operating the Self-Improvement Supervisor on DGX Spark

Ensure Node `v22.22.3` is on `PATH`:
```bash
export PATH="/home/wael/.nvm/versions/node/v22.22.3/bin:$PATH"
WA_BIN="/home/wael/Code/Wazir-self-improvement-candidate/bin/wa.js"
```

### 7.1 Inspect Readiness & Systemd Unit Template (Non-Mutating)
```bash
node "$WA_BIN" improve doctor
node "$WA_BIN" improve doctor --print-systemd-unit
```

### 7.2 Run One Bounded Improvement Cycle
```bash
# Observation + diagnosis + recommendation cycle:
node "$WA_BIN" improve run --mode harden

# Scoped repair cycle in an isolated candidate worktree:
node "$WA_BIN" improve run --mode harden --scope /path/to/scope.json
```

### 7.3 Start / Monitor / Control Background Continuous Supervisor
```bash
# Start background daemon (acquires singleton lease):
node "$WA_BIN" improve start --continuous --mode harden,optimize --interval 300 --max-cycles 20

# Inspect live status & stream structured JSONL events:
node "$WA_BIN" improve status --live
node "$WA_BIN" improve logs --follow

# Inspect deduplicated failures, recommendations, and attempt history:
node "$WA_BIN" improve failures
node "$WA_BIN" improve recommendations
node "$WA_BIN" improve history

# Pause, resume, or stop cleanly:
node "$WA_BIN" improve pause
node "$WA_BIN" improve resume
node "$WA_BIN" improve stop
```

### 7.4 Builder Operations
```bash
bash ~/.local/share/wazir-self-improvement-builder/builder.sh status
bash ~/.local/share/wazir-self-improvement-builder/builder.sh doctor
bash ~/.local/share/wazir-self-improvement-builder/builder.sh logs --follow
bash ~/.local/share/wazir-self-improvement-builder/builder.sh resume
bash ~/.local/share/wazir-self-improvement-builder/builder.sh stop
```

---

## 8. Remaining Risks & Limitations

1. **Non-Login Shell Node PATH**: On DGX Spark, non-login shells and systemd user units default to `/usr/bin:/bin` unless `/home/wael/.nvm/versions/node/v22.22.3/bin` is added to `PATH` (handled automatically by `builder.sh` and the systemd unit generated by `wa improve doctor --print-systemd-unit`).
2. **Local Model Context Ceiling**: `qwen/qwen3.8-27b` in LM Studio is currently loaded with `loaded_context_length: 8192` (though the model supports up to `262144`). Keep improvement scopes focused on specific files/modules (`files` array in `scope.json`) or increase the loaded context length in LM Studio for large multi-file refactors.
3. **Candidate Promotion Requires Explicit Operator Approval or `promote: true`**: By design, `HARDEN` and `EVOLVE` source repairs remain in isolated candidate worktrees (`STAGED`) until promoted by the operator after reviewing `wa improve history`.
