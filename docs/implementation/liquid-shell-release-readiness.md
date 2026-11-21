# Wazir Built-In Liquid AI Shell Orchestrator (`wazir-shell-mini`) — Release-Readiness & Verification Report

## 1. Executive Summary

Wazir ships **Liquid AI `LFM2.5-350M` (`Q4_K_M`, `LFM2.5-350M-Q4_K_M.gguf`)** as its built-in, zero-configuration, offline AI shell intent parser and tool router (`wazir-shell-mini`, runtime provider `wazir-embedded`, powered by pinned `llama.cpp`).

- **100% Held-Out Evaluation Accuracy:** `216 / 216` passed across all 12 benchmark categories (release gate: `>= 95.0%`).
- **0% Invalid Tool-Call Rate:** `0` unvalidated or malformed tool calls executed.
- **0 Unauthorized Executions:** `0` mutating or adversarial prompt-injection requests bypassed `PolicyEngine` or shell permission modes.
- **Sub-100ms Warm Latency:** `p50 = 54.81 ms` (`p95 = 119.47 ms`) on macOS ARM64 Metal (`557.4 tok/s` decode throughput, `373.55 MB` peak RSS) and `p50 = 124.86 ms` (`p95 = 257.19 ms`) on Linux ARM64 (Jetson, `95.51 tok/s`, `547.27 MB` peak RSS).

---

## 2. Pinned Artifact & Provenance Table

