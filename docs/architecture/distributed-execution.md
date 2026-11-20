# Distributed Execution & Lease-Fencing Architecture

## Control Plane & Worker Protocol

- **Registration (`POST /computers/register`)**: Workers report OS, architecture, CPU/RAM/GPU capabilities, and discovered runtimes (`ollama`, `mlx`, `lmstudio`, `vllm`) using `WAZIR_REGISTRATION_TOKEN`.
- **Heartbeat (`POST /computers/:id/heartbeat`)**: Periodic liveness, load, and model readiness updates.
- **SSE Task Stream (`GET /computers/:id/tasks`)**: Persistent Server-Sent Events channel for low-latency task dispatch.
- **Lease Fencing (`POST /computers/:id/executions/:requestId/claim`)**: Workers must acquire a fenced lease token before executing side-effecting steps, preventing duplicate work when a coordinator restarts or a worker reconnects.
- **Canonical Status Transitions (`packages/core/src/services/statusTransitions.ts`)**: Terminal states (`completed`, `failed`, `cancelled`) are never silently resurrected by stale worker writes.

## Local-First Compute Policy

- Target >= 90% local inference across Apple Silicon (`WaelMacPro.local`, MLX/Ollama) and NVIDIA DGX Spark (`waelbot`, `qwen3-coder:30b`, `qwen3.6:35b-a3b-q8_0`, `gemma4:26b`).
- Remote providers are used only when explicitly authorized and recorded.
