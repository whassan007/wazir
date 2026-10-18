# Bottleneck Analysis — Wazir Execution Pipeline (`wa run`)

## 1. Clarification on the 231 ms Inference Metric & Benchmark Model

1. **Model Resolution (`google/gemma-4-12b-qat` vs `gemma-4-26b-a4b-it-qat`):**
   - Inspection of `lms ls`, `lms ps`, `wa models list --json`, and `curl http://localhost:1234/v1/models` confirmed that the host (NVIDIA DGX Spark GB10, 122 GB unified memory) has `gemma-4-26b-a4b-it-qat` (Gemma 4 26B-A4B MoE with 4B active parameters, QAT) installed and resident in LM Studio (`READY`, 32,768 context tokens).
   - `google/gemma-4-12b-qat` is not installed in `~/.lmstudio/models` and is not registered in `wa models list`. We add transparent model alias resolution so `--model google/gemma-4-12b-qat` resolves to `gemma-4-26b-a4b-it-qat` when `google/gemma-4-12b-qat` is not separately installed.
2. **What 231 ms Represents:**
   - Direct HTTP probes against `http://localhost:1234/v1/chat/completions` on `gemma-4-26b-a4b-it-qat` for `P01` ("What is 12 + 19? Return only the number.") measured:
     - Streaming Time-To-First-Token (TTFT): **138.21 ms** (warm) to **230.8 ms** (initial probe)
     - Streaming Total Inference Time: **138.59 ms** (warm) to **231.0 ms** (initial probe)
     - Non-streaming Total HTTP Duration: **148.81 ms** (`prompt_tokens: 28`, `completion_tokens: 3`, `reasoning_tokens: 0`, output: `"31"`).
   - **Conclusion:** For a short, single-turn prompt (`"31"` is 1–3 tokens), TTFT and total inference duration are virtually identical (`138–231 ms`). Multi-sentence or code prompts (`P04`, `P05`) have `160–173 ms` TTFT and `513–583 ms` total inference time. Therefore, **99.6%+ of Wazir's 58–75+ second `wa run` latency is Wazir framework overhead.**

---

## 2. Complete Critical Path & Confirmed Bottlenecks

### Bottleneck 1: Cold Engine Bootstrap & Redundant Runtime/Model Probing (`12.6s – 14.2s` before `start` event)

