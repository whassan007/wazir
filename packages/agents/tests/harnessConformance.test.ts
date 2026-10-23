import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PolicyEngine,
  VerificationEngine,
  detectOracleWeakening,
  classifyOption,
  type AgentAdapter,
  type AgentRunRequest,
  type AgentRuntime,
  type AgentTurn,
  type ToolCallRecord,
  type CheckRunRecord,
  type PolicyRequirements,
  type TaskType,
  type CostStatus,
  type AgentErrorKind,
  type TerminationReason,
} from '@wazir/core';
import { CodingAgent } from '../src/codingAgent.js';
import {
  AcpAgentAdapter,
  decideAcpPermission,
  type AcpPermissionMode,
} from '../src/acp/acpAgentAdapter.js';
import {
  createDeterministicAcpSpec,
  createEmptyAcpAuditLog,
} from './fixtures/deterministicAcpFixture.js';

// ============================================================================
// Shared Contract Types (Group A: Cross-Harness Execution Contract v1)
// ============================================================================

const HARNESS_CONTRACT_SCHEMA_VERSION = 1 as const;

type HarnessKind = 'native' | 'acp' | 'external-cli';

type HarnessCapability =
  | 'coding'
  | 'chat'
  | 'step-execution'
  | 'streaming'
  | 'tool-Forwarding'
  | 'checkpoint-resume'
  | 'cancellation'
  | 'mcp'
  | 'workspace-isolation';

