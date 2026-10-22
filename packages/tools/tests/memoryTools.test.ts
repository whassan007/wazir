import { describe, it, expect } from 'vitest';
import { ToolRegistry, executeTool } from '../src/registry.js';
import { createFleetMemoryTools } from '../src/memoryTools.js';
import { createFleetMemoryService, PolicyEngine } from '@wazir/core';
import { MemoryStore } from '@wazir/shared';

describe('remember_fact / recall_facts', () => {
  it('are visible to every model without requiring any special capability', () => {
    const service = createFleetMemoryService(new MemoryStore());
    const registry = new ToolRegistry(createFleetMemoryTools(service));
    expect(registry.forModel().map((t) => t.name).sort()).toEqual(['recall_facts', 'remember_fact']);
  });

  it('the real PolicyEngine allows both by name, scoped to the fleet-memory store', () => {
    const policy = new PolicyEngine({ projectRoot: '/tmp' });
    const remember = policy.classify({ tool: 'remember_fact', input: {} });
    const recall = policy.classify({ tool: 'recall_facts', input: {} });
    expect(remember.decision).toBe('allow');
    expect(remember.rule).toBe('fleet-memory-policy');
    expect(recall.decision).toBe('allow');
    expect(recall.rule).toBe('fleet-memory-policy');
  });

  it('a fact remembered through the tool is scoped to ctx.projectRoot and recalled the same way', async () => {
    const service = createFleetMemoryService(new MemoryStore());
    const registry = new ToolRegistry(createFleetMemoryTools(service));

    const rememberResult = await executeTool(
      registry,
      'remember_fact',
      { title: 'flaky test', body: 'tests/db.test.ts needs --retries=3' },
      { projectRoot: '/repos/widget' },
    );
    expect(rememberResult.ok).toBe(true);
    expect(rememberResult.output).toContain('flaky test');

    // A different project root never sees it.
    const otherProject = await executeTool(registry, 'recall_facts', {}, { projectRoot: '/repos/other' });
    expect(otherProject.output).toContain('No fleet memory facts');

    const sameProject = await executeTool(registry, 'recall_facts', {}, { projectRoot: '/repos/widget' });
    expect(sameProject.output).toContain('--retries=3');
  });

  it('rejects an empty title/body through the real validation path instead of storing junk', async () => {
    const service = createFleetMemoryService(new MemoryStore());
    const registry = new ToolRegistry(createFleetMemoryTools(service));
    const result = await executeTool(registry, 'remember_fact', { title: '', body: 'x' }, { projectRoot: '/tmp' });
    expect(result.failureClass).toBe('TOOL_VALIDATION_FAILED');
  });
});
