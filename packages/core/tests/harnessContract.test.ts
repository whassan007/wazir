import { describe, it, expect } from 'vitest';
import {
  HARNESS_CONTRACT_SCHEMA_VERSION,
  validateUnifiedExecutionRequest,
  validateUnifiedExecutionResult,
  normalizeExecutionResult,
  migrateUnifiedExecutionResult,
  computeRequestContractDigest,
  fromExecutionRecordToUnifiedResult,
  type HarnessDescriptor,
  type UnifiedExecutionRequest,
  type UnifiedExecutionResult,
} from '../src/types/harnessContract.js';
import type { ExecutionRecord } from '../src/types/execution.js';

function createValidRequest(
  overrides: Partial<UnifiedExecutionRequest> = {},
): UnifiedExecutionRequest {
  return {
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: 'exec-101',
    taskId: 'task-202',
    objective: 'Implement cross-harness execution contract',
    taskType: 'coding',
    harnessPreference: 'wazir-native',
    modelPreference: 'qwen2.5-coder:14b',
    runtimePreference: 'ollama',
    workspace: {
      root: '/workspace/repo',
      revision: 4,
    },
    constraints: {
      maxCostUSD: 1.5,
      maxDurationMs: 60000,
      maxTokens: 32000,
      maxAttempts: 2,
      maxTurns: 12,
      maxToolCalls: 25,
      allowFallback: true,
    },
    verification: {
      requiredChecks: ['build', 'test'],
      protectedPaths: ['.env', 'package-lock.json'],
      mutationRequired: true,
      expectedArtifacts: ['src/contract.ts'],
    },
    policyContext: {
      dataClassification: 'internal',
      localOnly: false,
      toolAccess: true,
    },
    ...overrides,
  };
}

function createValidResult(
  overrides: Partial<UnifiedExecutionResult> = {},
): UnifiedExecutionResult {
  return {
    schemaVersion: HARNESS_CONTRACT_SCHEMA_VERSION,
    executionId: 'exec-101',
    taskId: 'task-202',
    harnessId: 'wazir-native',
    harnessKind: 'native',
    modelId: 'qwen2.5-coder:14b',
    runtimeId: 'ollama',
    status: 'completed',
    verified: true,
    terminationReason: 'VERIFICATION_PASSED',
    workspaceRevision: '5',
    filesChanged: ['src/contract.ts'],
    artifacts: [
      {
        path: 'src/contract.ts',
        hash: 'abc123def456',
        kind: 'file',
        createdAt: '2026-10-23T02:00:00.000Z',
      },
    ],
    toolCalls: [],
    checks: [
      {
        workspaceRevision: 5,
        name: 'test',
        command: 'npx vitest run',
        ok: true,
        output: '15 passed',
        durationMs: 420,
      },
    ],
    usage: {
      inputTokens: 1200,
      outputTokens: 450,
      totalTokens: 1650,
      costUSD: 0,
      costStatus: 'ACTUAL',
      durationMs: 3200,
      firstTokenLatencyMs: 110,
      modelCalls: 3,
    },
    verificationEvidenceIds: ['ev-test-5', 'ev-build-5'],
    output: 'Successfully implemented contract',
    provenance: {
      startedAt: '2026-10-23T01:59:56.800Z',
      completedAt: '2026-10-23T02:00:00.000Z',
      contractDigest: 'a1b2c3d4e5f6',
    },
    ...overrides,
  };
}