interface HarnessDescriptor {
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

interface UnifiedExecutionRequest {
  schemaVersion?: number;
  executionId: string;
  taskId: string;
  objective: string;
  taskType?: TaskType;
  harnessPreference?: string;
  modelPreference?: string;
  runtimePreference?: string;
  requiredCapabilities?: HarnessCapability[];
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
  isCancelled?: () => boolean;
}

type UnifiedExecutionStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';

interface UnifiedArtifactRecord {
  path: string;
  hash?: string;
  kind?: 'file' | 'patch' | 'log' | 'evidence';
  createdAt?: string;
}

interface UnifiedExecutionResult {
  schemaVersion: number;
  executionId: string;
  taskId: string;
  harnessId: string;
  harnessKind?: HarnessKind;
  modelId: string;
  runtimeId: string;
  status: UnifiedExecutionStatus;
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

// ============================================================================
// Deterministic Conformance Controller & Harness Runner
// ============================================================================

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function createDeterministicNativeRuntime(options: {
  projectRoot: string;
  policyEngine: PolicyEngine;
  verificationEngine: VerificationEngine;
  scriptedResponses: Array<Record<string, unknown> | string>;
  checkOutcomes?: Record<string, { ok: boolean; output: string }>;
  protectedPaths?: string[];
  unavailable?: boolean;
  costStatus?: CostStatus;
  costUSD?: number;
}): {
  runtime: AgentRuntime;
  toolCallRecords: ToolCallRecord[];
  checkRecords: CheckRunRecord[];
} {
  let turnIndex = 0;
  const toolCallRecords: ToolCallRecord[] = [];
  const checkRecords: CheckRunRecord[] = [];
  const protectedPaths = options.protectedPaths ?? [];

  const tools: AgentRuntime['tools'] = [
    {
      name: 'read',
      description: 'Read a file inside the workspace',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'write',
      description: 'Write a file inside the workspace',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit',
      description: 'Edit a file inside the workspace',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
    {
      name: 'shell',
      description: 'Execute a shell command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
    {
      name: 'build',
      description: 'Run project build check',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'test',
      description: 'Run project test suite',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'lint',
      description: 'Run project lint check',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'typecheck',
      description: 'Run project typecheck',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  const runtime: AgentRuntime = {
    tools,
    async *generate() {
      if (options.unavailable) {
        throw new Error('RUNTIME_UNAVAILABLE: Primary runtime endpoint is unreachable (ECONNREFUSED)');
      }
      const next = options.scriptedResponses[turnIndex] ?? {
        action: 'done',
        summary: 'Completed task.',
      };
      turnIndex += 1;
      const text = typeof next === 'string' ? next : JSON.stringify(next);
      yield { type: 'token', content: text };
      yield {
        type: 'completed',
        content: text,
        finishReason: 'stop',
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
      };
    },
    async executeTool(toolName: string, input: Record<string, unknown>) {
      const started = Date.now();
      const rawPath = typeof input.path === 'string' ? input.path : undefined;

      // 1. PolicyEngine authorization check
      const policyDecision = await options.policyEngine.authorize({
        tool: toolName,
        input,
        projectRoot: options.projectRoot,
      });

      // 2. Protected oracle path check on mutating file tools
      if ((toolName === 'write' || toolName === 'edit') && rawPath) {
        const rel = path.relative(options.projectRoot, path.resolve(options.projectRoot, rawPath));
        const normalizedRel = rel.split(path.sep).join('/');
        if (
          protectedPaths.some(
            (pp) => normalizedRel === pp || normalizedRel.endsWith(`/${pp}`),
          )
        ) {
          const deniedRecord: ToolCallRecord = {
            id: `tc-${toolCallRecords.length + 1}`,
            tool: toolName,
            input,
            ok: false,
            error: `PROTECTED_PATH_DENIED: modification of protected oracle path '${normalizedRel}' is forbidden`,
            policyEffect: 'deny',
            policyRule: 'protected-oracle-path-deny',
            durationMs: Date.now() - started,
            at: new Date(),
          };
          toolCallRecords.push(deniedRecord);
          return {
            ok: false,
            output: '',
            error: deniedRecord.error,
            durationMs: deniedRecord.durationMs,
          };
        }
      }

      if (policyDecision.decision !== 'allow') {
        const deniedRecord: ToolCallRecord = {
          id: `tc-${toolCallRecords.length + 1}`,
          tool: toolName,
          input,
          ok: false,
          error: `POLICY_DENIED (${policyDecision.rule}): ${policyDecision.reasons.join('; ')}`,
          policyEffect: policyDecision.decision,
          policyRule: policyDecision.rule,
          durationMs: Date.now() - started,
          at: new Date(),
        };
        toolCallRecords.push(deniedRecord);
        return {
          ok: false,
          output: '',
          error: deniedRecord.error,
          durationMs: deniedRecord.durationMs,
        };
      }

      // Execute allowed tool
      if (toolName === 'read' && rawPath) {
        const abs = path.resolve(options.projectRoot, rawPath);
        const content = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const rec: ToolCallRecord = {
          id: `tc-${toolCallRecords.length + 1}`,
          tool: toolName,
          input,
          output: content,
          ok: true,
          policyEffect: 'allow',
          policyRule: policyDecision.rule,
          durationMs: Date.now() - started,
          at: new Date(),
        };
        toolCallRecords.push(rec);
        return { ok: true, output: content, durationMs: rec.durationMs };
      }

      if ((toolName === 'write' || toolName === 'edit') && rawPath) {
        const abs = path.resolve(options.projectRoot, rawPath);
        const beforeContent = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        const afterContent =
          toolName === 'write'
            ? String(input.content ?? '')
            : (beforeContent ?? '').replace(
                String(input.oldString ?? ''),
                String(input.newString ?? ''),
              );

        // Check anti-test-theater / oracle weakening before committing
        const rel = path.relative(options.projectRoot, abs).split(path.sep).join('/');
        const findings = detectOracleWeakening(rel, beforeContent, afterContent);
        if (findings.length > 0) {
          const reason = `ORACLE_WEAKENING_BLOCKED: ${findings.map((f) => f.detail).join(', ')}`;
          const rec: ToolCallRecord = {
            id: `tc-${toolCallRecords.length + 1}`,
            tool: toolName,
            input,
            ok: false,
            error: reason,
            policyEffect: 'deny',
            policyRule: 'verification-integrity-guard',
            durationMs: Date.now() - started,
            at: new Date(),
          };
          toolCallRecords.push(rec);
          return { ok: false, output: '', error: reason, durationMs: rec.durationMs };
        }

        await fs.mkdir(path.dirname(abs), { recursive: true });
        writeFileSync(abs, afterContent, 'utf8');
        const mutation = options.verificationEngine.trackPhysicalMutation({
          filePath: rel,
          beforeContent,
          afterContent,
        });

        const rec: ToolCallRecord = {
          id: `tc-${toolCallRecords.length + 1}`,
          tool: toolName,
          input,
          output: `wrote ${rel}`,
          ok: true,
          policyEffect: 'allow',
          policyRule: policyDecision.rule,
          durationMs: Date.now() - started,
          at: new Date(),
        };
        toolCallRecords.push(rec);
        return {
          ok: true,
          output: `wrote ${rel}`,
          durationMs: rec.durationMs,
          fileMutations: [{ path: rel, changed: mutation.mutated }],
        };
      }

      if (['build', 'test', 'lint', 'typecheck'].includes(toolName)) {
        const outcome = options.checkOutcomes?.[toolName] ?? {
          ok: true,
          output: `${toolName} passed (exit 0)`,
        };
        const checkRec: CheckRunRecord = {
          workspaceRevision: options.verificationEngine.getRevision(),
          name: toolName as CheckRunRecord['name'],
          command: `npm run ${toolName}`,
          ok: outcome.ok,
          output: outcome.output,
          durationMs: Date.now() - started,
        };
        checkRecords.push(checkRec);
        const rec: ToolCallRecord = {
          id: `tc-${toolCallRecords.length + 1}`,
          tool: toolName,
          input,
          output: outcome.output,
          ok: outcome.ok,
          error: outcome.ok ? undefined : outcome.output,
          policyEffect: 'allow',
          policyRule: policyDecision.rule,
          durationMs: checkRec.durationMs,
          at: new Date(),
        };
        toolCallRecords.push(rec);
        return {
          ok: outcome.ok,
          output: outcome.output,
          error: outcome.ok ? undefined : outcome.output,
          durationMs: rec.durationMs,
        };
      }

      const rec: ToolCallRecord = {
        id: `tc-${toolCallRecords.length + 1}`,
        tool: toolName,
        input,
        output: 'ok',
        ok: true,
        policyEffect: 'allow',
        policyRule: policyDecision.rule,
        durationMs: Date.now() - started,
        at: new Date(),
      };
      toolCallRecords.push(rec);
      return { ok: true, output: 'ok', durationMs: rec.durationMs };
    },
  };

  return { runtime, toolCallRecords, checkRecords };
}

/**
 * Executes a `UnifiedExecutionRequest` across either the Native (`CodingAgent`) or ACP
 * (`AcpAgentAdapter`) harness, enforcing contract schema version validation, capability
 * pre-flight gating, runtime fallback policy, and independent `VerificationEngine` checks.
 */
async function executeUnifiedHarnessRequest(params: {
  request: UnifiedExecutionRequest;
  descriptor: HarnessDescriptor;
  adapter: AgentAdapter;
  runtime: AgentRuntime;
  fallback?: {
    descriptor: HarnessDescriptor;
    adapter: AgentAdapter;
    runtime: AgentRuntime;
  };
  verificationEngine: VerificationEngine;
  independentChecks?: Array<{
    oracle: 'BUILD' | 'TEST' | 'TYPECHECK' | 'LINT';
    command: string;
    exitCode: number;
    output: string;
    evidenceRevision?: number;
  }>;
  costConfig?: {
    costStatus: CostStatus;
    costUSD?: number;
  };
}): Promise<UnifiedExecutionResult> {
  const startedAt = new Date();
  const startMs = Date.now();
  const req = params.request;
  const schemaVersion = req.schemaVersion ?? HARNESS_CONTRACT_SCHEMA_VERSION;

  const contractDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ executionId: req.executionId, taskId: req.taskId, objective: req.objective }))
    .digest('hex');

  // 1. Execution Contract Schema Version Gate (Scenario 12)
  if (schemaVersion !== HARNESS_CONTRACT_SCHEMA_VERSION) {
    return {
      schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
      executionId: req.executionId,
      taskId: req.taskId,
      harnessId: params.descriptor.harnessId,
      harnessKind: params.descriptor.kind,
      modelId: req.modelPreference ?? 'unknown',
      runtimeId: req.runtimePreference ?? 'unknown',
      status: 'failed',
      verified: false,
      terminationReason: 'POLICY_DENIED',
      errorKind: 'protocol',
      workspaceRevision: String(params.verificationEngine.getRevision()),
      filesChanged: [],
      artifacts: [],
      toolCalls: [],
      checks: [],
      usage: { durationMs: Date.now() - startMs, costStatus: 'ACTUAL', costUSD: 0 },
      verificationEvidenceIds: [],
      failureClassification: 'CONTRACT_SCHEMA_VERSION_MISMATCH',
      errors: [
        `CONTRACT_VERSION_MISMATCH: Unsupported execution contract schemaVersion '${schemaVersion}'; expected '${HARNESS_CONTRACT_SCHEMA_VERSION}'`,
      ],
      provenance: {
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        contractDigest,
      },
    };
  }

  // 2. Pre-flight Capability Validation Gate (Scenario 10)
  const missingCapabilities = (req.requiredCapabilities ?? []).filter(
    (cap) => !params.descriptor.capabilities.includes(cap),
  );
  if (
    missingCapabilities.length > 0 ||
    (req.taskType &&
      params.descriptor.supportedTaskTypes.length > 0 &&
      !params.descriptor.supportedTaskTypes.includes(req.taskType))
  ) {
    const reason =
      missingCapabilities.length > 0
        ? `UNSUPPORTED_CAPABILITY: Harness '${params.descriptor.harnessId}' lacks required capabilities: ${missingCapabilities.join(', ')}`
        : `UNSUPPORTED_TASK_TYPE: Harness '${params.descriptor.harnessId}' does not support taskType '${req.taskType}'`;
    return {
      schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
      executionId: req.executionId,
      taskId: req.taskId,
      harnessId: params.descriptor.harnessId,
      harnessKind: params.descriptor.kind,
      modelId: req.modelPreference ?? 'unknown',
      runtimeId: req.runtimePreference ?? 'unknown',
      status: 'failed',
      verified: false,
      terminationReason: 'POLICY_DENIED',
      errorKind: 'policy',
      workspaceRevision: String(params.verificationEngine.getRevision()),
      filesChanged: [],
      artifacts: [],
      toolCalls: [],
      checks: [],
      usage: { durationMs: Date.now() - startMs, costStatus: 'ACTUAL', costUSD: 0 },
      verificationEvidenceIds: [],
      failureClassification: 'UNSUPPORTED_CAPABILITY',
      errors: [reason],
      provenance: {
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        contractDigest,
      },
    };
  }

  // 3. Execute Primary Harness (with optional Fallback on Infrastructure Error - Scenario 11)
  const runSingleHarness = async (
    desc: HarnessDescriptor,
    adapter: AgentAdapter,
    runtime: AgentRuntime,
  ) => {
    const turns: AgentTurn[] = [];
    const toolCalls: ToolCallRecord[] = [];
    let thrownError: Error | undefined;

    const agentRequest: AgentRunRequest = {
      modelId: req.modelPreference ?? 'deterministic-model',
      taskDescription: req.objective,
      taskType: req.taskType ?? 'coding',
      projectRoot: req.workspace.root,
      maxTurns: req.constraints.maxTurns ?? 10,
      maxToolCalls: req.constraints.maxToolCalls ?? 25,
      maxTokens: req.constraints.maxTokens ?? 100_000,
      maxWallClockMs: req.constraints.maxDurationMs ?? 15_000,
      mutationRequired: req.verification.mutationRequired ?? true,
      expectedArtifacts: req.verification.expectedArtifacts,
      isCancelled: req.isCancelled,
    };

    try {
      for await (const turn of adapter.run(agentRequest, runtime)) {
        turns.push(turn);
        if (turn.kind === 'tool_call' && turn.tool) {
          toolCalls.push({
            id: `tc-${toolCalls.length + 1}`,
            tool: turn.tool,
            input: turn.toolInput ?? {},
            output: turn.toolResult?.output,
            ok: turn.toolResult?.ok ?? true,
            error: turn.toolResult?.error,
            policyEffect: turn.toolResult?.ok === false ? 'deny' : 'allow',
            policyRule: 'harness-tool-dispatch',
            durationMs: turn.toolResult?.durationMs ?? 0,
            at: new Date(),
          });
        }
      }
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err));
    }

    return { desc, turns, toolCalls, thrownError };
  };

