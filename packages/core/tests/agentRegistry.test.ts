import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../src/services/agentRegistry.js';
import type { AgentAdapter, AgentDescriptor, AgentRunRequest, AgentRuntime, AgentTurn } from '../src/types/agent.js';
import type { Task } from '../src/types/task.js';

function fakeAgent(descriptor: Partial<AgentDescriptor> & { name: string }): AgentAdapter {
  const full: AgentDescriptor = {
    name: descriptor.name,
    version: descriptor.version ?? '1.0.0',
    description: descriptor.description ?? 'fake agent',
    capabilities: descriptor.capabilities ?? [],
    requiredTools: descriptor.requiredTools ?? [],
    modelRequirements: descriptor.modelRequirements ?? { capabilities: [] },
    permissions: descriptor.permissions ?? [],
    taskTypes: descriptor.taskTypes ?? [],
    strategy: descriptor.strategy ?? 'fake',
  };
  return {
    descriptor: full,
    async *run(_request: AgentRunRequest, _runtime: AgentRuntime): AsyncIterable<AgentTurn> {
      yield { kind: 'done' };
    },
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    type: 'coding',
    input: 'do something',
    requirements: {},
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('auto-selects an agent whose taskTypes include the task type', () => {
    registry.register(fakeAgent({ name: 'wazir-coding', taskTypes: ['coding', 'debugging'] }), 'native');

    const { agent, reasons } = registry.resolveForTask(fakeTask({ type: 'coding' }));

    expect(agent.descriptor.name).toBe('wazir-coding');
    expect(reasons[0]).toContain('wazir-coding');
  });

  it('never auto-selects an agent registered with empty taskTypes, even if it sorts first alphabetically', () => {
    // 'opencode' sorts before 'wazir-coding', so this proves selection is by
    // taskTypes/capabilities, not registration or list order.
    registry.register(fakeAgent({ name: 'opencode', taskTypes: [], capabilities: ['coding'] }), 'external');
    registry.register(fakeAgent({ name: 'wazir-coding', taskTypes: ['coding'] }), 'native');

    const { agent } = registry.resolveForTask(fakeTask({ type: 'coding' }));

    expect(agent.descriptor.name).toBe('wazir-coding');
  });

  it('resolves an empty-taskTypes agent when explicitly requested via targetAgentId', () => {
    registry.register(fakeAgent({ name: 'opencode', taskTypes: [], capabilities: ['coding'] }), 'external');
    registry.register(fakeAgent({ name: 'wazir-coding', taskTypes: ['coding'] }), 'native');

    const { agent, reasons } = registry.resolveForTask(
      fakeTask({ type: 'coding', execution: { targetAgentId: 'opencode' } }),
    );

    expect(agent.descriptor.name).toBe('opencode');
    expect(reasons[0]).toContain('explicitly requested');
  });

  it('throws when an explicitly requested agent is not registered', () => {
    registry.register(fakeAgent({ name: 'wazir-coding', taskTypes: ['coding'] }), 'native');

    expect(() =>
      registry.resolveForTask(fakeTask({ type: 'coding', execution: { targetAgentId: 'opencode' } })),
    ).toThrow(/not registered/);
  });

  it('throws when no agent supports the task type and none is explicitly requested', () => {
    registry.register(fakeAgent({ name: 'opencode', taskTypes: [], capabilities: ['coding'] }), 'external');

    expect(() => registry.resolveForTask(fakeTask({ type: 'research' }))).toThrow(
      /No agent supports task type/,
    );
  });
});
