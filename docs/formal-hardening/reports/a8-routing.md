# Formal Hardening Report: Subagent A8 (Provider Routing, Fallback & Privacy Boundaries)

## Executive Summary

- **Subagent ID**: Subagent A8 (Provider Routing, Fallback & Privacy Boundaries)
- **Campaign**: Wazir 12-Agent Formal Hardening Campaign
- **Working Tree**: `/Users/wael/Code/Wazir/.worktrees/fh-a8-routing` (Branch: `fh/a8-routing`)
- **Git Base HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Alloy 6 Analyzer JAR**: `/Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar` (Alloy 6.2.0 CLI, SAT4J solver)
- **Status**: **CONFIRMED DEFECTS IDENTIFIED, FORMALLY MODELLED, REPRODUCED, AND FIXED**
- **Test Results**:
  - Pre-fix Reproduction Suite: **7/7 failed**
  - Post-fix Reproduction Suite: **7/7 passed**
  - Neighboring & Cross-Package Verification: **67/67 passed** (zero regressions across `providerFallbackBoundaries`, `shadowRouter`, `harnessDispatch`, `schedulerHostedRouting`, `hostedProviderFailure`, and `modelLifecycle`)

---

## 1. Subsystem Scope & Codebase Mapping

Subagent A8 audited the complete routing, provider fallback, shadow exploration, and dispatch subsystem across Wazir:

1. **`packages/core/src/services/scheduler.ts`**:
   - Two-phase scheduling pipeline: constraint resolution (`resolveRoutingConstraint`), residency assessment (`residency`), model qualification (`resolveModelCandidate`), and worker/computer placement (`scheduleComputer`).
   - Hosted provider gating (`effectivePolicyForHosted`).
   - External delegated agent boundary resolution (`resolveForTask`).
2. **`packages/core/src/services/harnessDispatchService.ts`**:
   - Multi-harness dispatch orchestration across native runtimes and external runners (`claude-code`, `codex-cli`, ACP stdio).
   - Candidate eligibility filtering (`evaluateCandidateEligibility`).
   - Primary failure detection, fallback eligibility, and retry loop (`dispatch`).
   - Cumulative budget tracking (`maxCostUSD`, `maxTokens`, `maxToolCalls`, `maxDurationMs`).
3. **`packages/core/src/services/shadowRouterService.ts`**:
   - Production vs. shadow policy evaluation and scoring (`scoreCandidatesForPolicy`).
   - Safe multi-armed bandit exploration (UCB and epsilon-greedy).
   - Task safety gates (`checkTaskExplorationSafety`).
   - Live duplicate shadow execution gating (`evaluateShadow`, `decideWithExploration`).
4. **`apps/cli/src/routeAvailability.ts`**:
   - CLI runtime availability verification loop (`planAvailableRoute`).
   - Dynamic exclusion and iterative re-planning upon runtime model unreadiness.
5. **`packages/core/src/resources/router.ts`**:
   - Resource candidate scoring, cost estimation, and budget previews (`assess`).

---

## 2. Formal Hardening Methodology & Alloy 6 Models

### Invariants Modeled

1. **`FallbackPreservesLocalityAndPrivacy`**:
   $$\forall s \in \text{State} : (\text{Task.isLocalOnly} = \text{True} \lor \text{Task.isSensitive} = \text{True}) \implies (s.\text{activeEndpoint}.\text{isLocal} = \text{True} \land s.\text{shadowEndpoint}.\text{isLocal} = \text{True})$$
   If a task requires local-only execution or processes sensitive/restricted data, no primary dispatch, fallback retry, or shadow evaluation may route to a non-local/hosted endpoint.

2. **`FallbackPreservesRequiredCapabilities`**:
   $$\forall s \in \text{State} : \text{Task.requiresToolCalling} = \text{True} \implies s.\text{activeEndpoint}.\text{hasToolCalling} = \text{True}$$
   Fallback endpoints must strictly satisfy all operational requirements declared by the task.

