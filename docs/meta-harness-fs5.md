# Wazir Meta-Harness: Autonomous Hardware Discovery, Forge Sovereign-5 Routing, and Zero-Manual-Test Qualification

## 1. Overview

The **Wazir Meta-Harness** (`@wazir/core` `metaHarness/*`, `@wazir/workers`, and `@wazir/cli`) upgrades Wazir into a self-discovering, hardware-aware, self-testing distributed execution system across sovereign local computers, remote GPU servers, local inference runtimes, and cloud coding-agent providers.

 CLI commands (`wa hardware ...`, `wa models ...`, `wa runtimes ...`, `wa workers ...`, `wa execution ...`, `wa qualify`), natural-language operational intents (`wa "<goal>"` / `wa ask "<goal>"`), and TUI slash/prompt handlers (`/hardware`, `/execution`, `/qualify`) share a single `MetaHarnessService` inventory and scheduler state with zero duplicated business logic.

---

## 2. Core Architecture & 8-Entity Capability Graph

`CapabilityGraphBuilder` (`packages/core/src/metaHarness/capabilityGraph.ts`) models eight distinct, non-interchangeable entity types:

1. **`PhysicalHostNode`** — Deduplicated by stable OS hardware UUID (`IOPlatformUUID` on macOS, `/etc/machine-id` on Linux, `MachineGuid` on Windows) hashed into `host-<16hex>`. A machine reachable over loopback, LAN, SSH, and Tailscale remains a single host and never has its RAM or GPU VRAM counted twice.
2. **`NetworkIdentityNode`** — Per-interface reachability (`loopback`, `lan`, `tailscale`, `ssh`, `tunnel`) scoped to authorized discovery targets only.
3. **`ExecutionWorkerNode`** — Local or SSH worker capability inventory (`localExecution`, `sshExecution`, `cuda`, `metal`, `browserCapable`).
4. **`RuntimeProcessNode`** — Daemon lifecycle (`lmstudio`, `ollama`, `vllm`, `llama-cpp`) tagged `primary` vs `secondary` so an intentionally stopped secondary daemon (e.g., stopped local Ollama alongside active LM Studio) never marks the physical host unhealthy.
5. **`InferenceEndpointNode`** — Tracks `rawUrl`, `originContextHostId`, `visibility`, `transport`, and 11-state acceptance status.
6. **`LoadedModelNode`** — Explicitly distinguishes `loaded` (verified via `/api/ps`, `/api/v0/models` `state === "loaded"`, or `/api/v1/models` `loaded_instances`) from `installed_not_loaded` and `provider_managed`.
7. **`CodingAgentProviderNode`** — Cloud coding-agent integrations (`antigravity`, `codex`, `claude`, `openai`, `google`, `nvidia`, `opencode`) without inventing provider physical GPUs/RAM or unverified quotas. Under Forge Sovereign-5 (`FS5`), `claude` is strictly `DISABLED_BY_POLICY` (`0%` / `0` slots).
8. **`AgentExecutionSlotNode`** — Bounded execution concurrency slots governed by `SharedGpuAdmissionController`, accounting for co-resident runtimes and protected external GPU workloads (e.g., `isaac-sim`, rendering, training).

### Critical Loopback Isolation Rule (`127.0.0.1`)

`networkContext.ts` enforces that `127.0.0.1` / `localhost` / `[::1]` **always** refers to `originContextHostId` (the host where the socket is bound):

- A remote host's loopback endpoint (`originContextHostId: "mac_studio"`, `rawUrl: "http://127.0.0.1:1234/v1"`) is **never** dialed directly as `127.0.0.1` from `macbook_pro`, and is **never** rewritten to a guessed LAN or Tailscale IP.
- Remote loopback services are routed exclusively through an explicitly configured secure transport (e.g., SSH tunnel `http://127.0.0.1:1235/v1 -> studio:127.0.0.1:1234/v1`) or an online execution worker on that host.

---

## 3. 11-State Server Acceptance & Progressive Concurrency Qualification

`runtimeAcceptance.ts` qualifies every runtime endpoint through an explicit 11-state machine:

`UNKNOWN` / `DISCOVERED` -> `REACHABLE` -> `API_READY` -> `MODEL_READY` -> `EXECUTION_VERIFIED` -> `CAPACITY_VERIFIED` (plus operational states `SATURATED`, `DEGRADED`, `UNAVAILABLE`, and `DISABLED_BY_POLICY`).

