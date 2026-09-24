import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  BranchSearchService,
  WorktreeManager,
  type SolutionStrategy,
  type ExecutionRecord,
} from '../src/index.js';

describe('Gate 10: Best-of-N / Branch Search', () => {
  let tempDir: string;
  let worktreeManager: WorktreeManager;
  let branchSearchService: BranchSearchService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-branch-test-'));
    worktreeManager = new WorktreeManager({ worktreeRootDir: path.join(tempDir, '.wazir', 'worktrees') });
    branchSearchService = new BranchSearchService({
      worktreeManager,
      evaluationService: {
        evaluate: (record: ExecutionRecord) => {
          const checks = record.checks ?? [];
          const evidence = record.evidence ?? [];
          const currentRev = record.workspaceState?.revision ?? 0;
          const passingChecks = checks.filter((c) => c.ok && (c.workspaceRevision ?? 0) === currentRev);
          const hasEvidence = evidence.some((e) => e.revision === currentRev && e.exitCode === 0);
          const physicalVerificationSuccess = (checks.length > 0 && passingChecks.length === checks.length) || hasEvidence;
          const passed = physicalVerificationSuccess && (record.errors?.length ?? 0) === 0;

          return {
            executionId: record.execution.id,
            taskId: record.task.id,
            passed,
            metrics: {
              taskSuccess: passed,
              physicalVerificationSuccess,
              totalModelCalls: 1,
              totalToolCalls: record.toolCalls?.length ?? 0,
              repairCycles: (record.checks?.filter((c) => !c.ok).length ?? 0),
              inputTokens: 1000,
              outputTokens: 200,
              compactedTokens: 0,
              totalWallTimeMs: 1500,
              modelLatencyMs: 800,
              toolLatencyMs: 300,
              costEstimateUsd: 0.005,
              verificationLatencyMs: 200,
            },
            evaluationResult: {
              success: passed,
              reasons: passed ? ['passed'] : ['failed verification'],
              filesChanged: record.filesChanged,
              checks: record.checks,
              evaluatedAt: new Date(),
            },
            summary: passed ? 'PASSED' : 'FAILED',
          };
        },
      },
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('selects winner based on physical verification evidence, not model confidence', async () => {
    const strategies: SolutionStrategy[] = [
      {
        id: 'strategy-a',
        name: 'High Confidence But No Verification',
      },
      {
        id: 'strategy-b',
        name: 'Verified Physical Fix',
      },
      {
        id: 'strategy-c',
        name: 'Failing Build Fix',
      },
    ];

    const result = await branchSearchService.search({
      taskId: 'task-best-of-n',
      projectRoot: tempDir,
      strategies,
      runner: async (strategy, { worktreePath }) => {
        if (strategy.id === 'strategy-a') {
          // Model claims 100% confidence, but no physical verification ran!
          return {
            execution: {
              id: 'exec-a',
              taskId: 'task-best-of-n',
              runtimeId: 'rt',
              modelId: 'model',
              status: 'completed',
              createdAt: new Date(),
            },
            task: {
              id: 'task-best-of-n',
              type: 'coding',
              input: 'task',
              requirements: {},
              priority: 'normal',
              status: 'completed',
              createdAt: new Date(),
            },
            policyDecisions: [],
            toolCalls: [{ id: 'tc', tool: 'write', input: {}, ok: true, durationMs: 50, policyEffect: 'allow', policyRule: 'r', at: new Date() }],
            filesChanged: ['src/app.ts'],
            workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
            checks: [], // NO CHECKS
            evidence: [],
            result: 'I am 100% confident this solution is flawless and needs no test.',
            errors: [],
            events: [],
          };
        } else if (strategy.id === 'strategy-b') {
          // Ran physical check and passed at current revision
          return {
            execution: {
              id: 'exec-b',
              taskId: 'task-best-of-n',
              runtimeId: 'rt',
              modelId: 'model',
              status: 'completed',
              createdAt: new Date(),
            },
            task: {
              id: 'task-best-of-n',
              type: 'coding',
              input: 'task',
              requirements: {},
              priority: 'normal',
              status: 'completed',
              createdAt: new Date(),
            },
            policyDecisions: [],
            toolCalls: [{ id: 'tc', tool: 'write', input: {}, ok: true, durationMs: 50, policyEffect: 'allow', policyRule: 'r', at: new Date() }],
            filesChanged: ['src/app.ts'],
            workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
            checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, output: 'ok', durationMs: 150 }],
            evidence: [{ id: 'ev', type: 'TEST', revision: 1, exitCode: 0, durationMs: 150 }],
            result: 'Tested and verified',
            errors: [],
            events: [],
          };
        } else {
          // Failed check
          return {
            execution: {
              id: 'exec-c',
              taskId: 'task-best-of-n',
              runtimeId: 'rt',
              modelId: 'model',
              status: 'failed',
              createdAt: new Date(),
            },
            task: {
              id: 'task-best-of-n',
              type: 'coding',
              input: 'task',
              requirements: {},
              priority: 'normal',
              status: 'failed',
              createdAt: new Date(),
            },
            policyDecisions: [],
            toolCalls: [],
            filesChanged: ['src/app.ts'],
            workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
            checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: false, output: 'error', durationMs: 150 }],
            evidence: [{ id: 'ev', type: 'TEST', revision: 1, exitCode: 1, durationMs: 150 }],
            errors: ['test failed'],
            events: [],
          };
        }
      },
    });

    expect(result.totalBranches).toBe(3);
    expect(result.winningBranch).toBeDefined();
    // Strategy B must be selected despite Strategy A's model claims!
    expect(result.winningBranch?.strategy.id).toBe('strategy-b');
    expect(result.winningBranch?.scoreReport.passed).toBe(true);
    expect(result.winningBranch?.scoreReport.metrics.physicalVerificationSuccess).toBe(true);
    expect(result.selectionReason).toContain('verified evidence');

    // Discarded branches tracked
    expect(result.discardedBranchIds.length).toBe(2);
  });
});
