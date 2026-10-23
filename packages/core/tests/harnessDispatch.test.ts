import { describe, it, expect, beforeEach } from 'vitest';
import {
  HarnessDispatchService,
  HarnessResolutionError,
  HARNESS_CONTRACT_SCHEMA_VERSION,
  type HarnessDescriptor,
  type HarnessRunner,
  type UnifiedExecutionRequest,
  type UnifiedExecutionResult,
} from '../src/services/harnessDispatchService.js';
import { VerificationEngine } from '../src/services/verificationEngine.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { Scheduler } from '../src/services/scheduler.js';
import { AgentRegistry } from '../src/services/agentRegistry.js';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { RuntimeRegistry } from '../src/services/runtimeRegistry.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';

function createBaseRequest(overrides: Partial<UnifiedExecutionRequest> = {}): UnifiedExecutionRequest {
  return {
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: 'exec-test-1',
    taskId: 'task-test-1',
    objective: 'Fix authentication token refresh bug and run unit tests',
    taskType: 'coding',
    workspace: {
      root: '/tmp/wazir-test-workspace',
      revision: 1,
    },
    constraints: {
      maxDurationMs: 10_000,
      maxTokens: 8000,
      maxToolCalls: 20,
      maxCostUSD: 1.5,
      allowFallback: false,
    },
    verification: {
      requiredChecks: ['TEST'],
      protectedPaths: ['.git', 'package.json'],
      mutationRequired: true,
    },
    policyContext: {},
    ...overrides,
  };
}

function createMockHarness(
  descriptorOverrides: Partial<HarnessDescriptor> & { harnessId: string },
  executeImpl?: (req: UnifiedExecutionRequest) => Promise<UnifiedExecutionResult>,
  isAvailableImpl?: () => Promise<boolean> | boolean,
): HarnessRunner {
  const descriptor: HarnessDescriptor = {
    name: descriptorOverrides.name ?? descriptorOverrides.harnessId,
    version: '1.0.0',
    kind: 'native',
    capabilities: ['coding', 'step-execution', 'cancellation', 'checkpoint-resume'],
    supportedTaskTypes: ['coding', 'debugging', 'review', 'research'],
    supportedProtocols: ['native'],
    allowsModelSelection: true,
    ...descriptorOverrides,
  };

  return {
    descriptor,
    isAvailable: isAvailableImpl,
    execute:
      executeImpl ??
      (async (req: UnifiedExecutionRequest): Promise<UnifiedExecutionResult> => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: req.executionId,
        taskId: req.taskId,
        harnessId: descriptor.harnessId,
        harnessKind: descriptor.kind,
        modelId: req.modelPreference ?? 'qwen2.5-coder:14b',
        runtimeId: req.runtimePreference ?? 'ollama',
        status: 'completed',
        workspaceRevision: String(req.workspace.revision),
        filesChanged: ['src/auth.ts'],
        artifacts: [{ path: 'src/auth.ts', kind: 'file' }],
        toolCalls: [
          {
            id: 'tc-1',
            tool: 'edit',
            input: { path: 'src/auth.ts' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'filesystem-project-allow',
            durationMs: 25,
            at: new Date(),
          },
        ],
        usage: {
          inputTokens: 400,
          outputTokens: 200,
          totalTokens: 600,
          costUSD: 0,
          costStatus: 'ACTUAL',
          durationMs: 120,
          modelCalls: 2,
        },
        verificationEvidenceIds: [],
        output: 'Fixed token refresh bug in src/auth.ts',
      })),
  };
}

