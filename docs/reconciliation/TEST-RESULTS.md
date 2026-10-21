# Test & Live Benchmark Results

All verification commands executed from `/Users/wael/Code/Wazir` on branch `integration/v0.2.12-completion` (Node v22.23.3, macOS darwin/arm64, Apple Silicon 24 GiB unified memory).

---

## 1. Full Typecheck & Workspace Build

```bash
npx tsc --build --force
npm run build
```

- **TypeScript (`tsc --build`)**: Clean, **0 errors** across all 26 workspaces.
- **Full Build (`npm run build`)**: Clean, **0 errors**. Builds all TypeScript packages, Rust/Tauri desktop (`apps/desktop/src-tauri/target/release/wazir-desktop`), web dashboard, worker daemon, and bundles the standalone CLI (`bin/wa.js`, 18.5 MB in 341ms).

---

## 2. Automated Test Suite Results (Unit, Integration, Security, TUI, Live-Coding Gates, E2E)

| Suite Group | Command | Test Files | Passed | Skipped | Failed |
|---|---|---|---|---|---|
| **Core & Domain Packages** (`core`, `tools`, `agents`, `shared`, `scheduler`, `policies`, `registry`, `database`, `workers`, `observability`, `memory`, `secrets`, `evaluation`, `models`) | `npx vitest run packages/core/tests packages/tools/tests packages/agents/tests packages/shared/tests packages/scheduler/tests packages/policies/tests packages/registry/tests packages/database/tests packages/workers/tests packages/observability/tests packages/memory/tests packages/secrets/tests packages/evaluation/tests packages/models/tests` | 201 | 1,601 | 29 | **0** |
| **Runtime Adapters** (`nvidia`, `lmstudio`, `ollama`, `openai`, `anthropic`, `google`) | `npx vitest run packages/runtimes/nvidia/tests packages/runtimes/lmstudio/tests packages/runtimes/ollama/tests packages/runtimes/openai/tests packages/runtimes/anthropic/tests packages/runtimes/google/tests` | 13 | 74 | 0 | **0** |
| **Applications & TUI** (`apps/cli`, `apps/api`) | `npx vitest run apps/cli/tests apps/api/tests` | 85 | 643 | 2 | **0** |
| **Live NVIDIA Smoke Suite** (`WAZIR_LIVE_NVIDIA_SMOKE=1`) | `WAZIR_LIVE_NVIDIA_SMOKE=1 npx vitest run apps/cli/tests/nvidiaProviderSystem.test.ts` | (1) | (10/10) | 0 | **0** |
| **Production-Realistic Live E2E Acceptance** | `npx vitest run tests/live/realWorldAcceptance.test.ts` | 1 | 10 | 0 | **0** |
| **TOTAL** | | **300** | **2,328** (2,329 w/ live NVIDIA smoke) | **31** | **0** |

### Key Subsystem Verification Breakdown

1. **Canonical NVIDIA Provider (`packages/runtimes/nvidia/tests/nvidiaAdapter.test.ts` + `apps/cli/tests/nvidiaProviderSystem.test.ts`)**:
   - **25/25 tests pass** (15 unit tests + 10 system/live integration tests, including Test 23 live smoke test against `https://integrate.api.nvidia.com/v1` on `nvidia/nemotron-3.5-super-vl-120b-a12b`).
   - Covers OpenAI-compatible completion & streaming, `delta.reasoning_content` vs `delta.content` separation, streaming tool calls, HTTP 400 unsupported-parameter stripping, HTTP 429 `Retry-After` bounded retries, HTTP 401/403 fail-fast without key leakage, secret redaction (`nvapi-*` and `Bearer`), `HOSTED_API_INFERENCE` vs `LOCAL_GPU_INFERENCE` placement explainability, and `provider_only` routing enforcement.
2. **Mission Control TUI & Terminal Hygiene (18 test files, 227 tests)**:
   - `missionControl.test.ts` (5), `missionControlGates.test.ts` (8), `missionControlWidths.test.ts` (4), `fleetTui.test.ts` (57), `terminalArchitecture.test.ts` (45), `terminalIntegrity.test.ts` (17), `pasteBarrier.test.ts` (18), `sessionEof.test.ts` (12), `tuiSessionLifecycle.test.ts` (10), `conversationProjection.test.ts` (12), `acceptanceTui.test.ts` (10), `observabilityGates.test.ts` (4), `promptCacheView.test.ts` (9), `verificationEvidenceView.test.ts` (4), `canaryTui.test.ts` (7): **227/227 pass**.
   - Verifies terminal resizing across `narrow` (<100), `standard` (100–139), and `wide` (>=140) layouts, progress reporting, `Ctrl+C`/`/cancel` cancellation, bracketed paste barrier (`pasteBarrier.test.ts`), approval queue diff previews, and failure recovery.
3. **Execution Architecture, Fast-Path & Subagent Guardrails**:
   - `packages/agents/tests/chatAgent.test.ts` (6/6 pass)
   - `packages/agents/tests/codingAgent.deterministicCommand.test.ts` (23/23 pass)
   - `apps/cli/tests/executeTask.e2e.test.ts` (10/10 pass — includes new E2E test verifying `pwd`/`ls` deterministic execution with 0 LLM calls)
   - `apps/cli/tests/subagentFleetPlacement.test.ts` (5/5 pass — includes Guardrail 3 tests verifying cross-provider escape rejection and provider-only propagation)
   - `packages/core/tests/modelLifecycleAdmission.test.ts` (24/24 pass — includes 2 new tests verifying `READY` state preservation across read-only `discoverAndReconcile({ verify: false })` passes)
