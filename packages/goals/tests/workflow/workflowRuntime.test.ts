import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import {
  GoalStudioFailure,
  analyzeGoalIntent,
  compileWorkflow,
  createGoalGovernance,
  createWorkflowRuntimeService,
  discoverLoopCollection,
  type CheckRunner,
  type GoalRunLedger,
} from '../../src/index.js';

function makeClock(startIso = '2026-11-21T12:00:00.000Z') {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advanceMs: (delta: number) => {
      ms += delta;
    },
  };
}

describe('Workflow Runtime & Compiler (Loop / Graph / Goal)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-workflow-runtime-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('discoverLoopCollection', () => {
    it('discovers cities from cities.json and bounds by maxIterations', async () => {
      await fs.writeFile(
        path.join(workspaceRoot, 'cities.json'),
        JSON.stringify([
          { id: 'solis', name: 'Solis' },
          { id: 'vespera', name: 'Vespera' },
          { id: 'aurelia', name: 'Aurelia' },
          { id: 'cinderford', name: 'Cinderford' },
        ]),
        'utf8',
      );

      const full = discoverLoopCollection(workspaceRoot, 'Improve every Lorecraft city and test it', 25);
      expect(full.kind).toBe('collection');
      expect(full.collectionSource).toBe('cities.json');
      expect(full.items).toHaveLength(4);
      expect(full.items.map((i) => i.itemId)).toEqual(['solis', 'vespera', 'aurelia', 'cinderford']);
      expect(full.items.every((i) => i.kind === 'city')).toBe(true);

      const bounded = discoverLoopCollection(workspaceRoot, 'Improve every Lorecraft city', 2);
      expect(bounded.items).toHaveLength(2);
      expect(bounded.maxIterations).toBe(2);
      expect(bounded.items.map((i) => i.targetId)).toEqual(['L-001', 'L-002']);
    });

    it('discovers cities from a cities/ directory when cities.json is absent', async () => {
      const citiesDir = path.join(workspaceRoot, 'cities');
      await fs.mkdir(citiesDir, { recursive: true });
      await fs.writeFile(path.join(citiesDir, 'aldervale.md'), '# Aldervale\n', 'utf8');
      await fs.writeFile(path.join(citiesDir, 'briarhollow.json'), '{"name":"Briarhollow"}', 'utf8');

      const loop = discoverLoopCollection(workspaceRoot, 'Polish every city in Lorecraft');
      expect(loop.kind).toBe('collection');
      expect(loop.collectionSource).toBe('cities');
      expect(loop.items).toHaveLength(2);
      expect(loop.items[0]).toMatchObject({
        targetId: 'L-001',
        itemId: 'aldervale',
        path: 'cities/aldervale.md',
        kind: 'city',
      });
      expect(loop.items[1]).toMatchObject({
        targetId: 'L-002',
        itemId: 'briarhollow',
        path: 'cities/briarhollow.json',
        kind: 'city',
      });
    });

    it('discovers markdown files in workspace when prompt targets markdown/docs', async () => {
      await fs.mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# Readme\n', 'utf8');
      await fs.writeFile(path.join(workspaceRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
      await fs.writeFile(path.join(workspaceRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');

      const loop = discoverLoopCollection(workspaceRoot, 'Audit every markdown file for broken links');
      expect(loop.kind).toBe('collection');
      expect(loop.collectionSource).toBe('workspace:*.md');
      expect(loop.items.map((i) => i.path).sort()).toEqual(['README.md', 'docs/guide.md']);
      expect(loop.items.every((i) => i.kind === 'file')).toBe(true);
    });

    it('uses explicit --items when provided and falls back to bounded iteration counts', async () => {
      await fs.writeFile(path.join(workspaceRoot, 'module-a.ts'), 'export {};\n', 'utf8');
      const explicit = discoverLoopCollection(workspaceRoot, 'Verify targets', 25, ['module-a.ts', 'module-b']);
      expect(explicit.kind).toBe('collection');
      expect(explicit.collectionSource).toBe('explicit-items');
      expect(explicit.items).toHaveLength(2);
      expect(explicit.items[0]?.path).toBe('module-a.ts');
      expect(explicit.items[1]?.path).toBeUndefined();

      const counted = discoverLoopCollection(workspaceRoot, 'Benchmark 4 iterations until p99 drops below 50ms');
      expect(counted.kind).toBe('predicate');
      expect(counted.completionPredicate).toBe('p99 drops below 50ms');
      expect(counted.items).toHaveLength(4);
      expect(counted.items.every((i) => i.kind === 'iteration')).toBe(true);
    });
  });

  describe('analyzeGoalIntent & compileWorkflow mode selection', () => {
    it('selects single mode for a focused task with explainable reasons', () => {
      const prompt = 'Fix the off-by-one pagination offset in searchResults.ts';
      const analysis = analyzeGoalIntent({ prompt, workspaceRoot });
      expect(analysis.selectedMode).toBe('single');
      expect(analysis.overridden).toBe(false);
      expect(analysis.reasons.length).toBeGreaterThan(0);

      const compiled = compileWorkflow({ prompt, workspaceRoot });
      expect(compiled.validation.valid).toBe(true);
      expect(compiled.plan.mode).toBe('single');
      expect(compiled.definition.targets).toHaveLength(1);
      expect(compiled.definition.targets[0]?.id).toBe('T1');
    });

    it('selects loop mode for iterative city collection prompts', async () => {
      await fs.writeFile(
        path.join(workspaceRoot, 'cities.json'),
        JSON.stringify([{ name: 'Solis' }, { name: 'Vespera' }, { name: 'Aurelia' }]),
        'utf8',
      );

      const prompt = 'Improve every Lorecraft city and test it';
      const analysis = analyzeGoalIntent({ prompt, workspaceRoot });
      expect(analysis.selectedMode).toBe('loop');
      expect(analysis.signals.loopSignals).toContain('quantifier:every');
      expect(analysis.signals.iterativeTargetsCount).toBe(3);

      const compiled = compileWorkflow({ prompt, workspaceRoot });
      expect(compiled.validation.valid).toBe(true);
      expect(compiled.plan.mode).toBe('loop');
      expect(compiled.plan.loop?.items).toHaveLength(3);
      expect(compiled.definition.targets.map((t) => t.id)).toEqual(['L-001', 'L-002', 'L-003']);
    });

    it('selects graph mode for multi-domain outcomes and hybrid mode for mixed goal + collection', async () => {
      await fs.writeFile(
        path.join(workspaceRoot, 'cities.json'),
        JSON.stringify([{ name: 'Solis' }, { name: 'Vespera' }]),
        'utf8',
      );

      const graphPrompt =
        'Build a multiplayer platform with paid accounts, authentication, subscriptions, multiplayer servers, player synchronization, deployment and QA';
      const graphAnalysis = analyzeGoalIntent({ prompt: graphPrompt, workspaceRoot });
      expect(graphAnalysis.selectedMode).toBe('graph');
      expect(graphAnalysis.signals.graphSignals).toEqual(
        expect.arrayContaining(['auth', 'billing', 'multiplayer', 'deploy', 'qa']),
      );
      expect(graphAnalysis.signals.dependencyCount).toBeGreaterThanOrEqual(3);

      const compiledGraph = compileWorkflow({ prompt: graphPrompt, workspaceRoot });
      expect(compiledGraph.validation.valid).toBe(true);
      expect(compiledGraph.plan.mode).toBe('graph');
      expect(compiledGraph.plan.criticalPath.depth).toBeGreaterThanOrEqual(3);

      const hybridPrompt =
        'Make Lorecraft production-ready across every city with backend, staging deployment, and QA';
      const hybridAnalysis = analyzeGoalIntent({ prompt: hybridPrompt, workspaceRoot });
      expect(hybridAnalysis.selectedMode).toBe('hybrid');
      expect(hybridAnalysis.signals.loopSignals.length).toBeGreaterThan(0);
      expect(hybridAnalysis.signals.graphSignals.length).toBeGreaterThanOrEqual(2);

      const compiledHybrid = compileWorkflow({ prompt: hybridPrompt, workspaceRoot });
      expect(compiledHybrid.validation.valid).toBe(true);
      expect(compiledHybrid.plan.mode).toBe('hybrid');
      expect(compiledHybrid.plan.nestedLoops?.length).toBe(1);
    });

    it('supports explicit overrideMode (loop, graph, single) with explainable reasons', () => {
      const multiPrompt =
        'Build Lorecraft multiplayer with paid accounts, authentication, subscriptions, multiplayer servers, player synchronization, deployment and QA';

      for (const overrideMode of ['loop', 'graph', 'single'] as const) {
        const analysis = analyzeGoalIntent({ prompt: multiPrompt, workspaceRoot, overrideMode });
        expect(analysis.selectedMode).toBe(overrideMode);
        expect(analysis.overridden).toBe(true);
        expect(analysis.confidence).toBe(1.0);
        expect(analysis.reasons.some((r) => r.includes(overrideMode))).toBe(true);

        const compiled = compileWorkflow({ prompt: multiPrompt, workspaceRoot, overrideMode });
        expect(compiled.validation.valid).toBe(true);
        expect(compiled.plan.mode).toBe(overrideMode);
        expect(compiled.plan.overridden).toBe(true);
      }
    });
  });

  describe('bounded execution limits (concurrency, iterations, repair & no-progress)', () => {
    it('enforces maxConcurrency=1 sequentially and maxConcurrency>1 in parallel', async () => {
      let activeSeq = 0;
      let maxObservedSeq = 0;
      const runtimeSeq = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
        targetHandler: async (ctx) => {
          activeSeq += 1;
          maxObservedSeq = Math.max(maxObservedSeq, activeSeq);
          await new Promise((r) => setTimeout(r, 20));
          activeSeq -= 1;
          return { ok: true, summary: `done ${ctx.target.id}`, claimedDone: true };
        },
      });

      const seqResult = await runtimeSeq.executeToCompletion({
        prompt: 'Improve each item',
        requestedMode: 'loop',
        items: ['one', 'two', 'three'],
        maxConcurrency: 1,
        workspaceRoot,
      });
      await runtimeSeq.shutdown();
      expect(seqResult.run.status).toBe('completed');
      expect(maxObservedSeq).toBe(1);

      let activePar = 0;
      let maxObservedPar = 0;
      const runtimePar = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
        targetHandler: async (ctx) => {
          activePar += 1;
          maxObservedPar = Math.max(maxObservedPar, activePar);
          await new Promise((r) => setTimeout(r, 40));
          activePar -= 1;
          return { ok: true, summary: `done ${ctx.target.id}`, claimedDone: true };
        },
      });

      const parResult = await runtimePar.executeToCompletion({
        prompt: 'Improve each item',
        requestedMode: 'loop',
        items: ['one', 'two', 'three'],
        maxConcurrency: 3,
        workspaceRoot,
      });
      await runtimePar.shutdown();
      expect(parResult.run.status).toBe('completed');
      expect(maxObservedPar).toBeGreaterThan(1);
    });

    it('bounds execution by maxIterations and stops repairing after maxRepairsPerTask / maxSameActionNoProgress', async () => {
      await fs.writeFile(
        path.join(workspaceRoot, 'cities.json'),
        JSON.stringify([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
        'utf8',
      );
      const executed: string[] = [];
      const iterRuntime = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
        targetHandler: async (ctx) => {
          executed.push(ctx.target.id);
          return { ok: true, summary: 'done', claimedDone: true };
        },
      });
      const boundedRun = await iterRuntime.executeToCompletion({
        prompt: 'Improve every Lorecraft city',
        maxIterations: 2,
        workspaceRoot,
      });
      await iterRuntime.shutdown();
      expect(boundedRun.run.status).toBe('completed');
      expect(executed).toEqual(['L-001', 'L-002']);

      // Distinct failures exhaust maxRepairsPerTask (1 repair => 2 attempts -> blocked RETRY_EXHAUSTED)
      let attemptSeen = 0;
      const repairBoundRuntime = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
        targetHandler: async () => {
          attemptSeen += 1;
          return {
            ok: false,
            summary: `failure #${attemptSeen}`,
            error: {
              code: 'EXECUTION_FAILED',
              message: attemptSeen === 1 ? 'syntax error in parser.ts line 12' : 'missing export symbol fooBar in index.ts',
              retryable: false,
              failureClass: attemptSeen === 1 ? 'BUILD_FAILED' : 'TYPECHECK_FAILED',
            },
          };
        },
      });
      const repairBounded = await repairBoundRuntime.executeToCompletion({
        prompt: 'Fix single module',
        overrideMode: 'single',
        maxRepairsPerTask: 1,
        maxSameActionNoProgress: 4,
        workspaceRoot,
      });
      await repairBoundRuntime.shutdown();
      expect(attemptSeen).toBe(2);
      expect(repairBounded.run.targets['T1']?.status).toBe('blocked');
      expect(repairBounded.run.targets['T1']?.repairs).toBe(1);
      expect(repairBounded.run.targets['T1']?.blockers.some((b) => b.includes('RETRY_EXHAUSTED'))).toBe(true);
    });
  });

  describe('independent VerificationService check runner', () => {
    it('rejects agent false completion when artifact is missing or command fails, then completes when repaired', async () => {
      let passTests = false;
      const checkRunner: CheckRunner = {
        async run({ command }) {
          return {
            exitCode: passTests ? 0 : 1,
            stdout: passTests ? 'all tests green' : '',
            stderr: passTests ? '' : `failing test in ${command}`,
            timedOut: false,
            durationMs: 5,
            sandbox: 'none',
          };
        },
      };

      const seenHypotheses: Array<string | undefined> = [];
      const runtime = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
        checkRunner,
        targetHandler: async (ctx) => {
          seenHypotheses.push(ctx.repairHypothesis);
          if (ctx.attempt === 1) {
            // Lie: claim done without writing the required artifact
            return { ok: true, summary: 'Claimed done', claimedDone: true, filesWritten: [] };
          }
          // On attempt 2 (repair), write the required artifact and allow tests to pass
          const abs = path.resolve(ctx.workspaceRoot, ctx.target.artifacts[0]!);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(
            abs,
            JSON.stringify({ targetId: ctx.target.id, summary: 'repaired', completedAt: new Date().toISOString() }),
            'utf8',
          );
          passTests = true;
          return { ok: true, summary: 'Repaired and verified', claimedDone: true };
        },
      });

      const res = await runtime.executeToCompletion({
        prompt: 'Implement healthcheck endpoint',
        overrideMode: 'single',
        verifyCommands: ['npm test'],
        maxRepairsPerTask: 2,
        maxSameActionNoProgress: 2,
        workspaceRoot,
      });
      await runtime.shutdown();

      expect(res.run.status).toBe('completed');
      expect(res.run.targets['T1']?.attempts).toBe(2);
      expect(res.run.targets['T1']?.repairs).toBe(1);
      expect(seenHypotheses[0]).toBeUndefined();
      expect(seenHypotheses[1]).toBeTruthy();
      expect(res.evidence.some((e) => e.verdict === 'FAIL')).toBe(true);
      expect(res.evidence.some((e) => e.validationMethod === 'test-suite' && e.verdict === 'PASS')).toBe(true);
    });

    it('blocks target after no-progress limit when CheckRunner keeps failing despite claimedDone=true', async () => {
      const checkRunner: CheckRunner = {
        async run() {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'AssertionError: expected 200 to equal 500',
            timedOut: false,
            durationMs: 5,
            sandbox: 'none',
          };
        },
      };

      const runtime = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
        checkRunner,
        targetHandler: async () => ({
          ok: true,
          summary: 'Agent claims everything is complete',
          claimedDone: true,
        }),
      });

      const res = await runtime.executeToCompletion({
        prompt: 'Fix status endpoint',
        overrideMode: 'single',
        verifyCommands: ['vitest run'],
        maxRepairsPerTask: 3,
        maxSameActionNoProgress: 2,
        workspaceRoot,
      });
      await runtime.shutdown();

      expect(res.run.status).toBe('idle');
      expect(res.run.targets['T1']?.status).toBe('blocked');
      expect(res.run.targets['T1']?.attempts).toBe(2);
      expect(res.run.targets['T1']?.blockers.some((b) => b.includes('NO_PROGRESS'))).toBe(true);
    });
  });

  describe('approval gates and policy checks', () => {
    it('holds production deployment gate at needs_approval until explicit approve() calls', async () => {
      const runtime = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
      });

      const prompt = 'Build backend API, run QA tests, and deploy directly to production';
      const initial = await runtime.executeToCompletion({
        prompt,
        workspaceRoot,
      });

      expect(initial.plan.explanation.policyAssessment.requiresApprovalGates.length).toBeGreaterThan(0);
      expect(initial.run.targets['G6.qa']?.status).toBe('completed');
      expect(initial.run.targets['G7.prod_release_gate']?.status).toBe('needs_approval');
      expect(initial.run.status).toBe('idle');

      // First approval unblocks execution of G7.prod_release_gate, which then hits completion signoff gate
      await runtime.approve(initial.run.runId, 'G7.prod_release_gate', 'user:release-lead', 'Approve execution');
      const afterExecApprove = await runtime.controller.settled(initial.run.runId);
      expect(afterExecApprove?.targets['G7.prod_release_gate']?.status).toBe('needs_approval');

      // Second approval completes G7.prod_release_gate and the overall run
      await runtime.approve(initial.run.runId, 'G7.prod_release_gate', 'user:release-lead', 'Approve release');
      const finalRun = await runtime.controller.settled(initial.run.runId);
      await runtime.shutdown();

      expect(finalRun?.targets['G7.prod_release_gate']?.status).toBe('completed');
      expect(finalRun?.status).toBe('completed');
    });

    it('rejects destructive delete outside workspace with VALIDATION policyViolation=true', async () => {
      const runtime = createWorkflowRuntimeService({
        store: new MemoryStore(),
        workspaceRoot,
      });

      let caught: unknown;
      try {
        await runtime.compile({
          prompt: 'rm -rf /etc/wazir-forbidden-outside-workspace',
          workspaceRoot,
        });
      } catch (err) {
        caught = err;
      }
      await runtime.shutdown();

      expect(caught).toBeInstanceOf(GoalStudioFailure);
      const failure = caught as GoalStudioFailure;
      expect(failure.code).toBe('VALIDATION');
      expect(failure.details?.policyViolation).toBe(true);
    });

    it('rejects hosted model execution when hostedSpendUsd=0', async () => {
      let handlerCalled = 0;
      const store = new MemoryStore();
      const runtime = createWorkflowRuntimeService({
        store,
        workspaceRoot,
        defaultModel: 'gpt-4o',
        targetHandler: async () => {
          handlerCalled += 1;
          return { ok: true, summary: 'should not execute' };
        },
      });

      const res = await runtime.executeToCompletion({
        prompt: 'Analyze single file',
        overrideMode: 'single',
        maxBudgetUsd: 0,
        workspaceRoot,
      });

      expect(handlerCalled).toBe(0);
      expect(res.run.targets['T1']?.status).toBe('blocked');
      expect(res.run.targets['T1']?.blockers.some((b) => b.includes('BUDGET_EXCEEDED'))).toBe(true);

      const governance = createGoalGovernance({ store, workspaceRoot });
      const spendDecision = governance.authorizeSpend(res.run as GoalRunLedger, 0.05);
      expect(spendDecision.effect).toBe('deny');
      expect(spendDecision.reasons.some((r) => r.includes('BUDGET_DENIED'))).toBe(true);

      await runtime.shutdown();
    });
  });

  describe('crash recovery and pause/resume over JsonFileStore', () => {
    it('resumes interrupted loop on a fresh runtime + JsonFileStore without re-executing completed item 1', async () => {
      const storeFile = path.join(workspaceRoot, '.wazir', 'workflow-store.json');
      await fs.writeFile(
        path.join(workspaceRoot, 'cities.json'),
        JSON.stringify([{ name: 'Aldervale' }, { name: 'Briarhollow' }, { name: 'Cinderford' }]),
        'utf8',
      );

      const executionCount: Record<string, number> = {};
      const mkHandler = (delayMsOnSecond = 0) => async (ctx: { target: { id: string }; loopItem?: { label: string } }) => {
        executionCount[ctx.target.id] = (executionCount[ctx.target.id] ?? 0) + 1;
        if (delayMsOnSecond > 0 && ctx.target.id === 'L-002') {
          await new Promise((r) => setTimeout(r, delayMsOnSecond));
        }
        return {
          ok: true,
          summary: `Improved ${ctx.loopItem?.label ?? ctx.target.id}`,
          claimedDone: true,
        };
      };

      const runtime1 = createWorkflowRuntimeService({
        store: new JsonFileStore(storeFile),
        workspaceRoot,
        targetHandler: mkHandler(80),
      });

      const interrupted = await runtime1.executeToCompletion({
        prompt: 'Improve every Lorecraft city',
        maxConcurrency: 1,
        interruptAfterCompletedTargets: 1,
        workspaceRoot,
      });
      await runtime1.controller.settled(interrupted.run.runId);
      await runtime1.shutdown();

      const pausedRun = await new JsonFileStore(storeFile).get<{ ledger: GoalRunLedger }>(
        `goals/runs/${interrupted.run.runId}`,
      );
      expect(pausedRun?.ledger.status).toBe('paused');
      expect(pausedRun?.ledger.targets['L-001']?.status).toBe('completed');
      expect(pausedRun?.ledger.targets['L-003']?.status).not.toBe('completed');
      expect(executionCount['L-001']).toBe(1);

      const runtime2 = createWorkflowRuntimeService({
        store: new JsonFileStore(storeFile),
        workspaceRoot,
        targetHandler: mkHandler(0),
      });
      const resumed = await runtime2.resume(interrupted.run.runId, 'user:local', { wait: true });
      await runtime2.shutdown();

      expect(resumed.status).toBe('completed');
      expect(resumed.targets['L-001']?.status).toBe('completed');
      expect(resumed.targets['L-002']?.status).toBe('completed');
      expect(resumed.targets['L-003']?.status).toBe('completed');
      expect(executionCount['L-001']).toBe(1);
      expect(executionCount['L-002']).toBe(1);
      expect(executionCount['L-003']).toBe(1);
    });

    it('recovers crashed running workflow via recover() on a new runtime without duplicate item 1 execution', async () => {
      const storeFile = path.join(workspaceRoot, '.wazir', 'crash-store.json');
      await fs.writeFile(
        path.join(workspaceRoot, 'cities.json'),
        JSON.stringify([{ name: 'Solis' }, { name: 'Vespera' }, { name: 'Aurelia' }]),
        'utf8',
      );

      const clock = makeClock();
      const executionCount: Record<string, number> = {};
      let notifyItem2Started!: () => void;
      const item2Started = new Promise<void>((resolve) => {
        notifyItem2Started = resolve;
      });

      const runtime1 = createWorkflowRuntimeService({
        store: new JsonFileStore(storeFile),
        workspaceRoot,
        clock: clock.now,
        holderId: 'worker-crash-1',
        leaseTtlMs: 80,
        targetHandler: async (ctx) => {
          executionCount[ctx.target.id] = (executionCount[ctx.target.id] ?? 0) + 1;
          if (ctx.target.id === 'L-002') {
            notifyItem2Started();
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return { ok: false, summary: 'crashed mid-flight', error: { code: 'CANCELLED', message: 'aborted', retryable: true } };
          }
          return { ok: true, summary: `done ${ctx.target.id}`, claimedDone: true };
        },
      });

      const started = await runtime1.start({
        prompt: 'Improve every Lorecraft city',
        maxConcurrency: 1,
        workspaceRoot,
      });

      await item2Started;
      await runtime1.shutdown({ releaseLeases: false });

      // Advance clock past leaseTtlMs so the new runtime steals the expired lease cleanly
      clock.advanceMs(500);

      const runtime2 = createWorkflowRuntimeService({
        store: new JsonFileStore(storeFile),
        workspaceRoot,
        clock: clock.now,
        holderId: 'worker-recovery-2',
        leaseTtlMs: 5_000,
        targetHandler: async (ctx) => {
          executionCount[ctx.target.id] = (executionCount[ctx.target.id] ?? 0) + 1;
          return { ok: true, summary: `recovered ${ctx.target.id}`, claimedDone: true };
        },
      });

      const recovered = await runtime2.recover({ wait: true });
      await runtime2.shutdown();

      const recoveredRun = recovered.find((r) => r.runId === started.run.runId);
      expect(recoveredRun?.status).toBe('completed');
      expect(recoveredRun?.targets['L-001']?.status).toBe('completed');
      expect(recoveredRun?.targets['L-002']?.status).toBe('completed');
      expect(recoveredRun?.targets['L-003']?.status).toBe('completed');
      expect(executionCount['L-001']).toBe(1);
      expect(executionCount['L-003']).toBe(1);
    });
  });
});
