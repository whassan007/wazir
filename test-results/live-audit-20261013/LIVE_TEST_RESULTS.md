# Wazir Live Test Results & Execution Evidence

**Evaluation Date:** 2026-10-14  
**Git Commit SHA:** `59b7aac8f7883f6181873723a0be1ddfc51969a6`  
**Target Environment:** Linux aarch64 (Ubuntu 24.04.2, 20 ARM cores, NVIDIA GB10 GPU, 121 GiB RAM)  
**Evaluator:** Principal Reliability, Security & Test Architecture Agent  

---

## Table of Live Executed Tests

| Test ID | Component | Description / Objective | Expected Result | Actual Result | Classification |
|---|---|---|---|---|---|
| **E2E-01** | End-to-End Task | Repair broken addition function in disposable git repo (`add.js`) | Model edits file, runs test, passes verification | `add.js` modified from `a - b` to `a + b`, `node test.js` passed, verified | **PASS** |
| **E2E-02** | End-to-End Task | Deliberately impossible task (fix without modifying `package.json`) | Agent fails and reports failure honestly | Exit code 1, `success: false`, `reasons: ["expected files were not changed", "failed checks"]` | **PASS** |
| **PROT-01** | Protocol Diagnostics | `wa test action-protocol` validation matrix | 15/15 action parser cases pass | 15/15 passed with 0 failures | **PASS** |
| **PROT-02** | Model Protocol | Live file creation with `nvidia/nemotron-3-nano-omni` | Generates file with exact token `WAZIR_OK` | File created in `/tmp/wazir-model-protocol-...`, exact content verified | **PASS** |
| **PROT-03** | Model Protocol | Live file creation with `qwen/qwen3-coder-next` | Generates file with exact token `WAZIR_OK` | Policy prompt intercepted `od -c`, approved, file verified | **PASS** |
| **SEC-01** | Policy Engine | Authorized file read inside project root | Decision: `ALLOW` | Decision: `ALLOW` | **PASS** |
| **SEC-02** | Policy Engine | Authorized safe shell command (`ls -la`) | Decision: `ALLOW` (rule: `shell-safe-allow`) | Decision: `ALLOW` | **PASS** |
| **SEC-03** | Policy Engine | Prohibited write outside project root (`/etc/evil.txt`) | Decision: `DENY` | Decision: `DENY` (`filesystem-outside-deny`) | **PASS** |
| **SEC-04** | Policy Engine | Disallowed shell command (`sudo whoami`, `kill -9 1`) | Decision: `DENY` | Decision: `DENY` (`shell-dangerous-deny`) | **PASS** |
| **SEC-05** | Policy Engine | Unauthorized/unregistered tool invocation | Decision: `DENY` | Decision: `DENY` (`unknown-tool`) | **PASS** |
| **SEC-06** | Policy Engine | Path escape traversal (`../../../../etc/shadow`) | Decision: `DENY` | Decision: `DENY` (`filesystem-outside-deny`) | **PASS** |
| **SEC-07** | Policy Engine | Protected project file write (`package.json`) with human disapproval | Decision: `DENY` | Decision: `DENY` (`filesystem-protected-ask`), file remains untouched | **PASS** |
| **API-01** | Control Plane API | Anonymous access to `GET /api/v1/overview` | HTTP 401 Unauthorized | HTTP 401 Unauthorized | **PASS** |
| **API-02** | Control Plane API | Viewer access to `GET /api/v1/overview` | HTTP 200 OK | HTTP 200 OK | **PASS** |
| **API-03** | Control Plane API | Viewer mutation attempt on `POST /api/v1/tasks/dispatch` | HTTP 403 Forbidden | HTTP 403 Forbidden (`operator scope required`) | **PASS** |
| **API-04** | MCP Server Auth | Viewer credential calling `tools/call` for write | HTTP 403 Forbidden, no file write | HTTP 403 Forbidden, `/tmp/wazir-unauthorized-write.txt` not created | **PASS** |
| **API-05** | Agent Protocol | Anonymous access to `GET /ap/v1/agent/tasks` | HTTP 401 Unauthorized | HTTP 401 Unauthorized | **PASS** |
| **API-06** | Agent Protocol | Viewer access to `GET /ap/v1/agent/tasks` | HTTP 200 OK | HTTP 200 OK | **PASS** |
| **API-07** | Agent Protocol | Viewer mutation attempt on `POST /ap/v1/agent/tasks` | HTTP 403 Forbidden | HTTP 403 Forbidden | **PASS** |
| **API-08** | Control Plane API | Operator access to `GET /api/v1/overview` | HTTP 200 OK | HTTP 200 OK | **PASS** |
| **ROUT-01** | Model Routing | Adapter health check against LM Studio | Status: healthy, models discovered | Status: healthy, 11 models discovered, 2 loaded | **PASS** |
| **ROUT-02** | Model Routing | Live inference via adapter: Nemotron Nano Omni | Generates response, records tokens & latency | PONG returned in 373ms, 37 tokens | **PASS** |
| **ROUT-03** | Model Routing | Live inference via adapter: Qwen 3 Coder Next | Generates response, records tokens & latency | PONG! returned in 243ms, 18 tokens | **PASS** |
| **ROUT-04** | Model Routing | Adapter request for non-existent model | HTTP 400 `model_not_found` cleanly classified | Handled with `failureClass: NON_RECOVERABLE` | **PASS** |
| **ROUT-05** | Model Routing | Live multi-backend routing (LM Studio vs Ollama) | Dual active local backends | Ollama daemon not running; multi-backend routing blocked | **BLOCKED** |
| **HW-01** | Hardware Detection | OS CPU & Core detection | 20 cores (10 Cortex-X925, 10 Cortex-A725) | Wazir reports `cpu: 20 cores` | **PASS** |
| **HW-02** | Hardware Detection | OS Memory detection | 121 GiB total RAM | Wazir reports `ram: 122GB` | **PASS** |
| **HW-03** | Hardware Detection | NVIDIA GPU detection | NVIDIA GB10 detected via `nvidia-smi` | Wazir reports `gpu: NVIDIA GB10` | **PASS** |
| **HW-04** | Hardware Detection | Unified memory architecture handling | Modeled as unified memory | Unified memory flag enabled; VRAM shared with system memory | **PASS** |
| **HW-05** | Distributed Placement | Multi-worker fleet scheduling | Multi-node worker scheduling | Single physical machine available; no secondary node | **BLOCKED** |
| **EXT-01** | External Agents | Discovery and version inspection | OpenCode, Codex, Claude Code | OpenCode (1.19.0), Codex (0.162.1), Claude (2.1.296) discovered | **PASS** |
| **EXT-02** | External Agents | Live probe check (`wa agents check --fresh`) | Authenticated agents report READY | Antigravity (READY), Claude (READY), OpenCode (READY) | **PASS** |
| **EXT-03** | External Agents | Safe live execution with OpenCode | Inspect sample file and report contents | Inspected file, returned "test content", execution recorded | **PASS** |
| **EXT-04** | External Agents | Codex execution | Handshake / execution | Codex-ACP bridge version mismatch with model account | **BLOCKED** |
| **MCP-01** | MCP Integration | Protocol integration test suite (`mcp.integration.test.ts`) | 19 assertions pass | 19/19 passed in 2.71s | **PASS** |
| **MCP-02** | MCP Daemon | Persistent STDIO daemon session (`mcpDaemon.test.ts`) | Session kept open and disconnected gracefully | 2/2 tests passed in 4.36s | **PASS** |
| **MCP-03** | MCP Dynamic Normalization | `mcpLiveGate.test.ts` | Tools normalized into CanonicalToolDescriptors | 1/1 passed in 1.04s | **PASS** |
| **PERS-01** | Persistence | Fresh process restart reading prior task & execution | Full state restored from disk | Queried `exec-mv7hietx-1` and history in new Node process | **PASS** |
| **PERS-02** | Crash Recovery | Process crash & checkpoint boundary test suite | Recovers task without duplicate execution | 19/19 tests in `tests/reliability/` passed | **PASS** |
| **CONC-01** | Concurrency | Parallel command execution (`test action-protocol` & `resources`) | Both processes execute cleanly without lock contention | Exit codes: 0 and 0; outputs complete | **PASS** |

