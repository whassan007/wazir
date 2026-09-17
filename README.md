# Wazir Meta-Harness

A production-quality local AI meta-harness that orchestrates multiple AI runtimes, models, tools, and target computers.

## Architecture

```
                    META-HARNESS
                         │
                     Task Engine
                         │
                    Requirements
                         │
                    Policy Engine
                         │
                     Scheduler
                         │
                 Capability Matching
                         │
                ┌────────┴────────┐
                │                 │
             Model             Runtime
                │                 │
                └────────┬────────┘
                         │
                  Target Computer
                         │
                      Worker
                         │
                      Result
```

## Features

- **Runtime Agnostic**: Ollama, LM Studio, and future runtimes as interchangeable backends
- **Intelligent Scheduling**: Selects best computer/model based on capabilities, resources, policies
- **Distributed Architecture**: Support for multiple target computers with workers
- **Policy Enforcement**: Data classification, local-only mode, tool access control
- **Observability**: Complete execution traces and explainable scheduling decisions

## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Generate macOS Apple DMG installer
npm run dmg
```

## Deployment

### Docker / Docker Compose

`Dockerfile` builds four targets from one multi-stage build: `api`, `worker`, `web`, and `cli`.

```bash
# One service
docker build --target api -t wazir-api .

# The full stack (API + worker + web dashboard + Postgres), wired together
# on one Docker network so the worker actually registers with the API and
# the dashboard proxies to it:
docker compose up -d api worker web

# One-off CLI commands against that stack:
docker compose run --rm cli wazir doctor
```

Set `WAZIR_OLLAMA_URL`/`WAZIR_LMSTUDIO_URL` in the environment (or a `.env`
file — see `.env.example`) to point the `api` service at runtimes reachable
from inside the container (e.g. `http://host.docker.internal:11434` to reach
an Ollama instance running on the Docker host itself).

### systemd (Linux)

Unit files for running the API and/or a worker as persistent background
services live in `scripts/systemd/`. Copy them to `/etc/systemd/system/`,
edit the `ExecStart` node/install paths for your machine, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wazir-api
sudo systemctl enable --now wazir-worker
```

### launchd (macOS)

`scripts/launchd/ai.wazir.worker.plist` runs a worker unattended in the
background with no dashboard — for using a Mac purely as a compute target.
This is distinct from the GUI `Wazir.app` produced by `npm run dmg`, which
starts the API + web dashboard and opens a browser. Install as a
LaunchAgent (runs as your user, can reach your own Ollama/LM Studio):

```bash
cp scripts/launchd/ai.wazir.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.wazir.worker.plist
```

## Directory Structure

```
wazir/
├── apps/
│   ├── api/      # API server
│   ├── web/      # Web UI
│   └── cli/      # Command-line interface
│
├── packages/
│   ├── core/             # Core domain types
│   ├── scheduler/        # Task scheduling logic
│   ├── models/           # Model routing
│   ├── policies/         # Policy enforcement
│   ├── runtimes/         # Runtime adapters
│   │   ├── interfaces/
│   │   ├── ollama/
│   │   └── lmstudio/
│   ├── workers/          # Worker agent
│   ├── tools/            # Tool registry
│   ├── evaluation/       # Model evaluation
│   └── observability/    # Logging & metrics
│
├── config/
├── migrations/
├── tests/
└── docs/
```

## Core Concepts

### Task → Requirements → Capabilities → Model → Runtime → Target → Execution

The system determines:

1. **Requirements**: What capabilities does the task need?
2. **Policy**: Are there constraints (local-only, allowed computers)?
3. **Model Router**: Which model best matches requirements?
4. **Scheduler**: Which computer has resources and is available?
5. **Runtime**: Which runtime adapter to use?

## Runtime Adapters

Implementations must conform to `RuntimeAdapter` interface:

```typescript
interface RuntimeAdapter {
  id: string;
  
  discover(): Promise<RuntimeInfo>;
  listModels(): Promise<ModelInfo[]>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  healthCheck(): Promise<HealthStatus>;
  generate(request: GenerationRequest): AsyncIterable<GenerationEvent>;
  
  cancel?(executionId: string): Promise<void>;
}
```

## Example Usage

```bash
# Run task with automatic selection
wazir ask "Analyze this codebase"

# Force specific computer
wazir ask "Explain this" --computer dgx-primary

# Force specific model
wazir ask "Solve this" --model qwen3-coder

# Dry run to see scheduling decision
wazir task plan "Review this document"
```

## Configuration

```yaml
harness:
  name: local-meta-harness

scheduler:
  strategy: weighted

workers:
  heartbeatSeconds: 10

database:
  url: postgresql://localhost/wazir
```

## Next Steps

1. Implement API server (`apps/api`)
2. Build web UI (`apps/web`)
3. Create CLI (`apps/cli`)
4. Complete runtime adapters
5. Add database persistence
6. Run end-to-end tests
