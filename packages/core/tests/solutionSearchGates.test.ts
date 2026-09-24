import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  SolutionSearchService,
  CheckpointService,
  WorktreeManager,
  ExecutionEngine,
  VerificationEngine,
  type SolutionSearchRequest,
  type ExecutionRecord,
} from '../src/index.js';

describe('Acceptance Gates: G26, G27, G28 — Solution Search & Promotion Safety', () => {
  let tempDir: string;
  let worktreeManager: WorktreeManager;
  let executionEngine: ExecutionEngine;
  let checkpointService: CheckpointService;
  let verificationEngine: VerificationEngine;
  let searchService: SolutionSearchService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acceptance-g26-28-'));
    // Setup defect fixture: scheduler queue race condition fixture
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'src/queue.ts'),
      `export class TaskQueue {
  private items: string[] = [];
  push(item: string) { this.items.push(item); }
  pop(): string | undefined {
    // BUG: does not check bounds before popping
    return this.items.shift();
  }
  size(): number { return this.items.length; }
}
`,
    );

    worktreeManager = new WorktreeManager({
      worktreeRootDir: path.join(tempDir, '.wazir', 'worktrees'),
    });

    executionEngine = new ExecutionEngine({ workspace: tempDir });
    await executionEngine.ready;

    checkpointService = new CheckpointService({
      executionEngine,
      worktreeManager,
      defaultWorkspaceRoot: tempDir,
    });

    verificationEngine = new VerificationEngine({ projectRoot: tempDir });

    searchService = new SolutionSearchService({
      checkpointService,
      worktreeManager,
      executionEngine,
      verificationEngine,
      defaultProjectRoot: tempDir,
      evaluationService: {
        evaluate: (record: ExecutionRecord) => {
          const checks = record.checks ?? [];
          const evidence = record.evidence ?? [];
          const currentRev = record.workspaceState?.revision ?? 0;
          const passingChecks = checks.filter((c) => c.ok && (c.workspaceRevision ?? 0) === currentRev);
          const hasEvidence = evidence.some((e) => (e.revision ?? e.workspaceRevision) === currentRev && e.exitCode === 0);
          const physicalVerificationSuccess = (checks.length > 0 && passingChecks.length === checks.length) || hasEvidence;
          const passed = physicalVerificationSuccess && (record.errors?.length ?? 0) === 0;

          return {
            executionId: record.execution.id,
            taskId: record.task.id,
            passed,
            rejectionReason: passed ? undefined : (record.errors?.[0] ?? 'Checks failed'),
            metrics: {
              taskSuccess: passed,
              physicalVerificationSuccess,
              totalModelCalls: 1,
              totalToolCalls: record.toolCalls?.length ?? 0,
              repairCycles: record.checks?.filter((c) => !c.ok).length ?? 0,
              inputTokens: record.usage?.input ?? 600,
              outputTokens: record.usage?.output ?? 150,
              compactedTokens: 0,
              totalWallTimeMs: 400,
              modelLatencyMs: 250,
              toolLatencyMs: 100,
              costEstimateUsd: 0.0025,
              verificationLatencyMs: 50,
            },
            evaluationResult: {
              success: passed,
              reasons: passed ? ['passed'] : ['failed checks'],
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

  async function createBaseExecution(prompt: string): Promise<ExecutionRecord> {
    return executionEngine.create({
      task: {
        id: `task-${Date.now()}`,
        type: 'coding',
        input: prompt,
        requirements: {},
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt-local',
      modelId: 'default-model',
      workspaceRoot: tempDir,
    });
  }

  // =========================================================================
  // G26: ACCEPTANCE GATE — SOLUTION SEARCH
  // =========================================================================
  it('G26: Solution Search — 3 isolated candidates, verified results, selection policy, safe promotion', async () => {
    const base = await createBaseExecution('Fix boundary check and concurrency in TaskQueue');

    const request: SolutionSearchRequest = {
      executionId: base.execution.id,
      objective: 'Fix boundary check and concurrency in TaskQueue',
      candidates: 3,
      strategy: 'same_model_diverse',
      maxParallelCandidates: 3,
      autoPromote: true,
      selectionPolicy: {
        requireCorrectness: true,
        requireProtectedVerification: true,
        requireTaskAcceptance: true,
        secondaryCriteria: [
          'fewer_repair_cycles',
          'smaller_change_surface',
          'lower_token_consumption',
        ],
      },
    };

    const searchResult = await searchService.search(request, async (ctx) => {
      const isA = ctx.descriptor.name.includes('Candidate A');
      const isB = ctx.descriptor.name.includes('Candidate B');
      const isC = ctx.descriptor.name.includes('Candidate C');

      if (isA) {
        // Candidate A: Implements valid minimal boundary check
        await fs.writeFile(
          path.join(ctx.worktreePath, 'src/queue.ts'),
          `export class TaskQueue {
  private items: string[] = [];
  push(item: string) { this.items.push(item); }
  pop(): string | undefined {
    if (this.items.length === 0) return undefined;
    return this.items.shift();
  }
  size(): number { return this.items.length; }
}
`,
        );

        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'qwen-coder', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [{ id: 'tc-1', tool: 'write', input: {}, ok: true, durationMs: 20, policyEffect: 'allow', policyRule: 'r', at: new Date() }],
          filesChanged: ['src/queue.ts'],
          usage: { input: 800, output: 200 },
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'npm test', ok: true, durationMs: 50 }],
          evidence: [{ id: 'ev-a', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 50, status: 'PASS', evidenceHash: 'h-a' }],
          errors: [],
          events: [],
        };
      } else if (isB) {
        // Candidate B: Mutates multiple files (adds mutex/lock file)
        await fs.writeFile(
          path.join(ctx.worktreePath, 'src/queue.ts'),
          `export class TaskQueue {
  private items: string[] = [];
  private locked = false;
  push(item: string) { this.items.push(item); }
  pop(): string | undefined {
    if (this.locked || this.items.length === 0) return undefined;
    return this.items.shift();
  }
  size(): number { return this.items.length; }
}
`,
        );
        await fs.writeFile(path.join(ctx.worktreePath, 'src/lock.ts'), 'export const lock = {};\n');

        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'gemma-27b', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [{ id: 'tc-2', tool: 'write', input: {}, ok: true, durationMs: 20, policyEffect: 'allow', policyRule: 'r', at: new Date() }],
          filesChanged: ['src/queue.ts', 'src/lock.ts'],
          usage: { input: 1200, output: 300 },
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'npm test', ok: true, durationMs: 80 }],
          evidence: [{ id: 'ev-b', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 80, status: 'PASS', evidenceHash: 'h-b' }],
          errors: [],
          events: [],
        };
      } else {
        // Candidate C: Model claims success without physical verification
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'gpt-oss', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [], // NO CHECKS
          evidence: [],
          errors: ['No physical checks executed'],
          events: [],
        };
      }
    });

    // 1. Assertions on G26 properties
    expect(searchResult.totalCandidates).toBe(3);
    expect(searchResult.qualifyingCandidates).toHaveLength(2); // Candidate A and B qualified
    expect(searchResult.disqualifiedCandidates).toHaveLength(1); // Candidate C disqualified
    expect(searchResult.selectedCandidate).toBeDefined();

    // 2. Selection policy applied: Candidate A selected over B due to smaller change surface (1 file vs 2)
    expect(searchResult.selectedCandidate?.descriptor.name).toContain('Candidate A');
    expect(searchResult.selectionReason).toContain('files=1');

    // 3. Promotion succeeded and parent re-verified
    expect(searchResult.promotionResult).toBeDefined();
    expect(searchResult.promotionResult?.success).toBe(true);
    expect(searchResult.promotionResult?.reverificationPassed).toBe(true);

    // 4. Authoritative parent workspace physically contains selected solution
    const finalQueueContent = await fs.readFile(path.join(tempDir, 'src/queue.ts'), 'utf8');
    expect(finalQueueContent).toContain('if (this.items.length === 0) return undefined;');

    // 5. Candidate B changes (src/lock.ts) must NOT leak into parent workspace
    const lockExists = await fs.access(path.join(tempDir, 'src/lock.ts')).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);

    // 6. Provenance links
    expect(searchResult.promotionResult?.provenance.checkpointId).toBe(searchResult.checkpointId);
    expect(searchResult.promotionResult?.provenance.parentExecutionId).toBe(base.execution.id);
  });

  // =========================================================================
  // G27: ACCEPTANCE GATE — FAILURE SEARCH & NO QUALIFYING CANDIDATE
  // =========================================================================
  it('G27: Failure Search — Candidate A fails compile, B fails tests, C succeeds -> C selected', async () => {
    const base = await createBaseExecution('Implement safe division');

    const searchResult = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Implement safe division',
        candidates: 3,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        const isA = ctx.descriptor.name.includes('Candidate A');
        const isB = ctx.descriptor.name.includes('Candidate B');

        if (isA) {
          // Candidate A fails compilation
          return {
            execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'failed', createdAt: new Date() },
            task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'failed', createdAt: new Date() },
            policyDecisions: [],
            toolCalls: [],
            filesChanged: ['src/math.ts'],
            workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
            checks: [{ workspaceRevision: 1, name: 'build', command: 'tsc', ok: false, durationMs: 20 }],
            evidence: [],
            errors: ['Syntax error: unexpected token'],
            events: [],
          };
        } else if (isB) {
          // Candidate B passes compile but fails unit tests
          return {
            execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'failed', createdAt: new Date() },
            task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'failed', createdAt: new Date() },
            policyDecisions: [],
            toolCalls: [],
            filesChanged: ['src/math.ts'],
            workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
            checks: [
              { workspaceRevision: 1, name: 'build', command: 'tsc', ok: true, durationMs: 20 },
              { workspaceRevision: 1, name: 'test', command: 'vitest', ok: false, durationMs: 50 },
            ],
            evidence: [{ id: 'ev-b', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 1, durationMs: 50, status: 'FAIL', evidenceHash: 'h' }],
            errors: ['AssertionError: expected null to be 0'],
            events: [],
          };
        } else {
          // Candidate C succeeds
          return {
            execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
            task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
            policyDecisions: [],
            toolCalls: [],
            filesChanged: ['src/math.ts'],
            workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
            checks: [
              { workspaceRevision: 1, name: 'build', command: 'tsc', ok: true, durationMs: 20 },
              { workspaceRevision: 1, name: 'test', command: 'vitest', ok: true, durationMs: 50 },
            ],
            evidence: [{ id: 'ev-c', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 50, status: 'PASS', evidenceHash: 'h' }],
            errors: [],
            events: [],
          };
        }
      },
    );

    // Only Candidate C qualifies
    expect(searchResult.qualifyingCandidates).toHaveLength(1);
    expect(searchResult.disqualifiedCandidates).toHaveLength(2);
    expect(searchResult.selectedCandidate?.descriptor.name).toContain('Candidate C');
  });

  it('G27: Failure Search — all candidates fail -> SEARCH_COMPLETED_NO_QUALIFYING_CANDIDATE', async () => {
    const base = await createBaseExecution('Impossible task');

    const searchResult = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Impossible task',
        candidates: 2,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'failed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'failed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: false, durationMs: 10 }],
          evidence: [],
          errors: ['Failed verification oracle'],
          events: [],
        };
      },
    );

    expect(searchResult.status).toBe('completed_no_qualifying');
    expect(searchResult.qualifyingCandidates).toHaveLength(0);
    expect(searchResult.selectedCandidate).toBeUndefined();
    expect(searchResult.selectionReason).toContain('SEARCH_COMPLETED_NO_QUALIFYING_CANDIDATE');
  });

  // =========================================================================
  // G28: ACCEPTANCE GATE — PROMOTION SAFETY & RECONCILIATION
  // =========================================================================
  it('G28: Promotion Safety — parent workspace changes independently after C0 -> PROMOTION_CONFLICT', async () => {
    const base = await createBaseExecution('Test conflict prevention');

    const searchResult = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Test conflict prevention',
        candidates: 1,
        strategy: 'same_model_diverse',
        autoPromote: false,
      },
      async (ctx) => {
        await fs.writeFile(path.join(ctx.worktreePath, 'src/math.ts'), 'export function add() { return 100; }\n');
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['src/math.ts'],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    const winner = searchResult.selectedCandidate!;
    const checkpoint = checkpointService.getCheckpoint(searchResult.checkpointId)!;

    // Mutate parent independently after C0
    await fs.writeFile(path.join(tempDir, 'src/math.ts'), 'export function add() { return 999; }\n');
    const parentRec = (await executionEngine.get(base.execution.id))!;
    parentRec.workspaceState!.revision = checkpoint.workspaceRevision + 1;

    // Attempt promotion
    const promoResult = await searchService.promoteCandidate({
      searchId: searchResult.searchId,
      candidate: winner,
      parentExecutionId: base.execution.id,
      checkpoint,
      projectRoot: tempDir,
    });

    // Must detect conflict and refuse promotion
    expect(promoResult.success).toBe(false);
    expect(promoResult.conflict?.reason).toContain('PROMOTION_CONFLICT');
    expect(promoResult.conflict?.parentChangedSinceCheckpoint).toBe(true);

    // Assert parent file was NEVER overwritten
    const content = await fs.readFile(path.join(tempDir, 'src/math.ts'), 'utf8');
    expect(content).toContain('return 999;');
  });
});
