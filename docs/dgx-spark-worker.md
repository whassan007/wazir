# Linux ARM64 NVIDIA DGX Spark Worker Guide

The NVIDIA DGX Spark is a high-density AI workstation featuring an ARM64 Cortex-X925/A725 20-core processor paired with an NVIDIA GB10 GPU (Blackwell architecture, ATS addressing mode, C2C interconnect, and 122 GB of high-bandwidth unified memory).

---

## 1. System Specifications & Topology

- **CPU**: 20-core ARM64 Cortex-X925 / Cortex-A725
- **OS**: Ubuntu 24.04 LTS (Kernel `7.0.0-1019-nvidia`)
- **GPU**: NVIDIA GB10 (Driver 580.178.04, CUDA 12.8, Compute Capability sm_100)
- **Addressing Mode**: Address Translation Services (ATS) with GPU Chip-to-Chip (C2C) interconnect
- **Memory**: 122 GB System-Shared Unified Memory Architecture (UMA)

---

## 2. Hardware Discovery Details

Because Linux ARM64 `/proc/cpuinfo` reports implementer and part codes without a traditional `model name: ` string, Wazir's hardware discovery module queries `lscpu` to accurately resolve `Cortex-X925`.

Furthermore, because NVIDIA GB10 uses ATS unified memory, `nvidia-smi` reports `memory.total = [N/A]`. Wazir correctly recognizes ATS mode and reports the host shared memory pool (122 GB) with `unifiedMemory: true` and `cuda: true`.

---

## 3. Worker Installation & Launch

```bash
# Install Wazir native standalone binary or npm package
npm install -g wazir

# Configure controller connection
export WAZIR_CONTROLLER_URL="http://controller-ip:4000"
export WAZIR_REGISTRATION_TOKEN="sk-cluster-token-12345"

# Launch worker
wa workers start --controller "$WAZIR_CONTROLLER_URL" --name "dgx-spark-01"
```

### Running as a systemd Service
Deploy `scripts/systemd/wazir-worker.service`:
```bash
sudo cp scripts/systemd/wazir-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wazir-worker
```

---

## 4. Tested End-to-End Example: Mac or Windows Controller -> DGX Spark Worker

A macOS or Windows controller can dispatch CUDA-intensive coding and compilation workloads to the DGX Spark worker.

### Controller-Side Task Definition (`cuda-task.json`)
```json
{
  "id": "task-dgx-cuda-gemm",
  "type": "coding",
  "title": "CUDA Blackwell Matrix Multiplication Kernel",
  "input": "Write an optimized FP8 matrix multiplication kernel targeting NVIDIA GB10 sm_100 and compile with nvcc",
  "requirements": {
    "os": "linux",
    "architecture": "arm64",
    "requiresCuda": true,
    "minimumMemoryGB": 64
  },
  "priority": "high"
}
```

### Submitting via CLI on macOS or Windows:
```bash
# On macOS Terminal or Windows PowerShell:
wa run --task-file ./cuda-task.json
```

### Automatic Routing Decision (Recorded by Controller Scheduler):
```
[SCHEDULER] Evaluating candidates for task 'task-dgx-cuda-gemm'...
  - mac-studio-m2 (darwin arm64): REJECTED (os mismatch: required 'linux', actual 'darwin'; CUDA missing)
  - win-workstation (win32 x64): REJECTED (os mismatch: required 'linux', actual 'win32'; arch mismatch)
  - dgx-spark-01 (linux arm64): SELECTED (Score: 14.5)
    * OS match: linux (+1.5)
    * Architecture match: arm64 (+1.0)
    * NVIDIA CUDA acceleration active (NVIDIA GB10 sm_100) (+2.0)
    * Unified Memory Architecture (122 GB host-GPU shared) (+0.5)
    * Memory satisfied: 122 GB >= 64 GB required
[DISPATCH] Handed execution 'task-dgx-cuda-gemm' to worker 'dgx-spark-01' via persistent SSE stream
[STREAM] Compiling CUDA kernel on DGX Spark GB10...
[COMPLETED] PTX generated for sm_100. Acceptance verification passed.
```
