import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeTool, ToolRegistry } from '../src/registry.js';
import type { Tool } from '@wazir/core';

afterEach(() => vi.useRealTimers());
function makeTool(execute: Tool['execute']): Tool {
  return { descriptor: { name: 'operation', description: 'test operation', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, permissions: ['filesystem_write'], riskLevel: 'high', environment: 'local' }, execute };
}

describe('registry-enforced tool contract pipeline', () => {
  it('validates arguments before checkpoint and dispatch', async () => {
    const execute = vi.fn();
    const checkpoint = vi.fn();
    const registry = new ToolRegistry([makeTool(execute)]);
    const result = await executeTool(registry, 'operation', { path: 12 }, { projectRoot: '/tmp', checkpoint });
    expect(result.failureClass).toBe('TOOL_VALIDATION_FAILED');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('waits for the durable checkpoint and propagates stable call identity', async () => {
    const order: string[] = [];
    const tool = makeTool(async (_input, ctx) => {
      expect(ctx.callId).toBe('call-1');
      expect(order).toEqual(['checkpoint']);
      order.push('execute');
      return { ok: true, output: 'done', durationMs: 1 };
    });
    const registry = new ToolRegistry([tool]);
    expect(tool.descriptor.sideEffectClass).toBe('NON_IDEMPOTENT_WRITE');
    await executeTool(registry, 'operation', { path: 'file' }, { projectRoot: '/tmp', callId: 'call-1', checkpoint: async () => { await Promise.resolve(); order.push('checkpoint'); } });
    expect(order).toEqual(['checkpoint', 'execute']);
  });

  it('never dispatches when checkpoint persistence fails', async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry([makeTool(execute)]);
    await expect(executeTool(registry, 'operation', { path: 'file' }, { projectRoot: '/tmp', checkpoint: async () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates declared structured output and retains raw output on failure', async () => {
    const tool = makeTool(async () => ({ ok: true, output: 'raw evidence', structuredOutput: { count: 'wrong' }, durationMs: 1 }));
    tool.descriptor.outputSchema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] };
    const result = await executeTool(new ToolRegistry([tool]), 'operation', { path: 'file' }, { projectRoot: '/tmp' });
    expect(result).toMatchObject({ ok: false, failureClass: 'ARTIFACT_CONTRACT_FAILED', output: 'raw evidence' });
  });

  it('marks timed-out writes as outcome unknown without replaying them', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => new Promise<never>(() => {}));
    const tool = makeTool(execute);
    tool.descriptor.timeoutMs = 50;
    const result = executeTool(new ToolRegistry([tool]), 'operation', { path: 'file' }, { projectRoot: '/tmp' });
    await vi.advanceTimersByTimeAsync(50);
    expect((await result).failureClass).toBe('TOOL_OUTCOME_UNKNOWN');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('removes unavailable schemas and refuses their execution', async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry([makeTool(execute)]);
    expect(registry.forModel(['read'])).toEqual([]);
    const result = await executeTool(registry, 'operation', { path: 'file' }, { projectRoot: '/tmp', allowedTools: ['read'] });
    expect(result.failureClass).toBe('POLICY_DENIED');
    expect(execute).not.toHaveBeenCalled();
  });
});