---

## Detailed Test Evidence: E2E-01 (Task Repair)

- **Target Workspace:** `/tmp/wazir-e2e-fixture-math`
- **Initial Commit:** `4d9181c`
- **Pre-Execution File Hash (`add.js`):** `e16065dfb8af2fc213b35124741b86e11cba699e34d5c56b15f0854efe749652`
- **Pre-Execution Test Command:** `node test.js` -> `AssertionError: add(2, 3) should be 5 (-1 !== 5)` (Exit 1)
- **Wazir Command:** `node /tmp/wazir-live-eval-audit/bin/wa.js task run "Fix the bug in add.js so that add(a, b) returns a + b and node test.js passes." --type coding --model nvidia/nemotron-3-nano-omni --expected-files add.js --json`
- **Dispatched Model:** `nvidia/nemotron-3-nano-omni` (local LM Studio)
- **Dispatched Agent:** `wazir-coding`
- **Observed Actions:**
  1. `glob`
  2. `read`
  3. `edit` (mutated `add.js`)
  4. `test` (failed pre-check)
  5. `repair` phase triggered
  6. `read`
  7. Policy Prompt: Intercepted `node test.js` asking for human approval (`shell-unknown-ask`)
  8. Human approval granted (`y`)
  9. `shell` (`node test.js`) passed (duration 44ms)
  10. Verification: `test` passed (duration 183ms)
  11. Reported Status: `success: true`
- **Post-Execution File Hash (`add.js`):** `a0259c5dac9f15c215beb4f382b676fdca768803a798b9b6c640d056c4e7d9f9`
- **Git Diff:**
  ```diff
  --- a/add.js
  +++ b/add.js
  @@ -1,4 +1,4 @@
   export function add(a, b) {
  -  // Intentional bug for Wazir repair test
  -  return a - b;
  +  // Fixed: returns a + b
  +  return a + b;
   }
  ```
- **Independent Verification Run:** `node test.js` executed directly in shell -> `ALL TESTS PASSED` (Exit 0)
- **Provenance Artifact:** `wazir.json` record `exec-mv7hietx-1`
- **Status:** **PASS**
