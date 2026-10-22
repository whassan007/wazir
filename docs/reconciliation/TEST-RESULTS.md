# Test & Live Benchmark Results (v0.2.12 Final)

All verification commands executed on branch `integration/v0.2.12-completion` (Node v22.23.3, macOS darwin/arm64, Apple Silicon 24 GiB unified memory).

---

## 1. Full Typecheck, Lint, Security Audit & Workspace Build

```bash
npx tsc --build --force
npm run lint
npm audit --omit=dev
npm run build
```

- **TypeScript (`tsc --build`)**: Clean, **0 errors** across all 26 workspaces.
- **Lint (`npm run lint`)**: Clean, **0 errors**.
- **Production Dependency Security (`npm audit --omit=dev`)**: **0 vulnerabilities** (fixed `@modelcontextprotocol/client` -> `1.29.0` and `shell-quote` -> `1.8.4`).
- **Full Build (`npm run build`)**: Clean, **0 errors**. Builds all TypeScript packages, Rust/Tauri desktop (`apps/desktop/src-tauri/target/release/wazir-desktop`), web dashboard, worker daemon, and bundles the standalone CLI (`bin/wa.js`, 18.6 MB in 435 ms).

---

## 2. Automated Test Suite Results (Unit, Integration, Security, TUI, Live-Coding Gates, E2E)

| Suite Group | Test Files | Passed | Skipped | Failed |
|---|---|---|---|---|
| **Core & Domain Packages** (`core`, `tools`, `agents`, `shared`, `scheduler`, `policies`, `registry`, `database`, `workers`, `observability`, `memory`, `secrets`, `evaluation`, `models`) | 203 | 1,613 | 22 | **0** |
| **Runtime Adapters** (`nvidia`, `lmstudio`, `ollama`, `openai`, `anthropic`, `google`) | 13 | 74 | 0 | **0** |
| **Applications & TUI** (`apps/cli`, `apps/api`) | 87 | 652 | 1 | **0** |
| **Top-Level Integration & Distributed Suites** (`tests/live`, `test/distributed`, `test/runtime`) | 12 | 10 | 8 | **0** |
| **Live NVIDIA Smoke Suite** (`WAZIR_LIVE_NVIDIA_SMOKE=1`) | (1) | (10/10) | 0 | **0** |
| **TOTAL** | **315** | **2,349** (2,350 w/ live NVIDIA smoke) | **31** | **0** |

### Skipped Tests Classification (31 Total — All Justified)

| Test File | Skipped | Classification | Reason |
|---|---|---|---|
| `packages/database/tests/postgresStore.test.ts` | 9 | **Justified** | Requires live PostgreSQL instance via `WAZIR_TEST_DATABASE_URL` |
| `packages/database/tests/createStore.test.ts` | 3 | **Justified** | Requires live PostgreSQL instance via `WAZIR_TEST_DATABASE_URL` |
| `packages/tools/tests/sandbox.test.ts` | 10 | **Justified** | Linux-only `bubblewrap` (`bwrap`) + `seccomp` tests skipped on macOS (`darwin` runs the 10 Seatbelt `sandbox-exec` tests) |
| `test/distributed/*.test.ts` | 7 | **Justified** | Opt-in distributed cluster harness requiring `WAZIR_DISTRIBUTED_TESTS=1` |
| `test/runtime/liveModelLifecycle.test.ts` | 1 | **Justified** | Opt-in live remote GPU lifecycle probe requiring `WAZIR_LIVE_TESTS=1` |
| `apps/cli/tests/nvidiaProviderSystem.test.ts` | 1 | **Justified** | Opt-in live NVIDIA smoke test (`WAZIR_LIVE_NVIDIA_SMOKE=1`); verified passing (`10/10`) when enabled |

### Key Subsystem Verification Breakdown

1. **Canonical NVIDIA Provider (`packages/runtimes/nvidia/tests/nvidiaAdapter.test.ts` + `apps/cli/tests/nvidiaProviderSystem.test.ts`)**:
   - **25/25 tests pass** (15 unit tests + 10 system/live integration tests, including Test 23 live smoke test against `https://integrate.api.nvidia.com/v1` on `nvidia/nemotron-3.5-super-vl-120b-a12b`).
