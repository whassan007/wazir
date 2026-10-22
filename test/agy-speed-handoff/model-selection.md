# Model Inventory & Selection Rationale

**Timestamp:** 2026-10-17T19:11:31-07:00  
**Environment:** NVIDIA DGX Spark (GB10, 122 GB Unified Memory, Ubuntu ARM64)  
**Runtime:** LM Studio (`lmstudio` on `local`, HEALTHY, 91 / 122 GiB memory OK)

## 1. Resident Model Inventory (`lms ps` & `wa models list --json`)

| Model ID | Architecture / Active Params | GPU Memory Footprint (`lms ps`) | Context | Parallel Slots | Direct Probe TTFT | Direct Probe Total (`max_tokens=16`) | Direct Probe Output (`2+2`) |
|---|---|---|---|---|---|---|---|
| **`gemma-4-26b-a4b-it-qat`** | Gemma 4 MoE (`26B-A4B`, Q4_0) | **14.44 GB** | 32,768 | 4 | **230.8 ms** | **231.0 ms** | `'4'` (Immediate answer) |
| `nvidia/nemotron-3-nano-omni` | Nemotron H MoE (`30B-A3B`, Q4_K_M) | 26.10 GB | 8,192 | 4 | 218.5 ms | 341.1 ms | `''` (Spends tokens on `<think>` / `reasoning_content`) |
| `qwen/qwen3.8-27b` | Qwen 3.5 Dense (`27B`, Q4_K_M) | 17.74 GB | 8,192 | 4 | 409.4 ms | 924.0 ms | `''` (Spends tokens on `<think>` / `reasoning_content`) |

*(7 additional models are installed on disk but unloaded: `qwen2.5-7b-instruct`, `qwen/qwen3-coder-next`, `unsloth/qwen3-coder-next`, `openai/gpt-oss-120b`, `nvidia/nemotron-3-super`, `text_encoder`, `text-embedding-nomic-embed-text-v1.5`, `transformer`.)*

## 2. Selection Decision

**Selected Model:** `gemma-4-26b-a4b-it-qat` (Runtime: `lmstudio` on `local`)

### Rationale against Mandatory Criteria:
1. **Already resident in GPU memory:** Yes (`STATUS: IDLE`, `loaded: true`, `state: READY`). No model loading required.
2. **Healthy runtime:** `lmstudio` is `READY` and `HEALTHY`.
3. **Small inference footprint:** Smallest resident footprint at **14.44 GB** with only **4B active parameters** per token (MoE 26B-A4B QAT).
4. **Low measured first-token & completion latency:** 230.8 ms TTFT and **231.0 ms** total completion time on elementary arithmetic.
5. **Correctness & non-thinking efficiency on elementary tasks:** Unlike `nvidia/nemotron-3-nano-omni` and `qwen/qwen3.8-27b`, which emit hidden reasoning/thinking chains before producing content tokens, `gemma-4-26b-a4b-it-qat` immediately emits the final token (`'4'`) with `schemaReliability: 0.958`.
6. **Parallel capacity:** Configured with `PARALLEL = 4` in LM Studio, directly supporting concurrency=2 and concurrency=3 benchmark runs.