- **No HTTP-200 False Positives**: Inventory endpoints (`/v1/models`, `/api/tags`) advance at most to `API_READY` or `MODEL_READY`. Reaching `EXECUTION_VERIFIED` requires a real bounded inference round-trip with valid completion output; cold-load warmups on the same runtime are serialized via `withRuntimeWarmupMutex` to prevent stampede HTTP 500s.
- **Empirical Concurrency Qualification (`wa hardware benchmark`)**: `qualifyRuntimeConcurrency` progressively probes concurrency levels `1..N`, halting immediately on error, timeout, latency blowup, or memory headroom threshold, followed by a post-load single-request recovery check.

---

## 4. Declarative `wazir.dev/v1` ExecutionPlan & FS5 Allocation

See [`examples/fs5.yaml`](../examples/fs5.yaml) (20 agents) and [`examples/fs5-100.yaml`](../examples/fs5-100.yaml) (100 agents with dynamic speed optimization).

- **Largest-Remainder Apportionment**: `apportionAgentsLargestRemainder` guarantees integer pool allocations sum to `total_agents` (`20 -> 7, 5, 2, 5, 1, 0`; `100 -> 35, 25, 10, 25, 5, 0`) while keeping disabled pools (`claude`) strictly at `0` under normal, saturated, and total-outage failover conditions.
- **Adaptive Speed Optimization**: `optimizeAgentAllocationForSpeed` coalesces micro-shards when `total_agents` exceeds `verifiedConcurrency * maxQueueWaves` (e.g., coalescing 100 logical agents to 28 active shards across 14 empirically verified concurrent slots in 2 waves) so local unified-memory GPUs never thrash in deep serial queues.
- **4-Quantity Pool Accounting**: Tracks `targetAllocation`, `admittedAgents`, `runningAgents` (plus `queuedAgents`), and `completedAgents` separately.
- **Durable CAS Leases & Epoch Fencing**: `DistributedExecutionController` enforces single-winner compare-and-swap task claims, monotonic fencing epochs (rejecting stale zombie worker writes), heartbeats, checkpoint recovery, and SHA-256 idempotent completion receipts.

---

## 5. CLI & Natural-Language Reference

```bash
# Hardware, Models, Runtimes & Workers
wa hardware discover [--detail] [--json]
wa hardware list [--refresh] [--json]
wa hardware inspect dgx_spark [--json]
wa hardware topology [--json]
wa hardware benchmark [--host <id>] [--max-concurrency <n>] [--json]
wa hardware capabilities [--model-billions 35] [--json]
wa hardware refresh

wa models discover --all
wa runtimes status --all
wa workers status --all

# Declarative Execution Plans & Honest Provenance Reports
wa execution plan "Implement distributed feature" --agents 100 --speed-opt --out fs5-100.yaml
wa execution run --plan examples/fs5-100.yaml
wa execution status [--detail]
wa execution report --out docs/evidence/fs5-live-qualification-report.json

# Autonomous Zero-Manual-Test Qualification (Journeys A–H + 12 Fault Injections + AT-01..AT-15)
wa qualify all

# Natural-Language Operational Intents
wa "Discover all my machines, GPUs, runtimes, and models."
wa "Which machine is best for running a 35B model?"
wa "Can I execute 100 agents using my current infrastructure?"
wa "Distribute 20 agents using FS5."
wa "Implement a small multi-file feature in a disposable test repository using multiple agents across available machines."
wa "Did it work?"
wa "Improve the execution."
```

---

## 6. Live Multi-Machine Qualification Evidence

Live execution evidence captured against the real Forge Sovereign-5 fleet (`dgx_spark` NVIDIA GB10 `121.69 GB` Unified Memory, `mac_studio` via SSH tunnel `:1235 -> :1234`, `macbook_pro` Apple M5 Pro `24 GB` Unified Memory, `antigravity`, `codex`, and `claude = DISABLED_BY_POLICY`) is recorded in [`docs/evidence/fs5-live-qualification-report.json`](./evidence/fs5-live-qualification-report.json) (`reportMode: "LIVE_OBSERVED_EXECUTION"`, `qualification.status: "QUALIFICATION_PASSED"`, `8/8` Journeys, `15/15` Acceptance Tests, `12/12` Controlled Fault Injections).