describe('HarnessDispatchService', () => {
  let verificationEngine: VerificationEngine;
  let policyEngine: PolicyEngine;
  let executionEngine: ExecutionEngine;

  beforeEach(async () => {
    verificationEngine = new VerificationEngine({
      projectRoot: '/tmp/wazir-test-workspace',
      initialRevision: 0,
      protectedFiles: ['package.json'],
    });
    verificationEngine.registerOracle({
      type: 'TEST',
      verify: async () => ({
        exitCode: 0,
        output: '12 passed (12)',
        status: 'PASS',
        reasons: ['All tests passed'],
      }),
    });
    verificationEngine.registerOracle({
      type: 'BUILD',
      verify: async () => ({
        exitCode: 0,
        output: 'Build clean',
        status: 'PASS',
        reasons: ['Build succeeded'],
      }),
    });

    policyEngine = new PolicyEngine({ projectRoot: '/tmp/wazir-test-workspace' });
    executionEngine = new ExecutionEngine({ workspace: '/tmp/wazir-test-workspace', fastStartup: true });
    await executionEngine.ready;
  });

  it('1. registers, gets, and lists native and external harnesses in deterministic order', () => {
    const service = new HarnessDispatchService();
    const acpRunner = createMockHarness({
      harnessId: 'claude-code-acp',
      kind: 'acp',
      supportedProtocols: ['acp'],
      allowsModelSelection: false,
    });
    const cliRunner = createMockHarness({
      harnessId: 'aider-cli',
      kind: 'external-cli',
      supportedProtocols: ['stdio-cli'],
    });
    const nativeRunner = createMockHarness({
      harnessId: 'wazir-native',
      kind: 'native',
      supportedProtocols: ['native'],
    });

    service.registerHarness(acpRunner);
    service.registerHarness(cliRunner);
    service.registerHarness(nativeRunner);

    expect(service.getHarness('wazir-native')).toBe(nativeRunner);
    expect(service.getHarness('claude-code-acp')).toBe(acpRunner);
    expect(service.getHarness('nonexistent')).toBeUndefined();

    const listed = service.listHarnesses();
    expect(listed.map((h) => h.harnessId)).toEqual(['wazir-native', 'aider-cli', 'claude-code-acp']);
  });

  it('2. dispatches the same task to native and ACP harnesses through the exact same independent verification pipeline', async () => {
    // Track physical mutation in verification engine so revision > 0
    verificationEngine.trackPhysicalMutation({
      filePath: 'src/auth.ts',
      beforeContent: 'const broken = true;',
      afterContent: 'const broken = false;',
    });

    const nativeHarness = createMockHarness({
      harnessId: 'wazir-native',
      kind: 'native',
      supportedProtocols: ['native'],
    });
    const acpHarness = createMockHarness(
      {
        harnessId: 'codex-acp',
        kind: 'acp',
        supportedProtocols: ['acp'],
        allowsModelSelection: true,
      },
      async (req) => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: req.executionId,
        taskId: req.taskId,
        harnessId: 'codex-acp',
        harnessKind: 'acp',
        modelId: 'gpt-4.1',
        runtimeId: 'acp-stdio',
        status: 'completed',
        workspaceRevision: String(req.workspace.revision),
        filesChanged: ['src/auth.ts'],
        artifacts: [{ path: 'src/auth.ts', kind: 'file' }],
        toolCalls: [],
        usage: {
          inputTokens: 500,
          outputTokens: 250,
          totalTokens: 750,
          costStatus: 'UNKNOWN',
          durationMs: 210,
        },
        verificationEvidenceIds: [],
        output: 'Completed via ACP harness',
      }),
    );

    const service = new HarnessDispatchService({
      harnesses: [nativeHarness, acpHarness],
      verificationEngine,
      policyEngine,
      executionEngine,
    });

    const nativeResult = await service.dispatch(
      createBaseRequest({
        executionId: 'exec-native-1',
        harnessPreference: 'wazir-native',
      }),
    );

    const acpResult = await service.dispatch(
      createBaseRequest({
        executionId: 'exec-acp-1',
        harnessPreference: 'codex-acp',
      }),
    );

    expect(nativeResult.harnessId).toBe('wazir-native');
    expect(nativeResult.harnessKind).toBe('native');
    expect(nativeResult.status).toBe('completed');
    expect(nativeResult.verified).toBe(true);
    expect(nativeResult.verificationEvidenceIds.length).toBeGreaterThan(0);

    expect(acpResult.harnessId).toBe('codex-acp');
    expect(acpResult.harnessKind).toBe('acp');
    expect(acpResult.status).toBe('completed');
    expect(acpResult.verified).toBe(true);
    expect(acpResult.verificationEvidenceIds.length).toBeGreaterThan(0);
    // Invariant 3: UNKNOWN cost is never coerced to 0
    expect(acpResult.usage.costStatus).toBe('UNKNOWN');
    expect(acpResult.usage.costUSD).toBeUndefined();

    // Both executions recorded durably in ExecutionEngine
    const allRecords = await executionEngine.list();
    expect(allRecords.length).toBe(2);
    expect(allRecords.every((r) => r.execution.status === 'completed')).toBe(true);
  });

  it('3. enforces Invariant 1: apparent harness completion is rejected when independent controller verification fails', async () => {
    const failingVerificationEngine = new VerificationEngine({
      projectRoot: '/tmp/wazir-test-workspace',
      initialRevision: 1,
    });
    failingVerificationEngine.trackPhysicalMutation({
      filePath: 'src/auth.ts',
      beforeContent: 'a',
      afterContent: 'b',
    });
    failingVerificationEngine.registerOracle({
      type: 'TEST',
      verify: async () => ({
        exitCode: 1,
        output: 'AssertionError: expected token to refresh',
        status: 'FAIL',
        reasons: ['1 test failed'],
      }),
    });

    const overconfidentHarness = createMockHarness({
      harnessId: 'wazir-native',
      kind: 'native',
    });

    const service = new HarnessDispatchService({
      harnesses: [overconfidentHarness],
      verificationEngine: failingVerificationEngine,
      policyEngine,
      executionEngine,
    });

    const result = await service.dispatch(createBaseRequest());

    expect(result.status).toBe('failed');
    expect(result.verified).toBe(false);
    expect(result.terminationReason).toBe('VERIFICATION_FAILED');
    expect(result.errorKind).toBe('verification');
    expect(result.errors?.some((e) => e.includes('TEST_FAILED'))).toBe(true);
  });

  it('4. performs capability matching and selects the harness supporting required capabilities and taskType', async () => {
    const basicHarness = createMockHarness({
      harnessId: 'basic-chat-harness',
      kind: 'native',
      capabilities: ['chat'],
      supportedTaskTypes: ['chat'],
    });
    const mcpCodingHarness = createMockHarness({
      harnessId: 'mcp-coding-harness',
      kind: 'acp',
      capabilities: ['coding', 'mcp', 'workspace-isolation'],
      supportedTaskTypes: ['coding'],
    });

    const service = new HarnessDispatchService({
      harnesses: [basicHarness, mcpCodingHarness],
      policyEngine,
    });

    const resolution = await service.resolveHarness(
      createBaseRequest({
        taskType: 'coding',
        policyContext: {
          requiredCapabilities: ['coding', 'mcp'],
        },
      }),
    );

    expect(resolution.descriptor.harnessId).toBe('mcp-coding-harness');
    expect(resolution.reasons.some((r) => r.includes('mcp-coding-harness'))).toBe(true);
  });

  it('5. honors explicit harnessPreference pin and fails closed when pinned harness is missing or lacks capabilities with allowFallback: false', async () => {
    const nativeHarness = createMockHarness({
      harnessId: 'wazir-native',
      kind: 'native',
      capabilities: ['coding'],
    });

    const service = new HarnessDispatchService({
      harnesses: [nativeHarness],
      policyEngine,
    });

    // Missing harness pin with allowFallback: false
    await expect(
      service.resolveHarness(
        createBaseRequest({
          harnessPreference: 'missing-acp-harness',
          constraints: { allowFallback: false },
        }),
      ),
    ).rejects.toThrow(/Pinned harness 'missing-acp-harness' is not registered/);

    // Capability mismatch on pinned harness with allowFallback: false
    await expect(
      service.resolveHarness(
        createBaseRequest({
          harnessPreference: 'wazir-native',
          constraints: { allowFallback: false },
          policyContext: {
            requiredCapabilities: ['mcp'],
          },
        }),
      ),
    ).rejects.toThrow(/lacks required capabilities: mcp/);
  });

  it('6. never silently substitutes an explicit user pin when strictPin is true even if allowFallback is true', async () => {
    const unavailablePinned = createMockHarness(
      {
        harnessId: 'pinned-acp',
        kind: 'acp',
      },
      undefined,
      () => false, // unavailable
    );
    const healthyBackup = createMockHarness({
      harnessId: 'wazir-native',
      kind: 'native',
    });

    const service = new HarnessDispatchService({
      harnesses: [unavailablePinned, healthyBackup],
      policyEngine,
    });

    await expect(
      service.resolveHarness(
        createBaseRequest({
          harnessPreference: 'pinned-acp',
          constraints: { allowFallback: true },
          policyContext: { strictPin: true },
        }),
      ),
    ).rejects.toThrow(/Pinned harness 'pinned-acp' cannot be used: harness 'pinned-acp' is currently unavailable/);
  });

  it('7. supports controlled fallback on primary harness infrastructure failure when allowFallback: true, preserving executionId, taskId, and consumed budget', async () => {
    let fallbackReceivedRequest: UnifiedExecutionRequest | undefined;

    const primaryFailingHarness = createMockHarness(
      {
        harnessId: 'primary-native',
        kind: 'native',
      },
      async (req) => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: req.executionId,
        taskId: req.taskId,
        harnessId: 'primary-native',
        harnessKind: 'native',
        modelId: 'qwen2.5-coder:14b',
        runtimeId: 'ollama',
        status: 'failed',
        errorKind: 'infrastructure',
        workspaceRevision: String(req.workspace.revision),
        filesChanged: [],
        artifacts: [],
        toolCalls: [
          {
            id: 'tc-read-1',
            tool: 'read',
            input: { path: 'src/auth.ts' },
            ok: true,
            policyEffect: 'allow',
            policyRule: 'filesystem-project-allow',
            durationMs: 10,
            at: new Date(),
          },
        ],
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          costUSD: 0.25,
          costStatus: 'ACTUAL',
          durationMs: 1000,
          modelCalls: 1,
        },
        verificationEvidenceIds: [],
        errors: ['Runtime connection reset (ECONNREFUSED)'],
      }),
    );

    const backupAcpHarness = createMockHarness(
      {
        harnessId: 'backup-acp',
        kind: 'acp',
        supportedProtocols: ['acp'],
      },
      async (req) => {
        fallbackReceivedRequest = req;
        return {
          schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
          executionId: req.executionId,
          taskId: req.taskId,
          harnessId: 'backup-acp',
          harnessKind: 'acp',
          modelId: 'claude-3-7-sonnet',
          runtimeId: 'acp-runtime',
          status: 'completed',
          workspaceRevision: String(req.workspace.revision),
          filesChanged: ['src/auth.ts'],
          artifacts: [{ path: 'src/auth.ts', kind: 'file' }],
          toolCalls: [],
          usage: {
            inputTokens: 800,
            outputTokens: 200,
            totalTokens: 1000,
            costUSD: 0.35,
            costStatus: 'ACTUAL',
            durationMs: 500,
            modelCalls: 1,
          },
          verificationEvidenceIds: [],
          output: 'Recovered and completed on backup-acp',
        };
      },
    );

    const service = new HarnessDispatchService({
      harnesses: [primaryFailingHarness, backupAcpHarness],
      policyEngine,
      verifyExecution: async () => ({
        verified: true,
        evidenceIds: ['evd-test-pass-1'],
        reasons: ['Verified by controller callback'],
      }),
    });

    const result = await service.dispatch(
      createBaseRequest({
        executionId: 'exec-fallback-preserve',
        taskId: 'task-fallback-preserve',
        constraints: {
          maxTokens: 8000,
          maxToolCalls: 20,
          maxCostUSD: 1.5,
          maxDurationMs: 10_000,
          allowFallback: true,
        },
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(result.harnessId).toBe('backup-acp');
    expect(result.executionId).toBe('exec-fallback-preserve');
    expect(result.taskId).toBe('task-fallback-preserve');

    // Verify backup harness received decremented remaining budget and resumeContext
    expect(fallbackReceivedRequest).toBeDefined();
    expect(fallbackReceivedRequest!.executionId).toBe('exec-fallback-preserve');
    expect(fallbackReceivedRequest!.taskId).toBe('task-fallback-preserve');
    expect(fallbackReceivedRequest!.constraints.maxTokens).toBe(6500); // 8000 - 1500
    expect(fallbackReceivedRequest!.constraints.maxToolCalls).toBe(19); // 20 - 1
    expect(fallbackReceivedRequest!.constraints.maxCostUSD).toBe(1.25); // 1.5 - 0.25
    expect(fallbackReceivedRequest!.resumeContext?.attempt).toBe(2);
    expect(fallbackReceivedRequest!.resumeContext?.consumed).toEqual({
      toolCalls: 1,
      tokens: 1500,
    });

    // Verify final result aggregates total usage across both attempts
    expect(result.usage.totalTokens).toBe(2500);
    expect(result.usage.costUSD).toBe(0.6);
    expect(result.usage.durationMs).toBe(1500);
  });

  it('8. fails closed without fallback when primary harness fails and allowFallback is false', async () => {
    let backupCalled = false;

    const primaryFailing = createMockHarness(
      { harnessId: 'primary-native', kind: 'native' },
      async (req) => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: req.executionId,
        taskId: req.taskId,
        harnessId: 'primary-native',
        modelId: 'm1',
        runtimeId: 'r1',
        status: 'failed',
        errorKind: 'infrastructure',
        workspaceRevision: '1',
        artifacts: [],
        toolCalls: [],
        usage: { durationMs: 50 },
        verificationEvidenceIds: [],
        errors: ['Primary daemon crashed'],
      }),
    );

    const backupHarness = createMockHarness(
      { harnessId: 'backup-acp', kind: 'acp' },
      async (req) => {
        backupCalled = true;
        return {
          schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
          executionId: req.executionId,
          taskId: req.taskId,
          harnessId: 'backup-acp',
          modelId: 'm2',
          runtimeId: 'r2',
          status: 'completed',
          workspaceRevision: '1',
          artifacts: [],
          toolCalls: [],
          usage: { durationMs: 50 },
          verificationEvidenceIds: [],
        };
      },
    );

    const service = new HarnessDispatchService({
      harnesses: [primaryFailing, backupHarness],
      policyEngine,
    });

    const result = await service.dispatch(
      createBaseRequest({
        constraints: { allowFallback: false },
      }),
    );

    expect(backupCalled).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.harnessId).toBe('primary-native');
    expect(result.verified).toBe(false);
  });

  it('9. blocks automatic fallback when unconfirmed mutating tool side effects (TOOL_OUTCOME_UNKNOWN) occurred', async () => {
    let backupCalled = false;

    const interruptedMutatingHarness = createMockHarness(
      { harnessId: 'primary-native', kind: 'native' },
      async (req) => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: req.executionId,
        taskId: req.taskId,
        harnessId: 'primary-native',
        modelId: 'm1',
        runtimeId: 'r1',
        status: 'interrupted',
        errorKind: 'infrastructure',
        workspaceRevision: '1',
        artifacts: [],
        toolCalls: [
          {
            id: 'tc-write-unknown',
            tool: 'write',
            input: { path: 'src/auth.ts', content: 'partial write' },
            ok: false,
            failureClass: 'TOOL_OUTCOME_UNKNOWN',
            policyEffect: 'allow',
            policyRule: 'filesystem-project-allow',
            durationMs: 40,
            at: new Date(),
          },
        ],
        usage: { durationMs: 100 },
        verificationEvidenceIds: [],
        errors: ['Worker connection lost mid-write'],
      }),
    );

    const backupHarness = createMockHarness(
      { harnessId: 'backup-acp', kind: 'acp' },
      async (req) => {
        backupCalled = true;
        return {
          schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
          executionId: req.executionId,
          taskId: req.taskId,
          harnessId: 'backup-acp',
          modelId: 'm2',
          runtimeId: 'r2',
          status: 'completed',
          workspaceRevision: '1',
          artifacts: [],
          toolCalls: [],
          usage: { durationMs: 50 },
          verificationEvidenceIds: [],
        };
      },
    );

    const service = new HarnessDispatchService({
      harnesses: [interruptedMutatingHarness, backupHarness],
      policyEngine,
    });

    const result = await service.dispatch(
      createBaseRequest({
        constraints: { allowFallback: true },
      }),
    );

    expect(backupCalled).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.verified).toBe(false);
    expect(result.failureClassification).toBe('UNCONFIRMED_SIDE_EFFECT_BLOCKS_FALLBACK');
    expect(result.errors?.some((e) => e.includes('TOOL_OUTCOME_UNKNOWN'))).toBe(true);
  });

  it('10. enforces timeout (maxDurationMs) when harness exceeds wall-clock budget', async () => {
    const slowHarness = createMockHarness(
      { harnessId: 'slow-harness', kind: 'native' },
      async (req) => {
        await new Promise((r) => setTimeout(r, 300));
        return {
          schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
          executionId: req.executionId,
          taskId: req.taskId,
          harnessId: 'slow-harness',
          modelId: 'm1',
          runtimeId: 'r1',
          status: 'completed',
          workspaceRevision: '1',
          artifacts: [],
          toolCalls: [],
          usage: { durationMs: 300 },
          verificationEvidenceIds: [],
        };
      },
    );

    const service = new HarnessDispatchService({
      harnesses: [slowHarness],
      policyEngine,
    });

    const result = await service.dispatch(
      createBaseRequest({
        constraints: {
          maxDurationMs: 40,
          allowFallback: false,
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.verified).toBe(false);
    expect(result.terminationReason).toBe('MAX_WALL_CLOCK');
    expect(result.errors?.some((e) => e.includes('maxDurationMs'))).toBe(true);
  });

  it('11. enforces cooperative cancellation (isCancelled) before and during execution', async () => {
    let cancelled = false;
    const cancellableHarness = createMockHarness(
      { harnessId: 'cancellable-harness', kind: 'native' },
      async (req) => {
        await new Promise((r) => setTimeout(r, 200));
        return {
          schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
          executionId: req.executionId,
          taskId: req.taskId,
          harnessId: 'cancellable-harness',
          modelId: 'm1',
          runtimeId: 'r1',
          status: 'completed',
          workspaceRevision: '1',
          artifacts: [],
          toolCalls: [],
          usage: { durationMs: 200 },
          verificationEvidenceIds: [],
        };
      },
    );

    const service = new HarnessDispatchService({
      harnesses: [cancellableHarness],
      policyEngine,
    });

    setTimeout(() => {
      cancelled = true;
    }, 30);

    const result = await service.dispatch(
      createBaseRequest({
        isCancelled: () => cancelled,
      }),
    );

    expect(result.status).toBe('cancelled');
    expect(result.verified).toBe(false);
    expect(result.terminationReason).toBe('CANCELLED');
    expect(result.errorKind).toBe('cancelled');
  });

  it('12. enforces provider_only routing constraint by rejecting external harnesses that manage their own model selection', async () => {
    const unmanagedAcpHarness = createMockHarness({
      harnessId: 'opaque-acp-agent',
      kind: 'acp',
      allowsModelSelection: false,
    });
    const pinnableAcpHarness = createMockHarness({
      harnessId: 'pinnable-acp-agent',
      kind: 'acp',
      allowsModelSelection: true,
    });

    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const agents = new AgentRegistry();

    const scheduler = new Scheduler({
      computers,
      runtimes,
      models,
      agents,
      policy: policyEngine,
      routing: {
        mode: 'provider_only',
        provider: 'nvidia',
        defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        allowFallback: false,
      },
    });

    const service = new HarnessDispatchService({
      harnesses: [unmanagedAcpHarness, pinnableAcpHarness],
      scheduler,
      policyEngine,
    });

    // Explicitly pinning the opaque external harness under provider_only must fail closed with POLICY_DENIED
    await expect(
      service.resolveHarness(
        createBaseRequest({
          harnessPreference: 'opaque-acp-agent',
          constraints: { allowFallback: true },
        }),
      ),
    ).rejects.toThrow(/manages its own model selection \(allowsModelSelection=false\) and is rejected under provider_only/);

    // Non-matching provider model on pinnable external harness is also rejected under provider_only
    await expect(
      service.resolveHarness(
        createBaseRequest({
          harnessPreference: 'pinnable-acp-agent',
          modelPreference: 'anthropic/claude-3-7-sonnet',
        }),
      ),
    ).rejects.toThrow(/cannot pin non-nvidia model/);
  });

  it('13. rejects tasks that violate PolicyEngine task-level policy or modify protected paths during verification', async () => {
    const nativeHarness = createMockHarness(
      { harnessId: 'wazir-native', kind: 'native' },
      async (req) => ({
        schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
        executionId: req.executionId,
        taskId: req.taskId,
        harnessId: 'wazir-native',
        modelId: 'm1',
        runtimeId: 'r1',
        status: 'completed',
        workspaceRevision: '1',
        filesChanged: ['package.json', 'src/auth.ts'],
        artifacts: [],
        toolCalls: [],
        usage: { durationMs: 50 },
        verificationEvidenceIds: [],
      }),
    );

    const service = new HarnessDispatchService({
      harnesses: [nativeHarness],
      policyEngine,
      verificationEngine,
    });

    // 1. PolicyEngine denies task where toolAccess=false but toolCalling=true
    await expect(
      service.dispatch(
        createBaseRequest({
          policyContext: {
            toolAccess: false,
            toolCalling: true,
          },
        }),
      ),
    ).rejects.toThrow(HarnessResolutionError);

    // 2. Protected path modified during run fails independent controller verification
    const protectedViolationResult = await service.dispatch(
      createBaseRequest({
        verification: {
          requiredChecks: ['TEST'],
          protectedPaths: ['package.json'],
          mutationRequired: true,
        },
      }),
    );

    expect(protectedViolationResult.status).toBe('failed');
    expect(protectedViolationResult.verified).toBe(false);
    expect(protectedViolationResult.terminationReason).toBe('VERIFICATION_FAILED');
    expect(
      protectedViolationResult.errors?.some((e) => e.includes('PROTECTED_PATH_VIOLATION')),
    ).toBe(true);
  });
});