2. **Mission Control TUI & Terminal Hygiene (18 test files, 227 tests)**:
   - `missionControl.test.ts` (5), `missionControlGates.test.ts` (8), `missionControlWidths.test.ts` (4), `fleetTui.test.ts` (57), `terminalArchitecture.test.ts` (45), `terminalIntegrity.test.ts` (17), `pasteBarrier.test.ts` (18), `sessionEof.test.ts` (12), `tuiSessionLifecycle.test.ts` (10), `conversationProjection.test.ts` (12), `acceptanceTui.test.ts` (10), `observabilityGates.test.ts` (4), `promptCacheView.test.ts` (9), `verificationEvidenceView.test.ts` (4), `canaryTui.test.ts` (7): **227/227 pass**.
3. **Execution Architecture, Fast-Path, Performance & Subagent Guardrails**:
   - `apps/cli/tests/executionPerformance.test.ts` (7/7 pass — includes `ResourceRouter.assess` batch ledger caching regression test across 84 models)
   - `packages/agents/tests/chatAgent.test.ts` (6/6 pass)
   - `packages/agents/tests/codingAgent.deterministicCommand.test.ts` (23/23 pass)
   - `packages/agents/tests/codingAgent.verificationFailureAnswer.test.ts` (2/2 pass)
   - `packages/agents/tests/verificationScope.test.ts` (12/12 pass)
   - `packages/tools/tests/checkToolsScoping.test.ts` (2/2 pass)
   - `packages/tools/tests/repoIntegrityGuard.test.ts` (4/4 pass)
   - `packages/tools/tests/security.test.ts` (18/18 pass)
   - `apps/cli/tests/delegationVerification.e2e.test.ts` (5/5 pass)
   - `apps/cli/tests/executeTask.e2e.test.ts` (10/10 pass)
   - `apps/cli/tests/subagentFleetPlacement.test.ts` (5/5 pass)
   - `packages/core/tests/modelLifecycleAdmission.test.ts` (24/24 pass)

---

## 3. Phase 4 Performance Optimization & Live Runtime Benchmark Summary

See [`docs/reconciliation/PERFORMANCE-BASELINE.md`](./PERFORMANCE-BASELINE.md) for the complete p50/p95/max tables across all tiers and providers.

| Metric | Pre-Optimization (v0.2.12 Checkpoint) | Post-Optimization (v0.2.12 Final) | Improvement |
|---|---|---|---|
| **`planTask(engine, 'pwd')` (84 NVIDIA models)** | `119.11 ms` p50 | **`1.73 ms` p50** (`0.40 ms` in-mem) | **-98.5% (68.8× faster)** |
| **`executeTask(engine, 'pwd')` (disk SQLite store)** | `970.40 ms` p50 | **`352.66 ms` p50** | **-63.7% (2.75× faster)** |
| **`executeTask(engine, 'pwd')` (`WAZIR_IN_MEMORY=1`)** | `692.00 ms` p50 | **`21.02 ms` p50** | **-97.0% (32.9× faster)** |
| **Full CLI Subprocess (`node bin/wa.js run "pwd" --json`)** | `1,141.00 ms` | **`524.34 ms` p50** (`167.26 ms` in-mem) | **-54.0% (-85.3% in-mem)** |
| **`snapshotWorkspace(projectRoot)` (1,610 files)** | `275.38 ms` p50 | **`229.02 ms` p50** | **-16.8% faster** |
| **`createEngine({ fastStartup: true })` (in-memory)** | `~280 ms` (w/ remote `/v1/models`) | **`60.98 ms` p50** | **-78.2% faster** |
| **Live NVIDIA Hosted TTFT (`nemotron-3.5-super-vl-120b-a12b`)** | `392.00 ms` | **`219.08 ms` p50** (`170.97 tok/s`) | Verified live |
| **Live Local LM Studio TTFT (`qwen2.5-coder-14b-instruct`)** | `405.00 ms` | **`646.57 ms` p50** (`88.90 tok/s`) | Verified live |
