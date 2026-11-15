# A17 — Formal Audit Report: Model Availability, Provider Timeouts, Stream Interruptions & Routing Stickiness

- **Agent ID**: A17 (Gemini TIER 1 — Model Availability & Routing Stickiness Auditor)
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Assigned Subsystem**: Model Availability, Provider Timeouts, Streaming Interruptions, Routing Stickiness, Circuit Breakers & Resumption (GROUP B P0/P1)
- **Critical Invariant**: *"A fallback model must satisfy the original task's authorization, capability, privacy, context, and resource constraints, and stickiness across turns and resumption must never revert to abandoned or failed models."*
- **Formal Toolchain**: Alloy 6.2.0 CLI (`tools/alloy/org.alloytools.alloy.dist.jar`), Java OpenJDK 21.0.12.1 (SAT4J Engine)
- **Alloy Models**:
  - Reference: [`tests/formal-hardening/models/a17-routing-stickiness.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a17-routing-stickiness.als)
  - Defect Mutant: [`tests/formal-hardening/models/a17-routing-stickiness-mutant.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a17-routing-stickiness-mutant.als)
- **Alloy Logs**:
  - Reference Logs: [`tests/formal-hardening/logs/alloy-a17-routing-stickiness/`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness/)
  - Mutant Logs: [`tests/formal-hardening/logs/alloy-a17-routing-stickiness-mutant/`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness-mutant/)
- **Executable Reproduction Suite**: [`tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts) (5 deterministic tests passing with Vitest)
- **Status**: **CONFIRMED PRODUCTION DEFECTS**

---

## 1. Executive Summary

This formal audit evaluated the fault tolerance, timeout handling, stream recovery, scheduling admission, and stickiness boundaries governing AI model execution in Wazir. The scope encompassed the turn-loop execution engine in `@wazir/agents` ([`CodingAgent`](file:///Users/wael/Code/Wazir/packages/agents/src/codingAgent.ts)), provider adapters in `@wazir/runtimes` (OpenAI, Anthropic, Google Gemini, Ollama, LMStudio, and Nvidia adapters), the two-phase scheduler in `@wazir/core` ([`Scheduler`](file:///Users/wael/Code/Wazir/packages/core/src/services/scheduler.ts)), model lifecycle management ([`ModelLifecycleService`](file:///Users/wael/Code/Wazir/packages/core/src/services/modelLifecycleService.ts)), reliability tracking ([`ModelReliabilityTracker`](file:///Users/wael/Code/Wazir/packages/core/src/services/modelReliability.ts)), and CLI orchestration and recovery ([`escalation.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/escalation.ts), [`routeAvailability.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/routeAvailability.ts), [`harnessResumeService.ts`](file:///Users/wael/Code/Wazir/packages/core/src/services/harnessResumeService.ts), and [`fleetRunner.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts)).

Our rigorous investigation revealed **five high-severity (P1) vulnerabilities** and **three medium-severity (P2) architectural flaws** that fundamentally break system reliability and violate the critical routing invariant:

1. **Abort Signal Crash in CodingAgent Turn Loop [P1-A17-01]**: When a model turn exceeds `modelTurnTimeoutMs` or prose limits, `CodingAgent` invokes `runtime.cancelCurrentTurn()` expecting the turn to gracefully yield `{ timedOut: true }` so it can issue a correction prompt and retry. Instead, runtime adapters throw an unhandled `Error("Request cancelled")`. Because `controlledGeneration` rethrows this generic error and `CodingAgent` fails to catch it, the entire generator loop crashes fatally, terminating the execution without retrying or triggering model fallback.
2. **Canonical Stream Interruption Rejection [P1-A17-02]**: When a provider stream terminates prematurely without a terminal completion event, `CodingAgent` raises `Error("INCOMPLETE_PROVIDER_STREAM: stream ended without terminal completion event")`. However, the retry predicate `TRANSIENT_STREAM_PATTERN` exclusively inspects low-level POSIX socket errors (`ECONNRESET`, `socket hang up`) and fails to match canonical Wazir stream failure errors (`INCOMPLETE_PROVIDER_STREAM`, `MALFORMED_PROVIDER_STREAM`), causing sudden transient stream cuts to fail permanently on attempt 1 of 3.
3. **Bypass of `allowFallback: false` When `defaultModel` Is Omitted [P1-A17-03]**: In `Scheduler.routeModel()`, the critical guard enforcing `!routing.allowFallback` only triggers if `routing.defaultModel` was explicitly defined. When an unpinned task without an explicit `defaultModel` specifies `execution.allowFallback: false`, `Scheduler` ignores the setting and silently selects alternate fallback models from the eligible pool.
4. **Resumption Stickiness Inversion via Stale Durable Records [P1-A17-04]**: When mid-flight model escalation switches execution to a capable fallback model, `escalateExecutionModel` appends an audit event to `record.events` but fails to update `record.execution.modelId`. Consequently, upon task interruption, checkpoint save, or harness resumption, `harnessResumeService` and `fleetRunner` read the un-updated `record.execution.modelId` and resurrect the abandoned, broken model.
5. **Loaded Small-Context Models Stamped `READY_NOW` [P1-A17-05]**: In `Scheduler.plan()`, existing placements with `state === 'READY'` are automatically assigned `readiness: 'READY_NOW'` regardless of whether `placed.contextTokens` satisfies `task.minimumContextTokens`. `prepareGenerationPlacement` relies on this readiness tag to skip `ensureReady()`, placing large-context tasks onto under-dimensioned context windows and inducing immediate runtime context overflows.

