# Wazir v0.2.12 Performance Baseline & Optimization Report

**Branch:** `integration/v0.2.12-completion`  
**Host Environment:** Apple Silicon macOS (`darwin`, Node.js `v22.23.3`)  
**Live Runtimes Benchmarked:**
1. **Local LM Studio** (`http://localhost:1234/v1` — `qwen2.5-coder-14b-instruct`, `qwen/qwen3.8-27b`, `google/gemma-4-12b-qat`)
2. **NVIDIA Hosted Inference** (`https://integrate.api.nvidia.com/v1` — `nvidia/nemotron-3.5-super-vl-120b-a12b`)
*(Note: DGX Spark benchmarks are excluded per mission scope restrictions.)*

---

## 1. Root-Cause Investigation of the ~1-Second Deterministic Execution Overhead

### Problem Statement
Initial checkpoint measurements reported:
- Raw deterministic tool execution (`pwd` / `ls`): **`56–89 ms`**
- Full CLI end-to-end execution (`wa run "pwd"`): **`~1,141 ms`** (`executeTask` programmatic: **`970 ms` p50 / `1,095 ms` max**)

### Stage-by-Stage Profiling & 3 Root Causes Identified

Using `profile_stages.mjs`, we profiled every stage of the deterministic execution path and isolated the exact three sources of the ~1,000 ms overhead:

1. **Root Cause 1 (`~550–788 ms`): Redundant Full-Repository `snapshotWorkspace()` Twice (`before` and `after`) on Read-Only Deterministic Commands**:
   - In `apps/cli/src/run.ts` line 720, `runRegisteredTool` passed `verifyWorkspace: true` even when `deterministicExecution` was active (`isDeterministicCommandRequest` matched a literal read-only command: `pwd`, `ls`, `git status`, `git diff`, `git log`).
   - Because the `shell` tool descriptor has `sideEffectClass: 'MUTATING'`, `executeTool()` in `packages/tools/src/registry.ts` called `snapshotWorkspace(ctx.projectRoot)` **twice** (`before` and `after`), sequentially running `fs.lstat`, `fs.realpath(root)`, `fs.realpath(target)`, `fs.open(O_NOFOLLOW)`, `handle.stat()`, and SHA-256 hashing across all **1,610 files** in `/Users/wael/Code/Wazir` (`2 × 275 ms = 550 ms` p50, `788 ms` max).
   - **Optimization Applied**:
     - Passed `verifyWorkspace: !Boolean(deterministicExecution)` in `apps/cli/src/run.ts` so verified read-only deterministic fast-path commands skip full-repo before/after hashing while retaining `PolicyEngine.authorize()` and `proposedOracleWeakening()` security checks in full.
     - Optimized `snapshotWorkspace()` (`packages/tools/src/workspaceSnapshot.ts` and `packages/tools/src/paths.ts`) to resolve `fs.realpath(root)` once per snapshot rather than 3,220 times per snapshot, preserving `O_NOFOLLOW` and `assertSameInode` TOCTOU protections (`F-20`).

2. **Root Cause 2 (`~119 ms`): `O(N)` Redundant SQLite Ledger & Budget Queries Across 84 NVIDIA Models in `ResourceRouter.assess()`**:
   - When 84 NVIDIA models were registered on `api:nvidia`, `Scheduler.plan()` invoked `ResourceRouter.assess()` with 84 candidates.
   - Inside `ResourceRouter.assess()` (`packages/core/src/resources/router.ts`), `budget.preview()`, `budget.status()`, `this.reliability()`, and `this.msPerToken()` executed ~500 synchronous SQLite queries per `planTask()` call for the exact same `accountId` (`api:nvidia`) and time window.
   - **Optimization Applied**:
     - Pre-fetched `recentUsageRows`, `recentProviderErrors`, and `recentAmbiguousEvents` once per `assess()` invocation and memoized `budget.status(accountId)` and `budget.preview()` per `(accountId, pricing, contextLimit)`.
     - Reduced SQLite queries per `assess()` pass from ~500 to 4, cutting `planTask(engine, 'pwd')` latency from **`119.11 ms` p50 to `1.73 ms` p50 (68× speedup)** and `< 0.40 ms` with in-memory store.

