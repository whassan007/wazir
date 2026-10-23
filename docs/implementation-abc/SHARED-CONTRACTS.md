# Wazir A+B+C Shared Integration Contracts

**Baseline Commit SHA:** `f7a40776bd058b80945ab20667ab7bd1780fa2f0`
**Integration Branch:** `integration/cross-harness-outcome-recovery`
**Contract Version:** `1.0.0` (Schema Version `1`)

## 1. Non-Negotiable Semantic Invariants

1. **Physical Execution Facts vs. Model Claims:**
   - A harness or model claiming completion (`status: "completed"`) is an *apparent* completion (`verified: false`) until the controller's `VerificationEngine` / `evaluateExecution` confirms physical evidence at the current `workspaceRevision`.
   - Model self-confidence is never used as a success probability.
2. **Tool Dispatch vs. Confirmed Side Effects:**
   - Every tool invocation distinguishes `STARTED`, `COMPLETED`, `FAILED`, and `OUTCOME_UNKNOWN`.
   - `OUTCOME_UNKNOWN` for any non-`READ_ONLY` tool blocks automatic replay until reconciled (`APPLIED` or `NOT_APPLIED`) or explicitly authorized by an operator (`UNDETERMINED` fails closed).
3. **Actual vs. Estimated vs. Unknown Monetary Costs:**
   - Local inference (`ollama`, `lmstudio`, local runtimes) has `costStatus: 'ACTUAL'` and `costUSD: 0`.
   - Priced remote API inference has `costStatus: 'ACTUAL'` or `'ESTIMATED'` with `costUSD: number`.
   - Unpriced remote or subscription CLI inference has `costStatus: 'UNKNOWN'` and `costUSD: undefined` (never coerced to `0`).
4. **Security & Policy Enforcement:**
   - External harnesses (ACP, CLI) never receive automatic `always` tool approvals; only one-shot grants permitted by `AcpPermissionMode` and `PolicyEngine` are allowed.
   - Checkpoint restoration and handoff resume cannot escalate permissions or reset consumed budgets.

---

## 2. Canonical Interfaces & File Ownership

### 2.1 Group A: Cross-Harness Execution (`packages/core/src/types/harnessContract.ts`)

Owned by **Agent A1** (`packages/core/src/types/harnessContract.ts`, exported via `packages/core/src/types/index.ts`):

```typescript
import type { TaskType, PolicyRequirements } from './task.js';
import type { ToolCallRecord, CheckRunRecord } from './execution.js';
import type { CostStatus } from './telemetry.js';
import type { AgentErrorKind, TerminationReason } from './agent.js';

export const HARNESS_CONTRACT_SCHEMA_VERSION = 1 as const;

export type HarnessKind = 'native' | 'acp' | 'external-cli';

export type HarnessCapability =
  | 'coding'
  | 'chat'
  | 'step-execution'
  | 'streaming'
  | 'tool-Forwarding'
  | 'checkpoint-resume'
  | 'cancellation'
  | 'mcp'
  | 'workspace-isolation';

export interface HarnessDescriptor {
  harnessId: string;
  name: string;
  version: string;
  kind: HarnessKind;
  capabilities: HarnessCapability[];
  supportedTaskTypes: TaskType[];
  supportedProtocols: Array<'native' | 'acp' | 'stdio-cli'>;
  requiresBinary?: string;
  allowsModelSelection: boolean;
  defaultPermissionMode?: 'read' | 'edit' | 'full';
}

export interface UnifiedExecutionRequest {
  schemaVersion?: number;
  executionId: string;
  taskId: string;
  objective: string;
  taskType?: TaskType;

  harnessPreference?: string;
  modelPreference?: string;
  runtimePreference?: string;

  workspace: {
    root: string;
    revision: string | number;
  };

  constraints: {
    maxCostUSD?: number;
    maxDurationMs?: number;
    maxTokens?: number;
    maxAttempts?: number;
    maxTurns?: number;
    maxToolCalls?: number;
    allowFallback: boolean;
  };

  verification: {
    requiredChecks: string[];
    protectedPaths: string[];
    mutationRequired?: boolean;
    expectedArtifacts?: string[];
  };

  policyContext: PolicyRequirements | Record<string, unknown>;

  checkpointId?: string;
  resumeContext?: import('./agent.js').AgentResumeContext;
  isCancelled?: () => boolean;
}

export type UnifiedExecutionStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

export interface UnifiedArtifactRecord {
  path: string;
  hash?: string;
  kind?: 'file' | 'patch' | 'log' | 'evidence';
  createdAt?: string;
}

export interface UnifiedExecutionResult {
  schemaVersion: number;
  executionId: string;
  taskId: string;

  harnessId: string;
  harnessKind?: HarnessKind;
  modelId: string;
  runtimeId: string;

  status: UnifiedExecutionStatus;
  /** True only when independent controller verification passed at workspaceRevision. */
  verified?: boolean;
  terminationReason?: TerminationReason;
  errorKind?: AgentErrorKind;

  workspaceRevision: string;
  filesChanged?: string[];

  artifacts: UnifiedArtifactRecord[];
  toolCalls: ToolCallRecord[];
  checks?: CheckRunRecord[];

  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
    costStatus?: CostStatus;
    durationMs: number;
    firstTokenLatencyMs?: number;
    modelCalls?: number;
  };

  verificationEvidenceIds: string[];

  checkpointId?: string;
  failureClassification?: string;
  errors?: string[];
  output?: string;
  provenance?: {
    startedAt: string;
    completedAt: string;
    contractDigest: string;
  };
}
```

