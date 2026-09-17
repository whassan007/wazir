# @wazir/api

The control-plane REST API — an Express server that lets remote workers register/heartbeat, exposes the fleet's inventory (computers, runtimes, models, agents, tools), and bridges task dispatch to whichever worker a scheduler decision picked.

## Running

```bash
npm run build
npm start                     # PORT=4800 by default
# or, for local dev with auto-restart:
npm run dev
```

Set `WAZIR_HOST=0.0.0.0` if this needs to be reachable from outside its own host (it defaults to `127.0.0.1`, which is correct for a bare-metal install but unreachable from outside a container — the Dockerfile's `api` target already sets this).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/api/v1/overview` | Name/version/description + counts across every registry |
| GET | `/api/v1/computers` | Registered computers (local + remote fleet) |
| GET | `/api/v1/workers` | Worker status for the local computer |
| GET | `/api/v1/runtimes` | Discovered runtimes and health |
| GET | `/api/v1/models` | Discovered models |
| GET | `/api/v1/model-instances` | Which computer/runtime combinations can actually serve which model — required for a remote `Scheduler` to place a task, not just see the model exists |
| GET | `/api/v1/agents` | Registered agents |
| GET | `/api/v1/tools` | Registered tools |
| GET | `/api/v1/executions` / `/:id` | In-memory execution log (this API's own, not the CLI's persisted history) |
| POST | `/computers/register` | Worker registration |
| POST | `/computers/:id/heartbeat` | Worker heartbeat |
| GET | `/computers/:id/tasks/stream` | SSE stream a worker holds open to receive dispatched tasks |
| POST | `/api/v1/tasks/dispatch` | Dispatch a `WorkerExecutionRequest` to a computer; `?wait=<ms>` blocks for the result |
| GET | `/api/v1/tasks/:requestId/status` | Poll a dispatched request's events/outcome |
| POST | `/computers/:id/executions/:requestId/events` / `.../result` | Worker reports execution progress/outcome back |

## What this is not

There's no authentication or CORS restriction on any route — this is meant for a trusted network (a home lab, a VPN, a single team's infra), not the public internet. There's no durable job queue either: dispatched-but-undelivered requests live in memory and are lost on restart. See `WAZIR_PRODUCTION_READINESS_REVIEW.md` at the repo root for what's tracked as still-open (auth, persistence for this specific in-memory state, sandboxing, telemetry).