---

## 2. Comprehensive Subsystem Boundary & Trace Analysis

| Subsystem Component | File & Line | Verified Behavior | Failure Mode Under Fault / Fallback | Severity |
|---|---|---|---|---|
| `CodingAgent.modelTurnWithStreamRetry` | `packages/agents/src/codingAgent.ts:1082-1135` | Catches stream errors matching `TRANSIENT_STREAM_PATTERN` up to `maxRetries` | Throws immediately on `INCOMPLETE_PROVIDER_STREAM`; zero retries executed | **P1** |
| `CodingAgent.run` & `generationControl` | `packages/agents/src/codingAgent.ts:984-987`, `packages/runtimes/src/generationControl.ts:80-84` | Cancels turn via `runtime.cancelCurrentTurn()` on timeout | Adapters throw `Error("Request cancelled")`; turn loop aborts fatally | **P1** |
| `Scheduler.routeModel` | `packages/core/src/services/scheduler.ts:681-687` | Routes model based on capabilities and placement | If `defaultModel` undefined, `allowFallback: false` is completely bypassed | **P1** |
| `CLI.escalateExecutionModel` | `apps/cli/src/escalation.ts:101-120` | Appends `model.route.changed` event to `record.events` | Fails to update `record.execution.modelId`; checkpoint/resume resurrects failed model | **P1** |
| `Scheduler.plan` | `packages/core/src/services/scheduler.ts:458, 1123-1132` | Stamps `readiness: 'READY_NOW'` when `placed.state === 'READY'` | Ignores `placed.contextTokens < task.minimumContextTokens`, skipping required reload | **P1** |
| `CLI.escalateExecutionModel` | `apps/cli/src/escalation.ts:36-40` | Gathers context requirements for fallback route | Uses initial `finalRequiredTokens`, ignoring transcript token growth | **P2** |
| `Scheduler.plan` (Model Filtering) | `packages/core/src/services/scheduler.ts:1010-1014` | Excludes `state: 'UNAVAILABLE'` or `health: 'unavailable'` | Permits `state: 'FAILED'` or `health: 'degraded'` models to be re-routed immediately | **P2** |
| `routeAvailability.planAvailableRoute` | `apps/cli/src/routeAvailability.ts:28-44` | Iterates models and checks computer availability | Skips all availability verification for hosted provider endpoints | **P2** |

---

## 3. Formal Alloy 6 Verification & Proof Matrix

The formal specification of model availability, fallback admissibility, and routing stickiness was modeled in Alloy 6 using first-order temporal logic (LTL) with SAT4J:
- Reference Specification: [`a17-routing-stickiness.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a17-routing-stickiness.als)
- Defect Mutant Specification: [`a17-routing-stickiness-mutant.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a17-routing-stickiness-mutant.als)

### 3.1 Reference Specification Verification

Execution Command:
```bash
/Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec \
  -f -t text -c '*' -o tests/formal-hardening/logs/alloy-a17-routing-stickiness \
  tests/formal-hardening/models/a17-routing-stickiness.als
```

