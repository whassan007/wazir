import { describe, it, expect } from 'vitest';
import {
  SessionEventLog,
  CrossRepoGraph,
  parseWorkflowContract,
  WorkflowDaemon,
  lintForwardOnlyLayers,
  runSlopCollectionPass,
} from '../src/metaHarness/index.js';

describe('Sense 1 Meta-Harness parity primitives', () => {
  it('supports append-only positional slicing and stateless brain wake()', () => {
    const log = new SessionEventLog();
    log.emitEvent('sess-1', 'session_started', { objective: 'fix auth' });
    log.emitEvent('sess-1', 'hand_provisioned', { container: 'c1' }, { handId: 'hand-1' });
    log.emitEvent('sess-1', 'tool_call', { tool: 'read_file' }, { brainId: 'brain-a', handId: 'hand-1' });

    const slice = log.getEvents('sess-1', 1);
    expect(slice.map((e) => e.seq)).toEqual([2, 3]);

    const wake = log.wake('sess-1', 'brain-b');
    expect(wake.activeBrainId).toBe('brain-b');
    expect(wake.activeHandId).toBe('hand-1');
    expect(wake.lastSeq).toBe(4);
  });

  it('computes cross-repo downstream impact and topological execution order', () => {
    const graph = new CrossRepoGraph();
    graph.registerRepo({ repoId: 'design-tokens', rootPath: '/repos/tokens', dependsOn: [] });
    graph.registerRepo({ repoId: 'ui-kit', rootPath: '/repos/ui', dependsOn: ['design-tokens'] });
    graph.registerRepo({ repoId: 'web-app', rootPath: '/repos/web', dependsOn: ['ui-kit'] });
    graph.registerRepo({ repoId: 'billing-api', rootPath: '/repos/billing', dependsOn: [] });

    const plan = graph.buildWorktreePlan('plan-1', ['design-tokens'], 'feat/tokens-v2');
    expect(plan.downstreamImpacted).toEqual(['ui-kit', 'web-app']);
    expect(plan.executionOrder).toEqual(['design-tokens', 'ui-kit', 'web-app']);
  });

  it('parses WORKFLOW.md and schedules unblocked issues up to concurrency cap', () => {
    const contract = parseWorkflowContract(`---
tracker: linear
pollIntervalMs: 15000
maxConcurrentIssues: 2
baseBranch: main
requiredChecks: [typecheck, test]
autoRebase: true
---
Fix all assigned issues with tests.`);
    expect(contract.tracker).toBe('linear');
    expect(contract.requiredChecks).toEqual(['typecheck', 'test']);

    const daemon = new WorkflowDaemon(contract, '/tmp/ws');
    const runnable = daemon.selectRunnableIssues([
      { id: 'ISS-1', title: 'Base', description: '', state: 'done', blockedBy: [] },
      { id: 'ISS-2', title: 'Child A', description: '', state: 'todo', blockedBy: ['ISS-1'] },
      { id: 'ISS-3', title: 'Child B', description: '', state: 'todo', blockedBy: ['ISS-2'] },
      { id: 'ISS-4', title: 'Independent', description: '', state: 'todo', blockedBy: [] },
    ]);
    expect(runnable.map((i) => i.id)).toEqual(['ISS-2', 'ISS-4']);
  });

  it('detects forward-only layer violations with remediation hints', () => {
    const report = runSlopCollectionPass({
      edges: [
        { fromFile: 'src/types/user.ts', fromLayer: 'types', toFile: 'src/service/auth.ts', toLayer: 'service' },
        { fromFile: 'src/service/auth.ts', fromLayer: 'service', toFile: 'src/types/user.ts', toLayer: 'types' },
      ],
    });
    expect(report.passed).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].remediation).toContain('Layer violation');
  });
});
