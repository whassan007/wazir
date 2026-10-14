# Wazir Live Environment Discovery & System Characterization

**Date & Time:** 2026-10-14T02:13:36Z (2026-10-13 19:13:36 PDT)  
**Evaluator:** Principal Reliability, Security & Test Architecture Agent  
**Repository Branch:** `reliability/validation-evidence-20261013`  
**Git Commit SHA:** `59b7aac8f7883f6181873723a0be1ddfc51969a6`  
**Git Working Tree State:** Clean (no uncommitted changes in primary workspace)  
**Evaluation Worktree:** Isolated disposable checkout at `/tmp/wazir-live-eval-audit` (branch detached at `59b7aac`)  
**Isolated Storage:** `WAZIR_HOME=/tmp/wazir-test-home-eval`  

---

## 1. Host Hardware & Architecture

- **Hostname:** `waelbot`
- **System Architecture:** `aarch64` (ARM 64-bit Little Endian)
- **Kernel:** Linux `7.0.0-1019-nvidia` #19~24.04.2-Ubuntu SMP PREEMPT_DYNAMIC Sun Sep 6 18:35:11 UTC 2 aarch64
- **Operating System:** Ubuntu 24.04.2 LTS (Noble Numbat)
- **CPU Model:**
  - 10x ARM Cortex-X925 (stepping r0p1, max 3900 MHz, min 1378 MHz)
  - 10x ARM Cortex-A725 (stepping r0p1, max 2808 MHz, min 338 MHz)
  - Total cores: 20 physical cores (single socket, 1 thread per core)
  - Features: `fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 sve sve2 sveaes svepmull svebitperm svesha3 svesm4 flagm2 frint svei8mm svebf16 i8mm bf16`
- **System Memory:**
  - Total RAM: 121 GiB (130,661,138,432 bytes)
  - Used: ~98 GiB (resident LLM memory via LM Studio)
  - Free: ~10 GiB
  - Available: ~23 GiB
  - Swap: 15 GiB (1.3 GiB used)
- **GPU & Accelerator Details:**
  - GPU Model: **NVIDIA GB10** (NVIDIA Grace Blackwell / DGX Spark mobile platform architecture)
  - Driver Version: `580.178.04`
  - CUDA Version: `13.0`
  - Persistence Mode: On
  - Bus ID: `0000000F:01:00.0`
  - Display Active: Off
  - Power Usage: 11W – 15W idle
  - Unified Memory Architecture: Yes (GB10 unified memory subsystem shared between CPU and GPU)

---

## 2. Runtimes, Interpreters & Toolchains

- **Node.js:** `v22.22.3` (`/home/wael/.nvm/versions/node/v22.22.3/bin/node`)
- **npm:** `10.9.8`
- **Python:** `3.12.8` (`/home/wael/miniconda3/bin/python3`)
- **Git:** `2.43.0` (`/usr/bin/git`)
- **CUDA Compiler (nvcc):** Not found on system PATH; runtime driver active via `/usr/local/cuda/lib64` and `nvidia-smi`

---

## 3. Network Connectivity & Boundary

- **Localhost Loopback:** Fully operational (`127.0.0.1`, `::1`)
- **Outbound Internet:** Active (tested ping to `8.8.8.8` and HTTPS probe to Google)
- **Wazir Policy Default:** In accordance with policy requirements, `networkAllowed: false` is enforced by default on agent execution tasks.

---

## 4. Local Inference Endpoints

| Provider | Endpoint | Reachability | Loaded Models | Notes |
|---|---|---|---|---|
| **LM Studio** | `http://localhost:1234` | **REACHABLE / HEALTHY** | `nvidia/nemotron-3-nano-omni`<br>`qwen/qwen3-coder-next` | 11 models installed in local catalog. 2 models resident in VRAM. |
| **Ollama** | `http://localhost:11434` | **UNREACHABLE** | None | Service daemon not active (`ECONNREFUSED`). Diagnosed correctly by `wa doctor`. |
| **Anthropic API** | Hosted API | Unconfigured | None | No API token in environment. |
| **OpenAI API** | Hosted API | Unconfigured | None | No API token in environment. |
| **Google API** | Hosted API | Unconfigured | None | No API token in environment. |

---

## 5. External AI Coding Agents

| Agent | Executable Path | Version | Probe Status | Notes |
|---|---|---|---|---|
| **Antigravity** | `/home/wael/.local/bin/agy` | `1.3.4` | **READY** | 13 models accessible via CLI login |
| **Claude Code** | `/home/wael/.local/bin/claude` | `2.1.296` | **READY** | Answered in 9.0s during probe |
| **OpenCode** | `/home/wael/.opencode/bin/opencode` | `1.19.0` | **READY** | Successfully executed live reading task |
| **Codex** | `/home/wael/.local/bin/codex` | `0.162.1` | **FAILED** | Codex-ACP bridge version mismatch with model account |
| **Gemini** | `/usr/bin/gemini` | Retired | **FAILED** | Google retired standalone tier; directs to Antigravity |
| **Qwen Code** | Candidate | Unconfigured | **FAILED** | Endpoint unreachable in `~/.qwen/settings.json` |

---

## 6. Execution Safety & Process Isolation

- **Test Home:** `WAZIR_HOME=/tmp/wazir-test-home-eval`
- **Worktree:** `/tmp/wazir-live-eval-audit`
- **No production user data was overwritten or modified.**
- **Existing background processes (Postgres, LLM Studio, Claude reliability harness) remained unaffected.**