Verification Outcome:
- `WitnessHappyPath`: **SAT** ([`WitnessHappyPath-solution-0.txt`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness/WitnessHappyPath-solution-0.txt))
  - Valid primary dispatch, turn execution, and successful completion.
- `WitnessFallbackSuccess`: **SAT** ([`WitnessFallbackSuccess-solution-0.txt`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness/WitnessFallbackSuccess-solution-0.txt))
  - Primary model fails, circuit trips, compliant fallback model is selected satisfying all task constraints, and execution reaches completion.
- `WitnessFailClosed`: **SAT** ([`WitnessFailClosed-solution-0.txt`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness/WitnessFailClosed-solution-0.txt))
  - Fallback is disallowed (`allowFallback = False`) or no candidates satisfy constraints; engine safely fails closed into `PhaseFailedClosed`.
- `check FallbackPreservesAllConstraints`: **UNSAT** (0 counterexamples up to 6 steps, 3 Models)
  - Proven: Every active fallback model strictly preserves authorization, locality/privacy, tool-calling capability, and context capacity.
- `check RoutingStickinessPreserved`: **UNSAT** (0 counterexamples up to 6 steps, 3 Models)
  - Proven: Once a failed model is abandoned, the engine never rolls back to it across subsequent turns or resumptions.
- `check DisallowedFallbackFailsClosed`: **UNSAT** (0 counterexamples up to 6 steps, 3 Models)
  - Proven: When `allowFallback = False`, no alternative model can be dispatched.
- `check TimeoutDoesNotCrash`: **UNSAT** (0 counterexamples up to 6 steps, 3 Models)
  - Proven: Handled turn timeouts do not induce unhandled generator crashes.

### 3.2 Negative-Control Defect Mutant Analysis

Execution Command:
```bash
/Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec \
  -f -t text -c '*' -o tests/formal-hardening/logs/alloy-a17-routing-stickiness-mutant \
  tests/formal-hardening/models/a17-routing-stickiness-mutant.als
```

Verification Outcome:
- `check FallbackPreservesAllConstraints`: **SAT (Counterexample Found)** ([`FallbackPreservesAllConstraints-solution-0.txt`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness-mutant/FallbackPreservesAllConstraints-solution-0.txt))
  - Mutant omits context capacity validation during fallback (matching P1-A17-05). Alloy generates a counterexample where an under-dimensioned model is assigned to a large-context task.
- `check RoutingStickinessPreserved`: **SAT (Counterexample Found)** ([`RoutingStickinessPreserved-solution-0.txt`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness-mutant/RoutingStickinessPreserved-solution-0.txt))
  - Mutant fails to update `durableModel` on model escalation (matching P1-A17-04). Resumption from durable storage resurrects the abandoned, failed primary model.
- `check DisallowedFallbackFailsClosed`: **SAT (Counterexample Found)** ([`DisallowedFallbackFailsClosed-solution-0.txt`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness-mutant/DisallowedFallbackFailsClosed-solution-0.txt))
  - Mutant permits fallback when `Task.allowFallback = False` (matching P1-A17-03). Alloy generates a trace where an unauthorized alternate model is dispatched.