  let attemptResult = await runSingleHarness(params.descriptor, params.adapter, params.runtime);
  const lastTurn = attemptResult.turns.at(-1);
  const isInfraFailure =
    Boolean(attemptResult.thrownError && /RUNTIME_UNAVAILABLE|ECONNREFUSED/i.test(attemptResult.thrownError.message)) ||
    (lastTurn?.kind === 'error' && lastTurn.errorKind === 'infrastructure');

  if (isInfraFailure && params.fallback) {
    if (req.constraints.allowFallback) {
      attemptResult = await runSingleHarness(
        params.fallback.descriptor,
        params.fallback.adapter,
        params.fallback.runtime,
      );
    } else {
      return {
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: req.executionId,
        taskId: req.taskId,
        harnessId: params.descriptor.harnessId,
        harnessKind: params.descriptor.kind,
        modelId: req.modelPreference ?? 'deterministic-model',
        runtimeId: req.runtimePreference ?? 'primary-runtime',
        status: 'failed',
        verified: false,
        terminationReason: 'RESOURCE_EXHAUSTED',
        errorKind: 'infrastructure',
        workspaceRevision: String(params.verificationEngine.getRevision()),
        filesChanged: [],
        artifacts: [],
        toolCalls: attemptResult.toolCalls,
        checks: [],
        usage: { durationMs: Date.now() - startMs, costStatus: 'UNKNOWN', costUSD: undefined },
        verificationEvidenceIds: [],
        failureClassification: 'RUNTIME_UNAVAILABLE_FALLBACK_FORBIDDEN',
        errors: [
          attemptResult.thrownError?.message ??
            lastTurn?.error ??
            'Primary runtime unavailable and allowFallback is false (fail-closed)',
        ],
        provenance: {
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          contractDigest,
        },
      };
    }
  }

  const terminalTurn = attemptResult.turns.at(-1);
  const activeDesc = attemptResult.desc;

  // Detect files physically written in workspace root for ACP harnesses
  for (const expectedArtifact of req.verification.expectedArtifacts ?? ['solution.ts']) {
    const abs = path.resolve(req.workspace.root, expectedArtifact);
    if (
      existsSync(abs) &&
      !params.verificationEngine.getFilesChanged().includes(expectedArtifact)
    ) {
      params.verificationEngine.trackPhysicalMutation({
        filePath: expectedArtifact,
        beforeContent: null,
        afterContent: readFileSync(abs, 'utf8'),
      });
    }
  }

  // Record independent controller verification checks
  const evidenceIds: string[] = [];
  if (params.independentChecks) {
    for (const chk of params.independentChecks) {
      const ev = params.verificationEngine.recordEvidence({
        oracle: chk.oracle,
        command: chk.command,
        exitCode: chk.exitCode,
        output: chk.output,
        workspaceRevision: chk.evidenceRevision ?? params.verificationEngine.getRevision(),
      });
      evidenceIds.push(ev.id);
    }
  }

  const requiredOracles = req.verification.requiredChecks.map((c) => {
    const u = c.toUpperCase();
    if (u === 'BUILD' || u === 'TEST' || u === 'LINT' || u === 'TYPECHECK') return u;
    return 'TEST';
  });

  const completionEval = params.verificationEngine.verifyCompletion({
    mutationRequired: req.verification.mutationRequired ?? true,
    expectedFiles: req.verification.expectedArtifacts,
    requiredOracles,
  });

  // Determine unified status
  let status: UnifiedExecutionStatus = 'failed';
  let failureClassification: string | undefined;
  const errors: string[] = [];

  if (attemptResult.thrownError) {
    errors.push(attemptResult.thrownError.message);
    status = 'failed';
    failureClassification = 'UNHANDLED_HARNESS_ERROR';
  } else if (terminalTurn?.kind === 'done') {
    // Invariant 1: Apparent completion is only verified if VerificationEngine confirms physical evidence
    status = 'completed';
  } else if (terminalTurn?.kind === 'error') {
    errors.push(terminalTurn.error ?? 'harness error');
    if (terminalTurn.terminationReason === 'CANCELLED' || terminalTurn.errorKind === 'cancelled') {
      status = 'cancelled';
      failureClassification = 'CANCELLED_BY_CONTROLLER';
    } else if (
      /exited during the turn|code 137|SIGKILL|simulated mid-turn/i.test(terminalTurn.error ?? '') ||
      (terminalTurn.errorKind === 'infrastructure' &&
        attemptResult.turns.some((t) => t.kind === 'tool_call'))
    ) {
      status = 'interrupted';
      failureClassification = 'CHILD_PROCESS_INTERRUPTED';
    } else if (/UNSUPPORTED_CAPABILITY/i.test(terminalTurn.error ?? '')) {
      status = 'failed';
      failureClassification = 'UNSUPPORTED_CAPABILITY';
    } else {
      status = 'failed';
      failureClassification = terminalTurn.terminationReason ?? 'EXECUTION_FAILED';
    }
  }

