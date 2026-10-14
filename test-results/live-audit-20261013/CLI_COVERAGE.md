# Wazir CLI Command Coverage & Subcommand Verification

**Executable Binary:** `./bin/wa.js` (Standalone bundled executable, 17.9 MB)  
**Package Manifest Entry:** `"bin": { "wa": "./bin/wa.js" }`  
**Execution Context:** Isolated `WAZIR_HOME=/tmp/wazir-test-home-eval`  
**Target Git Commit:** `59b7aac8f7883f6181873723a0be1ddfc51969a6`  

---

## 1. Top-Level Discovery & Command Matrix

Every command discovered in `--help` was subjected to three distinct phases:
1. **Discovery:** Verification of `--help` documentation and flag recognition.
2. **Live Invocation:** Meaningful, non-destructive execution against live runtime and store.
3. **Negative Testing:** Submitting invalid flags, missing arguments, or bogus entity IDs to verify proper error reporting and rejection.

| Index | Command | Discovery (`--help`) | Live Invocation | Negative Testing | Primary Finding / Observation |
|---|---|---|---|---|---|
| 1 | `version` | **PASS** | **PASS** | **PASS** (rejected) | Outputs SemVer `0.1.60`, commit SHA `59b7aac`, node version, build date in JSON. |
| 2 | `doctor` | **PASS** | **PASS (1)** | **PASS** (rejected) | Accurately identifies LM Studio as HEALTHY and Ollama as UNREACHABLE (diagnosed with exit code 1). |
| 3 | `status` | **PASS** | **PASS** | **PASS** (rejected) | Correctly outputs system status, control plane version, configDir, and project root. |
| 4 | `config` | **PASS** | **PASS** | **PASS** (rejected) | `wa config show` outputs active JSON configuration; bare command prompts for subcommand. |
| 5 | `resources` | **PASS** | **PASS** | **PASS** (rejected) | Outputs RAM, GPU (NVIDIA GB10), local runtimes, and 24h economics in JSON. |
| 6 | `computers` | **PASS** | **PASS** | **FAIL** (accepted) | `wa computers list` shows local 20 cores 122GB GB10; `inspect <bogus>` exits 0 instead of 1. |
| 7 | `workers` | **PASS** | **PASS** | **PASS** (rejected) | Lists local worker with connected runtimes and models. |
| 8 | `runtimes` | **PASS** | **PASS** | **FAIL** (accepted) | Lists LM Studio and Ollama runtimes; `inspect <bogus>` exits 0 with empty output. |
| 9 | `models` | **PASS** | **PASS** | **FAIL** (accepted) | Discovers all 11 models from LM Studio; `inspect <bogus>` outputs empty json with exit 0. |
| 10 | `agents` | **PASS** | **PASS** | **PASS** (rejected) | Lists native agents and external agents; `check` performs live probe. |
| 11 | `policy` | **PASS** | **PASS** | **PASS** (rejected) | `explain` correctly classifies shell commands into ALLOW/ASK/DENY. Note: `inspect` fixed. |
| 12 | `tools` | **PASS** | **PASS** | **PASS** (rejected) | Lists built-in tools (read, write, edit, glob, shell, git, test, etc.) with risk profiles. |
| 13 | `task` | **PASS** | **PASS** | **FAIL** (accepted) | `plan` simulates scheduling; **Defect:** `status <bogus>` reports `queued` with exit 0. |
| 14 | `run` | **PASS** | **PASS** | **PASS** (rejected) | Alias for `wa task run`; rejects missing prompt argument with code 1. |
| 15 | `executions` | **PASS** | **PASS** | **FAIL** (accepted) | `list --json` lists past runs; `inspect <bogus>` prints not found but exits 0. |
| 16 | `history` | **PASS** | **PASS** | **PASS** (rejected) | `wa history list` outputs block history table; bare command prompts for subcommand. |
| 17 | `context` | **PASS** | **PASS** | **PASS** (rejected) | Lists active context blocks and memory slots. |
| 18 | `mcp` | **PASS** | **PASS** | **PASS** (rejected) | Manages MCP servers, connections, credentials, and tools. |
| 19 | `web` | **PASS** | **PASS** | **PASS** (rejected) | Outputs policy-controlled web grounding diagnostics and provider status. |
| 20 | `auth` | **PASS** | **PASS** | **PASS** (rejected) | Displays authentication status for Anthropic, OpenAI, Google hosted providers. |
| 21 | `audit` | **PASS** | **PASS** | **PASS** (rejected) | Dumps append-only audit log of security and policy decisions. |
| 22 | `ask` | **PASS** | **PASS** | **PASS** (rejected) | Rejects invocation with missing prompt argument. |
| 23 | `jobs` | **PASS** | **PASS** | **PASS** (rejected) | Manages DAG jobs; rejects unknown subcommand with code 1. |
| 24 | `artifacts` | **PASS** | **PASS** | **FAIL** (accepted) | Lists artifacts and provenance; `inspect <bogus>` prints not found but exits 0. |
| 25 | `explain` | **PASS** | **PASS** | **PASS** (rejected) | Explains scheduling decisions for executions; rejects invalid execution ID. |
| 26 | `evidence` | **PASS** | **PASS** | **PASS** (rejected) | Outputs verification evidence, build/test results, and provenance digests. |
| 27 | `search` | **PASS** | **PASS** | **PASS** (rejected) | Best-of-N solution trajectory explorer. |
| 28 | `improve` | **PASS** | **PASS** | **PASS** (rejected) | Displays empirical self-improvement engine status and active configurations. |
| 29 | `canary` | **PASS** | **PASS** | **PASS** (rejected) | Shows autonomous continuous canary deployment state. |
| 30 | `service` | **PASS** | **PASS** | **PASS** (rejected) | Controls systemd/launchd daemon service configurations. |
| 31 | `test` | **PASS** | **PASS** | **PASS** (rejected) | Protocol diagnostics: `action-protocol` (15/15 passed) and `model-protocol` (passed). |
| 32 | `init` | **PASS** | **PASS** | **PASS** (rejected) | Initializes control plane configuration. |
| 33 | `evaluation` | **PASS** | **PASS** | **PASS** (rejected) | `show <id>` displays quantitative EvaluationRecord; rejects bogus subcommand. |
| 34 | `benchmark` | **PASS** | **PASS** | **PASS** (rejected) | Rejects bogus subcommands; exposes `run`. |
| 35 | `discover` | **PASS** | **PASS** | **PASS** (rejected) | Triggers runtime and model discovery across local and network endpoints. |
| 36 | `chat` | **PASS** | **PASS** | **PASS** (rejected) | Interactive fleet TUI launcher. |
| 37 | `dashboard` | **PASS** | **PASS** | **PASS** (rejected) | Launches Web UI & API control plane dashboard. |

---

## 2. Command Coverage Statistics

- **Total Commands Evaluated:** 37
- **Documented with `--help`:** 37 / 37 (100%)
- **Successfully Executed Live:** 37 / 37 (100%)
- **Negative Testing Handling:**
  - Proper nonzero exit code & rejection: 31 / 37 (83.8%)
  - Nonzero exit omitted on entity not found: 6 / 37 (16.2%) (Defect P3)
  - Unknown task ID false positive status (`queued`): 1 instance (Defect P2)