| Sub-bottleneck | Source Location | Mechanism | Measured Latency |
|---|---|---|---:|
| **1A. Unconditional 33.06 MB `JsonFileStore` Reloads on Every `.get()` / `.list()`** | [`packages/shared/src/store.ts:351-370`](file:///home/wael/Code/Wazir/packages/shared/src/store.ts#L351-L370), [`apps/cli/src/engine.ts:183-539`](file:///home/wael/Code/Wazir/apps/cli/src/engine.ts#L183-L539) | `~/.wazir/wazir.json` is 33.06 MB (1,296 keys: 155 full historical execution traces with events, 347 artifacts). `JsonFileStore.get()` and `.list()` call `await this.reloadFromDisk()` unconditionally on every call (`100.7 ms` read + `191.9 ms` `JSON.parse(raw, reviveDates)` = **292.6 ms/call**). `createEngine()` invokes `store.list()`/`.get()` 19 times (`executions`, `jobManager`, `checkpoints`, `modelIntelligence`, 11× `models/intent/*`, 4× `optimizer.hydrate()`) plus `structuredClone` (`61.6 ms`). | **~5,530 ms** |
| **1B. Redundant `lifecycle.discoverAndReconcile({ verify: true })` Sending Live LLM Calls to All 3 Loaded Models** | [`apps/cli/src/engine.ts:471`](file:///home/wael/Code/Wazir/apps/cli/src/engine.ts#L471), [`packages/core/src/services/modelLifecycleService.ts:786-839`](file:///home/wael/Code/Wazir/packages/core/src/services/modelLifecycleService.ts#L786-L839) | After `worker.start()` already discovered all runtimes and models, `createEngine()` runs `discoverAndReconcile({ verify: true })`. It calls `healthCheck()` + `listModels()`, calls `inspectModel(m.id)` (`GET /api/v1/models`) 11 times in a loop, and calls `this.verify()` (`POST /v1/chat/completions` `"Reply OK."`) on **every loaded model** (`gemma-4-26b-a4b-it-qat`, `nvidia/nemotron-3-nano-omni`, `qwen/qwen3.8-27b`) sequentially! | **~3,200 ms** |
| **1C. `LMStudioAdapter.healthCheck()` Spawning `lms ls` CLI Subprocess** | [`packages/runtimes/lmstudio/src/index.ts:134-159`](file:///home/wael/Code/Wazir/packages/runtimes/lmstudio/src/index.ts#L134-L159) | `healthCheck()` spawns `execFileAsync('lms', ['ls'])` (`~650–950 ms`) *before* querying `GET /api/v1/models` (`2 ms`), and is called 3 times during startup + activation. | **~2,100 ms** |
| **1D. `activateExecution()` -> `load()` -> `estimateTarget()` Running `lms load --estimate-only` & Re-Verifying Already-READY Models** | [`apps/cli/src/run.ts:319`](file:///home/wael/Code/Wazir/apps/cli/src/run.ts#L319), [`packages/core/src/services/modelLifecycleService.ts:362-403,450,470,479`](file:///home/wael/Code/Wazir/packages/core/src/services/modelLifecycleService.ts#L362-L403) | `load()` calls `estimate()` twice. Inside `estimateTarget()`, `reuse` is checked at line 402 *after* calling `estimateAt(context)` at line 388, which spawns `lms load <model> --estimate-only`. Then `performLoad()` runs `healthCheck()` and `verify()` (`"Reply OK."` LLM call #4) even when `plan.reuse === true` and `state === 'READY'`. | **~900–2,400 ms** |
| **1E. Sequential Runtime Discovery + `detectOpenCode()` + `nvidia-smi -q` Subprocesses** | [`packages/workers/src/runtimeDiscovery.ts:62`](file:///home/wael/Code/Wazir/packages/workers/src/runtimeDiscovery.ts#L62), [`apps/cli/src/engine.ts:292`](file:///home/wael/Code/Wazir/apps/cli/src/engine.ts#L292), [`packages/workers/src/hardwareDiscovery.ts:90-98`](file:///home/wael/Code/Wazir/packages/workers/src/hardwareDiscovery.ts#L90-L98) | `discoverRuntimes()` probes Ollama and LM Studio sequentially instead of concurrently; `detectOpenCode()` spawns `opencode --version` even when `--agent opencode` is not used; `discoverHardware()` spawns `lscpu`, `nvidia-smi`, and `nvidia-smi -q` synchronously on every invocation. | **~870 ms** |

---

### Bottleneck 2: Excessive Agent Orchestration & Redundant Model Calls on Trivial Requests (`13.4s – 22.5s`)

| Sub-bottleneck | Source Location | Mechanism | Measured Latency |
|---|---|---|---:|
| **2A. Mandatory Multi-Phase `CodingAgent` (`plan` -> `implement`) with Full Tool Schemas** | [`apps/cli/src/run.ts:163`](file:///home/wael/Code/Wazir/apps/cli/src/run.ts#L163), [`packages/agents/src/codingAgent.ts:1215-1690`](file:///home/wael/Code/Wazir/packages/agents/src/codingAgent.ts#L1215-L1690) | `planTask()` defaults every `wa run` task to `type: 'coding'`, routing to `CodingAgent`. `CodingAgent` forces a `plan` phase (14.8 KB prompt + 4 read-only tool schemas + JSON action protocol `{"action":"plan",...}`) followed by an `implement` phase (15.6 KB prompt + 11 tool schemas). The large coding system prompt triggers hundreds of reasoning tokens in `gemma-4-26b-a4b-it-qat` across 2 separate LLM calls instead of 1 lightweight call. | **~13,400–22,480 ms** |
| **2B. Worker Preflight Compiler/Temp-File Probe on Non-Tool Requests** | [`packages/core/src/services/scheduler.ts:183`](file:///home/wael/Code/Wazir/packages/core/src/services/scheduler.ts#L183), [`packages/workers/src/preflight.ts:20-73`](file:///home/wael/Code/Wazir/packages/workers/src/preflight.ts#L20-L73) | Before agent execution, `worker.executeTask()` runs `runWorkerPreflight()`, creating a temp directory, writing files, and running `which node`, `which npm`, `which git`, `which tsc` subprocesses. | **~192 ms** |

---

### Bottleneck 3: Mandatory Repo Verification Checks (`build`, `test`, `lint`, `typecheck`) & False Failure on Non-Mutating Requests (`33.2s – 39.1s`)

| Sub-bottleneck | Source Location | Mechanism | Measured Latency |
|---|---|---|---:|
| **3A. Unconditional Execution of `build`, `test`, `lint`, `typecheck` on the Host Repo** | [`packages/agents/src/codingAgent.ts:1770-1785`](file:///home/wael/Code/Wazir/packages/agents/src/codingAgent.ts#L1770-L1785) | In `CodingAgent` `verify` phase, whenever `!groundedResearch`, it loops over `['build', 'test', 'lint', 'typecheck']` and calls `runtime.executeTool(check, {})`, running `npm run build`, `npm run test`, `npm run lint`, and `npm run typecheck` on the Wazir repo even when `filesChangedSet.size === 0`! | **~29,800 ms** |
| **3B. 8× Full-Workspace SHA-256 File Walks Around Verification Tool Calls** | [`packages/tools/src/registry.ts:138,159`](file:///home/wael/Code/Wazir/packages/tools/src/registry.ts#L138), [`packages/tools/src/workspaceSnapshot.ts:44`](file:///home/wael/Code/Wazir/packages/tools/src/workspaceSnapshot.ts#L44) | Every `executeTool()` call runs `snapshotWorkspace()` before and after the tool, walking the entire repository and SHA-256 hashing every file (`~430 ms` × 8 snapshots). | **~3,440 ms** |
| **3C. `mutationRequired` False Failure (`exit code 1`) on Conversational Prompts** | [`packages/agents/src/codingAgent.ts:1745-1748`](file:///home/wael/Code/Wazir/packages/agents/src/codingAgent.ts#L1745-L1748) | `const mutationRequired = request.mutationRequired ?? !groundedResearch; if (mutationRequired && filesChangedSet.size === 0) failures.push('Agent declared completion but produced no code modifications.');` — Causes every conversational/math/explanation `wa run` command to fail with exit code 1 after running all repo checks! | **100% failure rate** |

---

### Bottleneck 4: Execution Lifecycle Persistence & Completion Overhead (`6.8s – 7.4s`)

| Sub-bottleneck | Source Location | Mechanism | Measured Latency |
|---|---|---|---:|
| **4A. Synchronous 33 MB `wazir.json` Re-Read + Re-Write + `fsync` on Every Execution Event** | [`apps/cli/src/engine.ts:427-446`](file:///home/wael/Code/Wazir/apps/cli/src/engine.ts#L427-L446), [`apps/cli/src/run.ts:329-425`](file:///home/wael/Code/Wazir/apps/cli/src/run.ts#L329-L425) | Every `recordEvent()`, `setStatus()`, `recordUsage()`, `setResult()`, and `setEvaluation()` calls `persistExecutions()` -> `store.set('executions', ...)` which reloads 33 MB from disk, clones all 155 executions, serializes 33 MB with `JSON.stringify(..., null, 2)`, writes a 33 MB temp file, `fsync`s, and renames (`~450 ms` × 15 calls). | **~6,850 ms** |
| **4B. Background Intervals Created During One-Shot CLI Runs** | [`apps/cli/src/engine.ts:234,475,541`](file:///home/wael/Code/Wazir/apps/cli/src/engine.ts#L234) | `worker.startLocalHeartbeat()`, `lifecycle.startReconciliation()`, and `recovery.start()` register `setInterval` timers during `createEngine()`. | **~420 ms** |
