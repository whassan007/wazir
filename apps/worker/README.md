# @wazir/worker

The standalone worker daemon binary. Wraps the `Worker` class from `@wazir/workers` in a small process that registers with a control plane, heartbeats, and stays resident waiting for dispatched work — this is what you run on a machine you want to contribute compute to the fleet (a DGX box, a spare Mac, a GPU workstation).

## Running

```bash
npm run build
node dist/index.js --server http://control-plane-host:4800 --computer dgx-1 --name "DGX Primary"
```

Or via environment variables (useful for systemd/Docker):

```bash
WAZIR_SERVER_URL=http://control-plane-host:4800 \
WAZIR_COMPUTER_ID=dgx-1 \
WAZIR_COMPUTER_NAME="DGX Primary" \
node dist/index.js
```

Omit `--server`/`WAZIR_SERVER_URL` to run in local-only mode — the worker still discovers hardware and runtimes, but never registers anywhere; it's not part of a fleet, and nothing can dispatch work to it. This is the daemon `scripts/systemd/wazir-worker.service` and `scripts/launchd/ai.wazir.worker.plist` run.

## What it actually does

1. Discovers local hardware (CPU, RAM, GPU) and runtimes (Ollama, LM Studio).
2. Registers with the control plane (retried with backoff — a worker starting before the control plane is ready is an ordinary occurrence under Docker Compose/systemd, not a crash).
3. Heartbeats periodically.
4. Holds an SSE connection open to receive dispatched `WorkerExecutionRequest`s, executes them against the local runtime, and reports events/outcome back.

It never makes scheduling decisions — it only executes exactly what the control plane's `Scheduler` already decided and sends.