| Artifact | Value |
|---|---|
| **Wazir Model ID** | `wazir-shell-mini` |
| **Runtime Provider** | `wazir-embedded` |
| **Upstream Base Model** | [`LiquidAI/LFM2.5-350M`](https://huggingface.co/LiquidAI/LFM2.5-350M) |
| **Upstream GGUF Distribution** | [`LiquidAI/LFM2.5-350M-GGUF`](https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF) |
| **Pinned Upstream Revision** | `657e078c94084481950a2d555a941481f715536b` |
| **Model File** | [`assets/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf`](file:///Users/wael/Code/Wazir/assets/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf) |
| **Model Size** | `229,129,280` bytes (`218.51 MB`) |
| **Model SHA-256** | `7e6f72643caafc9a68256686638c4d7916f2cec76d1df478d4c3ddcd95a6aed4` |
| **License File** | [`assets/models/wazir-shell-mini/LICENSE-LFM-1.0.txt`](file:///Users/wael/Code/Wazir/assets/models/wazir-shell-mini/LICENSE-LFM-1.0.txt) |
| **License SHA-256** | `5188f2b355da20647257a3156db5834c794e5fb5e6d8dc4d4cdbb3180e75b85b` |
| **Model Manifest** | [`assets/models/wazir-shell-mini/manifest.json`](file:///Users/wael/Code/Wazir/assets/models/wazir-shell-mini/manifest.json) |
| **macOS ARM64 Runtime** | `assets/runtimes/darwin-arm64/llama-server` (`0.4.0-dev`, build `10909`, commit `329b6160f`, SHA-256 `d707b6db4c1397a7383176fba12d339e5b33c7513669d74c8fbc2a76f6979a72`) |
| **Linux ARM64 Runtime** | `assets/runtimes/linux-arm64/llama-server` (`0.9.0-dev`, build `12347`, commit `c2cf5f983`, SHA-256 `0b57de23c70159152bf61cfb6c7113431c8921b1c072178edea2d1f5252faa2b`) |

---

## 3. Three-Path Shell Architecture

1. **Path A — Deterministic Shell (`Tier 0` & `Tier 1`, `< 50 ms` p95):**
   - Recognized OS commands (`ls -la`, `pwd`, `git status`, `cd`, `export`, pipelines) and deterministic system facts (`what time is it`, `what directory am I in`, `version`, `whoami`, `hostname`, safe recursive-descent arithmetic `2 + 2`) execute immediately with zero model initialization.
2. **Path B — Bundled Liquid AI Model (`wazir-shell-mini`, `wazir-embedded`):**
   - Lightweight natural-language shell requests (`"Find the largest files in this directory"`, `"Show processes listening on port 8000"`, `"Find all modified TypeScript files"`, `"What branch am I on?"`, `"Show disk usage"`, `"Summarize my Git changes"`) invoke the resident loopback `llama-server` (`127.0.0.1`).
   - Output is parsed via a zero-`eval` recursive-descent parser (`parseAndValidateLiquidToolCall`) supporting `<|tool_call_start|>[tool_name(arg=val)]<|tool_call_end|>`, validated against the versioned 18-tool catalog (`LIQUID_SHELL_TOOLS` v1.0.0), and gated by `PolicyEngine` and workspace path containment before execution.
3. **Path C — Full Wazir Orchestration (`Tier 3`):**
   - Complex coding, debugging, refactoring, architecture, deployment, multi-agent workflows, and unsupported requests emit `escalate_to_wazir(reason=...)` and escalate seamlessly to Wazir's full planner, scheduler, and agent runtime.

---

## 4. Measured Hardware Benchmarks

Full machine-readable report: [`test/reports/liquid-shell-benchmark.json`](file:///Users/wael/Code/Wazir/test/reports/liquid-shell-benchmark.json)

| Platform / Mode | Cold Load (ms) | TTFT p50 (ms) | TTFT p95 (ms) | Decode Throughput (tok/s) | Total Latency p50 (ms) | Total Latency p95 (ms) | Peak RSS Memory (MB) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **macOS ARM64 Metal (`-ngl 99`, Apple M5 Pro)** | `264.89 ms` | `29.21 ms` | `93.40 ms` | `557.40 tok/s` | `54.81 ms` | `119.47 ms` | `373.55 MB` |
| **macOS ARM64 CPU Fallback (`-ngl 0`, Apple M5 Pro)** | `249.68 ms` | `300.03 ms` | `855.27 ms` | `404.54 tok/s` | `329.70 ms` | `891.15 ms` | `612.36 MB` |
| **Linux ARM64 (`jetson-linux-arm64`, Jetson)** | `329.90 ms` | `98.40 ms` | `195.10 ms` | `95.51 tok/s` | `124.86 ms` | `257.19 ms` | `547.27 MB` |
| **DGX Spark (`linux-arm64`)** | Bundled & verified (`llama-server` build 12347 + `LFM2.5-350M-Q4_K_M.gguf` synced to `~/.wazir/`; SSH timed out during final benchmark sweep) | — | — | — | — | — | — |

---

## 5. Held-Out 216-Request Evaluation Corpus Results

Corpus file: [`test/benchmarks/liquidShellCorpus.json`](file:///Users/wael/Code/Wazir/test/benchmarks/liquidShellCorpus.json)

| Category | Total Requests | Passed | Accuracy |
|---|---:|---:|---:|
| 1. `filesystem_queries` | 18 | 18 | **100.0%** |
| 2. `git_inspection` | 18 | 18 | **100.0%** |
| 3. `process_and_network` | 18 | 18 | **100.0%** |
| 4. `system_status` | 18 | 18 | **100.0%** |
| 5. `path_quoting_and_special_chars` | 18 | 18 | **100.0%** |
| 6. `structured_search` | 18 | 18 | **100.0%** |
| 7. `read_only_operations` | 18 | 18 | **100.0%** |
| 8. `mutating_operations_requiring_auth` | 18 | 18 | **100.0%** |
| 9. `unsupported_requests` | 18 | 18 | **100.0%** |
| 10. `prompt_injection_attempts` | 18 | 18 | **100.0%** |
| 11. `ambiguous_language` | 18 | 18 | **100.0%** |
| 12. `escalation_cases` | 18 | 18 | **100.0%** |
| **Total** | **216** | **216** | **100.0% (Gate >= 95.0%)** |

---

## 6. Clean Installation, Offline Usage & Rollback Instructions

### Offline Zero-Configuration Usage

1. Build and bundle Wazir:
   ```bash
   npm run build
   ```
2. Launch Wazir Shell offline (no Ollama, LM Studio, or cloud API keys required):
   ```bash
   ./bin/wa.js shell
   ```
3. Run single commands directly:
   ```bash
   ./bin/wa.js shell -c "what time is it"
   ./bin/wa.js shell -c "what directory am I in"
   ./bin/wa.js shell -c "show the largest files"
   ./bin/wa.js shell -c "find TypeScript files"
   ./bin/wa.js shell -c "summarize git status"
   ```

### Licensing & Enterprise Rollback / Opt-Out

- See [`docs/legal/lfm-license-compliance.md`](file:///Users/wael/Code/Wazir/docs/legal/lfm-license-compliance.md) for full **LFM Open License v1.0** compliance terms and the $10,000,000 USD annual revenue commercial threshold.
- To disable the bundled model in restricted enterprise environments without removing Wazir Shell:
  ```bash
  export WAZIR_DISABLE_EMBEDDED_MODEL=1
  ```
