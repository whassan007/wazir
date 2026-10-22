# DGX Spark Model Verification & Pinning

- **Timestamp:** 2026-10-18T02:55:11.070Z
- **Host / Computer:** `waelbot` (NVIDIA DGX Spark, Ubuntu 24.04.5 LTS `aarch64`, 20 ARM64 cores Cortex-X925/A725, 121 GiB unified memory, 33 GiB available)
- **Wazir Version:** `0.2.5`
- **Local Runtimes Checked:**
  - **LM Studio (`lmstudio`):** ONLINE & READY at `http://127.0.0.1:1234` (`lms ps` verified 3 resident models)
  - **Ollama (`ollama`):** CLI installed at `/usr/local/bin/ollama`, daemon UNREACHABLE (0 resident models)
  - **Hosted Providers:** None authenticated; hosted fallback strictly prohibited (`--routing-mode LOCAL_ONLY`)

## Resident Loaded Models & Bounded Calibration Probes (3/3)

| Model Identifier | Runtime | Status | Size | Context | Probe Latency | Direct Output | Notes |
|---|---|---|---:|---:|---:|---|---|
| `gemma-4-26b-a4b-it-qat` | `lmstudio` | LOADED (IDLE) | 14.44 GB | 32768 | 135 ms | `READY` | 4B active (26B MoE) — clean direct text generation |
| `nvidia/nemotron-3-nano-omni` | `lmstudio` | LOADED (IDLE) | 26.1 GB | 8192 | 577 ms | `(reasoning only)` | Nano Omni — consumes tokens in thinking channel before final content |
| `qwen/qwen3.8-27b` | `lmstudio` | LOADED (IDLE) | 17.74 GB | 8192 | 1534 ms | `(reasoning only)` | 27B dense — consumes tokens in thinking channel before final content |

## Selected & Pinned Model

- **Pinned Model Identifier:** `gemma-4-26b-a4b-it-qat`
- **Runtime:** `lmstudio`
- **Computer:** `local` (`waelbot`)
- **Loaded State:** `LOADED` (`loaded=true`, verified resident via `lms ps` and `/api/v0/models`)
- **Explicit CLI Selection Flags:** `wa run "<prompt>" --model gemma-4-26b-a4b-it-qat --runtime lmstudio --routing-mode LOCAL_ONLY --json`
- **Lifecycle Pin Command Result:** `{"ok":true,"modelId":"gemma-4-26b-a4b-it-qat","pinned":true}` (exit=0)