### 2.2 Group B: Measured Router Qualification

- **Agent B1 (`packages/core/src/services/harnessPerformanceService.ts` & `packages/core/src/services/modelIntelligenceService.ts`)**:
  - Extends `ProfileSegmentationKey` (or defines `HarnessProfileSegmentationKey extends ProfileSegmentationKey` with `harnessId?: string; environmentKey?: string`).
  - `HarnessPerformanceService` tracks `(harnessId, modelId, runtimeId, taskCategory, environment)` outcomes, separating provider/infrastructure outages (`errorKind === 'infrastructure'`, rate limits, connection errors) from coding/verification failures, deduplicating by `executionId`, computing Wilson/Beta confidence intervals and sample counts, and persisting to `KeyValueStore` under `harness-perf/`.
- **Agent B2 (`packages/core/src/resources/router.ts` & `packages/core/src/services/scheduler.ts`)**:
  - Extends `RouteCandidate` with `harnessId?: string; workerId?: string; expectedVerificationCostUsd?: number; expectedRetryCostUsd?: number; expectedColdStartCostUsd?: number; sampleCount?: number; uncertainty?: number`.
  - Extends `RouteAssessment` with `expectedTotalCostUsd?: number; predictedVerifiedSuccessProb?: number; expectedLatencyMs?: number; rationale?: string[]`.
- **Agent B3 (`packages/core/src/services/shadowRouterService.ts`)**:
  - Evaluates candidate routing policies in shadow mode (no live duplicate execution unless explicitly authorized by `allowLiveShadowExecution: true` and non-sensitive task policy), enforces exploration budget (`maxExplorationRate`, `maxExplorationCostUsd`), records predicted vs. observed outcomes, and supports instant rollback to baseline policy.
- **Agent B4 (`packages/core/src/services/telemetryService.ts` & `packages/core/src/services/executionExplanation.ts`)**:
  - Extends `ExecutionExplanation` and `TelemetryCollector` with routing telemetry: harness/model/runtime selection, candidate alternatives, eligibility exclusions, predicted success probability, calibration evidence, estimated vs. actual cost, first-token latency, end-to-end latency, verification duration, cold-start overhead, retry overhead, and routing policy version.
- **Agent B5 (`packages/evaluation/src/comparativeRouterBenchmark.ts` & `packages/core/tests/routerBenchmark.test.ts`)**:
  - Implements reproducible comparative router benchmark across >= 20 task cases spanning multiple categories and difficulty levels, measuring `verified_success_rate`, `cost_per_verified_success`, `end_to_end_latency_p50`, `end_to_end_latency_p95`, `retry_rate`, `fallback_rate`, and `policy_violation_rate` with sample counts, variance, and uncertainty.

### 2.3 Group C: Recovery and Portable Handoffs (`packages/core/src/types/portableCheckpoint.ts`)

Owned by **Agent C1** (`packages/core/src/types/portableCheckpoint.ts`, exported via `packages/core/src/types/index.ts`):

