# Distributed Heterogeneous Fleet Setup Guide

Wazir orchestrates AI agent workloads across heterogeneous physical machines, cloud VMs, and dedicated GPU workstations running macOS, Windows, and Linux.

---

## 1. Fleet Architecture Overview

The Wazir distributed fleet operates on a decoupled **Control Plane (Controller)** and **Execution Worker** model:

```
+-------------------------------------------------------------------------+
|                       WAZIR CONTROLLER                                  |
|   (macOS / Windows / Linux Control Plane with REST API & Task Scheduler)|
+--------------------+--------------------------------+-------------------+
                     |                                |
       Bearer Token  |                  Bearer Token  |     Bearer Token
     Task Stream SSE |                Task Stream SSE |   Task Stream SSE
                     v                                v                   v
+-----------------------------+ +-----------------------------+ +-----------------------------+
|    Linux ARM64 DGX Spark    | |      macOS Apple Silicon    | |     Windows x64 Workstation |
|  NVIDIA GB10 GPU (122GB UMA)| |  Apple M2/M3/M4 Max/Ultra   | |  NVIDIA RTX 4090 / CUDA     |
|  Ollama / vLLM / C++ NVCC   | |  MLX / LM Studio / CoreML   | |  LM Studio / WSL2 / PyTorch |
+-----------------------------+ +-----------------------------+ +-----------------------------+
```

### Core Security & Transport Model
- **Control Plane Endpoint**: Controller hosts HTTP/SSE server on port `4000` (or configured port).
- **Worker Registration (`POST /computers/register`)**: Workers discover local hardware (CPU, RAM, GPU, CUDA) and local runtimes, and register with the controller using `WAZIR_REGISTRATION_TOKEN`.
- **Durable Task Stream (`GET /computers/:id/tasks`)**: Workers maintain a persistent Server-Sent Events (SSE) stream to receive task dispatch signals.
- **Heartbeat Loop (`POST /computers/:id/heartbeat`)**: Workers publish health, load, and model readiness every 5 seconds.
- **Durable Leases & Fencing**: Dispatched tasks require workers to claim leases (`POST /computers/:id/executions/:requestId/claim`). Fenced lease tokens prevent split-brain execution and duplicate side effects upon reconnection.

---

## 2. Controller Setup

To start a Wazir controller:

```bash
# 1. Set environment variables
export WAZIR_API_TOKEN="sk-ctrl-prod-token-$(openssl rand -hex 16)"
export WAZIR_REGISTRATION_TOKEN="sk-reg-cluster-$(openssl rand -hex 16)"
export WAZIR_SERVER_PORT=4000

# 2. Launch the Wazir controller server
wa start:api
```

The controller initializes:
- `TaskDispatcher` with durable WAL persistence
- `ComputerRegistry` tracking live worker topologies
- `ModelRegistry` & `ModelLifecycleService`
- `Scheduler` with OS-, architecture-, and CUDA-aware placement

---

## 3. Worker Setup

On each worker machine, install Wazir CLI and launch the worker daemon:

```bash
# Linux / macOS
export WAZIR_CONTROLLER_URL="http://controller-host.internal:4000"
export WAZIR_REGISTRATION_TOKEN="sk-reg-cluster-..."
wa workers start --controller "$WAZIR_CONTROLLER_URL" --name "worker-node-01"

# Windows (PowerShell)
$env:WAZIR_CONTROLLER_URL = "http://controller-host.internal:4000"
$env:WAZIR_REGISTRATION_TOKEN = "sk-reg-cluster-..."
wa workers start --controller $env:WAZIR_CONTROLLER_URL --name "win-worker-01"
```

---

## 4. Heterogeneous Routing Policy

Tasks submitted to the controller automatically evaluate candidate machines based on:
1. **OS Compatibility**: `linux`, `darwin`, `win32`
2. **Architecture**: `arm64`, `x64`
3. **Hardware Accelerators**: NVIDIA CUDA (`requiresCuda`), Apple Metal, Unified Memory
4. **Agent & Model Availability**: Pre-warmed model instances, available RAM/VRAM
5. **Subscription & Quota Budgets**: Prioritizing local zero-cost hardware before paid APIs
