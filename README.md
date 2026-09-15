# Rook Meta-Harness

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
```

## Directory Structure

```
meta-harness/
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
mh ask "Analyze this codebase"

# Force specific computer
mh ask "Explain this" --computer dgx-primary

# Force specific model
mh ask "Solve this" --model qwen3-coder

# Dry run to see scheduling decision
mh task plan "Review this document"
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
  url: postgresql://localhost/meta_harness
```

## Next Steps

1. Implement API server (`apps/api`)
2. Build web UI (`apps/web`)
3. Create CLI (`apps/cli`)
4. Complete runtime adapters
5. Add database persistence
6. Run end-to-end tests
