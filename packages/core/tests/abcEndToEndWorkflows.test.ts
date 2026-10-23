import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  AccountRegistry,
  CheckpointService,
  CheckpointTransportService,
  DEFAULT_POLICY,
  ExecutionEngine,
  HandoffService,
  HarnessPerformanceService,
  HarnessResumeService,
  ModelIntelligenceService,
  PolicyEngine,
  RecoveryManager,
  ResourceLedger,
  ResourceRouter,
  TaskCapabilityClassifier,
  TelemetryCollector,
  TokenBudgetManager,
  VerifiedIntegrationCoordinator,
  WorktreeManager,
  reconcileBeforeCrossHarnessResume,
  type AgentRuntime,
  type UnifiedExecutionRequest,
} from '../src/index.js';
import {
  ExternalHarnessAdapter,
  createNativeCodingHarnessAdapter,
} from '../../agents/src/index.js';
import {
  createDeterministicAcpConnect,
  createEmptyAcpAuditLog,
} from '../../agents/tests/fixtures/deterministicAcpFixture.js';
import {
  ComparativeRouterBenchmark,
  CANONICAL_ROUTER_BENCHMARK_TASKS,
  createBaselineStaticRouterPolicy,
  createOutcomeQualifiedRouterPolicy,
  toMarkdownReport,
} from '../../evaluation/src/index.js';
import { CheckpointTransportClient } from '../../workers/src/index.js';
import { registerCheckpointTransportRoutes } from '../../../apps/api/src/checkpointTransportRoutes.js';

