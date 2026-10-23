# Nobel Goal Graph Example (`examples/goal-studio/`)

This directory contains the reusable example and guide for the **Provable Algorithmic Peace Program** (Nobel Goal Graph), demonstrating how to manage zero-cost, provably verified decentralized goal graphs under strict constitution limits.

## Overview

The [`nobel_goal_graph.yaml`](./nobel_goal_graph.yaml) file models a 3-year, 10-target Directed Acyclic Graph (DAG) with:
- **$0 Hosted Spend** (`hosted_spend_usd: 0`)
- **Local Model First** enforcement (`local_model_first: true`)
- **External Verification Gates** on nodes `Y1.4`, `Y2.3`, and `Y3.3` (`external_dependency: true`)

## Running the Example

### 1. Standalone Script
Run the workflow demonstration directly using Node.js:
```bash
node examples/goal-studio/run-nobel-example.mjs
```

Pass `--json` for machine-parsable JSON output:
```bash
node examples/goal-studio/run-nobel-example.mjs --json
```

### 2. Via Wazir CLI (`wa`)
Import and execute via the Wazir CLI:
```bash
wa goal import examples/goal-studio/nobel_goal_graph.yaml
wa goal nobel --project nobel-peace-program
```

### 3. Via Web UI (`/goal-studio`)
Start the Wazir Goal Studio development dashboard:
```bash
wa goal-studio --port 3000
```
Navigate to `http://localhost:3000/goal-studio`, load `nobel_goal_graph.yaml`, and observe real-time target progression (`Y1.1 -> Y1.2 -> Y1.3` completing with verified SHA-256 artifacts while `Y1.4` holds securely at `awaiting_external`).