  const verified = status === 'completed' && completionEval.complete;
  if (status === 'completed' && !verified) {
    errors.push(...completionEval.reasons);
    failureClassification = 'UNVERIFIED_APPARENT_COMPLETION';
  }

  const filesChanged = params.verificationEngine.getFilesChanged();
  const artifacts: UnifiedArtifactRecord[] = filesChanged
    .filter((f) => existsSync(path.resolve(req.workspace.root, f)))
    .map((f) => {
      const content = readFileSync(path.resolve(req.workspace.root, f));
      return {
        path: f,
        hash: crypto.createHash('sha256').update(content).digest('hex'),
        kind: 'file' as const,
        createdAt: new Date().toISOString(),
      };
    });

  const costStatus: CostStatus =
    params.costConfig?.costStatus ?? (activeDesc.kind === 'native' ? 'ACTUAL' : 'UNKNOWN');
  const costUSD: number | undefined =
    costStatus === 'UNKNOWN' ? undefined : (params.costConfig?.costUSD ?? 0);

  return {
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: req.executionId,
    taskId: req.taskId,
    harnessId: activeDesc.harnessId,
    harnessKind: activeDesc.kind,
    modelId: req.modelPreference ?? 'deterministic-model',
    runtimeId: req.runtimePreference ?? (activeDesc.kind === 'native' ? 'local-ollama' : 'acp-stdio'),
    status,
    verified,
    terminationReason: terminalTurn?.terminationReason,
    errorKind: terminalTurn?.errorKind,
    workspaceRevision: String(params.verificationEngine.getRevision()),
    filesChanged,
    artifacts,
    toolCalls: attemptResult.toolCalls,
    usage: {
      inputTokens: terminalTurn?.runStats?.tokensUsed ?? 60,
      outputTokens: 20,
      totalTokens: terminalTurn?.runStats?.tokensUsed ?? 60,
      costStatus,
      costUSD,
      durationMs: Date.now() - startMs,
      modelCalls: terminalTurn?.runStats?.turns ?? 1,
    },
    verificationEvidenceIds: evidenceIds,
    failureClassification,
    errors: errors.length > 0 ? errors : undefined,
    output: terminalTurn?.content,
    provenance: {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      contractDigest,
    },
  };
}

function assertUnifiedExecutionResultContract(result: UnifiedExecutionResult): void {
  expect(result.schemaVersion).toBe(HARNESS_CONTRACT_SCHEMA_VERSION);
  expect(typeof result.executionId).toBe('string');
  expect(result.executionId.length).toBeGreaterThan(0);
  expect(typeof result.taskId).toBe('string');
  expect(typeof result.harnessId).toBe('string');
  expect(['native', 'acp', 'external-cli']).toContain(result.harnessKind);
  expect(['completed', 'failed', 'cancelled', 'interrupted', 'unknown']).toContain(result.status);
  expect(typeof result. verified).toBe('boolean');
  expect(typeof result.workspaceRevision).toBe('string');
  expect(Array.isArray(result.artifacts)).toBe(true);
  expect(Array.isArray(result.toolCalls)).toBe(true);
  expect(Array.isArray(result.verificationEvidenceIds)).toBe(true);
  expect(typeof result.usage.durationMs).toBe('number');
  expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.provenance?.contractDigest).toMatch(/^[a-f0-9]{64}$/);

  // Non-Negotiable Semantic Invariant 3: Cost Status
  if (result.usage.costStatus === 'UNKNOWN') {
    expect(result.usage.costUSD).toBeUndefined();
  } else if (result.usage.costStatus === 'ACTUAL' || result.usage.costStatus === 'ESTIMATED') {
    expect(typeof result.usage.costUSD).toBe('number');
  }
}

// ============================================================================
// Mandatory 12-Scenario Cross-Harness Conformance & Security Suite (Agent A5)
// ============================================================================