describe('Cross-Harness Unified Execution Contract (Agent A1)', () => {
  it('1. validates a complete native harness UnifiedExecutionRequest and defaults schemaVersion', () => {
    const req = createValidRequest({ schemaVersion: undefined });
    const res = validateUnifiedExecutionRequest(req);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.value?.schemaVersion).toBe(HARNESS_CONTRACT_SCHEMA_VERSION);
  });

  it('2. validates ACP and external-cli HarnessDescriptors and requests', () => {
    const acpDescriptor: HarnessDescriptor = {
      harnessId: 'claude-code-acp',
      name: 'Claude Code ACP Harness',
      version: '1.2.0',
      kind: 'acp',
      capabilities: ['coding', 'streaming', 'tool-Forwarding', 'checkpoint-resume', 'cancellation'],
      supportedTaskTypes: ['coding', 'debugging', 'review'],
      supportedProtocols: ['acp'],
      requiresBinary: 'claude',
      allowsModelSelection: true,
      defaultPermissionMode: 'edit',
    };
    expect(acpDescriptor.kind).toBe('acp');

    const req = createValidRequest({
      harnessPreference: acpDescriptor.harnessId,
      workspace: { root: '/workspace/acp', revision: 'git-sha-99a8b7' },
      isCancelled: () => false,
    });
    const validation = validateUnifiedExecutionRequest(req);
    expect(validation.valid).toBe(true);
  });

  it('3. rejects malformed UnifiedExecutionRequest payloads', () => {
    expect(validateUnifiedExecutionRequest(null).valid).toBe(false);
    expect(validateUnifiedExecutionRequest('invalid').valid).toBe(false);

    const badReq = {
      schemaVersion: 99,
      executionId: '',
      taskId: '  ',
      objective: '',
      workspace: { root: '', revision: -5 },
      constraints: { allowFallback: 'yes', maxCostUSD: -1 },
      verification: { requiredChecks: [''], protectedPaths: 'not-array' },
      policyContext: null,
      isCancelled: 'not-a-fn',
    };
    const res = validateUnifiedExecutionRequest(badReq);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(8);
    expect(res.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
    expect(res.errors.some((e) => e.includes('executionId'))).toBe(true);
    expect(res.errors.some((e) => e.includes('workspace.root'))).toBe(true);
    expect(res.errors.some((e) => e.includes('constraints.maxCostUSD'))).toBe(true);
  });

  it('4. validates a complete verified UnifiedExecutionResult', () => {
    const result = createValidResult();
    const validation = validateUnifiedExecutionResult(result);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.value?.verified).toBe(true);
  });

  it('5. validates ACP and external-cli UnifiedExecutionResults', () => {
    const acpResult = createValidResult({
      harnessId: 'codex-acp',
      harnessKind: 'acp',
      runtimeId: 'acp-stdio',
      modelId: 'gpt-5-codex',
      usage: {
        inputTokens: 4000,
        outputTokens: 1200,
        totalTokens: 5200,
        costUSD: 0.042,
        costStatus: 'ESTIMATED',
        durationMs: 8500,
      },
    });
    expect(validateUnifiedExecutionResult(acpResult).valid).toBe(true);

    const cliResult = createValidResult({
      harnessId: 'gemini-cli',
      harnessKind: 'external-cli',
      runtimeId: 'external-cli',
      modelId: 'gemini-2.5-pro',
      usage: {
        durationMs: 11200,
        costStatus: 'UNKNOWN',
        costUSD: undefined,
      },
    });
    expect(validateUnifiedExecutionResult(cliResult).valid).toBe(true);
  });

  it('6. enforces Invariant 1: rejects verified === true when verificationEvidenceIds is empty', () => {
    const unverifiedClaim = createValidResult({
      status: 'completed',
      verified: true,
      verificationEvidenceIds: [],
    });
    const validation = validateUnifiedExecutionResult(unverifiedClaim);
    expect(validation.valid).toBe(false);
    expect(
      validation.errors.some((e) =>
        e.includes('verified cannot be true when verificationEvidenceIds is empty'),
      ),
    ).toBe(true);
  });

  it('7. enforces Invariant 1: rejects verified === true when status is not completed', () => {
    for (const status of ['failed', 'cancelled', 'interrupted', 'unknown'] as const) {
      const invalidVerified = createValidResult({
        status,
        verified: true,
        verificationEvidenceIds: ['ev-1'],
      });
      const validation = validateUnifiedExecutionResult(invalidVerified);
      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((e) =>
          e.includes(`verified cannot be true when status is '${status}'`),
        ),
      ).toBe(true);
    }
  });

  it('8. allows apparent completion (status: completed, verified: false) with empty evidence', () => {
    const apparentCompletion = createValidResult({
      status: 'completed',
      verified: false,
      verificationEvidenceIds: [],
    });
    const validation = validateUnifiedExecutionResult(apparentCompletion);
    expect(validation.valid).toBe(true);
  });

  it('9. normalizeExecutionResult demotes verified to false when evidence is missing or status is non-completed', () => {
    const unverifiedClaim = createValidResult({
      status: 'completed',
      verified: true,
      verificationEvidenceIds: [],
    });
    const normalized1 = normalizeExecutionResult(unverifiedClaim);
    expect(normalized1.verified).toBe(false);
    expect(validateUnifiedExecutionResult(normalized1).valid).toBe(true);

    const failedButMarkedVerified = createValidResult({
      status: 'failed',
      verified: true,
      verificationEvidenceIds: ['ev-1'],
    });
    const normalized2 = normalizeExecutionResult(failedButMarkedVerified);
    expect(normalized2.verified).toBe(false);
    expect(validateUnifiedExecutionResult(normalized2).valid).toBe(true);
  });

  it('10. enforces Invariant 3: rejects costStatus UNKNOWN when costUSD is coerced to 0 or any number', () => {
    const coercedZero = createValidResult({
      usage: {
        durationMs: 2500,
        costStatus: 'UNKNOWN',
        costUSD: 0,
      },
    });
    const validationZero = validateUnifiedExecutionResult(coercedZero);
    expect(validationZero.valid).toBe(false);
    expect(
      validationZero.errors.some((e) =>
        e.includes('usage.costUSD must be undefined when usage.costStatus is UNKNOWN'),
      ),
    ).toBe(true);

    const coercedPositive = createValidResult({
      usage: {
        durationMs: 2500,
        costStatus: 'UNKNOWN',
        costUSD: 0.15,
      },
    });
    expect(validateUnifiedExecutionResult(coercedPositive).valid).toBe(false);
  });

  it('11. enforces Invariant 3: supports ACTUAL ($0 local or >$0 remote) and ESTIMATED costs, and rejects missing costUSD for ACTUAL/ESTIMATED', () => {
    const localZero = createValidResult({
      usage: { durationMs: 1000, costStatus: 'ACTUAL', costUSD: 0 },
    });
    expect(validateUnifiedExecutionResult(localZero).valid).toBe(true);

    const remoteEstimated = createValidResult({
      usage: { durationMs: 1000, costStatus: 'ESTIMATED', costUSD: 0.085 },
    });
    expect(validateUnifiedExecutionResult(remoteEstimated).valid).toBe(true);

    const missingActualAmount = createValidResult({
      usage: { durationMs: 1000, costStatus: 'ACTUAL', costUSD: undefined },
    });
    expect(validateUnifiedExecutionResult(missingActualAmount).valid).toBe(false);
  });

  it('12. normalizeExecutionResult strips costUSD when costStatus is UNKNOWN', () => {
    const dirtyCost = createValidResult({
      usage: {
        durationMs: 1500,
        costStatus: 'UNKNOWN',
        costUSD: 0,
      },
    });
    const normalized = normalizeExecutionResult(dirtyCost);
    expect(normalized.usage.costStatus).toBe('UNKNOWN');
    expect(normalized.usage.costUSD).toBeUndefined();
    expect(validateUnifiedExecutionResult(normalized).valid).toBe(true);
  });

  it('13. rejects malformed or incomplete UnifiedExecutionResult fields', () => {
    const malformed = {
      schemaVersion: 2,
      executionId: '',
      taskId: '',
      harnessId: '',
      harnessKind: 'invalid-kind',
      modelId: '',
      runtimeId: '',
      status: 'running', // not a terminal/unified status
      workspaceRevision: '',
      artifacts: [{ path: '' }],
      toolCalls: 'not-an-array',
      usage: {
        durationMs: -100,
        inputTokens: -5,
      },
      verificationEvidenceIds: [''],
      provenance: {
        startedAt: '',
        completedAt: '2026-10-23T00:00:00Z',
        contractDigest: '',
      },
    };
    const res = validateUnifiedExecutionResult(malformed);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(12);
    expect(res.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
    expect(res.errors.some((e) => e.includes('harnessKind'))).toBe(true);
    expect(res.errors.some((e) => e.includes('usage.durationMs'))).toBe(true);
    expect(res.errors.some((e) => e.includes('artifacts[0].path'))).toBe(true);
    expect(res.errors.some((e) => e.includes('provenance.startedAt'))).toBe(true);
  });

  it('14. computes deterministic SHA-256 contract digest regardless of key ordering or transient callbacks', () => {
    const req1 = createValidRequest({
      isCancelled: () => false,
      policyContext: { b: 2, a: 1, nested: { z: true, y: false } },
    });
    const req2 = createValidRequest({
      schemaVersion: undefined, // should default to 1 identically
      isCancelled: () => true,
      policyContext: { nested: { y: false, z: true }, a: 1, b: 2 },
    });

    const digest1 = computeRequestContractDigest(req1);
    const digest2 = computeRequestContractDigest(req2);
    expect(digest1).toMatch(/^[a-f0-9]{64}$/);
    expect(digest1).toBe(digest2);

    const req3 = createValidRequest({ objective: 'Different objective' });
    expect(computeRequestContractDigest(req3)).not.toBe(digest1);
  });

  it('15. migrates legacy unversioned result payloads via migrateUnifiedExecutionResult', () => {
    const legacyPayload: Record<string, unknown> = {
      executionId: 'exec-legacy-1',
      taskId: 'task-legacy-1',
      harnessId: 'wazir-native',
      modelId: 'llama3.1:8b',
      runtimeId: 'ollama',
      status: 'completed',
      verified: false,
      workspaceRevision: 12, // numeric in legacy
      usage: {
        durationMs: 950,
        costStatus: 'ACTUAL',
        costUSD: 0,
      },
    };

    const migrated = migrateUnifiedExecutionResult(legacyPayload);
    expect(migrated.schemaVersion).toBe(HARNESS_CONTRACT_SCHEMA_VERSION);
    expect(migrated.workspaceRevision).toBe('12');
    expect(migrated.artifacts).toEqual([]);
    expect(migrated.toolCalls).toEqual([]);
    expect(migrated.verificationEvidenceIds).toEqual([]);

    const validation = validateUnifiedExecutionResult(migrated);
    expect(validation.valid).toBe(true);
  });

  it('16. converts Wazir ExecutionRecord to UnifiedExecutionResult preserving verification, provenance, and local cost semantics', () => {
    const startedAt = new Date('2026-10-23T01:00:00.000Z');
    const completedAt = new Date('2026-10-23T01:00:05.500Z');
    const mutationAt = new Date('2026-10-23T01:00:03.000Z');

    const record: ExecutionRecord = {
      execution: {
        id: 'exec-rec-1',
        taskId: 'task-rec-1',
        agentId: 'coding-agent',
        runtimeId: 'ollama-local',
        modelId: 'qwen2.5-coder:7b',
        workspaceRoot: '/Users/wael/Code/Wazir',
        status: 'completed',
        createdAt: startedAt,
        startedAt,
        completedAt,
      },
      task: {
        id: 'task-rec-1',
        type: 'coding',
        title: 'Fix parser bug',
        input: 'Fix parser bug in utils.ts',
        requirements: { mutationRequired: true },
        priority: 'normal',
        status: 'completed',
        createdAt: startedAt,
      },
      policyDecisions: [],
      toolCalls: [
        {
          id: 'tc-1',
          tool: 'write_file',
          input: { path: 'src/utils.ts' },
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default-edit',
          durationMs: 25,
          at: mutationAt,
        },
      ],
      filesChanged: ['src/utils.ts'],
      checks: [
        {
          workspaceRevision: 3,
          name: 'test',
          command: 'npm test',
          ok: true,
          output: 'PASS',
          durationMs: 1200,
        },
      ],
      errors: [],
      result: 'Parser bug fixed and verified.',
      usage: {
        input: 800,
        output: 200,
        total: 1000,
      },
      totalModelCalls: 2,
      events: [],
      workspaceState: {
        workspaceId: 'ws-1',
        revision: 3,
        updatedAt: completedAt,
      },
      evidence: [
        {
          id: 'ev-stale-2',
          revision: 2,
          workspaceRevision: 2,
          type: 'TEST',
          exitCode: 0,
          status: 'PASS',
        },
        {
          id: 'ev-current-3',
          revision: 3,
          workspaceRevision: 3,
          type: 'TEST',
          exitCode: 0,
          status: 'PASS',
        },
      ],
      mutationHistory: [
        {
          path: 'src/utils.ts',
          revision: 3,
          at: mutationAt,
        },
      ],
    };

    const unified = fromExecutionRecordToUnifiedResult(record);
    const validation = validateUnifiedExecutionResult(unified);
    expect(validation.valid).toBe(true);
    expect(unified.executionId).toBe('exec-rec-1');
    expect(unified.harnessId).toBe('coding-agent');
    expect(unified.harnessKind).toBe('native');
    expect(unified.workspaceRevision).toBe('3');
    // Only revision 3 evidence should be included, not stale revision 2 evidence
    expect(unified.verificationEvidenceIds).toEqual(['ev-current-3']);
    expect(unified.verified).toBe(true);
    expect(unified.usage.costStatus).toBe('ACTUAL');
    expect(unified.usage.costUSD).toBe(0);
    expect(unified.usage.durationMs).toBe(5500);
    expect(unified.usage.totalTokens).toBe(1000);
    expect(unified.usage.modelCalls).toBe(2);
    expect(unified.artifacts).toEqual([
      {
        path: 'src/utils.ts',
        kind: 'file',
        createdAt: mutationAt.toISOString(),
      },
    ]);
    expect(unified.provenance?.contractDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('17. marks converted ExecutionRecord as verified: false when evidence is stale or from a remote unpriced runtime with UNKNOWN cost', () => {
    const now = new Date('2026-10-23T01:10:00.000Z');
    const record: ExecutionRecord = {
      execution: {
        id: 'exec-rec-2',
        taskId: 'task-rec-2',
        runtimeId: 'anthropic-cloud',
        modelId: 'claude-3-7-sonnet',
        status: 'completed',
        createdAt: now,
        startedAt: now,
        completedAt: now,
      },
      task: {
        id: 'task-rec-2',
        type: 'coding',
        input: 'Update README',
        requirements: {},
        priority: 'normal',
        status: 'completed',
        createdAt: now,
      },
      policyDecisions: [],
      toolCalls: [],
      filesChanged: ['README.md'],
      checks: [],
      errors: [],
      events: [],
      workspaceState: {
        workspaceId: 'ws-2',
        revision: 5,
        updatedAt: now,
      },
      evidence: [
        {
          id: 'ev-old-4',
          revision: 4,
          workspaceRevision: 4,
          type: 'BUILD',
          exitCode: 0,
          status: 'PASS',
        },
      ],
    };

    const unified = fromExecutionRecordToUnifiedResult(record, {
      harnessId: 'claude-code-acp',
      harnessKind: 'acp',
    });
    expect(validateUnifiedExecutionResult(unified).valid).toBe(true);
    expect(unified.status).toBe('completed');
    expect(unified.verificationEvidenceIds).toEqual([]);
    expect(unified.verified).toBe(false);
    expect(unified.usage.costStatus).toBe('UNKNOWN');
    expect(unified.usage.costUSD).toBeUndefined();
  });
});