3. **`FallbackWithinBudgetLimit`**:
   $$\forall s \in \text{State} : s.\text{activeEndpoint}.\text{cost} \le \text{Task.maxBudget}$$
   Fallback selections cannot exceed the declared budget tier.

4. **`RoutingRespectsAllowedEndpoints`**:
   $$\forall s \in \text{State} : s.\text{activeEndpoint} \in \text{Task.allowedEndpoints}$$
   Tasks with explicit whitelists (`allowedModels`, `allowedRuntimes`, `allowedComputers`) can only route to approved endpoints.

5. **`NoRoutingToUnhealthyEndpoints`**:
   $$\forall s \in \text{State} : s.\text{activeEndpoint}.\text{health} = \text{Healthy}$$
   Unhealthy, crashed, or offline endpoints cannot be assigned.

### Alloy 6 Models

- **Specification Model**: [`docs/formal-hardening/models/a8-routing.als`](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/a8-routing.als)
- **Negative Control Mutant**: [`docs/formal-hardening/models/a8-routing-mutant.als`](file:///Users/wael/Code/Wazir/docs/formal-hardening/models/a8-routing-mutant.als)

### Alloy 6 CLI Execution & Verification

Both models were executed against the Alloy 6.2.0 Analyzer CLI with SAT4J:

```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a8-routing \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a8-routing.als

java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a8-routing-mutant \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a8-routing-mutant.als
```

#### Verification Evidence:

1. **`a8-routing.als` (Hardened Specification)**:
   - `WitnessHappyPath`: **SAT** (valid single-dispatch execution trace found)
   - `WitnessFallbackSuccess`: **SAT** (valid primary fail $\to$ fallback dispatch trace found)
   - `WitnessFailClosed`: **SAT** (valid exhaustive failure terminating in `TerminatedExhausted` found)
   - `FallbackPreservesLocalityAndPrivacy`: **UNSAT** (no counterexamples up to 6 steps, 1 Task, 3 Endpoints)
   - `FallbackPreservesRequiredCapabilities`: **UNSAT** (no counterexamples up to 6 steps)
   - `FallbackWithinBudgetLimit`: **UNSAT** (no counterexamples up to 6 steps)
   - `RoutingRespectsAllowedEndpoints`: **UNSAT** (no counterexamples up to 6 steps)
   - `NoRoutingToUnhealthyEndpoints`: **UNSAT** (no counterexamples up to 6 steps)
   *Receipt*: [`docs/formal-hardening/results/a8-routing/receipt.json`](file:///Users/wael/Code/Wazir/docs/formal-hardening/results/a8-routing/receipt.json)

2. **`a8-routing-mutant.als` (Mutant / Bug Simulation)**:
   - `FallbackPreservesLocalityAndPrivacy`: **SAT** (**Counterexample found!**)
   - Trace demonstrates State 1 (local endpoint active) $\to$ State 2 (fails) $\to$ State 3 (mutated fallback selects remote `Endpoint$0` for `Task$0` with `isSensitive=True` and `isLocalOnly=True`).
   - *Receipt*: [`docs/formal-hardening/results/a8-routing-mutant/receipt.json`](file:///Users/wael/Code/Wazir/docs/formal-hardening/results/a8-routing-mutant/receipt.json)

---

## 3. Confirmed Defects & Physical Code Reproductions

### Defect FH-A8-01 (P0): Fallback Leaks Sensitive / Local-Only Tasks to Hosted Providers

- **Subsystems**:
  - `packages/core/src/services/scheduler.ts:167-185,273-289,320-335`
  - `apps/cli/src/routeAvailability.ts:30-45`
- **Severity**: **P0 (Critical Privacy Violation / Data Exfiltration)**
- **Description**:
  In `Scheduler.resolveRoutingConstraint`, the routing mode was determined solely from `cfg.mode` and `task.execution.routingMode`. It completely ignored `task.requirements.localOnly` and `task.policy.dataClassification in ('sensitive', 'restricted')`. When a primary local model became unavailable, `routeAvailability.ts` excluded the local model and re-planned; because the constraint was unconstrained (`AUTO`), the scheduler fell back to registered hosted models (e.g. OpenAI GPT-4o, Anthropic Claude) or external delegated agents, silently transmitting proprietary/sensitive code to cloud APIs.
- **Physical Reproduction**:
  In `packages/core/tests/providerFallbackBoundaries.test.ts` (Tests 1 & 2):
  1. Setting `task.requirements.localOnly = true` scheduled a hosted provider when local runtimes were absent.
  2. In `planAvailableRoute`, when the local model reported `MODEL_UNAVAILABLE`, the router silently substituted `gpt-4o` rather than failing closed.

### Defect FH-A8-02 (P0): External CLI / ACP Harness Fallback Ignores Local-Only & Privacy Policy

- **Subsystem**: `packages/core/src/services/harnessDispatchService.ts:365-385`
- **Severity**: **P0 (Critical Privacy Violation / Sandbox Escape)**
- **Description**:
  In `HarnessDispatchService.evaluateCandidateEligibility`, the candidate filter only checked `constraints.routingMode === 'provider_only'` to exclude non-provider harnesses. It omitted checks for `policyContext.localOnly === true` or `policyContext.dataClassification in ('sensitive', 'restricted')`. When a primary native local runner failed with an infrastructure error (e.g. spawn failure), fallback automatically dispatched the execution request to external CLI or remote ACP harnesses (e.g. `external-cli-remote`).
- **Physical Reproduction**:
  In `packages/core/tests/providerFallbackBoundaries.test.ts` (Test 3):
  A native local harness failed with an infrastructure error. The service dispatched the sensitive task to `external-cli-remote`.

### Defect FH-A8-03 (P1): Harness Fallback Retries Exceed Total Task Budget Limits

- **Subsystem**: `packages/core/src/services/harnessDispatchService.ts:470-520`
- **Severity**: **P1 (Financial / Resource Exhaustion)**
- **Description**:
  When a primary harness failed after consuming resources (e.g. incurring $3.00 on a $2.00 task budget), `HarnessDispatchService.dispatch` re-executed the fallback runner if `allowFallback: true`. While it clamped `remainingCostUSD = Math.max(0, ...)`, it did not evaluate budget exhaustion prior to invoking subsequent candidates. The fallback runner proceeded to execute and consume additional spend, exceeding the declared budget cap.
- **Physical Reproduction**:
  In `packages/core/tests/providerFallbackBoundaries.test.ts` (Test 4):
  Runner 1 consumed $3.00 (> $2.00 maxCostUSD) and failed with an infrastructure error. Fallback runner 2 was invoked and executed.

### Defect FH-A8-04 (P1): Shadow Router Candidate Scoring & Custom Policy Bypass Policy Whitelists

- **Subsystem**: `packages/core/src/services/shadowRouterService.ts:430-490,605-620,695-705,940-955`
- **Severity**: **P1 (Governance & Policy Bypass)**
- **Description**:
  In `ShadowRouterService.scoreCandidatesForPolicy`, candidates were scored and ranked without checking `task.policy.allowedModels`, `task.policy.allowedRuntimes`, or `task.policy.allowedComputers`. If a custom policy `evaluate()` returned an unapproved candidate, it was accepted. Exploration safety checks did not block exploration when a task pinned a single model in `allowedModels`. Furthermore, live shadow execution did not enforce `this.config.perTaskMaxCostDeltaUSD`.
- **Physical Reproduction**:
  In `packages/core/tests/providerFallbackBoundaries.test.ts` (Tests 5 & 6):
  Unapproved models and runtimes scored high and were retained in ranked candidate lists despite explicit task policy whitelist restrictions.

### Defect FH-A8-05 (P1): Stale or Dead Model Instances Retain Ready State and Receive Locality Scoring Boost

- **Subsystem**: `packages/core/src/services/scheduler.ts:310-340,360-390,710-745`
- **Severity**: **P1 (Fault Tolerance / Misrouting)**
- **Description**:
  In `Scheduler.residency` and `preferredWorker`, stale model instances registered on offline computers or crashed runtimes were awarded a +30 residency bonus and treated as `READY`. In `scheduleComputer`, non-local computers (`!computer.local`) and hosted runtimes were not blocked for sensitive/restricted or `localOnly` tasks if the model record was marked `local: true`, permitting remote server worker placement.
- **Physical Reproduction**:
  In `packages/core/tests/providerFallbackBoundaries.test.ts` (Test 7):
  A sensitive task was scheduled on remote computer `remote-worker-1` when no local computer was registered.

---

## 4. Production Code Patches & Mitigation

The minimal, surgical fixes applied to `/Users/wael/Code/Wazir/.worktrees/fh-a8-routing`:

### 1. `packages/core/src/services/scheduler.ts`

- **Enforce `LOCAL_ONLY` Routing Constraint**:
  ```typescript
  if (
    task.policy?.localOnly === true ||
    task.requirements?.localOnly === true ||
    task.policy?.dataClassification === 'sensitive' ||
    task.policy?.dataClassification === 'restricted'
  ) {
    return 'LOCAL_ONLY';
  }
  ```
- **Reject External Delegated Agents on `LOCAL_ONLY`**:
  ```typescript
  if (routingConstraint === 'LOCAL_ONLY') {
    if (delegatedAgent.external || delegatedAgent.provider) {
      throw new SchedulingError(
        `Task requires LOCAL_ONLY routing, but delegated agent '${delegatedAgent.id}' is external or provider-backed.`,
      );
    }
  }
  ```
- **Disallow Hosted Providers on Privacy Tasks**:
  ```typescript
  if (
    task.policy?.localOnly ||
    task.requirements?.localOnly ||
    task.policy?.dataClassification === 'sensitive' ||
    task.policy?.dataClassification === 'restricted'
  ) {
    return { ...basePolicy, localOnly: true, allowHostedProviders: false };
  }
  ```
- **Verify Runtime & Worker Health for Assessment Candidates**:
  ```typescript
  const runtimeObj = candidate.runtimeId ? this.runtimes.get(candidate.runtimeId) : undefined;
  const computerObj = candidate.computerId ? this.computers.get(candidate.computerId) : undefined;
  const runtimeHealthy = runtimeObj ? runtimeObj.health === 'healthy' : true;
  const computerHealthy = computerObj ? computerObj.status === 'online' : true;
  candidate.runtimeAvailable = runtimeHealthy;
  candidate.workerAvailable = computerHealthy;
  ```
- **Reject Remote Worker Placement on Local-Only Tasks**:
  ```typescript
  if (localOnlyRequired) {
    if (computer.local === false) {
      throw new SchedulingError(
        `Task requires local-only execution, but computer '${computer.id}' is remote.`,
      );
    }
  }
  ```

### 2. `packages/core/src/services/harnessDispatchService.ts`

- **Block External CLI & ACP Remote Harnesses on Local Tasks**:
  ```typescript
  if (request.policyContext?.localOnly || request.policyContext?.dataClassification === 'sensitive' || request.policyContext?.dataClassification === 'restricted') {
    if (runner.descriptor.kind === 'external-cli' || runner.descriptor.kind === 'acp') {
      return { eligible: false, reason: `localOnly / ${request.policyContext?.dataClassification ?? 'sensitive'} policy forbids external CLI or ACP harness` };
    }
  }
  ```
- **Fail Closed When Task Budget is Exhausted on Fallback**:
  ```typescript
  if (costExhausted || tokensExhausted || toolsExhausted || durationExhausted) {
    return {
      ...lastResult,
      status: 'failed',
      failureClassification: costExhausted ? 'MAX_COST_EXCEEDED' : durationExhausted ? 'TIMEOUT' : 'BUDGET_EXHAUSTED',
      reasons: [
        ...lastResult.reasons,
        `Fallback candidate '${candidate.descriptor.harnessId}' blocked: budget exhausted after previous attempt.`,
      ],
    };
  }
  ```

### 3. `packages/core/src/services/shadowRouterService.ts`

- **Enforce Policy Whitelists in Candidate Scoring**:
  ```typescript
  if (task.policy?.allowedModels && !task.policy.allowedModels.includes(c.modelId)) return false;
  if (task.policy?.allowedRuntimes && !task.policy.allowedRuntimes.includes(c.runtimeId)) return false;
  if (task.policy?.allowedComputers && c.workerId && !task.policy.allowedComputers.includes(c.workerId)) return false;
  ```
- **Prevent Exploration on Explicit Model Pin**:
  ```typescript
  if (task.policy?.allowedModels && task.policy.allowedModels.length === 1) {
    return {
      allowed: false,
      reason: `blocked: task has explicit allowedModels pin '${task.policy.allowedModels[0]}'`,
      localOnly: Boolean(task.policy?.localOnly || task.requirements?.localOnly),
    };
  }
  ```
- **Enforce `perTaskMaxCostDeltaUSD` on Live Shadow Execution**:
  ```typescript
  } else if (shadowChoice.expectedCostUSD > this.config.perTaskMaxCostDeltaUSD) {
    liveShadowExecutionBlockReason = `live shadow execution cost ($${shadowChoice.expectedCostUSD.toFixed(4)}) exceeds perTaskMaxCostDeltaUSD ($${this.config.perTaskMaxCostDeltaUSD.toFixed(4)})`;
  ```

### 4. `apps/cli/src/routeAvailability.ts`

- **Robust Error Classification on Availability Loop**:
  ```typescript
  const isUnavailable =
    (error instanceof ModelLifecycleError || (error as any)?.name === 'ModelLifecycleError') &&
    (error as any).code === 'MODEL_UNAVAILABLE';
  if (!isUnavailable) throw error;
  ```

---

## 5. Verification & Regression Evidence

### Reproduction Test Suite (`packages/core/tests/providerFallbackBoundaries.test.ts`)

```
 RUN  v2.1.9 /Users/wael/Code/Wazir/.worktrees/fh-a8-routing

 ✓ packages/core/tests/providerFallbackBoundaries.test.ts (7)
   ✓ Provider Fallback & Privacy Boundaries Hardening (7)
     ✓ 1. task.requirements.localOnly must prevent fallback or routing to hosted provider
     ✓ 2. planAvailableRoute must not fall back to hosted provider when local model is unavailable on a localOnly task
     ✓ 3. HarnessDispatchService must not fall back to remote external-cli or ACP harness on local-only task
     ✓ 4. HarnessDispatchService must stop fallback retries when maxCostUSD budget is exhausted
     ✓ 5. ShadowRouterService must filter out unapproved models when task.policy.allowedModels is set
     ✓ 6. ShadowRouterService must filter out unapproved runtimes when task.policy.allowedRuntimes is set
     ✓ 7. Scheduler must not place sensitive task on remote computer

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

### Full Regression & Neighboring Test Suites

1. **`packages/core/tests/providerFallbackBoundaries.test.ts`**: 7/7 passed
2. **`packages/core/tests/shadowRouter.test.ts`**: 16/16 passed
3. **`packages/core/tests/harnessDispatch.test.ts`**: 13/13 passed
4. **`packages/core/tests/schedulerHostedRouting.test.ts`**: 7/7 passed
5. **`apps/cli/tests/hostedProviderFailure.test.ts`**: 2/2 passed
6. **`apps/cli/tests/modelLifecycle.test.ts`**: 22/22 passed

**Total: 67/67 tests passing with 0 regressions.**

---

## 6. Limitations & Future Work

1. **Classification Accuracy**: Fallback isolation relies on tasks or caller workflows properly populating `task.policy.localOnly`, `task.requirements.localOnly`, or `task.policy.dataClassification`.
2. **Harness Descriptor Truthfulness**: Harness boundaries assume `descriptor.kind` accurately reflects the environment (e.g. `'native'` vs `'external-cli'`).
3. **Cost Reporting Integrity**: Budget exhaustion detection requires harness runners to report cumulative `usage.costUSD` truthfully on failure outcomes.
