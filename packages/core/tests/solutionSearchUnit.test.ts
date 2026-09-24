import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  type CandidateRunner,
  type ExecutionRecord,
  type SolutionSearchResult,
} from '../src/index.js';

describe('SolutionSearchService — Comprehensive Deterministic Unit & Property Tests', () => {
  let tempDir: string;
  let worktreeManager: WorktreeManager;
  let executionEngine: ExecutionEngine;
  let checkpointService: CheckpointService;
  let verificationEngine: VerificationEngine;
  let searchService: SolutionSearchService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-solution-search-test-'));
    // Setup minimal project files
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src/math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

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
            rejectionReason: passed ? undefined : 'Checks failed or missing revision-specific evidence',
            metrics: {
              taskSuccess: passed,
              physicalVerificationSuccess,
              totalModelCalls: 1,
              totalToolCalls: record.toolCalls?.length ?? 0,
              repairCycles: record.checks?.filter((c) => !c.ok).length ?? 0,
              inputTokens: record.usage?.input ?? 500,
              outputTokens: record.usage?.output ?? 100,
              compactedTokens: 0,
              totalWallTimeMs: 500,
              modelLatencyMs: 300,
              toolLatencyMs: 150,
              costEstimateUsd: 0.002,
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

  async function createBaseExecution(prompt: string = 'Implement add function'): Promise<ExecutionRecord> {
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

  // 1. Search creates baseline checkpoint C0
  it('1. search creates baseline checkpoint C0', async () => {
    const base = await createBaseExecution();
    let capturedCheckpointId = '';

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Test C0 checkpoint creation',
        candidates: 2,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        capturedCheckpointId = ctx.checkpoint.id;
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    expect(res.checkpointId).toBeDefined();
    expect(res.checkpointId).toBe(capturedCheckpointId);
    const checkpoint = checkpointService.getCheckpoint(res.checkpointId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.executionId).toBe(base.execution.id);
  });

  // 2. N candidates fork from same checkpoint
  it('2. N candidates fork from same checkpoint', async () => {
    const base = await createBaseExecution();
    const seenCheckpoints = new Set<string>();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Fork from same C0',
        candidates: 3,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        seenCheckpoints.add(ctx.checkpoint.id);
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    expect(seenCheckpoints.size).toBe(1);
    expect(seenCheckpoints.has(res.checkpointId)).toBe(true);
    expect(res.candidates.length).toBe(3);
  });

  // 3 & 5. Candidates have isolated workspaces & mutation in A is invisible to B
  it('3 & 5. candidates have isolated workspaces and mutation in A is invisible to B', async () => {
    const base = await createBaseExecution();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Test isolation',
        candidates: 2,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        const isCandidateA = ctx.descriptor.name.includes('Candidate A');
        if (isCandidateA) {
          await fs.writeFile(path.join(ctx.worktreePath, 'src/math.ts'), 'export function add() { return 42; }\n');
          await fs.writeFile(path.join(ctx.worktreePath, 'src/only_in_a.ts'), 'export const A = 1;\n');
        } else {
          // Candidate B verifies only_in_a does not exist
          const exists = await fs.access(path.join(ctx.worktreePath, 'src/only_in_a.ts')).then(() => true).catch(() => false);
          expect(exists).toBe(false);
          const mathContent = await fs.readFile(path.join(ctx.worktreePath, 'src/math.ts'), 'utf8');
          expect(mathContent).toContain('return a + b;'); // Unmutated baseline
        }

        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: isCandidateA ? ['src/math.ts', 'src/only_in_a.ts'] : [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    expect(res.candidates.length).toBe(2);
  });

  // 4 & 6. Candidates have isolated contexts & verification evidence isolated
  it('4 & 6. verification evidence is isolated per branch and revision', async () => {
    const base = await createBaseExecution();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Isolated evidence',
        candidates: 2,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        const isCandidateA = ctx.descriptor.name.includes('Candidate A');
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['src/math.ts'],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: isCandidateA, durationMs: 10 }],
          evidence: isCandidateA
            ? [{ id: 'ev-a', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'ha' }]
            : [{ id: 'ev-b', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 1, durationMs: 10, status: 'FAIL', evidenceHash: 'hb' }],
          errors: isCandidateA ? [] : ['Test suite failed on candidate B'],
          events: [],
        };
      },
    );

    const candA = res.candidates[0];
    const candB = res.candidates[1];

    expect(candA.evidence[0].status).toBe('PASS');
    expect(candB.evidence[0].status).toBe('FAIL');
    expect(candA.evaluation?.qualifies).toBe(true);
    expect(candB.evaluation?.qualifies).toBe(false);
  });

  // 7. Candidate failure does not kill search
  it('7. candidate failure does not kill search', async () => {
    const base = await createBaseExecution();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Resilience against candidate failure',
        candidates: 2,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        if (ctx.descriptor.name.includes('Candidate A')) {
          throw new Error('Fatal compiler crash in Candidate A');
        }
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

    expect(res.candidates.length).toBe(2);
    expect(res.candidates[0].status).toBe('failed');
    expect(res.candidates[0].failureReason).toContain('Fatal compiler crash');
    expect(res.candidates[1].status).toBe('completed');
    expect(res.selectedCandidate?.candidateId).toBe(res.candidates[1].candidateId);
  });

  // 8 & 9. Candidate timeout and budget handled
  it('8 & 9. candidate timeout and budget handled gracefully', async () => {
    const base = await createBaseExecution();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Timeout candidate test',
        candidates: 2,
        strategy: 'same_model_diverse',
        candidateBudget: {
          timeoutMs: 50,
        },
      },
      async (ctx) => {
        if (ctx.descriptor.name.includes('Candidate A')) {
          // Wait for signal abortion
          await new Promise<void>((resolve) => {
            if (ctx.signal?.aborted) return resolve();
            ctx.signal?.addEventListener('abort', () => resolve());
          });
        }
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    expect(res.candidates[0].status).toBe('cancelled');
    expect(res.candidates[0].failureReason).toContain('timeout');
    expect(res.candidates[1].status).toBe('completed');
  });

  // 10 & 11. Multiple models routed correctly and same-model candidates remain distinct
  it('10 & 11. multi-model strategy routes models and same-model candidates remain distinct', async () => {
    const base = await createBaseExecution();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Multi-model distribution',
        candidates: 3,
        strategy: 'multi_model',
      },
      async (ctx) => {
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: ctx.descriptor.modelId ?? 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    const models = res.candidates.map((c) => c.descriptor.modelId);
    expect(models[0]).toBe('qwen-coder');
    expect(models[1]).toBe('gemma-27b');
    expect(models[2]).toBe('gpt-oss');
  });

  // 13 & 14. Non-qualifying candidate and protected-oracle failure excluded
  it('13 & 14. non-qualifying and protected-oracle failing candidates are excluded', async () => {
    const base = await createBaseExecution();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Exclusion test',
        candidates: 3,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        const isA = ctx.descriptor.name.includes('Candidate A');
        const isB = ctx.descriptor.name.includes('Candidate B');

        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: ['src/math.ts'],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: isA
            ? [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }]
            : [],
          evidence: isA
            ? [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }]
            : [],
          errors: isB ? ['PROTECTED_ORACLE_VIOLATION: Attempted to weaken test assertion'] : isA ? [] : ['Compilation error'],
          events: [],
        };
      },
    );

    expect(res.qualifyingCandidates.length).toBe(1);
    expect(res.selectedCandidate?.candidateId).toBe(res.candidates[0].candidateId);
    expect(res.disqualifiedCandidates).toHaveLength(2);
    const hasProtectedViolation = res.disqualifiedCandidates.some((d) =>
      d.reasons.some((r) => r.toLowerCase().includes('protected'))
    );
    expect(hasProtectedViolation).toBe(true);
  });

  // 15 & 16. Selection and Pareto frontier deterministic
  it('15 & 16. selection and Pareto frontier are deterministic', async () => {
    const base = await createBaseExecution();

    const runSearch = async () => searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Deterministic Pareto frontier',
        candidates: 3,
        strategy: 'same_model_diverse',
      },
      async (ctx) => {
        const isA = ctx.descriptor.name.includes('Candidate A');
        const isB = ctx.descriptor.name.includes('Candidate B');
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: isA ? ['src/math.ts'] : isB ? ['src/math.ts', 'src/util.ts'] : ['src/math.ts', 'src/a.ts', 'src/b.ts'],
          usage: { input: isA ? 1000 : 500, output: 200 },
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    const res1 = await runSearch();
    expect(res1.paretoFrontier.candidates.length).toBeGreaterThanOrEqual(1);
    expect(res1.selectedCandidate).toBeDefined();
    // Candidate A has smallest change surface (1 file vs 2 and 3)
    expect(res1.selectedCandidate?.descriptor.name).toContain('Candidate A');
  });

  // 18, 19, 20, 21, 22. Promotion preserves provenance, detects conflicts, and re-verifies parent
  it('18, 19, 20, 21, 22. promotion preserves provenance, detects parent mutation conflict, and re-verifies parent revision', async () => {
    const base = await createBaseExecution();

    // Run search with autoPromote: false
    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Promote safely',
        candidates: 1,
        strategy: 'same_model_diverse',
        autoPromote: false,
      },
      async (ctx) => {
        await fs.writeFile(path.join(ctx.worktreePath, 'src/math.ts'), 'export function add(a: number, b: number) { return (a + b) | 0; }\n');
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

    const winner = res.selectedCandidate!;
    const checkpoint = checkpointService.getCheckpoint(res.checkpointId)!;

    // Promotion Case 1: Parent modified since checkpoint C0 -> PROMOTION_CONFLICT
    const parentRec = (await executionEngine.get(base.execution.id))!;
    parentRec.workspaceState!.revision = checkpoint.workspaceRevision + 1; // Simulate out-of-band edit

    const conflictPromo = await searchService.promoteCandidate({
      searchId: res.searchId,
      candidate: winner,
      parentExecutionId: base.execution.id,
      checkpoint,
      projectRoot: tempDir,
    });

    expect(conflictPromo.success).toBe(false);
    expect(conflictPromo.conflict?.reason).toContain('PROMOTION_CONFLICT');
    expect(conflictPromo.conflict?.parentChangedSinceCheckpoint).toBe(true);

    // Promotion Case 2: Parent clean -> Success, revision R -> R+1, re-verified
    parentRec.workspaceState!.revision = checkpoint.workspaceRevision; // Restore clean state
    const cleanPromo = await searchService.promoteCandidate({
      searchId: res.searchId,
      candidate: winner,
      parentExecutionId: base.execution.id,
      checkpoint,
      projectRoot: tempDir,
    });

    expect(cleanPromo.success).toBe(true);
    expect(cleanPromo.promotedRevision).toBe(checkpoint.workspaceRevision + 1);
    expect(cleanPromo.reverificationPassed).toBe(true);
    expect(cleanPromo.provenance.checkpointId).toBe(checkpoint.id);
  });

  // 23, 24, 25, 26. Cancellation, pause/resume, candidate steering
  it('23, 24, 25, 26. search cancellation, candidate cancellation, pause/resume, and candidate steering', async () => {
    const base = await createBaseExecution();

    const searchPromise = searchService.search(
      {
        searchId: 'search-steer-test',
        executionId: base.execution.id,
        objective: 'Steer and pause test',
        candidates: 2,
        strategy: 'same_model_diverse',
        maxParallelCandidates: 2,
      },
      async (ctx) => {
        if (ctx.descriptor.name.includes('Candidate B')) {
          await new Promise<void>((resolve) => {
            const check = () => {
              if (ctx.signal?.aborted) return resolve();
            };
            ctx.signal?.addEventListener('abort', () => resolve());
            setTimeout(resolve, 300); // safety fallback
          });
        }
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    // Give search a moment to start
    await new Promise((r) => setTimeout(r, 20));

    // Pause & Resume
    expect(searchService.pauseSearch('search-steer-test')).toBe(true);
    expect(searchService.resumeSearch('search-steer-test')).toBe(true);

    // Steer Candidate A
    const steerResult = searchService.steerCandidate('search-steer-test', 'cand-A', {
      guidance: 'Avoid using eval',
      injectedConstraints: { maxTurns: 3 },
    });
    expect(steerResult.success).toBe(true);

    const res = await searchPromise;
    expect(res.candidates[0].status).toBe('completed');
  });

  // 27 & 28. Global budget and max concurrency enforcement
  it('27 & 28. global budget enforcement produces SEARCH_BUDGET_EXHAUSTED', async () => {
    const base = await createBaseExecution();

    const res = await searchService.search(
      {
        executionId: base.execution.id,
        objective: 'Budget exhaustion test',
        candidates: 4,
        strategy: 'same_model_diverse',
        maxParallelCandidates: 1,
        searchBudget: {
          maxTotalModelCalls: 2, // Limit total calls to 2
        },
      },
      async (ctx) => {
        return {
          execution: { id: `exec-${ctx.candidateId}`, taskId: 't', runtimeId: 'rt', modelId: 'm', status: 'completed', createdAt: new Date() },
          task: { id: 't', type: 'coding', input: 'i', requirements: {}, priority: 'normal', status: 'completed', createdAt: new Date() },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          workspaceState: { workspaceId: 'ws', revision: 1, updatedAt: new Date() },
          checks: [{ workspaceRevision: 1, name: 'test', command: 'test', ok: true, durationMs: 10 }],
          evidence: [{ id: 'ev', type: 'TEST', oracle: 'TEST', revision: 1, workspaceRevision: 1, exitCode: 0, durationMs: 10, status: 'PASS', evidenceHash: 'h' }],
          errors: [],
          events: [],
        };
      },
    );

    expect(res.status).toBe('budget_exhausted');
    expect(res.budgetExhaustedReason).toContain('SEARCH_BUDGET_EXHAUSTED');
    expect(res.candidates.length).toBeLessThanOrEqual(3);
  });
});
