# Distributed Fleet Troubleshooting Guide

## Common Issues and Solutions

### 1. Worker Cannot Connect to Controller
- **Symptom**: `fetch failed: ECONNREFUSED` or `ETIMEDOUT` when launching worker.
- **Remedy**:
  - Verify controller is running: `curl http://<controller-ip>:4000/health`.
  - Check firewall settings: Controller listens on TCP port `4000` (or `WAZIR_SERVER_PORT`). On Linux, ensure `ufw allow 4000/tcp` is allowed. On Windows, verify Windows Defender Firewall permits incoming connections on the controller port.

### 2. Registration Authentication Rejected (HTTP 401 / 403)
- **Symptom**: `registration failed: HTTP 401 (registration token required)`.
- **Remedy**:
  - Ensure `WAZIR_REGISTRATION_TOKEN` on the worker exactly matches the controller's token.
  - If replacing a previously registered worker ID after a cold restart, either provide its existing token or present the cluster `WAZIR_REGISTRATION_TOKEN`.

### 3. DGX Spark GPU Memory Reports N/A
- **Symptom**: `nvidia-smi` reports memory total as `[N/A]`.
- **Reason**: The NVIDIA GB10 uses Address Translation Services (ATS) with GPU Chip-to-Chip (C2C) interconnect over unified system memory.
- **Resolution**: Wazir handles this automatically in `packages/workers/src/hardwareDiscovery.ts` by reading host total memory and flagging `unifiedMemory: true`. Ensure you are running Wazir v0.1.59+.

### 4. Lease Lost / Fencing Error (`LEASE_LOST`)
- **Symptom**: Worker reports `LEASE_LOST` when attempting to resolve a task.
- **Reason**: The worker lost network connectivity for longer than the lease expiration window (default 30-60 seconds), and the controller orphaned the task to prevent split-brain execution.
- **Resolution**: The worker will cleanly abort the stale task. Ensure network stability between worker and controller, or tune `workerLeaseMs` in controller configuration for high-latency WAN links.

### 5. Windows Path Separation in Symbol Graphs
- **Symptom**: Symbol resolution fails when Windows workers produce backslash path references.
- **Resolution**: Fixed in v0.1.59 (`normalizeCalleePath` normalizes all path separators before indexing).