- `check TimeoutDoesNotCrash`: **SAT (Counterexample Found)** ([`TimeoutDoesNotCrash-solution-0.txt`](file:///Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a17-routing-stickiness-mutant/TimeoutDoesNotCrash-solution-0.txt))
  - Mutant simulates unhandled adapter abort error (matching P1-A17-01). Alloy proves that the turn loop transitions directly into `PhaseCrashed`.

---

## 4. Detailed Vulnerability Analyses

### 4.1 [P1-A17-01] Provider Abort Error Crashes CodingAgent Turn Loop
- **Subsystem**: Agent Runtime Execution / Provider Adapter Interoperability
- **Primary Source Locations**:
  - [`packages/runtimes/openai/src/index.ts:362-367`](file:///Users/wael/Code/Wazir/packages/runtimes/openai/src/index.ts#L362-L367)
  - [`packages/runtimes/anthropic/src/index.ts:236-238, 355-357`](file:///Users/wael/Code/Wazir/packages/runtimes/anthropic/src/index.ts#L236-L238)
  - [`packages/runtimes/google/src/index.ts:279-281, 375-377`](file:///Users/wael/Code/Wazir/packages/runtimes/google/src/index.ts#L279-L281)
  - [`packages/runtimes/interfaces/src/generationControl.ts:80-84`](file:///Users/wael/Code/Wazir/packages/runtimes/interfaces/src/generationControl.ts#L80-L84)
  - [`packages/agents/src/codingAgent.ts:984-987, 1557, 1791`](file:///Users/wael/Code/Wazir/packages/agents/src/codingAgent.ts#L984-L987)
- **Critical Invariant**: *"A timeout or controlled turn interruption must not crash the agent execution loop; it must allow graceful retry, correction prompting, or governed model escalation."*
- **Mechanism**:
  In `CodingAgent.run()`, each model turn is guarded by `modelTurnTimeoutMs` and prose char thresholds (`maxProseBeforeActionChars`). When a threshold fires, `CodingAgent` invokes:
  ```typescript
  if (options.runtime && typeof (options.runtime as any).cancelCurrentTurn === 'function') {
    (options.runtime as any).cancelCurrentTurn();
  }
  ```
  `CodingAgent` expects the turn stream to exit with `{ timedOut: true }` so it can execute lines 984–987:
  ```typescript
  if (turn.timedOut) {
    yield* this.handleTurnTimeout(...);
    continue;
  }
  ```
  However, in `OpenAIAdapter`, `AnthropicAdapter`, and `GoogleAdapter`, the active generator reacts to `controller.signal.aborted` by throwing:
  ```typescript
  if (controller.signal.aborted) {
    throw new Error('Request cancelled');
  }
  ```
  In `packages/runtimes/interfaces/src/generationControl.ts:80-84`, `controlledGeneration` wraps generation:
  ```typescript
  try {
    yield* generator();
  } catch (error) {
    if (error instanceof GenerationLimitError) {
      return { timedOut: true, ... };
    }
    throw error; // Re-throws generic Error('Request cancelled')!
  }
  ```
  `controlledGeneration` only catches its own `GenerationLimitError`. When the provider adapter throws `Error('Request cancelled')`, it bubbles out of `controlledGeneration`. `CodingAgent` does not catch this error, destroying the entire execution generator.
- **Impact**: Turn timeouts and prose interruptions permanently terminate executions with unhandled rejections rather than retrying or escalating.
- **Reproduction**: Test 1 in `tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts`.

---

### 4.2 [P1-A17-02] Canonical Stream Interruption Errors Bypassed by `TRANSIENT_STREAM_PATTERN`
- **Subsystem**: Agent Stream Retry Management
- **Primary Source Locations**:
  - [`packages/agents/src/codingAgent.ts:140-143, 1082-1084, 1106-1120`](file:///Users/wael/Code/Wazir/packages/agents/src/codingAgent.ts#L140-L143)
- **Critical Invariant**: *"Transient streaming interruptions and incomplete provider responses must be retried with exponential backoff before failing the task or triggering fallback."*
- **Mechanism**:
  `CodingAgent` implements stream recovery in `modelTurnWithStreamRetry`:
  ```typescript
  const TRANSIENT_STREAM_PATTERN =
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|premature close|network timeout|fetch failed)\b/i;
  ```
  When an SSE provider stream cuts off prematurely without an ending `[DONE]` token or closing chunk, the runtime adapters throw canonical Wazir stream errors:
  ```typescript
  throw new Error('INCOMPLETE_PROVIDER_STREAM: stream ended without terminal completion event');
  // or 'MALFORMED_PROVIDER_STREAM: incomplete json payload'
  ```
  When tested against `TRANSIENT_STREAM_PATTERN.test(err.message)`, this returns `false`.
  As a result, line 1118:
  ```typescript
  if (!isTransientStreamError(err) || attempt >= maxRetries) {
    throw err;
  }
  ```
  triggers immediately on `attempt = 1`. The stream retry mechanism is completely bypassed.
- **Impact**: Transient network hiccups during SSE streaming immediately terminate the agent turn instead of performing the 3 configured retries.
- **Reproduction**: Test 2 in `tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts`.

---

### 4.3 [P1-A17-03] Missing `allowFallback: false` Enforcement When `defaultModel` Is Omitted
- **Subsystem**: Core Scheduler Routing & Admission Control
- **Primary Source Locations**:
  - [`packages/core/src/services/scheduler.ts:681-687`](file:///Users/wael/Code/Wazir/packages/core/src/services/scheduler.ts#L681-L687)
  - [`apps/cli/src/routeAvailability.ts:24-44`](file:///Users/wael/Code/Wazir/apps/cli/src/routeAvailability.ts#L24-L44)
- **Critical Invariant**: *"When fallback is disabled (allowFallback: false), the scheduler must never route to an alternative model if candidate models are excluded or fail."*
- **Mechanism**:
  In `packages/core/src/services/scheduler.ts`:
  ```typescript
  if (
    routing.allowFallback === false &&
    routing.defaultModel &&
    excludeModelIds.includes(routing.defaultModel)
  ) {
    throw new SchedulingError(
      'ROUTING_FALLBACK_DISALLOWED',
      `Routing fallback is disallowed and default model ${routing.defaultModel} is excluded`
    );
  }
  ```
  Notice the condition: `routing.allowFallback === false && routing.defaultModel && ...`.
  If a task request is configured with:
  ```json
  {
    "execution": { "allowFallback": false },
    "routing": { "eligible": ["model-a", "model-b"] }
  }
  ```
  where `defaultModel` is undefined (or when `defaultModel` has not yet been selected), and `excludeModelIds` contains `["model-a"]`, the `if` block evaluates to `false`!
  The scheduler proceeds past the check, filters `models` by `excludeModelIds`, finds `model-b`, and successfully returns `model-b` as a route!
- **Impact**: Users and automated policies that explicitly forbid fallback models have their constraints silently violated when tasks are launched without an explicit `defaultModel`.
- **Reproduction**: Test 3 in `tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts`.

---

### 4.4 [P1-A17-04] Model Escalations Do Not Persist to `ExecutionRecord.execution.modelId` (Resumption Stickiness Inversion)
- **Subsystem**: Execution State Persistence & Checkpoint Resumption
- **Primary Source Locations**:
  - [`packages/core/src/services/executionEngine.ts:750-775, 1553-1572`](file:///Users/wael/Code/Wazir/packages/core/src/services/executionEngine.ts#L750-L775)
  - [`apps/cli/src/escalation.ts:101-120`](file:///Users/wael/Code/Wazir/apps/cli/src/escalation.ts#L101-L120)
  - [`packages/core/src/services/harnessResumeService.ts:1199-1201`](file:///Users/wael/Code/Wazir/packages/core/src/services/harnessResumeService.ts#L1199-L1201)
  - [`apps/cli/src/fleetRunner.ts:170-200, 249-252`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L170-L200)
- **Critical Invariant**: *"Stickiness across turns and resumption must never revert to abandoned or failed models."*
- **Mechanism**:
  When a model is escalated mid-execution due to capacity failure or repeated errors, `escalateExecutionModel` in `apps/cli/src/escalation.ts:101-120` runs:
  ```typescript
  await executionEngine.recordEvent({
    executionId: record.id,
    type: 'model.route.changed',
    source: 'system',
    phase: 'executing',
    metadata: {
      fromModelId: previousModelId,
      toModelId: targetModelId,
      reason: escalationReason,
      route: plan.route,
    },
  });
  ```
  `recordEvent` flushes the event into `record.events`. However, **it never updates `record.execution.modelId`**! Only `engine.steerExecution` modifies `record.execution.modelId`.
  When an execution is suspended, checkpointed, or resumed via `harnessResumeService` or `fleetRunner`:
  ```typescript
  const effectiveModelId = record.execution?.modelId || plan.modelId;
  ```
  The resumption service reads `record.execution.modelId`, which still points to the initial, failed model `previousModelId`!
- **Impact**: Resumed tasks revert to the exact failed model that caused the escalation, inducing identical failures and breaking execution forward progress.
- **Reproduction**: Test 4 in `tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts`.

---

### 4.5 [P1-A17-05] Loaded Small-Context Models Stamped `READY_NOW`, Bypassing Context Expansion
- **Subsystem**: Scheduler Phase 2 / Model Lifecycle Integration
- **Primary Source Locations**:
  - [`packages/core/src/services/scheduler.ts:458, 1123-1132, 1159-1163, 1428-1430`](file:///Users/wael/Code/Wazir/packages/core/src/services/scheduler.ts#L458)
  - [`apps/cli/src/escalation.ts:152-155`](file:///Users/wael/Code/Wazir/apps/cli/src/escalation.ts#L152-L155)
- **Critical Invariant**: *"A fallback model must satisfy the original task's context constraint before being scheduled or stamped ready."*
- **Mechanism**:
  In `packages/core/src/services/scheduler.ts:1123-1132`:
  ```typescript
  const placed = placements.find((p) => p.modelId === targetModelId && p.computerId === computer.id);
  const readiness = placed?.state === 'READY'
    ? 'READY_NOW'
    : placed?.state === 'LOADING'
      ? 'LOADING'
      : 'NEEDS_LOAD';
  ```
  Notice that `readiness` is assigned `'READY_NOW'` solely if `placed.state === 'READY'`.
  However, local models (e.g. running under Ollama, vLLM, or llama.cpp) can be loaded with small default context windows (e.g. `contextTokens: 4096`).
  If a task arrives requiring `minimumContextTokens: 32768`, and the computer has a model loaded with `contextTokens: 4096`, `Scheduler.plan` stamps `readiness: 'READY_NOW'`.
  In `apps/cli/src/escalation.ts:152-155`:
  ```typescript
  if (routePlan.readiness !== 'READY_NOW') {
    await modelLifecycle.ensureReady(routePlan.placement);
  }
  ```
  Because `readiness === 'READY_NOW'`, `modelLifecycle.ensureReady()` is bypassed! The model is not re-loaded with expanded context.
- **Impact**: Tasks immediately fail with runtime context truncation or out-of-context errors during execution.
- **Reproduction**: Test 5 in `tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts`.

---

### 4.6 [P2-A17-06] Model Escalation Routes Against Stale Initial Prompt Budget
- **Subsystem**: CLI Escalation & Context Estimation
- **Primary Source Locations**:
  - [`apps/cli/src/run.ts:607-612`](file:///Users/wael/Code/Wazir/apps/cli/src/run.ts#L607-L612)
  - [`apps/cli/src/fleetRunner.ts:262-267`](file:///Users/wael/Code/Wazir/apps/cli/src/fleetRunner.ts#L262-L267)
  - [`apps/cli/src/escalation.ts:36-40`](file:///Users/wael/Code/Wazir/apps/cli/src/escalation.ts#L36-L40)
- **Mechanism**:
  When mid-run escalation occurs, `escalateExecutionModel` constructs context requirements using:
  ```typescript
  const minimumContextTokens =
    contextRequirements?.finalRequiredTokens ??
    contextRequirements?.minimumContextTokens ??
    8192;
  ```
  `finalRequiredTokens` is calculated at task initialization prior to turn 1. As the agent interacts with tools, edits code, and accumulates terminal logs, the active transcript token count grows significantly. Routing the fallback model against the initial static token count permits fallback models whose context windows are smaller than the active transcript.

---

### 4.7 [P2-A17-07] Scheduler Does Not Exclude Models in `state: 'FAILED'` or `health: 'degraded'`
- **Subsystem**: Core Scheduler Computer Placement
- **Primary Source Locations**:
  - [`packages/core/src/services/scheduler.ts:1010-1014, 1179-1181, 1342-1345`](file:///Users/wael/Code/Wazir/packages/core/src/services/scheduler.ts#L1010-L1014)
- **Mechanism**:
  In `Scheduler.scheduleComputer`, placement filtering excludes models only if:
  ```typescript
  if (placement.state === 'UNAVAILABLE' || placement.health === 'unavailable') {
    continue;
  }
  ```
  If a model failed repeatedly during an earlier run or is marked `state: 'FAILED'` or `health: 'degraded'`, the scheduler does not exclude it from the candidate list unless explicitly included in `excludeModelIds`.

---

### 4.8 [P2-A17-08] `planAvailableRoute` Completely Bypasses Verification for Hosted Providers
- **Subsystem**: CLI Route Availability
- **Primary Source Locations**:
  - [`apps/cli/src/routeAvailability.ts:28-44`](file:///Users/wael/Code/Wazir/apps/cli/src/routeAvailability.ts#L28-L44)
- **Mechanism**:
  In `apps/cli/src/routeAvailability.ts`:
  ```typescript
  for (const candidateModelId of candidateModelIds) {
    const scheduling = await scheduler.plan({ ... });
    const targetComputerId = scheduling.placement?.computerId;
    if (!targetComputerId) {
      return { modelId: candidateModelId, scheduling };
    }
    const available = await verifyModelAvailable(modelLifecycle, candidateModelId, targetComputerId);
    if (available) return ...;
  }
  ```
  For hosted models (OpenAI, Anthropic, Google), `scheduling.placement.computerId` is `undefined`. `planAvailableRoute` immediately returns the candidate without checking credentials, rate limit status, or reliability circuit breaker state.

---

## 5. Deterministic Reproduction Evidence

The test suite [`tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts) reproduces each of the five P1 findings deterministically without flaky timers or external network dependencies:

```bash
cd /Users/wael/Code/Wazir && npx vitest run tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts
```

Output:
```
 RUN  v2.1.9 /Users/wael/Code/Wazir

 ✓ tests/formal-hardening/reproductions/A17-routing-stickiness.test.ts (5)
   ✓ A17 — Model Availability, Provider Timeouts, Stream Interruptions & Routing Stickiness (5)
     ✓ FINDING 1 (P1): Provider abort throws unhandled Error("Request cancelled"), crashing CodingAgent turn timeout recovery (18ms)
     ✓ FINDING 2 (P1): INCOMPLETE_PROVIDER_STREAM does not match TRANSIENT_STREAM_PATTERN, failing immediately without retry (4ms)
     ✓ FINDING 3 (P1): allowFallback=false is bypassed when defaultModel is undefined, enabling unauthorized model substitutions (12ms)
     ✓ FINDING 4 (P1): Model escalation does not persist to ExecutionRecord.execution.modelId, breaking stickiness across resumption (9ms)
     ✓ FINDING 5 (P1): Scheduler flags loaded instance as READY_NOW even when loaded context is insufficient for task (3ms)

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  21:15:56
   Duration  2.05s
```

---

## 6. Strategic Remediation Roadmap

To fully satisfy the formal invariants without breaking existing workflows, the following targeted patches should be applied:

### Remediation 1: Normalize Turn Aborts into Governed Turn Timeout Results
In `packages/runtimes/interfaces/src/generationControl.ts`:
```typescript
try {
  yield* generator();
} catch (error: any) {
  if (
    error instanceof GenerationLimitError ||
    error?.message?.includes('Request cancelled') ||
    error?.name === 'AbortError'
  ) {
    return {
      timedOut: true,
      text: accumulatedText,
      totalProseChars: proseCount,
      totalActionChars: actionCount,
    };
  }
  throw error;
}
```

### Remediation 2: Expand `TRANSIENT_STREAM_PATTERN` to Match Canonical Stream Errors
In `packages/agents/src/codingAgent.ts:140`:
```typescript
const TRANSIENT_STREAM_PATTERN =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|premature close|network timeout|fetch failed|INCOMPLETE_PROVIDER_STREAM|MALFORMED_PROVIDER_STREAM)\b/i;
```

### Remediation 3: Strengthen `allowFallback: false` in `Scheduler.routeModel`
In `packages/core/src/services/scheduler.ts:681`:
```typescript
if (routing.allowFallback === false && excludeModelIds.length > 0) {
  throw new SchedulingError(
    'ROUTING_FALLBACK_DISALLOWED',
    `Routing fallback is disallowed and primary model candidates are excluded: ${excludeModelIds.join(', ')}`
  );
}
```

### Remediation 4: Persist Escalated Model ID to `ExecutionRecord.execution.modelId`
In `apps/cli/src/escalation.ts:101`:
```typescript
await executionEngine.steerExecution({
  executionId: record.id,
  targetModelId,
  reason: escalationReason,
});
```
Or directly in `executionEngine.recordEvent`: when `type === 'model.route.changed'`, update `record.execution.modelId = metadata.toModelId`.

### Remediation 5: Include Context Tokens in `Scheduler.plan` Readiness Gate
In `packages/core/src/services/scheduler.ts:1123`:
```typescript
const isContextSufficient = !task.minimumContextTokens || (placed?.contextTokens ?? 0) >= task.minimumContextTokens;
const readiness = placed?.state === 'READY' && isContextSufficient
  ? 'READY_NOW'
  : placed?.state === 'LOADING'
    ? 'LOADING'
    : 'NEEDS_LOAD';
```
