import { describe, it, expect } from 'vitest';
import { PromptLayoutPlanner, type ContextItem } from '../src/index.js';

describe('PromptLayoutPlanner (Strategies & Cache Stability)', () => {
  const planner = new PromptLayoutPlanner();

  const systemItem: ContextItem = {
    kind: 'system',
    label: 'Core System Instructions',
    content: 'System instructions content...',
    category: 'PINNED',
    priority: 100,
  };

  const agentsMdRoot: ContextItem = {
    kind: 'system',
    label: 'Project Instructions: WAZIR.md',
    content: 'Project rules...',
    sourceUri: 'WAZIR.md',
    scope: 'root',
    category: 'PINNED',
    priority: 85,
  };

  const scopedAgentsMd: ContextItem = {
    kind: 'system',
    label: 'Project Instructions: packages/core/AGENTS.md',
    content: 'Package rules...',
    sourceUri: 'packages/core/AGENTS.md',
    scope: 'packages/core',
    category: 'RELEVANT',
    priority: 80,
  };

  const activeError: ContextItem = {
    kind: 'task',
    label: 'Active Diagnostics',
    content: 'SyntaxError at line 20',
    category: 'ACTIVE',
    priority: 88,
  };

  const activeDiff: ContextItem = {
    kind: 'repository',
    label: 'Current Workspace Diff',
    content: '+ const x = 1;',
    category: 'ACTIVE',
    priority: 85,
  };

  it('classifies items into STATIC, SEMI_STABLE, and VOLATILE categories', () => {
    expect(planner.classifyStability(systemItem)).toBe('STATIC');
    expect(planner.classifyStability(agentsMdRoot)).toBe('STATIC');
    expect(planner.classifyStability(scopedAgentsMd)).toBe('SEMI_STABLE');
    expect(planner.classifyStability(activeError)).toBe('VOLATILE');
    expect(planner.classifyStability(activeDiff)).toBe('VOLATILE');
  });

  it('CACHE_STABLE_PREFIX places STATIC before SEMI_STABLE before VOLATILE', () => {
    const items = [activeDiff, scopedAgentsMd, systemItem, activeError, agentsMdRoot];
    const layout = planner.plan(items, 'CACHE_STABLE_PREFIX');

    expect(layout.strategy).toBe('CACHE_STABLE_PREFIX');
    expect(layout.stablePrefix.length).toBe(2); // systemItem, agentsMdRoot
    expect(layout.semiStable.length).toBe(1); // scopedAgentsMd
    expect(layout.volatileTail.length).toBe(2); // activeError, activeDiff

    // Verify ordering in orderedItems
    expect(layout.orderedItems[0].category).toBe('PINNED');
    expect(layout.orderedItems[layout.orderedItems.length - 1].category).toBe('ACTIVE');
  });

  it('RELEVANCE_FIRST orders purely by priority descending', () => {
    const items = [activeDiff, scopedAgentsMd, systemItem, activeError, agentsMdRoot];
    const layout = planner.plan(items, 'RELEVANCE_FIRST');

    expect(layout.strategy).toBe('RELEVANCE_FIRST');
    const priorities = layout.orderedItems.map((i) => (typeof i.priority === 'number' ? i.priority : 0));
    for (let i = 0; i < priorities.length - 1; i++) {
      expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i + 1]);
    }
  });

  it('computes accurate token breakdowns across partitions', () => {
    const items = [systemItem, scopedAgentsMd, activeError];
    const layout = planner.plan(items, 'CACHE_STABLE_PREFIX');

    expect(layout.tokens.total).toBe(
      layout.tokens.stablePrefix + layout.tokens.semiStable + layout.tokens.volatileTail,
    );
    expect(layout.tokens.stablePrefix).toBeGreaterThan(0);
    expect(layout.tokens.volatileTail).toBeGreaterThan(0);
  });
});
