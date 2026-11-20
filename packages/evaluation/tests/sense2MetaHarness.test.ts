import { describe, it, expect } from 'vitest';
import {
  TraceDigester,
  validateFalsifiableEditContract,
  verifyEditContractOutcome,
  verifyBilevelSelfEdit,
  createDisjointSplits,
  evaluateRrsiPromotionGate,
  auditBenchmarkLeakage,
  evaluateAnchorRetentionGate,
  OnlineReflectionReviser,
  MosibBranchRouter,
  buildExactTokenRolloutGroups,
} from '../src/index.js';

describe('Sense 2 Meta-Harness Optimization & Regularization', () => {
  it('compiles trace-linked progressive-disclosure overview markdown', () => {
    const digester = new TraceDigester();
    const md = digester.compileOverviewMarkdown('cand-1', [
      {
        candidateId: 'cand-1',
        taskId: 't-1',
        passed: false,
        totalTokens: 1200,
        traceFilePath: '/tmp/traces/t-1.jsonl',
        steps: [{ stepIndex: 4, toolName: 'run_shell', error: 'ENOENT: missing build dir' }],
      },
      {
        candidateId: 'cand-1',
        taskId: 't-2',
        passed: true,
        totalTokens: 800,
        traceFilePath: '/tmp/traces/t-2.jsonl',
        steps: [{ stepIndex: 2 }],
      },
    ]);
    expect(md).toContain('Passed: 1/2');
    expect(md).toContain('ENOENT: missing build dir');
    expect(md).toContain('/tmp/traces/t-1.jsonl');
  });

  it('enforces falsifiable edit contracts, allowedWritePaths, and bilevel draft verification', () => {
    const contract = {
      editId: 'ed-1',
      targetFiles: ['packages/agents/src/qwenCore/turn.ts'],
      failureEvidence: [{ taskId: 't-1', tracePath: '/tmp/t-1.jsonl', stepIndex: 4 }],
      rootCause: 'Missing cwd bootstrap check',
      targetedFix: 'Inject cwd check in pre-turn hook',
      predictedTaskFlips: ['t-1'],
    };

    const pre = validateFalsifiableEditContract(contract, ['packages/agents/src'], '/repo');
    expect(pre.valid).toBe(true);

    const outOfBounds = validateFalsifiableEditContract(
      { ...contract, targetFiles: ['packages/policies/src/index.ts'] },
      ['packages/agents/src'],
      '/repo',
    );
    expect(outOfBounds.valid).toBe(false);

    const outcome = verifyEditContractOutcome(
      contract,
      { 't-1': false, 't-2': true },
      { 't-1': true, 't-2': true },
      ['packages/agents/src'],
      '/repo',
    );
    expect(outcome.accepted).toBe(true);
    expect(outcome.predictionPrecision).toBe(1);

    expect(
      verifyBilevelSelfEdit({
        traceMinimizationPassed: true,
        failureReplayPassed: false,
        singleStepPerturbationPassed: true,
      }).accepted,
    ).toBe(false);
  });

  it('enforces 3-way disjoint splits, RRSI token-cost gate, and benchmark leakage audit', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `task-${i}` }));
    const splits = createDisjointSplits(tasks);
    expect(splits.search).toHaveLength(4);
    expect(splits.selection).toHaveLength(2);
    expect(splits.holdout).toHaveLength(2);

    const bloated = evaluateRrsiPromotionGate({
      baselineScore: 0.50,
      candidateScore: 0.52,
      baselineTokens: 1000,
      candidateTokens: 2000, // +100% tokens -> penalty 0.05 -> effectiveGain = 0.02 - 0.05 = -0.03
      gamma: 0.05,
      noiseFloorTau: 0.01,
    });
    expect(bloated.accepted).toBe(false);

    const leakage = auditBenchmarkLeakage([
      { source: 'AGENTS.md', content: 'answer_key: FLAG{1234}' },
    ]);
    expect(leakage.clean).toBe(false);
  });

  it('enforces HCL anchor retention budget and ReHarness backward revision', () => {
    const gate = evaluateAnchorRetentionGate({
      anchorAccuracyBefore: 0.90,
      anchorAccuracyAfter: 0.82,
      epsilonAnchor: 0.02,
    });
    expect(gate.accepted).toBe(false);

    const reviser = new OnlineReflectionReviser();
    reviser.addReflection({ id: 'ref-1', taskPattern: 'ts-build', guidance: 'Always delete dist', confidence: 0.2 });
    const revised = reviser.reviseFromFailure('ref-1', 'Only clean stale tsbuildinfo', 0.15);
    expect(revised?.superseded).toBe(true);
    expect(reviser.getActiveReflections()).toHaveLength(0);
  });

  it('partitions uniquely solved MoSIB branches and merges exact-token-ID rollouts', () => {
    const router = new MosibBranchRouter();
    const unique = router.partitionUniquelySolved({
      'branch-sql': { t1: true, t2: true, t3: false },
      'branch-ui': { t1: true, t2: false, t3: true },
    });
    expect(unique['branch-sql']).toEqual(['t2']);
    expect(unique['branch-ui']).toEqual(['t3']);

    router.registerBranch({ branchId: 'branch-sql', domainTags: ['postgres', 'sql'], uniquelySolvedTaskIds: ['t2'], nichePassRate: 0.9 });
    router.registerBranch({ branchId: 'branch-ui', domainTags: ['react', 'css'], uniquelySolvedTaskIds: ['t3'], nichePassRate: 0.9 });
    expect(router.routeTask('Fix postgres migration sql query')?.branchId).toBe('branch-sql');

    const groups = buildExactTokenRolloutGroups([
      { turnIndex: 0, promptTokenIds: [1, 2], responseTokenIds: [3, 4], reward: 0 },
      { turnIndex: 1, promptTokenIds: [1, 2, 3, 4, 5], responseTokenIds: [6], reward: 1 },
      { turnIndex: 2, promptTokenIds: [1, 9, 9], responseTokenIds: [7], reward: 1 },
    ]);
    expect(groups).toEqual([[0, 1], [2]]);
  });
});