3. **Root Cause 3 (`~220–350 ms` cold): Live Network `GET /v1/models` During `createEngine({ fastStartup: true })`**:
   - `createHostedProviders()` in `apps/cli/src/hostedProviders.ts` defaulted `discoverModelsRemote` to `true` even during one-shot `fastStartup: true` CLI commands (`wa run`, `wa task run`, `wa task plan`, `wa ask`), making a live HTTPS call to `https://integrate.api.nvidia.com/v1/models` on every CLI invocation.
   - **Optimization Applied**:
     - Set `discoverModelsRemote: nvidiaCfg?.capabilities?.discoverOnStartup ?? !options?.fastStartup` in `createHostedProviders()` and enabled `{ fastStartup: true }` on `wa ask`. One-shot CLI commands register `CURATED_NVIDIA_MODELS` + configured models + any `--model` pin (`ensureNvidiaModelRegistered`) locally in `0 ms` network time, while full remote catalog discovery runs in `wa providers test`, `wa doctor`, TUI, or when `discoverOnStartup: true`.

---

## 2. Before vs. After Optimization Comparison (5 Samples Each)

| Metric | Before (p50) | Before (p95 / max) | After (p50) | After (p95 / max) | Improvement |
|---|---:|---:|---:|---:|---|
| **`planTask(engine, 'pwd')` Routing & Context Compilation** | `119.11 ms` | `120.44 / 140.30 ms` | **`1.73 ms`** (`0.40 ms` mem) | `2.49 / 13.43 ms` | **68.8× faster (`-117.4 ms`)** |
| **`executeTask(engine, 'pwd')` (8.5 MB Disk Store)** | `970.00 ms` | `986.00 / 1095.00 ms` | **`352.00 ms`** | `359.00 / 419.00 ms` | **2.76× faster (`-618.0 ms`)** |
| **`executeTask(engine, 'pwd')` (`WAZIR_IN_MEMORY=1`)** | `695.00 ms` | `720.00 / 810.00 ms` | **`21.00 ms`** | `22.00 / 74.00 ms` | **33.1× faster (`-674.0 ms`)** |
| **`createEngine({ fastStartup: true })` (Disk Store)** | `395.00 ms` | `440.00 / 540.00 ms` | **`384.00 ms`** | `391.00 / 459.00 ms` | **`-81 ms` cold max (0 network calls)** |
| **`createEngine({ fastStartup: true })` (`WAZIR_IN_MEMORY=1`)** | `290.00 ms` | `320.00 / 380.00 ms` | **`60.98 ms`** | `66.95 / 243.86 ms` | **4.75× faster (`-229.0 ms`)** |
| **Full CLI Subprocess `node bin/wa.js run "pwd" --json`** | `1,141.00 ms` | `1,190.00 / 1,245.00 ms` | **`524.34 ms`** (`925.83 ms` fresh disk) | `531.16 / 565.03 ms` | **2.18× faster (`-616.7 ms`)** |
| **Single `snapshotWorkspace()` (1,610 files)** | `275.00 ms` | `275.00 / 394.00 ms` | **`229.00 ms`** | `229.00 / 367.00 ms` | **1.20× faster (`-46.0 ms` per snapshot)** |

---

## 3. Complete Multi-Sample Performance Baseline Table

All measurements collected across 5 samples (`min`, `p50`, `p95`, `max`) on `integration/v0.2.12-completion`:

