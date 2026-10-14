# Wazir Persistence, Restart Recovery & Durability Report

**Evaluation Date:** 2026-10-14  
**Evaluator:** Principal Reliability & Storage Systems Engineer  
**Test Storage Path:** `WAZIR_HOME=/tmp/wazir-test-home-eval`  

---

## 1. Storage Architecture Overview

Wazir implements multi-tiered durable persistence:
1. **JSON Document Store (`wazir.json`):** Tracks tasks, execution histories, agent turn records, and tool execution outputs.
2. **SQLite Database Store (`resources.db`):** Maintains economic metrics, token quotas, telemetry series, and hardware capacity models.
3. **Append-Only Audit Log (`audit.jsonl`):** Records immutable policy decisions and tool authorization timestamps.
4. **Configuration State (`mcp.json`, `agent-preflight.json`, `config.json`):** Persists external integrations and probe states.

---

## 2. Process Restart & Task Recovery Verification

### Test Protocol
1. Executed end-to-end task `task-12a13a13c55290b968a980ee03b2a5a5` generating execution record `exec-mv7hietx-1`.
2. Terminated the original Node.js process and closed all open descriptors.
3. Spawned an independent Node.js process with the same `WAZIR_HOME`.
4. Queried the execution record via CLI:
   ```bash
   wa evaluation show exec-mv7hietx-1
   wa history list
   ```

### Observations
- **Execution Recovery:** The new process immediately recognized `exec-mv7hietx-1` without data loss. It printed the full quantitative evaluation record:
  - 9 model requests (measured)
  - 48,685 input tokens, 814 output tokens
  - 12 tool calls
  - Termination status: `VERIFICATION_PASSED`
- **History Recovery:** `wa history list` displayed historical entries across prior sessions (`doctor failed 4m ago`, `doctor failed 35m ago`).
- **Resource DB State:** `resources.db` preserved GPU utilization history and 24h token usage tables.

---

## 3. Crash Point Recovery & Checkpoint Boundaries

Evaluated against the `tests/reliability/` test suites (19 tests executed via Vitest):

| Suite | Focus Area | Assertions | Result |
|---|---|---|---|
| `checkpointBoundary.test.ts` | Atomic boundaries before tool dispatch, during mutation, before result write | 5 tests | **PASS** |
| `checkpointDurability.test.ts` | State persistence across simulated SIGKILL / SIGTERM | 2 tests | **PASS** |
| `memoryDurability.test.ts` | Invalidation and memory record survival across independent processes | 1 test | **PASS** |
| `recoveryProcess.test.ts` | Interrupted task resumption and lease reclamation | 2 tests | **PASS** |
| `providerFaults.test.ts` | Provider socket disconnects, retry policies, backoff ceilings | 8 tests | **PASS** |
| `webBinding.test.ts` | Loopback binding security and proxy session survival | 1 test | **PASS** |

### Duplicate Execution Prevention
- When an execution is terminated or crashed mid-turn, Wazir marks the execution as interrupted or failed.
- Tools are never blindly re-dispatched upon recovery.
- Verification evidence is revision-bound: modifications require fresh check evaluations (`test`, `build`, `lint`) against the current workspace revision. Model assertions without fresh verification evidence are rejected.
