import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '@wazir/shared';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { WorktreeManager } from '../src/services/worktreeManager.js';
import { CheckpointService } from '../src/services/checkpointService.js';
import {
  HandoffService,
  PORTABLE_HANDOFF_SCHEMA_VERSION,
} from '../src/services/handoffService.js';
import {
  HarnessResumeService,
  HARNESS_CONTRACT_SCHEMA_VERSION,
} from '../src/services/harnessResumeService.js';

describe('Cross-Harness Handoff and Resume (Group C2)', () => {
  let tempDir: string;
  let store: MemoryStore;
  let executions: ExecutionEngine;
  let worktrees: WorktreeManager;
  let checkpoints: CheckpointService;
  let handoffs: HandoffService;
  let resumeService: HarnessResumeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-c2-resume-'));
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'src', 'auth.ts'),
      'export function verifyToken(t: string) { return t.length > 0; }\n',
      'utf8',
    );

    store = new MemoryStore();
    executions = new ExecutionEngine({ workspace: tempDir });
    worktrees = new WorktreeManager({ worktreeRootDir: path.join(tempDir, '.wazir', 'worktrees') });
    checkpoints = new CheckpointService({
      store,
      executionEngine: executions,
      worktreeManager: worktrees,
      defaultWorkspaceRoot: tempDir,
    });
    handoffs = new HandoffService({
      store,
      executions,
      checkpoints,
      projectRoot: tempDir,
    });
    await handoffs.ready;
    resumeService = new HarnessResumeService({
      handoffs,
      executions,
      checkpoints,
      defaultWorkspaceRoot: tempDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('1. creates a PortableHandoff with schemaVersion 1, SHA-256 integrityDigest, and secret redaction', async () => {
    const record = await executions.create({
      task: {
        id: 'task-sec-1',
        type: 'coding',
        input: 'Fix OAuth client with api_key=sk-live-999888777 and password=topsecretvalue',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'qwen-coder',
      workspaceRoot: tempDir,
    });

    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    await executions.recordToolCall(record.execution.id, {
      id: 'tc-1',
      callId: 'tc-1',
      tool: 'read',
      input: { path: 'src/auth.ts', token: 'ghp_secretToken123' },
      output: 'Loaded file with authorization=BearerSecretXYZ',
      ok: true,
      policyEffect: 'allow',
      policyRule: 'read-workspace',
      durationMs: 12,
      at: new Date(),
    });

    const portable = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
      pendingActions: ['Rotate secret=my-raw-secret and run unit tests'],
    });

    expect(portable.schemaVersion).toBe(PORTABLE_HANDOFF_SCHEMA_VERSION);
    expect(portable.executionId).toBe(record.execution.id);
    expect(portable.taskId).toBe('task-sec-1');
    expect(portable.objective).not.toContain('sk-live-999888777');
    expect(portable.objective).not.toContain('topsecretvalue');
    expect(portable.objective).toContain('[REDACTED]');
    expect(portable.completedActions.map((a) => a.summary).join(' ')).not.toContain('BearerSecretXYZ');
    expect(portable.pendingActions[0]).not.toContain('my-raw-secret');

    const verification = handoffs.verifyPortableHandoff(portable);
    expect(verification.valid).toBe(true);
    expect(verification.errors).toEqual([]);

    // Tampering with any field invalidates the SHA-256 integrityDigest
    const tampered = { ...portable, workspaceRevision: '999' };
    const tamperedResult = handoffs.verifyPortableHandoff(tampered);
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.errors.some((e) => e.includes('INTEGRITY_DIGEST_MISMATCH'))).toBe(true);

    // Unsupported schemaVersion is rejected
    const badSchema = { ...portable, schemaVersion: 2 };
    const badSchemaResult = handoffs.verifyPortableHandoff(badSchema);
    expect(badSchemaResult.valid).toBe(false);
    expect(badSchemaResult.errors.some((e) => e.includes('UNSUPPORTED_SCHEMA_VERSION'))).toBe(true);
  });

  it('2. executes Native -> ACP handoff and continuation bound to the same executionId and taskId', async () => {
    const record = await executions.create({
      task: {
        id: 'task-native-to-acp',
        type: 'coding',
        input: 'Implement JWT expiration check in src/auth.ts',
        requirements: {},
        policy: {
          localOnly: false,
          dataClassification: 'internal',
          allowHostedProviders: true,
        },
        priority: 'high',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'native',
      runtimeId: 'local',
      modelId: 'llama-3.3-70b',
      workspaceRoot: tempDir,
    });

    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    await executions.recordCheck(record.execution.id, {
      name: 'build',
      command: 'npm run build',
      ok: true,
      output: 'Build succeeded',
      durationMs: 120,
      workspaceRevision: executions.getWorkspaceRevision(record.execution.id),
    });

    const chk = await checkpoints.checkpoint(record.execution.id, {
      description: 'after-initial-edit',
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
      checkpointId: chk.id,
      budgetLimits: {
        maxTokens: 20000,
        maxToolCalls: 25,
        maxModelCalls: 15,
        maxCostUSD: 2.5,
        maxDurationMs: 120000,
      },
      pendingActions: ['Add unit test for expired JWT token', 'Run test suite'],
    });

    const resumed = await resumeService.prepareResume(handoff, {
      targetHarnessId: 'claude-code',
      targetModelId: 'claude-3-7-sonnet',
      targetRuntimeId: 'anthropic',
    });

    expect(resumed.status).toBe('ready');
    expect(resumed.resumable).toBe(true);
    expect(resumed.sourceHarnessId).toBe('native');
    expect(resumed.targetHarnessId).toBe('claude-code');
    expect(resumed.targetHarness?.kind).toBe('acp');
    expect(resumed.request).toBeDefined();
    expect(resumed.request?.schemaVersion).toBe(HARNESS_CONTRACT_SCHEMA_VERSION);
    expect(resumed.request?.executionId).toBe(record.execution.id);
    expect(resumed.request?.taskId).toBe('task-native-to-acp');
    expect(resumed.request?.harnessPreference).toBe('claude-code');
    expect(resumed.request?.checkpointId).toBe(chk.id);
    expect(resumed.resumeContext?.executionId).toBe(record.execution.id);
    expect(resumed.resumeContext?.filesChanged).toEqual(['src/auth.ts']);
    expect(resumed.resumeContext?.verification.passing).toContain('check:build@r1');
  });

  it('3. executes ACP -> Native handoff and continuation preserving durable facts', async () => {
    const record = await executions.create({
      task: {
        id: 'task-acp-to-native',
        type: 'debugging',
        input: 'Diagnose race condition in token refresh',
        requirements: {},
        policy: {
          localOnly: true,
          dataClassification: 'sensitive',
          protectedPaths: ['.env', 'config/keys.json'],
        },
        priority: 'high',
        status: 'running',
        createdAt: new Date(),
      },
      agentId: 'codex',
      runtimeId: 'local',
      modelId: 'local-deepseek-r1',
      workspaceRoot: tempDir,
    });

    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'codex',
      targetHarnessId: 'native',
      budgetLimits: { maxTokens: 15000, maxToolCalls: 20 },
      pendingActions: ['Verify race condition fix under concurrent calls'],
    });

    const resumed = await resumeService.prepareResume(handoff, {
      targetHarnessId: 'native',
      targetRuntimeId: 'ollama',
    });

    expect(resumed.status).toBe('ready');
    expect(resumed.sourceHarnessId).toBe('codex');
    expect(resumed.targetHarnessId).toBe('native');
    expect(resumed.targetHarness?.kind).toBe('native');
    expect(resumed.request?.executionId).toBe(record.execution.id);
    expect(resumed.request?.taskId).toBe('task-acp-to-native');
    expect(resumed.request?.verification.protectedPaths).toEqual(['.env', 'config/keys.json']);
    expect(resumed.effectivePolicy.localOnly).toBe(true);
    expect(resumed.effectivePolicy.dataClassification).toBe('sensitive');
  });

  it('4. supports Worker A -> Worker B portable handoff persistence and restoration', async () => {
    const record = await executions.create({
      task: {
        id: 'task-worker-migration',
        type: 'coding',
        input: 'Migrate worker checkpoint state cleanly',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'worker-a',
      workerId: 'worker-a',
      runtimeId: 'local',
      modelId: 'qwen-2.5-coder',
      workspaceRoot: tempDir,
    });

    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    const createdOnWorkerA = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'acp',
    });
    expect(createdOnWorkerA.sourceWorkerId).toBe('worker-a');

    // Simulate Worker B loading from shared store
    const workerBHandoffs = new HandoffService({
      store,
      executions,
      checkpoints,
      projectRoot: tempDir,
    });
    await workerBHandoffs.ready;

    const workerBResume = new HarnessResumeService({
      handoffs: workerBHandoffs,
      executions,
      checkpoints,
      defaultWorkspaceRoot: tempDir,
    });

    const result = await workerBResume.resume(record.execution.id, {
      targetHarnessId: 'acp',
      targetWorkerId: 'worker-b',
    });

    expect(result.status).toBe('ready');
    expect(result.executionId).toBe(record.execution.id);
    expect(result.request?.executionId).toBe(record.execution.id);
  });

  it('5. builds semantic continuation prompt from durable facts WITHOUT replaying raw model transcript or KV cache', async () => {
    const record = await executions.create({
      task: {
        id: 'task-semantic-prompt',
        type: 'coding',
        input: 'Add rate limiting middleware to src/auth.ts',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'model-x',
      workspaceRoot: tempDir,
    });

    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    await executions.recordCheck(record.execution.id, {
      name: 'typecheck',
      command: 'tsc --noEmit',
      ok: true,
      output: '0 errors',
      durationMs: 85,
      workspaceRevision: executions.getWorkspaceRevision(record.execution.id),
    });

    // Inject verbose raw model transcript / reasoning / token events that must NOT be replayed
    const liveRecord = (await executions.get(record.execution.id))!;
    liveRecord.events.push({
      id: 'ev-raw-1',
      executionId: record.execution.id,
      type: 'generation.token',
      timestamp: new Date(),
      data: { content: 'RAW_TRANSCRIPT_INTERNAL_MONOLOGUE_DO_NOT_REPLAY_987654321' },
    });
    liveRecord.events.push({
      id: 'ev-raw-2',
      executionId: record.execution.id,
      type: 'agent.turn',
      timestamp: new Date(),
      data: { raw: 'UNPARSED_MODEL_CHATTER_KV_CACHE_SPECIFIC_112233' },
    });
    liveRecord.events.push({
      id: 'ev-step-1',
      executionId: record.execution.id,
      type: 'step.completed',
      stepId: 'step-inspect',
      timestamp: new Date(),
      data: { summary: 'Inspected existing auth module exports' },
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
      pendingActions: ['Implement token bucket counter', 'Run integration tests'],
      budgetLimits: { maxTokens: 8000, maxToolCalls: 12 },
    });

    const prompt = resumeService.buildContinuationPrompt(handoff);

    // Contains structured durable facts
    expect(prompt).toContain('# Cross-Harness Execution Continuation');
    expect(prompt).toContain(`Execution ID: ${record.execution.id}`);
    expect(prompt).toContain('Handoff Route: native -> claude-code');
    expect(prompt).toContain('Raw model transcript and prior KV cache are NOT replayed');
    expect(prompt).toContain('Add rate limiting middleware to src/auth.ts');
    expect(prompt).toContain('Inspected existing auth module exports');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('check:typecheck@r1');
    expect(prompt).toContain('1. Implement token bucket counter');
    expect(prompt).toContain('2. Run integration tests');

    // Never replays raw transcript chatter
    expect(prompt).not.toContain('RAW_TRANSCRIPT_INTERNAL_MONOLOGUE_DO_NOT_REPLAY_987654321');
    expect(prompt).not.toContain('UNPARSED_MODEL_CHATTER_KV_CACHE_SPECIFIC_112233');
  });

  it('6. carries forward remaining execution budgets (remainingBudget = maxBudget - consumedBudget)', async () => {
    const record = await executions.create({
      task: {
        id: 'task-budget-carry',
        type: 'coding',
        input: 'Optimize auth hashing',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'model-a',
      workspaceRoot: tempDir,
    });

    record.usage = { input: 1200, output: 800, total: 2000 };
    record.totalModelCalls = 3;
    (record as any).costUSD = 0.45;
    (record as any).costStatus = 'ACTUAL';

    await executions.recordToolCall(record.execution.id, {
      id: 'tc-b1',
      tool: 'read',
      input: { path: 'src/auth.ts' },
      ok: true,
      policyEffect: 'allow',
      policyRule: 'read',
      durationMs: 10,
      at: new Date(),
    });
    await executions.recordToolCall(record.execution.id, {
      id: 'tc-b2',
      tool: 'search',
      input: { query: 'verifyToken' },
      ok: true,
      policyEffect: 'allow',
      policyRule: 'search',
      durationMs: 15,
      at: new Date(),
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'acp',
      budgetLimits: {
        maxTokens: 10000,
        maxToolCalls: 10,
        maxModelCalls: 8,
        maxCostUSD: 1.5,
      },
    });

    expect(handoff.consumedBudget.tokensUsed).toBe(2000);
    expect(handoff.consumedBudget.toolCallsUsed).toBe(2);
    expect(handoff.consumedBudget.modelCallsUsed).toBe(3);
    expect(handoff.consumedBudget.costUSD).toBe(0.45);

    expect(handoff.remainingBudget.maxTokens).toBe(8000);
    expect(handoff.remainingBudget.maxToolCalls).toBe(8);
    expect(handoff.remainingBudget.maxModelCalls).toBe(5);
    expect(handoff.remainingBudget.maxCostUSD).toBe(1.05);

    const resumed = await resumeService.prepareResume(handoff);
    expect(resumed.status).toBe('ready');
    expect(resumed.request?.constraints.maxTokens).toBe(8000);
    expect(resumed.request?.constraints.maxToolCalls).toBe(8);
    expect(resumed.request?.constraints.maxTurns).toBe(5);
    expect(resumed.request?.constraints.maxCostUSD).toBe(1.05);
    expect(resumed.resumeContext?.consumed).toEqual({
      toolCalls: 2,
      tokens: 2000,
    });
  });

  it('7. refuses resume when any execution budget dimension is exhausted (<= 0)', async () => {
    const record = await executions.create({
      task: {
        id: 'task-budget-exhausted',
        type: 'coding',
        input: 'Refactor auth module',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'model-a',
      workspaceRoot: tempDir,
    });

    record.usage = { input: 4500, output: 1000, total: 5500 };

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'acp',
      budgetLimits: {
        maxTokens: 5000, // 5000 - 5500 = -500 (<= 0)
        maxToolCalls: 10,
      },
    });

    expect(handoff.resumable).toBe(false);
    expect(handoff.remainingBudget.maxTokens).toBe(-500);

    const resumed = await resumeService.prepareResume(handoff);
    expect(resumed.status).toBe('rejected');
    expect(resumed.resumable).toBe(false);
    expect(resumed.failureCode).toBe('BUDGET_EXHAUSTED');
    expect(resumed.request).toBeUndefined();
    expect(resumed.reasons.join(' ')).toContain('maxTokens (remaining: -500)');
  });

  it('8. prevents policy escalation: blocks weakening localOnly or enabling allowHostedProviders', async () => {
    const record = await executions.create({
      task: {
        id: 'task-policy-local',
        type: 'coding',
        input: 'Audit local key store',
        requirements: {},
        policy: {
          localOnly: true,
          allowHostedProviders: false,
          dataClassification: 'sensitive',
        },
        priority: 'high',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'acp',
    });

    // Attempt 1: weaken localOnly to false
    const attemptLocalFalse = await resumeService.prepareResume(handoff, {
      policyOverride: { localOnly: false },
    });
    expect(attemptLocalFalse.status).toBe('rejected');
    expect(attemptLocalFalse.failureCode).toBe('POLICY_ESCALATION');
    expect(attemptLocalFalse.reasons.join(' ')).toContain("cannot weaken 'localOnly'");

    // Attempt 2: enable allowHostedProviders
    const attemptHostedTrue = await resumeService.prepareResume(handoff, {
      policyOverride: { allowHostedProviders: true },
    });
    expect(attemptHostedTrue.status).toBe('rejected');
    expect(attemptHostedTrue.failureCode).toBe('POLICY_ESCALATION');
    expect(attemptHostedTrue.reasons.join(' ')).toContain("cannot enable 'allowHostedProviders'");

    // Attempt 3: route to hosted runtime ('anthropic') while localOnly is true
    const attemptHostedRuntime = await resumeService.prepareResume(handoff, {
      targetRuntimeId: 'anthropic',
    });
    expect(attemptHostedRuntime.status).toBe('rejected');
    expect(attemptHostedRuntime.failureCode).toBe('POLICY_ESCALATION');
    expect(attemptHostedRuntime.reasons.join(' ')).toContain("target runtime 'anthropic' is hosted");
  });

  it('9. prevents policy escalation: blocks downgrading dataClassification while allowing tightening', async () => {
    const record = await executions.create({
      task: {
        id: 'task-policy-classification',
        type: 'coding',
        input: 'Process internal customer records',
        requirements: {},
        policy: {
          dataClassification: 'sensitive',
          localOnly: true,
        },
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id);

    // Downgrading 'sensitive' -> 'public' or 'internal' is rejected
    const downgraded = await resumeService.prepareResume(handoff, {
      policyOverride: { dataClassification: 'public' },
    });
    expect(downgraded.status).toBe('rejected');
    expect(downgraded.failureCode).toBe('POLICY_ESCALATION');
    expect(downgraded.reasons.join(' ')).toContain(
      "cannot downgrade 'dataClassification' from 'sensitive' to 'public'",
    );

    // Tightening 'sensitive' -> 'restricted' is allowed
    const tightened = await resumeService.prepareResume(handoff, {
      policyOverride: { dataClassification: 'restricted' },
    });
    expect(tightened.status).toBe('ready');
    expect(tightened.effectivePolicy.dataClassification).toBe('restricted');
  });

  it('10. prevents policy escalation: blocks expanding allowedTools or dropping protectedPaths', async () => {
    const record = await executions.create({
      task: {
        id: 'task-policy-tools-paths',
        type: 'coding',
        input: 'Inspect auth logic safely',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      policyContext: {
        allowedTools: ['read', 'search', 'edit'],
        protectedPaths: ['.env', 'packages/core/src/services/policyEngine.ts'],
      },
    });

    // Adding 'shell' to allowedTools is rejected
    const expandedTools = await resumeService.prepareResume(handoff, {
      policyOverride: {
        allowedTools: ['read', 'search', 'edit', 'shell'],
      },
    });
    expect(expandedTools.status).toBe('rejected');
    expect(expandedTools.failureCode).toBe('POLICY_ESCALATION');
    expect(expandedTools.reasons.join(' ')).toContain('shell');

    // Dropping 'packages/core/src/services/policyEngine.ts' from protectedPaths is rejected
    const droppedProtected = await resumeService.prepareResume(handoff, {
      policyOverride: {
        protectedPaths: ['.env'],
      },
    });
    expect(droppedProtected.status).toBe('rejected');
    expect(droppedProtected.failureCode).toBe('POLICY_ESCALATION');
    expect(droppedProtected.reasons.join(' ')).toContain(
      'packages/core/src/services/policyEngine.ts',
    );

    // Narrowing allowedTools and adding an extra protectedPath succeeds
    const narrowedAndTightened = await resumeService.prepareResume(handoff, {
      policyOverride: {
        allowedTools: ['read', 'search'],
        protectedPaths: ['.env', 'packages/core/src/services/policyEngine.ts', 'secrets.yaml'],
      },
    });
    expect(narrowedAndTightened.status).toBe('ready');
    expect(narrowedAndTightened.effectivePolicy.allowedTools).toEqual(['read', 'search']);
    expect(narrowedAndTightened.effectivePolicy.protectedPaths).toContain('secrets.yaml');
  });

  it('11. invalidates prior verification evidence when workspace revision drifts after checkpoint', async () => {
    const record = await executions.create({
      task: {
        id: 'task-rev-drift',
        type: 'coding',
        input: 'Update token validation',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    await executions.recordCheck(record.execution.id, {
      name: 'test',
      command: 'vitest run',
      ok: true,
      output: 'All tests pass',
      durationMs: 50,
      workspaceRevision: executions.getWorkspaceRevision(record.execution.id),
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'acp',
    });
    expect(handoff.workspaceRevision).toBe('1');
    expect(handoff.verificationEvidenceIds).toContain('check:test@r1');

    // Advance workspace revision outside the checkpoint before resuming
    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    expect(executions.getWorkspaceRevision(record.execution.id)).toBe(2);

    const resumed = await resumeService.prepareResume(handoff);
    expect(resumed.status).toBe('ready');
    expect(resumed.workspaceDrifted).toBe(true);
    expect(resumed.evidenceInvalidated).toBe(true);
    expect(resumed.validVerificationEvidenceIds).toEqual([]);
    expect(resumed.staleVerificationEvidenceIds).toContain('check:test@r1');
    expect(resumed.resumeContext?.verification.passing).toEqual([]);
    expect(resumed.resumeContext?.verification.stale).toBeGreaterThanOrEqual(1);
    expect(resumed.request?.verification.requiredChecks).toEqual(
      expect.arrayContaining(['build', 'test']),
    );
    expect(resumed.continuationPrompt).toContain('STATUS: STALE / INVALIDATED');
  });

  it('12. invalidates prior verification evidence when physical workspace files change on disk outside checkpoint', async () => {
    const record = await executions.create({
      task: {
        id: 'task-digest-drift',
        type: 'coding',
        input: 'Verify physical file integrity across handoff',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    await executions.recordFilesChanged(record.execution.id, ['src/auth.ts']);
    await executions.recordCheck(record.execution.id, {
      name: 'build',
      command: 'tsc',
      ok: true,
      output: 'ok',
      durationMs: 30,
      workspaceRevision: 1,
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
    });
    expect(handoff.verificationEvidenceIds).toContain('check:build@r1');

    // Modify physical file on disk WITHOUT recording a new revision on ExecutionEngine
    await fs.writeFile(
      path.join(tempDir, 'src', 'auth.ts'),
      'export function verifyToken(t: string) { return false; /* untrusted external edit */ }\n',
      'utf8',
    );

    const resumed = await resumeService.prepareResume(handoff);
    expect(resumed.status).toBe('ready');
    expect(resumed.workspaceDrifted).toBe(true);
    expect(resumed.evidenceInvalidated).toBe(true);
    expect(resumed.validVerificationEvidenceIds).toEqual([]);
    expect(resumed.staleVerificationEvidenceIds).toContain('check:build@r1');
    expect(resumed.reasons.join(' ')).toContain('WORKSPACE_DIGEST_DRIFT');
  });

  it('13. blocks resumption (status: "blocked") when unresolved mutating side effects exist, but allows READ_ONLY', async () => {
    const record = await executions.create({
      task: {
        id: 'task-side-effects',
        type: 'coding',
        input: 'Commit changes to branch',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    // Dispatch a mutating tool call with no completion event
    await executions.recordToolStart(
      record.execution.id,
      'git',
      { command: 'commit -m "feat: auth"' },
      { callId: 'call-mut-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
    );

    const handoffWithMutating = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'acp',
    });
    expect(handoffWithMutating.resumable).toBe(false);
    expect(handoffWithMutating.unresolvedSideEffects).toHaveLength(1);

    const blockedResult = await resumeService.prepareResume(handoffWithMutating);
    expect(blockedResult.status).toBe('blocked');
    expect(blockedResult.resumable).toBe(false);
    expect(blockedResult.failureCode).toBe('UNRESOLVED_SIDE_EFFECTS');
    expect(blockedResult.blockingSideEffects).toHaveLength(1);
    expect(blockedResult.blockingSideEffects[0].callId).toBe('call-mut-1');
    expect(blockedResult.request).toBeUndefined();

    // Now test an execution with ONLY an interrupted READ_ONLY tool call -> should NOT block
    const readOnlyRecord = await executions.create({
      task: {
        id: 'task-readonly-interrupted',
        type: 'coding',
        input: 'Read config and update',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });
    await executions.recordToolStart(
      readOnlyRecord.execution.id,
      'read',
      { path: 'src/auth.ts' },
      { callId: 'call-ro-1', sideEffectClass: 'READ_ONLY' },
    );

    const handoffReadOnly = await handoffs.createPortableHandoff(readOnlyRecord.execution.id);
    expect(handoffReadOnly.resumable).toBe(true);

    const readyResult = await resumeService.prepareResume(handoffReadOnly);
    expect(readyResult.status).toBe('ready');
    expect(readyResult.resumable).toBe(true);
    expect(readyResult.blockingSideEffects).toEqual([]);
  });

  it('14. unblocks resumption once an unresolved mutating tool call is reconciled from physical evidence', async () => {
    const record = await executions.create({
      task: {
        id: 'task-reconcile-unblock',
        type: 'coding',
        input: 'Write updated auth module',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    await executions.recordToolStart(
      record.execution.id,
      'write',
      { path: 'src/auth.ts' },
      { callId: 'write-call-1', sideEffectClass: 'IDEMPOTENT_WRITE' },
    );

    const handoff = await handoffs.createPortableHandoff(record.execution.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code',
    });

    // Initially blocked
    const beforeReconcile = await resumeService.prepareResume(handoff);
    expect(beforeReconcile.status).toBe('blocked');

    // Reconcile the tool call on ExecutionEngine with physical proof
    await executions.reconcileToolCall(record.execution.id, 'write-call-1', {
      outcome: 'APPLIED',
      evidence: 'src/auth.ts matches expected SHA-256 content',
      inspectedBy: 'operator-audit',
    });

    // Resuming the handoff now succeeds and records the reconciliation in resumeContext
    const afterReconcile = await resumeService.prepareResume(handoff);
    expect(afterReconcile.status).toBe('ready');
    expect(afterReconcile.resumable).toBe(true);
    expect(afterReconcile.resumeContext?.reconciled).toContain(
      "Reconciled 'write' (write-call-1)",
    );
  });

  it('15. verifies target harness capabilities, taskType support, and external binary availability', async () => {
    const record = await executions.create({
      task: {
        id: 'task-harness-compat',
        type: 'coding',
        input: 'Execute workspace-isolated refactoring',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      runtimeId: 'local',
      modelId: 'local-model',
      workspaceRoot: tempDir,
    });

    const handoff = await handoffs.createPortableHandoff(record.execution.id);

    // 1. Unregistered harness ID is rejected
    const unknownHarness = await resumeService.prepareResume(handoff, {
      targetHarnessId: 'non-existent-harness',
    });
    expect(unknownHarness.status).toBe('rejected');
    expect(unknownHarness.failureCode).toBe('INCOMPATIBLE_HARNESS');
    expect(unknownHarness.reasons.join(' ')).toContain('TARGET_HARNESS_NOT_FOUND');

    // 2. Requiring 'workspace-isolation' on 'codex' (which does not advertise workspace-isolation) is rejected
    const missingCap = await resumeService.prepareResume(handoff, {
      targetHarnessId: 'codex',
      requiredCapabilities: ['checkpoint-resume', 'workspace-isolation'],
    });
    expect(missingCap.status).toBe('rejected');
    expect(missingCap.failureCode).toBe('INCOMPATIBLE_HARNESS');
    expect(missingCap.reasons.join(' ')).toContain('MISSING_HARNESS_CAPABILITY');

    // 3. Registering a custom external CLI harness requiring a missing binary is rejected
    const customResumeService = new HarnessResumeService({
      handoffs,
      executions,
      checkpoints,
      defaultWorkspaceRoot: tempDir,
      isBinaryAvailable: (bin) => bin !== 'missing-agent-cli',
      harnesses: [
        {
          harnessId: 'custom-cli-agent',
          name: 'Custom CLI Agent',
          version: '1.0.0',
          kind: 'external-cli',
          capabilities: ['coding', 'checkpoint-resume'],
          supportedTaskTypes: ['coding'],
          supportedProtocols: ['stdio-cli'],
          requiresBinary: 'missing-agent-cli',
          allowsModelSelection: false,
        },
      ],
    });

    const missingBin = await customResumeService.prepareResume(handoff, {
      targetHarnessId: 'custom-cli-agent',
    });
    expect(missingBin.status).toBe('rejected');
    expect(missingBin.failureCode).toBe('INCOMPATIBLE_HARNESS');
    expect(missingBin.reasons.join(' ')).toContain('MISSING_EXTERNAL_BINARY');
  });
});