| Stage / Workload | Min | p50 (Median) | p95 | Max | Notes |
|---|---:|---:|---:|---:|---|
| **CLI Cold-Start (`node bin/wa.js --version`)** | `271.03 ms` | **`283.77 ms`** | `288.90 ms` | `300.44 ms` | Node.js V8 startup + 19.9 MB CJS bundle parse |
| **Config Loading (`loadConfig()`)** | `0.05 ms` | **`0.05 ms`** | `0.08 ms` | `0.92 ms` | Local JSON config + defaults |
| **Command Classification (`isDeterministicCommandRequest` + `isConversationalFastPathRequest`)** | `0.002 ms` | **`0.004 ms`** | `0.672 ms` | `1.839 ms` | Pure regex/token classification |
| **Engine Init (`createEngine({ fastStartup: true })`, In-Memory)** | `55.40 ms` | **`60.98 ms`** | `66.95 ms` | `243.86 ms` | Parallel local runtime discovery + local-only hosted status |
| **Engine Init (`createEngine({ fastStartup: true })`, 8.5 MB Disk Store)** | `376.00 ms` | **`384.00 ms`** | `391.00 ms` | `459.00 ms` | Includes initial `JsonFileStore` parse of 8.5 MB `wazir.json` |
| **Tier 0 Deterministic: `pwd` (`executeTask`)** | `14.54 ms` | **`23.30 ms`** | `27.72 ms` | `69.96 ms` | 0 LLM calls, 0 tokens, policy-authorized |
| **Tier 0 Deterministic: `ls` (`executeTask`)** | `15.58 ms` | **`15.69 ms`** | `15.91 ms` | `17.71 ms` | 0 LLM calls, 0 tokens, policy-authorized |
| **Tier 0 Deterministic: `git status` (`executeTask`)** | `14.90 ms` | **`17.08 ms`** | `21.12 ms` | `114.25 ms` | 0 LLM calls, 0 tokens, policy-authorized |
| **Tier 0 Deterministic: `git diff` (`executeTask`)** | `15.11 ms` | **`16.06 ms`** | `16.14 ms` | `49.11 ms` | 0 LLM calls, 0 tokens, policy-authorized |
| **Tier 0 Deterministic: `git log` (`executeTask`)** | `15.13 ms` | **`15.59 ms`** | `15.71 ms` | `40.77 ms` | 0 LLM calls, 0 tokens, policy-authorized |
| **Local LM Studio (`qwen2.5-coder-14b-instruct`) TTFT** | `623.84 ms` | **`646.57 ms`** | `693.82 ms` | `8,328.66 ms` | `max` includes initial model warm-up; warm TTFT is `~646 ms` |
| **Local LM Studio (`qwen2.5-coder-14b-instruct`) Throughput** | `78.25 tok/s` | **`88.90 tok/s`** | `88.95 tok/s` | `89.00 tok/s` | Streaming generation throughput |
| **Local LM Studio (`qwen2.5-coder-14b-instruct`) Tier 1 E2E** | `264.00 ms` | **`1,029.93 ms`** | `1,548.00 ms` | `1,785.00 ms` | 0 tool calls, single LLM turn |
| **NVIDIA Hosted (`nvidia/nemotron-3.5-super-vl-120b-a12b`) TTFT** | `217.31 ms` | **`219.08 ms`** | `219.08 ms` | `888.27 ms` | Hosted NIM streaming API |
| **NVIDIA Hosted (`nvidia/nemotron-3.5-super-vl-120b-a12b`) Throughput** | `72.26 tok/s` | **`170.97 tok/s`** | `170.97 tok/s` | `178.85 tok/s` | Streaming token + reasoning throughput |
| **NVIDIA Hosted (`nvidia/nemotron-3.5-super-vl-120b-a12b`) Tier 1 E2E** | `527.30 ms` | **`565.74 ms`** | `1,340.00 ms` | `7,233.00 ms` | `max` includes extended reasoning trace on arithmetic |
| **Tier 2 Agentic Bug Repair (`qwen2.5-coder-14b-instruct`, 9 tool calls + 4 checks)** | — | **`29,391 ms`** | — | — | `glob` (`14ms`), `read` (`2ms`), `edit` (`12ms`), `build`/`test`/`lint`/`typecheck` (`142–269ms` each) |
| **Memory Consumption (Post-Benchmark RSS / Heap Used)** | — | **`108.0 MB RSS`** | — | `78.3 MB Heap` | Heap total: `98.9 MB` |
| **Token Usage & Cost (Tier 0 / Local Tier 1 / Hosted Tier 1)** | `0 tok ($0.00)` | **`28–64 tok ($0.00 local)`** | — | `~$0.0001 hosted` | Tracked in SQLite `ResourceLedger` |