describe('Group A (Agent A5): Cross-Harness Conformance & Security Suite', () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
      workspaceDir = undefined;
    }
  });

  const createWorkspace = async (): Promise<string> => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-conformance-a5-'));
    return workspaceDir;
  };

  const nativeDescriptor: HarnessDescriptor = {
    harnessId: 'wazir-native',
    name: 'Wazir Native Coding Agent',
    version: '1.0.0',
    kind: 'native',
    capabilities: [
      'coding',
      'chat',
      'step-execution',
      'streaming',
      'checkpoint-resume',
      'cancellation',
      'workspace-isolation',
    ],
    supportedTaskTypes: ['coding', 'debugging', 'code_analysis', 'chat'],
    supportedProtocols: ['native'],
    allowsModelSelection: true,
    defaultPermissionMode: 'edit',
  };

  const acpDescriptor: HarnessDescriptor = {
    harnessId: 'acp-codex',
    name: 'ACP External Coding Harness',
    version: '1.0.0',
    kind: 'acp',
    capabilities: ['coding', 'streaming', 'cancellation', 'workspace-isolation'],
    supportedTaskTypes: ['coding', 'debugging'],
    supportedProtocols: ['acp'],
    allowsModelSelection: false,
    defaultPermissionMode: 'edit',
  };

  const makeBaseRequest = (root: string, overrides: Partial<UnifiedExecutionRequest> = {}): UnifiedExecutionRequest => ({
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: `exec-${crypto.randomBytes(4).toString('hex')}`,
    taskId: 'task-conformance-1',
    objective: 'Implement solution.ts exporting answer = 42 and pass tests.',
    taskType: 'coding',
    workspace: { root, revision: 0 },
    constraints: {
      maxTurns: 8,
      maxToolCalls: 15,
      maxDurationMs: 10_000,
      allowFallback: false,
    },
    verification: {
      requiredChecks: ['BUILD', 'TEST'],
      protectedPaths: ['tests/oracle.test.ts'],
      mutationRequired: true,
      expectedArtifacts: ['solution.ts'],
    },
    policyContext: { localOnly: true },
    ...overrides,
  });

  // --------------------------------------------------------------------------
  // Scenario 1: Native agent execution produces contract-compliant result
  // --------------------------------------------------------------------------
  it('1. Native agent execution produces a contract-compliant UnifiedExecutionResult', async () => {
    const root = await createWorkspace();
    const policyEngine = new PolicyEngine({ projectRoot: root });
    const verificationEngine = new VerificationEngine({
      projectRoot: root,
      protectedFiles: ['tests/oracle.test.ts'],
    });

    const { runtime } = createDeterministicNativeRuntime({
      projectRoot: root,
      policyEngine,
      verificationEngine,
      scriptedResponses: [
        { action: 'plan', content: '1. Write solution.ts 2. Run build & test 3. Complete' },
        {
          action: 'tool',
          tool: 'write',
          input: { path: 'solution.ts', content: 'export const answer = 42;\n' },
        },
        { action: 'done', summary: 'Implemented solution.ts and verified build and tests.' },
      ],
    });

    const nativeAgent = new CodingAgent({ maxTurns: 8 });
    const request = makeBaseRequest(root, { harnessPreference: 'wazir-native' });

    const result = await executeUnifiedHarnessRequest({
      request,
      descriptor: nativeDescriptor,
      adapter: nativeAgent,
      runtime,
      verificationEngine,
      independentChecks: [
        { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'Build succeeded' },
        { oracle: 'TEST', command: 'npm test', exitCode: 0, output: 'All tests passed' },
      ],
      costConfig: { costStatus: 'ACTUAL', costUSD: 0 },
    });

    assertUnifiedExecutionResultContract(result);
    expect(result.harnessId).toBe('wazir-native');
    expect(result.harnessKind).toBe('native');
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(result.terminationReason).toBe('VERIFICATION_PASSED');
    expect(result.filesChanged).toContain('solution.ts');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe('solution.ts');
    expect(result.verificationEvidenceIds).toHaveLength(2);
    expect(result.usage.costStatus).toBe('ACTUAL');
    expect(result.usage.costUSD).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 2: ACP agent execution produces contract-compliant result
  // --------------------------------------------------------------------------
  it('2. ACP agent execution produces an identical contract-compliant UnifiedExecutionResult (both in-memory and stdio)', async () => {
    const root = await createWorkspace();
    const verificationEngine = new VerificationEngine({ projectRoot: root });
    const auditLog = createEmptyAcpAuditLog();

    const acpSpec = createDeterministicAcpSpec({
      scenario: 'normal-completion',
      mode: 'in-memory',
      targetFile: 'solution.ts',
      targetContent: 'export const answer = 42;\n',
      auditLog,
    });
    const acpAdapter = new AcpAgentAdapter(acpSpec);
    const request = makeBaseRequest(root, { harnessPreference: 'acp-codex' });

    const result = await executeUnifiedHarnessRequest({
      request,
      descriptor: acpDescriptor,
      adapter: acpAdapter,
      runtime: {} as AgentRuntime,
      verificationEngine,
      independentChecks: [
        { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'Build succeeded' },
        { oracle: 'TEST', command: 'npm test', exitCode: 0, output: 'All tests passed' },
      ],
      costConfig: { costStatus: 'UNKNOWN' },
    });

    assertUnifiedExecutionResultContract(result);
    expect(result.harnessId).toBe('acp-codex');
    expect(result.harnessKind).toBe('acp');
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(result.terminationReason).toBe('COMPLETED');
    expect(result.filesChanged).toContain('solution.ts');
    expect(result.artifacts[0].path).toBe('solution.ts');
    expect(result.verificationEvidenceIds).toHaveLength(2);
    // Invariant 3: Unpriced external subscription/CLI inference has costStatus: 'UNKNOWN' and costUSD: undefined
    expect(result.usage.costStatus).toBe('UNKNOWN');
    expect(result.usage.costUSD).toBeUndefined();
    expect(auditLog.initialized).toBe(true);
    expect(auditLog.permissionRequests).toHaveLength(1);
    expect(auditLog.permissionRequests[0].selectedOptionId).toBe('allow-once');

    // Also verify real stdio child-process execution produces the same result
    const stdioRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-conformance-stdio-'));
    try {
      const stdioVerification = new VerificationEngine({ projectRoot: stdioRoot });
      const stdioSpec = createDeterministicAcpSpec({
        scenario: 'normal-completion',
        mode: 'stdio',
        targetFile: 'solution.ts',
      });
      const stdioResult = await executeUnifiedHarnessRequest({
        request: makeBaseRequest(stdioRoot),
        descriptor: acpDescriptor,
        adapter: new AcpAgentAdapter(stdioSpec),
        runtime: {} as AgentRuntime,
        verificationEngine: stdioVerification,
        independentChecks: [
          { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'ok' },
          { oracle: 'TEST', command: 'npm test', exitCode: 0, output: 'ok' },
        ],
      });
      assertUnifiedExecutionResultContract(stdioResult);
      expect(stdioResult.status).toBe('completed');
      expect(stdioResult.verified).toBe(true);
      expect(existsSync(path.join(stdioRoot, 'solution.ts'))).toBe(true);
    } finally {
      await fs.rm(stdioRoot, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Tool approval and denial across harnesses
  // --------------------------------------------------------------------------
  it('3. Enforces one-shot tool approval in edit mode, denies execute in read/edit mode, and never grants always escalation', async () => {
    const root = await createWorkspace();
    const auditLog = createEmptyAcpAuditLog();

    // 3a. Direct unit verification of decideAcpPermission across modes
    const classifiedOptions = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ].map(classifyOption);

    expect(decideAcpPermission('edit', 'edit', classifiedOptions)).toEqual({ optionId: 'allow-once' });
    expect(decideAcpPermission('read', 'edit', classifiedOptions)).toEqual({ cancelled: true });
    expect(decideAcpPermission('read', 'execute', classifiedOptions)).toEqual({ cancelled: true });
    expect(decideAcpPermission('edit', 'execute', classifiedOptions)).toEqual({ cancelled: true });

    const alwaysOnly = [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }].map(
      classifyOption,
    );
    for (const mode of ['read', 'edit', 'full'] as AcpPermissionMode[]) {
      expect(decideAcpPermission(mode, 'edit', alwaysOnly)).toEqual({ cancelled: true });
      expect(decideAcpPermission(mode, 'execute', alwaysOnly)).toEqual({ cancelled: true });
    }

    // 3b. Run malicious-always-permission scenario through AcpAgentAdapter in edit mode
    const maliciousSpec = createDeterministicAcpSpec({
      scenario: 'malicious-always-permission',
      mode: 'in-memory',
      permissionMode: 'edit',
      auditLog,
    });
    const adapter = new AcpAgentAdapter(maliciousSpec);
    const turns: AgentTurn[] = [];
    for await (const turn of adapter.run(
      {
        modelId: 'external',
        taskType: 'coding',
        taskDescription: 'Attempt privilege escalation',
        projectRoot: root,
      },
      {} as AgentRuntime,
    )) {
      turns.push(turn);
    }

    // Every malicious permission request must be cancelled/denied
    expect(auditLog.permissionRequests).toHaveLength(3);
    for (const req of auditLog.permissionRequests) {
      expect(req.outcome).toBe('cancelled');
      expect(req.selectedOptionId).toBeUndefined();
    }
    expect(existsSync(path.join(root, 'compromised.txt'))).toBe(false);
    expect(
      turns.filter((t) => t.kind === 'message' && t.content?.includes('permission denied')),
    ).toHaveLength(3);
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Malformed external output handled without crashing controller
  // --------------------------------------------------------------------------
  it('4. Handles malformed external output and invalid JSON/update payloads without crashing the controller', async () => {
    const root = await createWorkspace();

    // 4a. ACP harness emitting malformed sessionUpdate payloads
    const acpVerification = new VerificationEngine({ projectRoot: root });
    const acpSpec = createDeterministicAcpSpec({
      scenario: 'malformed-output',
      mode: 'in-memory',
    });
    const acpResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root, {
        verification: { requiredChecks: [], protectedPaths: [], mutationRequired: false },
      }),
      descriptor: acpDescriptor,
      adapter: new AcpAgentAdapter(acpSpec),
      runtime: {} as AgentRuntime,
      verificationEngine: acpVerification,
    });

    assertUnifiedExecutionResultContract(acpResult);
    expect(acpResult.status).toBe('completed');
    expect(acpResult.output).toContain('Controller survived malformed output payloads.');

    // 4b. Native CodingAgent receiving 3 malformed non-JSON responses fails gracefully with protocol error
    const policyEngine = new PolicyEngine({ projectRoot: root });
    const nativeVerification = new VerificationEngine({ projectRoot: root });
    const { runtime } = createDeterministicNativeRuntime({
      projectRoot: root,
      policyEngine,
      verificationEngine: nativeVerification,
      scriptedResponses: [
        '<<CORRUPTED_NON_JSON_STREAM_1>>',
        '<<<INVALID_JSON { broken: ]]]',
        'still not valid json at all',
      ],
    });

    const nativeResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root),
      descriptor: nativeDescriptor,
      adapter: new CodingAgent({ maxTurns: 6 }),
      runtime,
      verificationEngine: nativeVerification,
    });

    assertUnifiedExecutionResultContract(nativeResult);
    expect(nativeResult.status).toBe('failed');
    expect(nativeResult.verified).toBe(false);
    expect(nativeResult.errorKind).toBe('protocol');
    expect(nativeResult.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Interrupted child processes detected and reported cleanly
  // --------------------------------------------------------------------------
  it('5. Detects interrupted child processes (exit code 137 / SIGKILL mid-turn) and reports interrupted status', async () => {
    const root = await createWorkspace();

    // Test both in-memory crash simulation and real stdio process exiting with code 137
    for (const mode of ['in-memory', 'stdio'] as const) {
      const verificationEngine = new VerificationEngine({ projectRoot: root });
      const crashSpec = createDeterministicAcpSpec({
        scenario: 'crash-mid-turn',
        mode,
        targetFile: 'solution.ts',
      });

      const result = await executeUnifiedHarnessRequest({
        request: makeBaseRequest(root),
        descriptor: acpDescriptor,
        adapter: new AcpAgentAdapter(crashSpec),
        runtime: {} as AgentRuntime,
        verificationEngine,
      });

      assertUnifiedExecutionResultContract(result);
      expect(result.status).toBe('interrupted');
      expect(result.verified).toBe(false);
      expect(result.errorKind).toBe('infrastructure');
      expect(result.failureClassification).toBe('CHILD_PROCESS_INTERRUPTED');
      expect(result.errors?.[0]).toMatch(/exited during the turn|137|ACP connection closed/);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Cancellation and process cleanup (no orphan processes)
  // --------------------------------------------------------------------------
  it.skipIf(process.platform === 'win32')(
    '6. Propagates cancellation and terminates the entire child process tree with zero orphan processes',
    async () => {
      const root = await createWorkspace();
      const pidFile = path.join(root, 'spawned.pids');
      let cancelled = false;

      const hangSpec = createDeterministicAcpSpec({
        scenario: 'hang-until-cancelled',
        mode: 'stdio',
        pidFile,
        ignoreCancelSignal: true, // Force process-tree kill on grace expiry
        cancelGraceMs: 250,
      });

      const verificationEngine = new VerificationEngine({ projectRoot: root });
      const runPromise = executeUnifiedHarnessRequest({
        request: makeBaseRequest(root, {
          isCancelled: () => cancelled,
        }),
        descriptor: acpDescriptor,
        adapter: new AcpAgentAdapter(hangSpec),
        runtime: {} as AgentRuntime,
        verificationEngine,
      });

      // Wait for stdio ACP agent and its child process to record their PIDs
      let pids: number[] = [];
      for (let i = 0; i < 80 && pids.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const raw = await fs.readFile(pidFile, 'utf8').catch(() => '');
        pids = raw
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
      }
      expect(pids.length).toBe(2);

      // Trigger controller cancellation
      cancelled = true;
      const result = await runPromise;

      assertUnifiedExecutionResultContract(result);
      expect(result.status).toBe('cancelled');
      expect(result.verified).toBe(false);
      expect(result.terminationReason).toBe('CANCELLED');
      expect(result.errorKind).toBe('cancelled');

      // Allow brief OS reap window and verify both parent and child PIDs are dead
      await new Promise((r) => setTimeout(r, 200));
      for (const pid of pids) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    },
    20_000,
  );

  // --------------------------------------------------------------------------
  // Scenario 7: Unauthorized filesystem modifications blocked by PolicyEngine
  // --------------------------------------------------------------------------
  it('7. Blocks unauthorized filesystem modifications (path traversal outside projectRoot, protected paths, and oracle weakening)', async () => {
    const root = await createWorkspace();
    const outsideFile = path.resolve(root, '..', `wazir-outside-${Date.now()}.txt`);
    const oracleTestRel = 'tests/oracle.test.ts';
    const oracleTestAbs = path.join(root, oracleTestRel);
    await fs.mkdir(path.dirname(oracleTestAbs), { recursive: true });
    const originalTestContent = `import { it, expect } from 'vitest';\nit('checks answer', () => { expect(42).toBe(42); });\n`;
    await fs.writeFile(oracleTestAbs, originalTestContent, 'utf8');

    const policyEngine = new PolicyEngine({ projectRoot: root });
    const verificationEngine = new VerificationEngine({
      projectRoot: root,
      protectedFiles: [oracleTestRel],
    });

    const { runtime, toolCallRecords } = createDeterministicNativeRuntime({
      projectRoot: root,
      policyEngine,
      verificationEngine,
      protectedPaths: [oracleTestRel],
      scriptedResponses: [
        { action: 'plan', content: 'Attempt unauthorized writes then write valid file' },
        // 1. Path traversal outside projectRoot
        {
          action: 'tool',
          tool: 'write',
          input: { path: '../outside-escape.txt', content: 'escaped' },
        },
        // 2. Protected git hook / package.json write without interactive approver
        {
          action: 'tool',
          tool: 'write',
          input: { path: '.git/hooks/pre-commit', content: '#!/bin/sh\nmalicious' },
        },
        // 3. Protected verification oracle file modification
        {
          action: 'tool',
          tool: 'write',
          input: { path: oracleTestRel, content: 'it.skip("checks answer", () => {});' },
        },
        // 4. Legitimate write inside workspace
        {
          action: 'tool',
          tool: 'write',
          input: { path: 'solution.ts', content: 'export const answer = 42;\n' },
        },
        { action: 'done', summary: 'Finished' },
      ],
    });

    const result = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root),
      descriptor: nativeDescriptor,
      adapter: new CodingAgent({ maxTurns: 10 }),
      runtime,
      verificationEngine,
      independentChecks: [
        { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'ok' },
        { oracle: 'TEST', command: 'npm test', exitCode: 0, output: 'ok' },
      ],
    });

    assertUnifiedExecutionResultContract(result);
    // Verify the 3 unauthorized writes were blocked
    const deniedCalls = toolCallRecords.filter((c) => !c.ok);
    expect(deniedCalls).toHaveLength(3);
    expect(deniedCalls[0].policyRule).toBe('filesystem-outside-deny');
    expect(deniedCalls[1].policyRule).toContain('filesystem-protected-ask');
    expect(deniedCalls[2].policyRule).toBe('protected-oracle-path-deny');

    // Verify physical files were untouched
    expect(existsSync(outsideFile)).toBe(false);
    expect(existsSync(path.resolve(root, '../outside-escape.txt'))).toBe(false);
    expect(await fs.readFile(oracleTestAbs, 'utf8')).toBe(originalTestContent);
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Incorrect verification claims by agent rejected
  // --------------------------------------------------------------------------
  it('8. Rejects false verification claims by the agent when physical verification checks fail (verified: false)', async () => {
    const root = await createWorkspace();

    // 8a. ACP agent claims "All tests passed! Verified 100%" while TEST oracle fails with exitCode 1
    const acpVerification = new VerificationEngine({ projectRoot: root });
    const falseClaimSpec = createDeterministicAcpSpec({
      scenario: 'false-verification-claim',
      mode: 'in-memory',
      targetFile: 'solution.ts',
      targetContent: 'export const answer = -1; // wrong\n',
    });

    const acpResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root),
      descriptor: acpDescriptor,
      adapter: new AcpAgentAdapter(falseClaimSpec),
      runtime: {} as AgentRuntime,
      verificationEngine: acpVerification,
      independentChecks: [
        { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'Build passed' },
        {
          oracle: 'TEST',
          command: 'npm test',
          exitCode: 1,
          output: 'AssertionError: expected -1 to equal 42',
        },
      ],
    });

    assertUnifiedExecutionResultContract(acpResult);
    expect(acpResult.output).toContain('All tests passed! Verified 100%');
    // Invariant 1: Apparent completion must have verified === false when physical TEST check fails
    expect(acpResult.status).toBe('completed');
    expect(acpResult.verified).toBe(false);
    expect(acpResult.failureClassification).toBe('UNVERIFIED_APPARENT_COMPLETION');
    expect(acpResult.errors?.some((e) => e.includes('TEST_FAILED'))).toBe(true);

    // 8b. Native CodingAgent claiming done when host-side VERIFY test fails
    const policyEngine = new PolicyEngine({ projectRoot: root });
    const nativeVerification = new VerificationEngine({ projectRoot: root });
    const { runtime } = createDeterministicNativeRuntime({
      projectRoot: root,
      policyEngine,
      verificationEngine: nativeVerification,
      checkOutcomes: {
        build: { ok: true, output: 'Build ok' },
        test: { ok: false, output: 'FAIL solution.test.ts: expected -1 to be 42' },
      },
      scriptedResponses: [
        { action: 'plan', content: 'Write file and claim done' },
        {
          action: 'tool',
          tool: 'write',
          input: { path: 'solution.ts', content: 'export const answer = -1;\n' },
        },
        { action: 'done', summary: 'All tests passed! 100% verified!' },
      ],
    });

    const nativeResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root),
      descriptor: nativeDescriptor,
      adapter: new CodingAgent({ maxTurns: 6 }),
      runtime,
      verificationEngine: nativeVerification,
      independentChecks: [
        { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'Build ok' },
        { oracle: 'TEST', command: 'npm test', exitCode: 1, output: 'FAIL solution.test.ts' },
      ],
    });

    assertUnifiedExecutionResultContract(nativeResult);
    expect(nativeResult.status).toBe('failed');
    expect(nativeResult.verified).toBe(false);
    expect(nativeResult.terminationReason).toBe('VERIFICATION_FAILED');
    expect(nativeResult.errorKind).toBe('verification');
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Missing or invalid (stale) verification evidence blocks verified completion
  // --------------------------------------------------------------------------
  it('9. Blocks verified completion when required verification evidence is missing or stale (from an older workspaceRevision)', async () => {
    const root = await createWorkspace();

    // 9a. Missing TEST evidence (only BUILD recorded)
    const missingEngine = new VerificationEngine({ projectRoot: root });
    const acpSpec1 = createDeterministicAcpSpec({
      scenario: 'normal-completion',
      mode: 'in-memory',
      targetFile: 'solution.ts',
    });

    const missingResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root),
      descriptor: acpDescriptor,
      adapter: new AcpAgentAdapter(acpSpec1),
      runtime: {} as AgentRuntime,
      verificationEngine: missingEngine,
      independentChecks: [
        { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'Build ok' },
        // TEST evidence omitted!
      ],
    });

    assertUnifiedExecutionResultContract(missingResult);
    expect(missingResult.status).toBe('completed');
    expect(missingResult.verified).toBe(false);
    expect(missingResult.errors?.some((e) => e.includes('NO_TEST_EVIDENCE'))).toBe(true);

    // 9b. Stale evidence recorded at revision 0 before file mutation advanced workspace to revision 1
    const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-conformance-stale-'));
    try {
      const staleEngine = new VerificationEngine({ projectRoot: staleRoot });
      const acpSpec2 = createDeterministicAcpSpec({
        scenario: 'normal-completion',
        mode: 'in-memory',
        targetFile: 'solution.ts',
      });

      const staleResult = await executeUnifiedHarnessRequest({
        request: makeBaseRequest(staleRoot),
        descriptor: acpDescriptor,
        adapter: new AcpAgentAdapter(acpSpec2),
        runtime: {} as AgentRuntime,
        verificationEngine: staleEngine,
        independentChecks: [
          {
            oracle: 'BUILD',
            command: 'npm run build',
            exitCode: 0,
            output: 'Build ok at rev 0',
            evidenceRevision: 0, // Stale! Current revision after mutation is 1
          },
          {
            oracle: 'TEST',
            command: 'npm test',
            exitCode: 0,
            output: 'Test ok at rev 0',
            evidenceRevision: 0, // Stale!
          },
        ],
      });

      assertUnifiedExecutionResultContract(staleResult);
      expect(staleResult.workspaceRevision).toBe('1');
      expect(staleResult.verified).toBe(false);
      expect(staleResult.errors?.some((e) => e.includes('BUILD_EVIDENCE_STALE'))).toBe(true);
      expect(staleResult.errors?.some((e) => e.includes('TEST_EVIDENCE_STALE'))).toBe(true);
    } finally {
      await fs.rm(staleRoot, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Unsupported capabilities rejected before execution
  // --------------------------------------------------------------------------
  it('10. Rejects unsupported capabilities both at pre-flight dispatch and during ACP protocol handshake', async () => {
    const root = await createWorkspace();
    const verificationEngine = new VerificationEngine({ projectRoot: root });
    const auditLog = createEmptyAcpAuditLog();

    // 10a. Pre-flight capability gate rejects request requiring 'checkpoint-resume' or 'mcp' on ACP harness
    const acpSpec = createDeterministicAcpSpec({
      scenario: 'normal-completion',
      mode: 'in-memory',
      auditLog,
    });
    const preflightResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root, {
        requiredCapabilities: ['coding', 'checkpoint-resume', 'mcp'],
      }),
      descriptor: acpDescriptor, // Only supports coding, streaming, cancellation, workspace-isolation
      adapter: new AcpAgentAdapter(acpSpec),
      runtime: {} as AgentRuntime,
      verificationEngine,
    });

    assertUnifiedExecutionResultContract(preflightResult);
    expect(preflightResult.status).toBe('failed');
    expect(preflightResult.verified).toBe(false);
    expect(preflightResult.terminationReason).toBe('POLICY_DENIED');
    expect(preflightResult.failureClassification).toBe('UNSUPPORTED_CAPABILITY');
    expect(preflightResult.errors?.[0]).toContain('checkpoint-resume');
    // Agent must not have been initialized or invoked
    expect(auditLog.initialized).toBe(false);

    // 10b. Handshake-level unsupported capability from ACP fixture
    const handshakeSpec = createDeterministicAcpSpec({
      scenario: 'unsupported-capability',
      mode: 'in-memory',
    });
    const handshakeResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root),
      descriptor: acpDescriptor,
      adapter: new AcpAgentAdapter(handshakeSpec),
      runtime: {} as AgentRuntime,
      verificationEngine,
    });

    assertUnifiedExecutionResultContract(handshakeResult);
    expect(handshakeResult.status).toBe('failed');
    expect(handshakeResult.verified).toBe(false);
    expect(handshakeResult.failureClassification).toBe('UNSUPPORTED_CAPABILITY');
    expect(handshakeResult.errors?.[0]).toContain('UNSUPPORTED_CAPABILITY');
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Runtime-unavailable fallback (when authorized) vs fail-closed
  // --------------------------------------------------------------------------
  it('11. Falls back to secondary harness when primary runtime is unavailable and allowFallback=true, and fails closed when allowFallback=false', async () => {
    const root = await createWorkspace();
    const policyEngine = new PolicyEngine({ projectRoot: root });

    // Primary native runtime is unavailable (throws ECONNREFUSED)
    const primaryVerification = new VerificationEngine({ projectRoot: root });
    const { runtime: unavailableRuntime } = createDeterministicNativeRuntime({
      projectRoot: root,
      policyEngine,
      verificationEngine: primaryVerification,
      scriptedResponses: [],
      unavailable: true,
    });

    // Secondary ACP harness is healthy
    const fallbackSpec = createDeterministicAcpSpec({
      scenario: 'normal-completion',
      mode: 'in-memory',
      targetFile: 'solution.ts',
    });

    // 11a. allowFallback: false -> Fail closed immediately
    const failClosedResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root, {
        constraints: { allowFallback: false, maxTurns: 5 },
      }),
      descriptor: nativeDescriptor,
      adapter: new CodingAgent({ maxTurns: 5 }),
      runtime: unavailableRuntime,
      fallback: {
        descriptor: acpDescriptor,
        adapter: new AcpAgentAdapter(fallbackSpec),
        runtime: {} as AgentRuntime,
      },
      verificationEngine: primaryVerification,
    });

    assertUnifiedExecutionResultContract(failClosedResult);
    expect(failClosedResult.status).toBe('failed');
    expect(failClosedResult.verified).toBe(false);
    expect(failClosedResult.harnessId).toBe('wazir-native');
    expect(failClosedResult.failureClassification).toBe('RUNTIME_UNAVAILABLE_FALLBACK_FORBIDDEN');
    expect(existsSync(path.join(root, 'solution.ts'))).toBe(false);

    // 11b. allowFallback: true -> Transparently falls back to ACP harness and succeeds with verification
    const fallbackVerification = new VerificationEngine({ projectRoot: root });
    const fallbackAllowedResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root, {
        constraints: { allowFallback: true, maxTurns: 5 },
      }),
      descriptor: nativeDescriptor,
      adapter: new CodingAgent({ maxTurns: 5 }),
      runtime: unavailableRuntime,
      fallback: {
        descriptor: acpDescriptor,
        adapter: new AcpAgentAdapter(fallbackSpec),
        runtime: {} as AgentRuntime,
      },
      verificationEngine: fallbackVerification,
      independentChecks: [
        { oracle: 'BUILD', command: 'npm run build', exitCode: 0, output: 'Build ok' },
        { oracle: 'TEST', command: 'npm test', exitCode: 0, output: 'Test ok' },
      ],
    });

    assertUnifiedExecutionResultContract(fallbackAllowedResult);
    expect(fallbackAllowedResult.status).toBe('completed');
    expect(fallbackAllowedResult.verified).toBe(true);
    expect(fallbackAllowedResult.harnessId).toBe('acp-codex');
    expect(fallbackAllowedResult.harnessKind).toBe('acp');
    expect(fallbackAllowedResult.filesChanged).toContain('solution.ts');
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Execution contract version mismatch rejected
  // --------------------------------------------------------------------------
  it('12. Rejects execution requests with an incompatible execution contract schemaVersion before invoking any harness', async () => {
    const root = await createWorkspace();
    const verificationEngine = new VerificationEngine({ projectRoot: root });
    const auditLog = createEmptyAcpAuditLog();

    const acpSpec = createDeterministicAcpSpec({
      scenario: 'normal-completion',
      mode: 'in-memory',
      auditLog,
    });

    const mismatchedResult = await executeUnifiedHarnessRequest({
      request: makeBaseRequest(root, {
        schemaVersion: 999, // Incompatible future schema version
      }),
      descriptor: acpDescriptor,
      adapter: new AcpAgentAdapter(acpSpec),
      runtime: {} as AgentRuntime,
      verificationEngine,
    });

    assertUnifiedExecutionResultContract(mismatchedResult);
    expect(mismatchedResult.schemaVersion).toBe(HARNESS_CONTRACT_SCHEMA_VERSION);
    expect(mismatchedResult.status).toBe('failed');
    expect(mismatchedResult.verified).toBe(false);
    expect(mismatchedResult.errorKind).toBe('protocol');
    expect(mismatchedResult.terminationReason).toBe('POLICY_DENIED');
    expect(mismatchedResult.failureClassification).toBe('CONTRACT_SCHEMA_VERSION_MISMATCH');
    expect(mismatchedResult.errors?.[0]).toContain('CONTRACT_VERSION_MISMATCH');
    expect(mismatchedResult.errors?.[0]).toContain('999');
    expect(auditLog.initialized).toBe(false);
  });
});
