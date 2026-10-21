# Handoff: Ultra-Low-Latency Fast Path Architecture

## Overview
This branch (`feat/ultra-low-latency-fast-path`) delivers an ultra-low-latency execution path for Wazir, optimizing turnaround times on Apple Silicon and NVIDIA hardware for non-mutating requests.

---

## Key Modules and Entry Points

### 1. `apps/cli/src/run.ts`
- **`isDirectAnswerRequest(description: string, options: any): boolean`**: Evaluates whether a prompt is a simple non-mutating query. Bypasses the multi-turn agent when matched or when `--fast-path` is provided.
- **Direct Adapter Execution Path**: Streams model generation directly using `adapter.generate`, logging execution lifecycle events `generation.started` and `generation.completed`.
- **Live Terminal Spinner**: Provides instant visual progress with real-time elapsed seconds.

### 2. `apps/cli/src/engine.ts` & `packages/core/src/types/modelLifecycle.ts`
- **`fastStartup: true`**: Passed by CLI run commands to avoid running background discovery verification probes, periodic interval timers, or recovery monitor loops.

### 3. `packages/core/src/resources/router.ts`
- **Residency Prioritization**: Boosted `residencyBonus` to `10.0` for models with residency status `'ready'`, preventing unnecessary eviction or reloading of resident models.

### 4. `packages/core/src/services/modelLifecycleService.ts`
- **Minimum Context Pre-check**: Avoids executing 10+ binary search iterations if `estimateAt(min)` fails.

---

## Build and Deployment Procedure
To rebuild and deploy the standalone CLI bundle:
```bash
# 1. Compile TypeScript
PATH="/Users/wael/Code/Wazir/node_modules/.bin:$PATH" npx tsc --build packages/core apps/cli

# 2. Bundle standalone executable
npm run bundle

# 3. Deploy to local bin and homebrew prefix
cp bin/wa.js /Users/wael/Code/Wazir/bin/wa.js
cp bin/wa.js /opt/homebrew/lib/node_modules/wazir/bin/wa.js
```

---

## Verification Commands
```bash
# Arithmetic (under ~3-6 seconds)
wa run "What is 2+2?"

# String reversal
wa run "Reverse the string 'hello world'"

# Valid JSON generation
wa run "Output a valid JSON object with keys name, role, and count"

# Inspect execution metrics
wa executions inspect <executionId>
```