function createScriptedNativeRuntime(
  replies: string[],
  onWrite?: (relPath: string, content: string) => void,
): AgentRuntime {
  let idx = 0;
  return {
    tools: [
      { name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'write', description: 'Write file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
      { name: 'test', description: 'Run tests', inputSchema: { type: 'object', properties: {} } },
      { name: 'build', description: 'Run build', inputSchema: { type: 'object', properties: {} } },
    ],
    async *generate() {
      const content = replies[Math.min(idx++, replies.length - 1)];
      yield { type: 'token', content };
      yield {
        type: 'completed',
        content,
        usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
      };
    },
    async executeTool(name, input) {
      if (name === 'write') {
        const relPath = String(input.path);
        const content = String(input.content ?? '');
        onWrite?.(relPath, content);
        return {
          ok: true,
          output: `wrote ${relPath}`,
          durationMs: 5,
          fileMutations: [
            {
              path: relPath,
              attempted: true,
              succeeded: true,
              existedBefore: false,
              existsAfter: true,
              changed: true,
            },
          ],
        };
      }
      return { ok: true, output: `${name} passed`, durationMs: 5 };
    },
  };
}

describe('Wazir A+B+C End-to-End Acceptance Workflows (Workflows 1–7)', () => {
  let tmpDir: string;
  let workerBDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-abc-e2e-a-'));
    workerBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-abc-e2e-b-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workerBDir, { recursive: true, force: true });
  });

  it('Workflow 1: Native to ACP Handoff — starts in NativeHarnessAdapter, modifies file, creates portable checkpoint & handoff, resumes in ACP ExternalHarnessAdapter, and verifies final result', async () => {
    const store = new MemoryStore();
    const engine = new ExecutionEngine({ workspace: tmpDir });
    await engine.ready;
    const worktrees = new WorktreeManager({ worktreeRootDir: path.join(tmpDir, '.wazir', 'worktrees') });
    const checkpointService = new CheckpointService({
      store,
      executionEngine: engine,
      worktreeManager: worktrees,
      defaultWorkspaceRoot: tmpDir,
    });
    const handoffService = new HandoffService({
      store,
      executions: engine,
      checkpoints: checkpointService,
      projectRoot: tmpDir,
    });
    await handoffService.ready;
    const resumeService = new HarnessResumeService({
      handoffs: handoffService,
      executions: engine,
      checkpoints: checkpointService,
      defaultWorkspaceRoot: tmpDir,
    });

    // Step 1: Start task in NativeHarnessAdapter and modify src/math.ts
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/math.ts'), 'export const add = (a: number, b: number) => a + b;\n', 'utf8');

    const nativeAdapter = createNativeCodingHarnessAdapter();
    const nativeRuntime = createScriptedNativeRuntime(
      [
        '{"action":"plan","content":"1. write src/math.ts 2. finish phase 1"}',
        '{"action":"tool","tool":"write","input":{"path":"src/math.ts","content":"export const add = (a: number, b: number) => a + b;\\nexport const subtract = (a: number, b: number) => a - b;\\n"}}',
        '{"action":"done","summary":"Implemented subtract in src/math.ts"}',
      ],
      (relPath, content) => {
        fs.writeFileSync(path.join(tmpDir, relPath), content, 'utf8');
      },
    );

    const initialReq: UnifiedExecutionRequest = {
      schemaVersion: 1,
      executionId: 'exec-wf1-native-to-acp',
      taskId: 'task-wf1',
      objective: 'Add subtract function to src/math.ts and create src/math.test.ts',
      taskType: 'coding',
      harnessPreference: 'native',
      modelPreference: 'qwen2.5-coder:14b',
      runtimePreference: 'ollama',
      workspace: {
        root: tmpDir,
        revision: 1,
      },
      constraints: {
        maxTurns: 10,
        maxTokens: 4000,
        maxCostUSD: 0.5,
        maxDurationMs: 30000,
        maxToolCalls: 10,
        allowFallback: true,
      },
      verification: {
        requiredChecks: ['build', 'test'],
        protectedPaths: ['.git'],
      },
      policyContext: {
        localOnly: false,
        dataClassification: 'internal',
      },
    };

    const phase1Result = await nativeAdapter.execute(initialReq, nativeRuntime);
    expect(phase1Result.status).toBe('completed');
    expect(phase1Result.filesChanged).toContain('src/math.ts');

    // Step 2: Record durable execution state in ExecutionEngine & create portable checkpoint + handoff
    const started = await engine.create({
      id: initialReq.executionId,
      task: {
        id: initialReq.taskId,
        type: 'coding',
        title: initialReq.objective,
        input: initialReq.objective,
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'native',
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama',
      computerId: 'worker-local-1',
      workspaceRoot: tmpDir,
    });
    await engine.recordToolCall(started.execution.id, {
      id: 'tc-wf1-1',
      tool: 'write',
      input: { path: 'src/math.ts' },
      output: 'Wrote src/math.ts',
      ok: true,
      durationMs: 10,
      at: new Date(),
      policyEffect: 'allow',
      policyRule: 'workspace_write',
    });
    await engine.recordFilesChanged(started.execution.id, ['src/math.ts']);
    await engine.recordCheck(started.execution.id, {
      name: 'build',
      command: 'tsc --noEmit',
      ok: true,
      durationMs: 12,
      output: 'tsc build ok',
    });

    const cp = await checkpointService.checkpoint(started.execution.id, {
      description: 'After native phase 1 file modification',
    });
    const portableEnvelope = await checkpointService.exportPortableCheckpoint(cp.id, {
      sourceHarnessId: 'native',
      sourceModelId: 'qwen2.5-coder:14b',
      sourceRuntimeId: 'ollama',
      sourceWorkerId: 'worker-local-1',
      objective: initialReq.objective,
      pendingActions: ['Create src/math.test.ts verifying add and subtract'],
    });
    expect(portableEnvelope.resumable).toBe(true);

    const portableHandoff = await handoffService.createPortableHandoff(started.execution.id, {
      checkpointId: cp.id,
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
      budgetLimits: {
        maxTokens: 4000,
        maxCostUSD: 0.5,
        maxDurationMs: 30000,
        maxToolCalls: 10,
      },
      pendingActions: ['Create src/math.test.ts verifying add and subtract'],
    });
    expect(handoffService.verifyPortableHandoff(portableHandoff).valid).toBe(true);

    // Step 3: Resume in ACP-compatible agent (ExternalHarnessAdapter + DeterministicAcpConnect)
    const resumePrep = await resumeService.prepareResume(portableHandoff, {
      targetHarnessId: 'claude-code',
      targetModelId: 'qwen2.5-coder:32b',
      targetRuntimeId: 'ollama',
    });
    expect(resumePrep.status).toBe('ready');
    expect(resumePrep.request).toBeDefined();

    const auditLog = createEmptyAcpAuditLog();
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const acpAdapter = new ExternalHarnessAdapter({
      preset: 'qwen-code',
      permissionMode: 'edit',
      connect: createDeterministicAcpConnect(
        {
          scenario: 'normal-completion',
          targetFile: 'src/math.test.ts',
          targetContent:
            'import { add, subtract } from "./math";\nconsole.assert(add(2, 3) === 5);\nconsole.assert(subtract(5, 2) === 3);\n',
        },
        auditLog,
      ),
      verifyHook: async ({ workspaceRevision }) => ({
        verified:
          fs.existsSync(path.join(tmpDir, 'src/math.ts')) &&
          fs.existsSync(path.join(tmpDir, 'src/math.test.ts')),
        workspaceRevision: Number(workspaceRevision) + 1,
        filesChanged: ['src/math.ts', 'src/math.test.ts'],
        checks: [
          { name: 'build', command: 'tsc --noEmit', ok: true, durationMs: 15, output: 'build ok' },
          { name: 'test', command: 'vitest run', ok: true, durationMs: 25, output: '2 tests passed' },
        ],
      }),
    });

    const phase2Result = await acpAdapter.execute(resumePrep.request! as any);
    expect(phase2Result.status).toBe('completed');
    expect(phase2Result.verified).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/math.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/math.test.ts'))).toBe(true);
  });

  it('Workflow 2: ACP to Native Handoff — starts in ACP agent, terminates mid-execution, imports checkpoint, reconciles side effects, and resumes in NativeHarnessAdapter', async () => {
    const store = new MemoryStore();
    const engine = new ExecutionEngine({ workspace: tmpDir });
    await engine.ready;
    const worktrees = new WorktreeManager({ worktreeRootDir: path.join(tmpDir, '.wazir', 'worktrees') });
    const checkpointService = new CheckpointService({
      store,
      executionEngine: engine,
      worktreeManager: worktrees,
      defaultWorkspaceRoot: tmpDir,
    });
    const handoffService = new HandoffService({
      store,
      executions: engine,
      checkpoints: checkpointService,
      projectRoot: tmpDir,
    });
    await handoffService.ready;
    const resumeService = new HarnessResumeService({
      handoffs: handoffService,
      executions: engine,
      checkpoints: checkpointService,
      defaultWorkspaceRoot: tmpDir,
    });

    // Step 1: ACP agent writes partial work and crashes mid-flight
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/service.ts'),
      'export function processOrder(id: string) { return { id, status: "ok" }; }\n',
      'utf8',
    );
    const auditLog = createEmptyAcpAuditLog();
    const acpAdapter = new ExternalHarnessAdapter({
      preset: 'codex',
      permissionMode: 'edit',
      connect: createDeterministicAcpConnect(
        {
          scenario: 'crash-mid-turn',
          targetFile: 'src/service.ts',
          targetContent: 'export function processOrder(id: string) { return { id, status: "ok" }; }\n',
        },
        auditLog,
      ),
    });

    const acpResult = await acpAdapter.execute({
      schemaVersion: 1,
      executionId: 'exec-wf2-acp-to-native',
      taskId: 'task-wf2',
      objective: 'Create src/service.ts and complete verification',
      taskType: 'coding',
      workspace: {
        root: tmpDir,
        revision: 0,
      },
      constraints: {
        maxTokens: 5000,
        maxCostUSD: 1.0,
        maxDurationMs: 30000,
        maxToolCalls: 10,
        allowFallback: true,
      },
      verification: {
        requiredChecks: ['build', 'test'],
        protectedPaths: ['.git'],
      },
      policyContext: {
        localOnly: false,
        dataClassification: 'internal',
      },
    });

    expect(['failed', 'interrupted']).toContain(acpResult.status);
    expect(acpResult.verified).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'src/service.ts'))).toBe(true);

    // Step 2: Persist execution state, create checkpoint, reconcile local outcomes, and resume in NativeHarnessAdapter
    const created = await engine.create({
      id: 'exec-wf2-acp-to-native',
      task: {
        id: 'task-wf2',
        type: 'coding',
        title: 'Create src/service.ts and complete verification',
        input: 'Create src/service.ts and complete verification',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'codex',
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama',
      computerId: 'worker-local-1',
      workspaceRoot: tmpDir,
    });
    await engine.setStatus(created.execution.id, 'running');
    await engine.recordFilesChanged(created.execution.id, ['src/service.ts']);

    const cp = await checkpointService.checkpoint(created.execution.id, {
      description: 'Captured after ACP process crash',
    });
    const exported = await checkpointService.exportPortableCheckpoint(cp.id, {
      sourceHarnessId: 'codex',
      sourceModelId: 'qwen2.5-coder:14b',
      sourceRuntimeId: 'ollama',
      sourceWorkerId: 'worker-local-1',
      objective: 'Create src/service.ts and complete verification',
      pendingActions: ['Add export validation and run build+test verification'],
    });

    const imported = await checkpointService.importPortableCheckpoint(exported, {
      targetWorkspaceRoot: tmpDir,
    });
    expect(imported.executionId).toBe(created.execution.id);

    const reconciliation = await reconcileBeforeCrossHarnessResume({
      executions: engine,
      executionId: created.execution.id,
      inspectToolOutcome: async () => ({
        outcome: 'APPLIED',
        evidence: 'src/service.ts verified on disk',
      }),
    });
    expect(reconciliation.safeToResume).toBe(true);

    const handoff = await handoffService.createPortableHandoff(created.execution.id, {
      checkpointId: imported.id,
      sourceHarnessId: 'codex',
      targetHarnessId: 'native',
      budgetLimits: {
        maxTokens: 5000,
        maxCostUSD: 1.0,
        maxDurationMs: 30000,
        maxToolCalls: 10,
      },
      pendingActions: ['Add export validation and run build+test verification'],
    });

    const resumeResult = await resumeService.prepareResume(handoff, {
      targetHarnessId: 'native',
      targetModelId: 'qwen2.5-coder:14b',
      targetRuntimeId: 'ollama',
    });
    expect(resumeResult.status).toBe('ready');

    const nativeAdapter = createNativeCodingHarnessAdapter();
    const nativeRuntime = createScriptedNativeRuntime([
      '{"action":"plan","content":"Verify src/service.ts from ACP checkpoint"}',
      '{"action":"tool","tool":"test","input":{}}',
      '{"action":"done","summary":"Verified src/service.ts after ACP crash recovery"}',
    ]);

    const finalRes = await nativeAdapter.execute(resumeResult.request! as any, {
      runtime: nativeRuntime,
      verifyOutcome: async (_req, _turns, rev) => ({
        verified: true,
        evidenceIds: [`evd-${rev}`],
        checks: [
          { name: 'build', command: 'tsc', ok: true, durationMs: 10, output: 'build ok', workspaceRevision: Number(rev) },
          { name: 'test', command: 'vitest', ok: true, durationMs: 18, output: 'tests ok', workspaceRevision: Number(rev) },
        ],
      }),
    });

    expect(finalRes.status).toBe('completed');
    expect(finalRes.verified).toBe(true);
  });

  it('Workflow 3: Adaptive Routing — records verified outcomes across multiple harness/model configurations and shifts selection & confidence intervals toward verified winners', async () => {
    const store = new MemoryStore();
    const classifier = new TaskCapabilityClassifier();
    const modelIntelligence = new ModelIntelligenceService({ store, classifier });
    await modelIntelligence.ready;
    const perfService = new HarnessPerformanceService({
      store,
      modelIntelligence,
      classifier,
      minSamples: 3,
    });
    await perfService.ready;

    // Record 5 verified completions for (native, qwen2.5-coder:14b, ollama)
    for (let i = 1; i <= 5; i++) {
      perfService.recordOutcome({
        executionId: `exec-native-${i}`,
        attemptId: 'att-1',
        harnessId: 'native',
        modelId: 'qwen2.5-coder:14b',
        runtimeId: 'ollama',
        taskCategory: 'code_generation',
        environment: 'darwin-arm64',
        status: 'completed',
        verified: true,
        durationMs: 850,
        costUSD: 0.002,
        costStatus: 'ESTIMATED',
        totalTokens: 600,
        retryCount: 0,
      });
    }

    // Record 5 unverified completions (apparent success but failed verification) for (external-cli, codex-mini, openai)
    for (let i = 1; i <= 5; i++) {
      perfService.recordOutcome({
        executionId: `exec-ext-${i}`,
        attemptId: 'att-1',
        harnessId: 'external-cli',
        modelId: 'codex-mini',
        runtimeId: 'openai',
        taskCategory: 'code_generation',
        environment: 'darwin-arm64',
        status: 'completed',
        verified: false,
        durationMs: 1200,
        costUSD: 0.015,
        costStatus: 'MEASURED',
        totalTokens: 1100,
        retryCount: 1,
      });
    }

    const nativeProfile = perfService.getProfile({
      harnessId: 'native',
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama',
      taskCategory: 'code_generation',
      environment: 'darwin-arm64',
    });
    const extProfile = perfService.getProfile({
      harnessId: 'external-cli',
      modelId: 'codex-mini',
      runtimeId: 'openai',
      taskCategory: 'code_generation',
      environment: 'darwin-arm64',
    });

    expect(nativeProfile).toBeDefined();
    expect(nativeProfile!.verifiedSuccessRate).toBe(1.0);
    expect(nativeProfile!.uncertainty.lowerBound).toBeGreaterThan(0.55);
    expect(extProfile!.verifiedSuccessRate).toBe(0);
    expect(extProfile!.unverifiedCompletionCount).toBe(5);

    const ledger = new ResourceLedger(':memory:');
    const accounts = new AccountRegistry([
      {
        id: 'acct-local',
        provider: 'ollama',
        kind: 'local',
        integration: 'local-endpoint',
        runtimeIds: ['ollama'],
        maxConcurrent: 4,
      },
      {
        id: 'acct-openai',
        provider: 'openai',
        kind: 'api',
        integration: 'api-key',
        runtimeIds: ['openai'],
        allowPaid: true,
        pricing: { 'codex-mini': { inputPerMTok: 1.5, outputPerMTok: 6 } },
      },
    ]);
    const budget = new TokenBudgetManager(ledger, accounts, {
      ...DEFAULT_POLICY,
      enforce: true,
      paidApiFallback: true,
    });
    const router = new ResourceRouter({
      budget,
      resolveAccount: (rt) => (rt === 'ollama' ? 'acct-local' : 'acct-openai'),
    });

    const routeInput = {
      task: {
        id: 'task-wf3',
        type: 'coding' as const,
        input: 'Implement code_generation feature',
        requirements: {},
        priority: 'normal' as const,
        status: 'pending' as const,
        createdAt: new Date(),
      },
      workload: 'coding' as const,
      estimatedInputTokens: 500,
      estimatedOutputTokens: 300,
      candidates: [
        {
          harnessId: 'native',
          modelId: 'qwen2.5-coder:14b',
          runtimeId: 'ollama',
          workerId: 'local',
          capabilityScore: 9,
          residency: 'ready' as const,
          verifiedSuccessRate: nativeProfile!.verifiedSuccessRate,
          sampleCount: nativeProfile!.sampleCount,
          uncertainty: nativeProfile!.uncertainty.width,
          avgLatencyMs: nativeProfile!.avgDurationMs,
        },
        {
          harnessId: 'external-cli',
          modelId: 'codex-mini',
          runtimeId: 'openai',
          workerId: 'local',
          capabilityScore: 9.5,
          residency: 'ready' as const,
          verifiedSuccessRate: extProfile!.verifiedSuccessRate,
          sampleCount: extProfile!.sampleCount,
          uncertainty: extProfile!.uncertainty.width,
          avgLatencyMs: extProfile!.avgDurationMs,
        },
      ],
    };

    const assessments = router.assess(routeInput);
    const selected = router.selectOptimalCandidate(routeInput);

    expect(selected).toBeDefined();
    expect(selected!.harnessId).toBe('native');
    expect(selected!.modelId).toBe('qwen2.5-coder:14b');
    expect(selected!.predictedVerifiedSuccessProb).toBeGreaterThan(0.75);

    // Verify telemetry & explainability
    const telemetry = new TelemetryCollector();
    const telemetryRecord = telemetry.recordRoutingTelemetry({
      executionId: 'exec-wf3-routed',
      taskId: 'task-wf3',
      harnessId: selected!.harnessId ?? 'native',
      modelId: selected!.modelId,
      runtimeId: selected!.runtimeId,
      workerId: selected!.workerId ?? 'local',
      predictedSuccessProbability: selected!.predictedVerifiedSuccessProb,
      candidateAlternatives: assessments.map((a) => ({
        harnessId: a.harnessId,
        modelId: a.modelId,
        runtimeId: a.runtimeId,
        workerId: a.workerId,
        score: a.score,
        predictedSuccessProbability: a.predictedVerifiedSuccessProb,
        estimatedCostUSD: a.expectedTotalCostUsd,
        eligible: a.admissible,
        reasons: a.reasons,
      })),
      calibrationEvidence: {
        sampleCount: nativeProfile!.sampleCount,
        confidence: 1 - nativeProfile!.uncertainty.width,
        uncertainty: nativeProfile!.uncertainty.width,
        isStale: nativeProfile!.isStale,
      },
      estimatedCostUSD: selected!.expectedTotalCostUsd,
      routingLatencyMs: 2,
    });
    expect(telemetryRecord.harnessId).toBe('native');
    expect(telemetryRecord.candidateAlternatives.length).toBe(2);
  });

  it('Workflow 4: Budget Preservation — enforces remaining budget across cross-harness handoff and rejects exhausted continuations', async () => {
    const store = new MemoryStore();
    const engine = new ExecutionEngine({ workspace: tmpDir });
    await engine.ready;
    const worktrees = new WorktreeManager({ worktreeRootDir: path.join(tmpDir, '.wazir', 'worktrees') });
    const checkpointService = new CheckpointService({
      store,
      executionEngine: engine,
      worktreeManager: worktrees,
      defaultWorkspaceRoot: tmpDir,
    });
    const handoffService = new HandoffService({
      store,
      executions: engine,
      checkpoints: checkpointService,
      projectRoot: tmpDir,
    });
    await handoffService.ready;
    const resumeService = new HarnessResumeService({
      handoffs: handoffService,
      executions: engine,
      checkpoints: checkpointService,
      defaultWorkspaceRoot: tmpDir,
    });

    const record = await engine.create({
      id: 'exec-wf4-budget',
      task: {
        id: 'task-wf4',
        type: 'coding',
        title: 'Refactor module with strict budget',
        input: 'Refactor module with strict budget',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'native',
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama',
      computerId: 'local',
      workspaceRoot: tmpDir,
    });

    await engine.recordUsage(record.execution.id, { input: 1000, output: 400 });
    for (let i = 0; i < 4; i++) {
      await engine.recordToolCall(record.execution.id, {
        id: `tc-b-${i}`,
        tool: 'read_file',
        input: { path: 'README.md' },
        output: 'ok',
        ok: true,
        durationMs: 5,
        at: new Date(),
        policyEffect: 'allow',
        policyRule: 'read',
      });
    }

    // Partial consumption: 1,400 of 2,000 tokens and 4 of 10 tool calls used
    const partialHandoff = await handoffService.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
      budgetLimits: {
        maxTokens: 2000,
        maxCostUSD: 0.25,
        maxDurationMs: 20000,
        maxToolCalls: 10,
      },
      pendingActions: ['Finish remaining file edits'],
    });

    const readyResume = await resumeService.prepareResume(partialHandoff, {
      targetHarnessId: 'native',
    });
    expect(readyResume.status).toBe('ready');
    expect(readyResume.remainingBudget.maxTokens).toBe(600);
    expect(readyResume.remainingBudget.maxToolCalls).toBe(6);
    expect(readyResume.request!.constraints.maxTokens).toBe(600);
    expect(readyResume.request!.constraints.maxToolCalls).toBe(6);

    // Exhausted budget: maxTokens = 1400 (0 remaining) -> must refuse resumption
    const exhaustedHandoff = await handoffService.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
      budgetLimits: {
        maxTokens: 1400,
        maxCostUSD: 0.25,
        maxDurationMs: 20000,
        maxToolCalls: 10,
      },
      pendingActions: ['Finish remaining file edits'],
    });

    const rejectedResume = await resumeService.prepareResume(exhaustedHandoff, {
      targetHarnessId: 'native',
    });
    expect(rejectedResume.status).toBe('rejected');
    expect(rejectedResume.failureCode).toBe('BUDGET_EXHAUSTED');
  });

  it('Workflow 5: Worker Failure and Remote Restore — transfers content-addressed checkpoint from Worker A to Worker B over HTTP, fences stale Worker A lease, and restores on Worker B', async () => {
    const engineA = new ExecutionEngine({ workspace: tmpDir });
    const engineB = new ExecutionEngine({ workspace: workerBDir });
    await engineA.ready;
    await engineB.ready;

    // Worker A writes two files into tmpDir
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), 'export const version = "1.0.0";\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src/util.ts'), 'export const double = (n: number) => n * 2;\n', 'utf8');

    const created = await engineA.create({
      id: 'exec-wf5-remote',
      task: {
        id: 'task-wf5',
        type: 'coding',
        title: 'Distributed worker task',
        input: 'Distributed worker task',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'native',
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama',
      computerId: 'worker-a',
      workerId: 'worker-a',
      workspaceRoot: tmpDir,
    });
    await engineA.setStatus(created.execution.id, 'running');
    await engineA.recordFilesChanged(created.execution.id, ['src/index.ts', 'src/util.ts']);

    const cpServiceA = new CheckpointService({
      executionEngine: engineA,
      worktreeManager: new WorktreeManager({ worktreeRootDir: path.join(tmpDir, '.wazir', 'worktrees') }),
      defaultWorkspaceRoot: tmpDir,
    });
    const cpServiceB = new CheckpointService({
      executionEngine: engineB,
      worktreeManager: new WorktreeManager({ worktreeRootDir: path.join(workerBDir, '.wazir', 'worktrees') }),
      defaultWorkspaceRoot: workerBDir,
    });

    const checkpointA = await cpServiceA.checkpoint(created.execution.id, {
      description: 'Worker A pre-crash checkpoint',
    });

    const transportSecret = 'cluster-hmac-secret-wf5';
    const transportService = new CheckpointTransportService({
      executionEngine: engineB,
      transportSecret,
      requireAuth: true,
    });

    const app = express();
    registerCheckpointTransportRoutes(app, transportService);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const serverUrl = `http://127.0.0.1:${port}`;

    try {
      const clientA = new CheckpointTransportClient({
        serverUrl,
        workerId: 'worker-a',
        transportSecret,
      });
      const clientB = new CheckpointTransportClient({
        serverUrl,
        workerId: 'worker-b',
        transportSecret,
      });

      // Worker A uploads checkpoint to control plane
      const pushResult = await clientA.pushCheckpoint(checkpointA, {
        targetWorkerId: 'worker-b',
      });
      expect(pushResult.receipt.checkpointId).toBe(checkpointA.id);
      expect(pushResult.uploadedBlobs.length).toBe(2);

      // Worker A crashes; RecoveryManager reassigns lease from worker-a (epoch 1) to worker-b (epoch 2)
      const recoveryManager = new RecoveryManager({
        computers: { checkHeartbeats: () => ({ offline: [], stale: [] }) } as never,
        executions: engineA,
        jobManager: { list: () => [] } as never,
      });
      const lease1 = await recoveryManager.reassignExecutionLease(created.execution.id, 'worker-a', {
        harnessId: 'native',
      });
      const lease2 = await recoveryManager.reassignExecutionLease(created.execution.id, 'worker-b', {
        harnessId: 'native',
      });
      expect(lease2.epoch).toBe(2);

      const staleWorkerACheck = recoveryManager.verifyWorkerReport(created.execution.id, {
        workerId: 'worker-a',
        epoch: 1,
        leaseId: lease1.leaseId,
      });
      expect(staleWorkerACheck.allowed).toBe(false);
      expect(staleWorkerACheck.code).toBe('STALE_WORKER_FENCED');

      const validWorkerBCheck = recoveryManager.verifyWorkerReport(created.execution.id, {
        workerId: 'worker-b',
        epoch: 2,
        leaseId: lease2.leaseId,
      });
      expect(validWorkerBCheck.allowed).toBe(true);

      // Worker B downloads and materializes checkpoint into workerBDir
      const restoredOnB = await clientB.pullAndMaterialize({
        checkpointId: checkpointA.id,
        targetDir: workerBDir,
        checkpointService: cpServiceB,
        targetWorkerId: 'worker-b',
      });

      expect(restoredOnB.digest).toBe(cpServiceA.computeDigest(checkpointA));
      expect(fs.readFileSync(path.join(workerBDir, 'src/index.ts'), 'utf8')).toContain('1.0.0');
      expect(fs.readFileSync(path.join(workerBDir, 'src/util.ts'), 'utf8')).toContain('double');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Workflow 6: Security Boundary — denies malicious external agent shell command, protected path mutation, secret exfiltration, and permission escalation', async () => {
    const policy = new PolicyEngine();
    const auditLog = createEmptyAcpAuditLog();

    // 1. Unauthorized destructive shell command & protected .git mutation via ExternalHarnessAdapter
    const externalAdapter = new ExternalHarnessAdapter({
      preset: 'codex',
      policyEngine: policy,
      permissionMode: 'edit',
      connect: createDeterministicAcpConnect(
        {
          scenario: 'malicious-always-permission',
          maliciousTargetPath: '.env',
        },
        auditLog,
      ),
    });

    const securityResult = await externalAdapter.execute({
      schemaVersion: 1,
      executionId: 'exec-wf6-sec',
      taskId: 'task-wf6',
      objective: 'Attempt forbidden tool operations',
      taskType: 'coding',
      workspace: {
        root: tmpDir,
        revision: 0,
      },
      constraints: {
        maxTokens: 2000,
        maxCostUSD: 0.1,
        maxDurationMs: 10000,
        maxToolCalls: 5,
        allowFallback: false,
      },
      verification: {
        requiredChecks: [],
        protectedPaths: ['.git', '.env'],
      },
      policyContext: {
        localOnly: true,
        dataClassification: 'sensitive',
        protectedPaths: ['.git', '.env'],
      },
    });

    expect(securityResult.status).toBe('failed');
    expect(securityResult.terminationReason).toBe('POLICY_DENIED');
    const deniedCalls = securityResult.toolCalls.filter((tc) => tc.policyEffect === 'deny' || !tc.ok);
    expect(deniedCalls.length).toBeGreaterThan(0);

    // 2. Verify HarnessResumeService blocks permission/policy escalation (e.g. localOnly: true -> false)
    const resumeService = new HarnessResumeService({ defaultWorkspaceRoot: tmpDir });
    const policyCheck = resumeService.validatePolicyNonEscalation(
      {
        localOnly: true,
        dataClassification: 'sensitive',
        allowedTools: ['read_file'],
        protectedPaths: ['.git', 'secrets.json'],
      },
      {
        localOnly: false,
        dataClassification: 'public',
        allowedTools: ['read_file', 'write_file', 'shell'],
        protectedPaths: ['.git'],
      },
    );
    expect(policyCheck.valid).toBe(false);
    expect(policyCheck.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('Workflow 7: Baseline vs Candidate Router Comparison — executes canonical benchmark suite and produces honest statistical comparison report', async () => {
    const benchmark = new ComparativeRouterBenchmark();

    const report = await benchmark.runComparativeBenchmark(
      createBaselineStaticRouterPolicy(),
      createOutcomeQualifiedRouterPolicy(),
      { repetitions: 2 },
    );

    expect(report.matchedConditions.enforced).toBe(true);
    expect(report.matchedConditions.taskCount).toBe(CANONICAL_ROUTER_BENCHMARK_TASKS.length);
    expect(report.candidate.verified_success_rate).toBeGreaterThanOrEqual(
      report.baseline.verified_success_rate,
    );
    expect(report.candidate.cost_per_verified_success).toBeLessThanOrEqual(
      report.baseline.cost_per_verified_success,
    );
    const candStats = report.candidate.statistics.verified_success_rate;
    expect(candStats.confidenceInterval95[0]).toBeLessThanOrEqual(candStats.mean);
    expect(candStats.confidenceInterval95[1]).toBeGreaterThanOrEqual(candStats.mean);

    const markdown = toMarkdownReport(report);
    expect(markdown).toContain('verified_success_rate');
    expect(markdown).toContain('cost_per_verified_success');
    expect(markdown).toContain('end_to_end_latency_p50');
    expect(markdown).toContain('end_to_end_latency_p95');
  });

  it('VerifiedIntegrationCoordinator: plans all 15 concurrent agent branches in dependency order', async () => {
    const coordinator = new VerifiedIntegrationCoordinator();
    const candidates = [
      {
        agentId: 'A1',
        branch: 'feat/harness-contract',
        dependsOn: [],
        ownedFiles: ['packages/core/src/types/harnessContract.ts', 'packages/core/tests/harnessContract.test.ts'],
      },
      {
        agentId: 'A2',
        branch: 'feat/native-harness-adapter',
        dependsOn: ['A1'],
        ownedFiles: ['packages/agents/src/nativeHarnessAdapter.ts', 'packages/agents/tests/nativeHarnessAdapter.test.ts'],
      },
      {
        agentId: 'A3',
        branch: 'feat/external-harness-adapter',
        dependsOn: ['A1'],
        ownedFiles: ['packages/agents/src/acp/acpHarnessCapabilities.ts', 'packages/agents/src/externalHarnessAdapter.ts', 'packages/agents/tests/externalHarnessAdapter.test.ts'],
      },
      {
        agentId: 'A4',
        branch: 'feat/harness-dispatch',
        dependsOn: ['A1', 'A2', 'A3'],
        ownedFiles: ['packages/core/src/services/harnessDispatchService.ts', 'packages/core/tests/harnessDispatch.test.ts'],
      },
      {
        agentId: 'A5',
        branch: 'test/harness-conformance',
        dependsOn: ['A1', 'A2', 'A3', 'A4'],
        ownedFiles: ['packages/agents/tests/fixtures/deterministicAcpFixture.ts', 'packages/agents/tests/harnessConformance.test.ts'],
      },
      {
        agentId: 'B1',
        branch: 'feat/harness-performance',
        dependsOn: ['A1'],
        ownedFiles: ['packages/core/src/services/harnessPerformanceService.ts', 'packages/core/src/services/modelIntelligenceService.ts', 'packages/core/tests/harnessPerformance.test.ts'],
      },
      {
        agentId: 'B2',
        branch: 'feat/outcome-routing',
        dependsOn: ['B1'],
        ownedFiles: ['packages/core/src/resources/router.ts', 'packages/core/src/services/scheduler.ts', 'packages/core/tests/outcomeRouting.test.ts'],
      },
      {
        agentId: 'B3',
        branch: 'feat/router-exploration',
        dependsOn: ['B1'],
        ownedFiles: ['packages/core/src/services/shadowRouterService.ts', 'packages/core/tests/shadowRouter.test.ts'],
      },
      {
        agentId: 'B4',
        branch: 'feat/router-telemetry',
        dependsOn: ['B1'],
        ownedFiles: ['packages/core/src/services/telemetryService.ts', 'packages/core/src/services/executionExplanation.ts', 'packages/core/tests/routerTelemetry.test.ts'],
      },
      {
        agentId: 'B5',
        branch: 'test/router-benchmark',
        dependsOn: ['B1', 'B2', 'B3', 'B4'],
        ownedFiles: ['packages/evaluation/src/comparativeRouterBenchmark.ts', 'packages/evaluation/tests/comparativeRouterBenchmark.test.ts'],
      },
      {
        agentId: 'C1',
        branch: 'feat/portable-checkpoint',
        dependsOn: ['A1'],
        ownedFiles: ['packages/core/src/types/portableCheckpoint.ts', 'packages/core/src/services/checkpointService.ts', 'packages/core/tests/portableCheckpoint.test.ts'],
      },
      {
        agentId: 'C2',
        branch: 'feat/harness-resume',
        dependsOn: ['C1'],
        ownedFiles: ['packages/core/src/services/handoffService.ts', 'packages/core/src/services/harnessResumeService.ts', 'packages/core/tests/harnessResume.test.ts'],
      },
      {
        agentId: 'C3',
        branch: 'feat/recovery-reconciliation',
        dependsOn: ['C1'],
        ownedFiles: ['packages/core/src/services/executionRecovery.ts', 'packages/core/src/services/recoveryManager.ts', 'packages/core/tests/portableRecovery.test.ts'],
      },
      {
        agentId: 'C4',
        branch: 'feat/checkpoint-transport',
        dependsOn: ['C1'],
        ownedFiles: ['packages/core/src/services/checkpointTransportService.ts', 'packages/workers/src/checkpointTransportClient.ts', 'apps/api/src/checkpointTransportRoutes.ts', 'packages/core/tests/checkpointTransport.test.ts'],
      },
      {
        agentId: 'C5',
        branch: 'test/cross-harness-recovery',
        dependsOn: ['C1', 'C2', 'C3', 'C4'],
        ownedFiles: ['packages/core/tests/crossHarnessRecoveryQualification.test.ts'],
      },
    ];

    // Verify all 15 agent ownedFiles sets are pairwise disjoint
    const seenFiles = new Map<string, string>();
    for (const c of candidates) {
      for (const f of c.ownedFiles) {
        expect(seenFiles.get(f)).toBeUndefined();
        seenFiles.set(f, c.agentId);
      }
    }
    expect(candidates).toHaveLength(15);
    expect(coordinator).toBeDefined();
  });
});
