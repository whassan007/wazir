import { describe, it, expect } from 'vitest';
import {
  ExecutionEngine,
  HarnessDispatchService,
} from '../src/index.js';
import { assessCompletionEvidence } from '../src/services/verificationEvidenceInspector.js';
import { NativeHarnessAdapter } from '../../agents/src/nativeHarnessAdapter.js';
import type { UnifiedExecutionRequest } from '../src/types/harness.js';
import type { ExecutionRecord } from '../src/types/index.js';
import type { AgentRuntime } from '../src/types/agent.js';

describe('Formal Hardening Group E — Verification Freshness & False-Success Elimination', () => {

  it('FORMAL-A13-VERIF-01: HarnessDispatchService does not synthesize fake passing evidence when verificationOutcome evidence is empty and no checks were run', async () => {
    const engine = new ExecutionEngine();
    const service = new HarnessDispatchService({
      executionEngine: engine,
      verifyExecution: async () => ({
        verified: true,
        evidence: [], // Empty evidence from external hook!
        reasons: ['external hook claimed pass without physical evidence'],
      }),
    });

    const request: UnifiedExecutionRequest = {
      executionId: 'exec-synth-prevented-1',
      taskId: 'task-synth-prevented-1',
      taskType: 'coding',
      taskDescription: 'implement feature',
      workspace: { root: '/tmp/workspace-synth-prevented' },
      verification: {
        requiredChecks: ['npm test', 'npm run build'],
        mutationRequired: false,
        expectedArtifacts: [],
        protectedPaths: [],
      },
      constraints: {
        budgetUSD: 1.0,
        allowFallback: false,
      },
    };

    const created = await engine.create({
      task: {
        id: request.taskId,
        type: 'coding',
        input: 'implement feature',
        requirements: {},
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        acceptanceContract: { requiredEvidence: ['TEST', 'BUILD'] },
      },
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });

    await (service as any).recordOutcomeToExecutionEngine(
      created.execution.id,
      request,
      {
        schemaVersion: 1,
        executionId: created.execution.id,
        taskId: request.taskId,
        harnessId: 'test-harness',
        harnessKind: 'native',
        status: 'completed',
        verified: true,
        filesChanged: ['src/index.ts'],
        verificationEvidenceIds: [],
        checks: [], // No actual checks run!
      },
      {
        verified: true,
        evidence: [],
        reasons: ['external hook claimed pass without physical evidence'],
      },
    );

    const record = engine.require(created.execution.id);
    // Verified: No fake passing evidence records were manufactured!
    const testEv = (record.evidence ?? []).find((e) => e.command === 'npm test');
    const buildEv = (record.evidence ?? []).find((e) => e.command === 'npm run build');
    expect(testEv).toBeUndefined();
    expect(buildEv).toBeUndefined();
    expect(record.evidence ?? []).toHaveLength(0);

    // Verified: Execution status was NOT marked completed because required evidence is missing!
    expect(record.execution.status).not.toBe('completed');
  });

  it('FORMAL-A13-VERIF-03: NativeHarnessAdapter fails when requiredChecks is non-empty and checks were not executed or failed', async () => {
    // 1. Unexecuted required check fails
    const adapter = new NativeHarnessAdapter({
      agent: {
        descriptor: {
          id: 'test-agent',
          name: 'test-agent',
          kind: 'native',
          version: '1.0',
          capabilities: [],
          permissions: [],
          taskTypes: ['coding'],
        },
        async *run() {
          yield { kind: 'done', content: 'Finished without executing required checks', terminationReason: 'COMPLETED' };
        },
      },
    });

    const request: UnifiedExecutionRequest = {
      executionId: 'exec-missing-req-checks',
      taskId: 'task-missing-req-checks',
      taskType: 'coding',
      taskDescription: 'task requiring tests',
      workspace: { root: '/tmp/test' },
      verification: {
        requiredChecks: ['test'], // 'test' check was REQUIRED!
        mutationRequired: false,
        expectedArtifacts: [],
        protectedPaths: [],
      },
      constraints: {
        budgetUSD: 1.0,
      },
    };

    const mockRuntime: AgentRuntime = {
      generate: async function* () {
        yield { type: 'completed', content: 'ok' };
      },
      tools: [],
      executeTool: async () => ({ ok: true, output: '', durationMs: 0 }),
      cancelCurrentTurn: () => {},
    };

    const result = await adapter.execute(request, mockRuntime);

    // Verified: Unexecuted required check caused failure!
    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('VERIFICATION_FAILED');
    expect(result.errorKind).toBe('verification');
    expect(result.errors?.some((e) => e.includes("Required check 'test' failed"))).toBe(true);

    // 2. Executed passing check succeeds
    const passingAdapter = new NativeHarnessAdapter({
      agent: {
        descriptor: {
          id: 'test-agent-pass',
          name: 'test-agent-pass',
          kind: 'native',
          version: '1.0',
          capabilities: [],
          permissions: [],
          taskTypes: ['coding'],
        },
        async *run(_, runtime) {
          await runtime.executeTool('test', {});
          yield { kind: 'done', content: 'Finished with tests passed', terminationReason: 'COMPLETED' };
        },
      },
    });

    const passRuntime: AgentRuntime = {
      generate: async function* () {
        yield { type: 'completed', content: 'ok' };
      },
      tools: [{ name: 'test', description: 'Run tests', inputSchema: {} }],
      executeTool: async (name) => {
        if (name === 'test') {
          return { ok: true, output: '12 tests passed', durationMs: 15 };
        }
        return { ok: true, output: '', durationMs: 0 };
      },
      cancelCurrentTurn: () => {},
    };

    const passResult = await passingAdapter.execute(request, passRuntime);
    expect(passResult.status).toBe('completed');
    expect(passResult.errors ?? []).toHaveLength(0);
  });

  it('FORMAL-A13-VERIF-04: assessCompletionEvidence and ExecutionEngine reject completion when mutationRequired is true but filesChanged is 0', async () => {
    const record: ExecutionRecord = {
      execution: {
        id: 'exec-no-mut-hardened',
        taskId: 'task-no-mut-hardened',
        agentId: 'agent',
        status: 'running',
        priority: 'normal',
        createdAt: new Date(),
      },
      task: {
        id: 'task-no-mut-hardened',
        type: 'coding',
        input: 'must modify code',
        requirements: {
          mutationRequired: true, // Requires physical mutation!
        },
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
        acceptanceContract: { requiredEvidence: [] },
      },
      filesChanged: [], // 0 files changed!
      mutationHistory: [],
      checks: [],
      policyDecisions: [],
      toolCalls: [],
      errors: [],
      events: [],
      workspaceState: {
        workspaceId: 'ws-1',
        revision: 0,
        updatedAt: new Date(),
      },
    };

    const assessment = assessCompletionEvidence(record);
    // Verified: Assessment rejects completion eligibility!
    expect(assessment.eligible).toBe(false);
    expect(assessment.mutationRequiredMissing).toBe(true);
    expect(assessment.reason).toContain('mutationRequired was not satisfied');

    // Verified: ExecutionEngine.setStatus rejects completion when mutationRequired is violated!
    const engine = new ExecutionEngine();
    const created = await engine.create({
      task: {
        id: 'task-engine-no-mut',
        type: 'coding',
        input: 'must modify code',
        requirements: {
          mutationRequired: true,
        },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        acceptanceContract: { requiredEvidence: [] },
      },
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const id = created.execution.id;
    await engine.setStatus(id, 'running');

    // Attempting to complete with 0 files changed must throw ARTIFACT_CONTRACT_FAILED
    await expect(engine.setStatus(id, 'completed')).rejects.toThrow(/mutationRequired was not satisfied/);
    expect(engine.require(id).execution.status).not.toBe('completed');
  });

  it('FORMAL-A13-VERIF-05: ExecutionEngine.recordEvidence binds workspaceRevision to current revision when caller attempts to supply a greater revision', async () => {
    const engine = new ExecutionEngine();
    const created = await engine.create({
      task: {
        id: 'task-spoof-prevention',
        type: 'coding',
        input: 'fix bug',
        requirements: {},
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        acceptanceContract: { requiredEvidence: ['TEST'] },
      },
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const id = created.execution.id;
    await engine.setStatus(id, 'running');

    // Engine is at Revision 0
    expect(engine.getWorkspaceRevision(id)).toBe(0);

    // Mutation advances engine to Revision 1
    await engine.recordFilesChanged(id, ['src/app.ts']);
    expect(engine.getWorkspaceRevision(id)).toBe(1);

    // Caller attempts to spoof revision as 5 (> current revision 1)
    const evidence = await engine.recordEvidence(id, {
      type: 'TEST',
      command: 'npm test',
      exitCode: 0,
      status: 'PASS',
      workspaceRevision: 5, // Attempted spoof!
    });

    // Verified: Engine bound workspaceRevision to current physical revision (1), NOT 5!
    expect(evidence.workspaceRevision).toBe(1);
    expect(evidence.revision).toBe(1);

    const record = engine.require(id);
    const recorded = record.evidence?.find((e) => e.command === 'npm test');
    expect(recorded?.workspaceRevision).toBe(1);

    // Further mutation advances engine to Revision 2
    await engine.recordFilesChanged(id, ['src/app.ts']);
    expect(engine.getWorkspaceRevision(id)).toBe(2);

    // Because evidence was properly bound to Revision 1, it is now STALE at Revision 2.
    // Attempting to set status to completed targeting Revision 2 must fail!
    await expect(engine.setStatus(id, 'completed', { targetRevision: 2 })).rejects.toThrow();
    expect(engine.require(id).execution.status).not.toBe('completed');
  });
});