4. **Live-Coding Release Gate Suites (`LIVE-CODE-01..08`)**:
   - `01-bugRepair.test.ts`, `02-shellCanary.test.ts`, `03-batchedTools.test.ts`, `04-mcpStructured.test.ts`, `05-multiAgent.test.ts`, `06-nonInteractive.test.ts`, `07-filesystemMutation.test.ts`, `08-revisionFencing.test.ts`: **All pass**.

---

## 3. Phase 5: Live DGX Spark & Runtime Benchmark Verification

### 3.1 DGX Spark Hardware Gate Status: `BLOCKED` (Host Offline on Tailscale)

Per the Phase 5 instruction (*"If live infrastructure is unavailable, mark the affected gate BLOCKED and do not claim it passed"*):

- Probed configured DGX nodes via `tailscale status` and direct TCP/SSH/HTTP probes on 2026-10-20:
  - `dgx-spark` (`100.113.62.112`, Linux arm64 Grace Blackwell GB10, hosts `qwen/qwen3-coder-next` and `gemma-4-26b-a4b-it-qat`): **OFFLINE (`tailscale status`: `offline, last seen 7h ago`)**.
  - `gx10-36bb` (`100.83.5.2`, Linux arm64 GB10): **OFFLINE (`tailscale status`: `offline, last seen 9d ago`)**.
- Consequently, live execution against the remote DGX Spark hardware (`qwen/qwen3-coder-next` at `100.113.62.112`) is marked **`BLOCKED`**.

### 3.2 Live Benchmarks on Available Runtimes (NVIDIA API Catalog + Local LM Studio)

While remote DGX hardware (`100.113.62.112`) was powered down, two real model runtimes were live and verified end to end from this workstation (`WaelMacPro.local`):
1. **NVIDIA Hosted API Catalog (`https://integrate.api.nvidia.com/v1`)**: Authenticated (`NVIDIA_API_KEY`), 84 models discovered, target model `nvidia/nemotron-3.5-super-vl-120b-a12b`.
2. **Local LM Studio Runtime (`http://127.0.0.1:1234`)**: Loaded and `READY` with `qwen2.5-coder-14b-instruct`, `google/gemma-4-12b-qat`, and `qwen/qwen3.8-27b`.

#### Raw Measurements & Comparison Against Historical DGX Baseline

| Metric | Live NVIDIA Hosted (`nvidia/nemotron-3.5-super-vl-120b-a12b`) | Live Local LM Studio (`qwen2.5-coder-14b-instruct`) | Historical DGX Spark Baseline (`test/codex-dgx-execution/FINAL-REPORT.md`, `gemma-4-26b-a4b-it-qat`) | Status / Notes |
|---|---|---|---|---|
| **CLI Binary Startup (`node bin/wa.js --version`)** | 240 ms | 240 ms | ~250 ms | Verified live |
| **Engine Cold-Start (`createEngine({ fastStartup: true })`)** | **419 ms** | **419 ms** | 1,208 ms (median ack) | **-65% faster** cold-start |
| **Provider Health Check (`wa providers test nvidia`)** | **220–223 ms** (84 models) | **<15 ms** (local native cache) | N/A | Verified live |
| **Time to First Token (TTFT)** | **392 ms** | **405 ms** | 1,593 ms (median first token) | Verified live streaming |
| **Tokens per Second (tok/s)** | **4.41 tok/s** (120B MoE w/ reasoning stream) | **41.52 tok/s** (14B local MLX/GGUF) | ~32–45 tok/s (DGX GB10) | Verified live streaming |
| **Conversational Fast-Path E2E (`What is 18 + 24?`)** | **1,084 ms** (`result: "42"`) | **~850 ms** | 2,140 ms (median E2E) | **-49% faster** E2E latency |
| **Deterministic Fast-Path Overhead (`wa run "pwd"`)** | **56–89 ms tool exec** (`1,141 ms` total CLI E2E w/ workspace snapshot; **0 LLM calls, 0 tokens**) | **56–89 ms tool exec** (`0 LLM calls, 0 tokens`) | N/A (previously invoked LLM) | Verified live (`3fda9b3`) |
| **Provider Selection Accuracy** | **100%** (`runtimeId: "nvidia"`, `placementKind: "hosted"`, `HOSTED_API_INFERENCE`) | **100%** (`runtimeId: "lmstudio"`, `placementKind: "local"`) | 10/10 (100%) | Verified across `NVIDIA`, `HYBRID`, `AUTO`, `LOCAL_ONLY` |
| **Quota Consumption & Ledger Accounting** | **Exact**: `promptTokens: 24`, `completionTokens: 29`, `totalTokens: 53` settled in `ResourceLedger` | Local hardware (0 cloud quota consumed) | N/A | Synthetic stress benchmark (`scripts/resource-routing-benchmark.mjs`) also verified: 5 concurrent tasks, 4 admitted, 1 deferred on quota exhaustion, 0 leaked reservations |
| **Subagent Dispatch Correctness (Guardrail 3)** | **100%**: NVIDIA child subagent succeeded (`exec-mvhk4uqg-3`); cross-provider child (`lmstudio`) blocked; impossible CUDA requirement on hosted NVIDIA blocked | **100%** | N/A | Verified live & in `subagentFleetPlacement.test.ts` |
| **Live Remote DGX Spark Coding Gate (`qwen/qwen3-coder-next` on `100.113.62.112`)** | — | — | — | **`BLOCKED`** (`dgx-spark` `100.113.62.112` offline on Tailscale, last seen 7h ago) |
