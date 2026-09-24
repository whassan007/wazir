import { describe, expect, it } from 'vitest';
import { SymbolGraph } from '../src/services/symbolGraph.js';
import { ChangeImpactAnalyzer, VerificationPlanner } from '../src/services/verificationPlanning.js';

describe('Gate 19: Change-Impact-Aware Verification Planning', () => {
  it('discovers affected symbols, packages, and tests for targeted verification and widens on ambiguous mutations', async () => {
    const symbolGraph = new SymbolGraph();

    // Setup symbol nodes and call edges:
    // modelLifecycleService.ts -> allocateCompute()
    symbolGraph.addNode({
      id: 'sym-alloc-compute',
      name: 'allocateCompute',
      kind: 'function',
      file: 'packages/core/src/services/modelLifecycleService.ts',
      range: { start: { line: 20, character: 0 }, end: { line: 40, character: 1 } },
    });

    // scheduler.ts -> scheduleNextTask() calls allocateCompute()
    symbolGraph.addNode({
      id: 'sym-sched-task',
      name: 'scheduleNextTask',
      kind: 'function',
      file: 'packages/core/src/services/scheduler.ts',
      range: { start: { line: 15, character: 0 }, end: { line: 55, character: 1 } },
    });

    // scheduler.test.ts -> testSuite() calls scheduleNextTask()
    symbolGraph.addNode({
      id: 'sym-sched-test',
      name: 'testSchedulerAllocation',
      kind: 'function',
      file: 'packages/core/tests/scheduler.test.ts',
      range: { start: { line: 5, character: 0 }, end: { line: 25, character: 1 } },
    });

    // Edges
    symbolGraph.addEdge({
      from: 'sym-sched-task',
      to: 'sym-alloc-compute',
      type: 'CALLS',
    });
    symbolGraph.addEdge({
      from: 'sym-sched-test',
      to: 'sym-sched-task',
      type: 'CALLS',
    });

    const analyzer = new ChangeImpactAnalyzer({ symbolGraph });
    const planner = new VerificationPlanner();

    // 1. Mutate modelLifecycleService.ts at revision 42
    const impact1 = await analyzer.analyze(
      ['packages/core/src/services/modelLifecycleService.ts'],
      42,
    );

    expect(impact1.confidence).toBe('high');
    expect(impact1.affectedPackages).toContain('@wazir/core');
    expect(impact1.affectedSymbols.some((s) => s.name === 'allocateCompute')).toBe(true);

    const callers = impact1.affectedSymbols.find((s) => s.name === 'allocateCompute')?.callers;
    expect(callers).toBeDefined();
    expect(callers?.some((c) => c.includes('scheduleNextTask'))).toBe(true);

    // Tests selected include scheduler.test.ts
    expect(impact1.affectedTests.some((t) => t.includes('scheduler.test.ts'))).toBe(true);

    // Plan generated is targeted
    const plan1 = planner.plan(impact1);
    expect(plan1.scope).toBe('targeted');
    expect(plan1.workspaceRevision).toBe(42);
    expect(plan1.checks.length).toBeGreaterThanOrEqual(1);

    const testCheck = plan1.checks.find((c) => c.kind === 'test');
    expect(testCheck).toBeDefined();
    expect(testCheck?.target).toContain('scheduler.test.ts');
    expect(testCheck?.reason).toContain('modelLifecycleService.ts');

    // 2. Introduce an ambiguous mutation (e.g. root package.json or unindexed configuration)
    const impact2 = await analyzer.analyze(
      ['package.json', 'packages/core/src/services/modelLifecycleService.ts'],
      43,
    );

    expect(impact2.confidence).toBe('ambiguous');
    expect(impact2.ambiguityReasons).toBeDefined();

    // Planner widens verification from targeted to full
    const plan2 = planner.plan(impact2);
    expect(plan2.scope).toBe('full');
    expect(plan2.escalationReason).toBeDefined();

    // Verify checks include full workspace verification
    const fullChecks = plan2.checks.map((c) => c.kind);
    expect(fullChecks).toContain('typecheck');
    expect(fullChecks).toContain('build');
    expect(fullChecks).toContain('test');
    expect(plan2.checks.every((c) => c.scope === 'full')).toBe(true);
  });
});