```typescript
import type { PolicyRequirements } from './task.js';
import type { ToolCallCheckpoint } from './execution.js';

export const PORTABLE_HANDOFF_SCHEMA_VERSION = 1 as const;

export interface PortableBudgetState {
  tokensUsed: number;
  toolCallsUsed: number;
  modelCallsUsed: number;
  costUSD: number;
  costStatus: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN';
  durationMs: number;
}

export interface PortableRemainingBudget {
  maxTokens?: number | null;
  maxToolCalls?: number | null;
  maxModelCalls?: number | null;
  maxCostUSD?: number | null;
  maxDurationMs?: number | null;
}

export interface PortableActionSummary {
  actionId: string;
  kind: 'tool_call' | 'file_mutation' | 'verification_check' | 'plan_step';
  summary: string;
  toolName?: string;
  targetPath?: string;
  workspaceRevision: number;
  confirmed: boolean;
  at: string;
}

export interface PortableHandoff {
  schemaVersion: number;

  executionId: string;
  taskId: string;
  jobId?: string;

  sourceHarnessId: string;
  targetHarnessId?: string;
  sourceModelId?: string;
  sourceRuntimeId?: string;
  sourceWorkerId?: string;

  workspaceRevision: string;
  workspaceContentDigest: string;
  checkpointId: string;

  objective: string;
  completedActions: PortableActionSummary[];
  pendingActions: string[];
  filesChanged: string[];

  unresolvedSideEffects: ToolCallCheckpoint[];

  verificationEvidenceIds: string[];

  consumedBudget: PortableBudgetState;
  remainingBudget: PortableRemainingBudget;

  policyContext: PolicyRequirements;

  resumable: boolean;
  nonResumableReason?: string;

  createdAt: string;
  integrityDigest: string;
}
```

---

## 3. Agent File Ownership Matrix (Zero-Conflict Isolation)

| Agent | Branch | Owned / Created Production & Test Files |
|---|---|---|
| **A1** | `feat/harness-contract` | `packages/core/src/types/harnessContract.ts`, `packages/core/tests/harnessContract.test.ts` |
| **A2** | `feat/native-harness-adapter` | `packages/agents/src/nativeHarnessAdapter.ts`, `packages/agents/tests/nativeHarnessAdapter.test.ts` |
| **A3** | `feat/external-harness-adapter` | `packages/agents/src/externalHarnessAdapter.ts`, `packages/agents/src/acp/acpHarnessCapabilities.ts`, `packages/agents/tests/externalHarnessAdapter.test.ts` |
| **A4** | `feat/harness-dispatch` | `packages/core/src/services/harnessDispatchService.ts`, `packages/core/tests/harnessDispatch.test.ts` |
| **A5** | `test/harness-conformance` | `packages/agents/tests/harnessConformance.test.ts`, `packages/agents/tests/fixtures/deterministicAcpFixture.ts` |
| **B1** | `feat/harness-performance` | `packages/core/src/services/harnessPerformanceService.ts`, `packages/core/src/services/modelIntelligenceService.ts`, `packages/core/tests/harnessPerformance.test.ts` |
| **B2** | `feat/outcome-routing` | `packages/core/src/resources/router.ts`, `packages/core/src/services/scheduler.ts`, `packages/core/tests/outcomeRouting.test.ts` |
| **B3** | `feat/router-exploration` | `packages/core/src/services/shadowRouterService.ts`, `packages/core/tests/shadowRouter.test.ts` |
| **B4** | `feat/router-telemetry` | `packages/core/src/services/telemetryService.ts`, `packages/core/src/services/executionExplanation.ts`, `packages/core/tests/routerTelemetry.test.ts` |
| **B5** | `test/router-benchmark` | `packages/evaluation/src/comparativeRouterBenchmark.ts`, `packages/evaluation/tests/comparativeRouterBenchmark.test.ts` |
| **C1** | `feat/portable-checkpoint` | `packages/core/src/types/portableCheckpoint.ts`, `packages/core/src/services/checkpointService.ts`, `packages/core/tests/portableCheckpoint.test.ts` |
| **C2** | `feat/harness-resume` | `packages/core/src/services/handoffService.ts`, `packages/core/src/services/harnessResumeService.ts`, `packages/core/tests/harnessResume.test.ts` |
| **C3** | `feat/recovery-reconciliation` | `packages/core/src/services/executionRecovery.ts`, `packages/core/src/services/recoveryManager.ts`, `packages/core/tests/portableRecovery.test.ts` |
| **C4** | `feat/checkpoint-transport` | `packages/core/src/services/checkpointTransportService.ts`, `packages/workers/src/checkpointTransportClient.ts`, `apps/api/src/checkpointTransportRoutes.ts`, `packages/core/tests/checkpointTransport.test.ts` |
| **C5** | `test/cross-harness-recovery` | `packages/core/tests/crossHarnessRecoveryQualification.test.ts` |
| **Orchestrator** | `integration/cross-harness-outcome-recovery` | Barrel exports (`index.ts`), CLI/API wiring, `docs/implementation-abc/*`, full E2E integration tests |
