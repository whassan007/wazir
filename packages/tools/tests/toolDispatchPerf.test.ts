import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@wazir/core';
import { ToolRegistry, boundToolOutput, executeTool, MAX_TOOL_OUTPUT_CHARS } from '../src/registry.js';

function createMockTool(
  name: string,
  options: {
    output?: string;
    sideEffectClass?: 'READ_ONLY' | 'NON_IDEMPOTENT_WRITE';
    provenanceSource?: 'local' | 'web' | 'mcp' | 'subagent';
    capabilities?: string[];
  } = {},
): Tool {
  return {
    descriptor: {
      name,
      description: `Mock tool ${name}`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
      permissions: options.sideEffectClass === 'READ_ONLY' ? ['filesystem_read'] : ['filesystem_write'],
      riskLevel: 'low',
      environment: 'local',
      sideEffectClass: options.sideEffectClass ?? 'READ_ONLY',
      ...(options.provenanceSource ? { provenance: { source: options.provenanceSource } } : {}),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    },
    async execute() {
      return {
        ok: true,
        output: options.output ?? `ok:${name}`,
        durationMs: 1,
      };
    },
  };
}

describe('Agent 15: ToolRegistry & executeTool Performance Optimizations', () => {
  it('caches sorted list(), descriptors(), and forModel() across 1,000 invocations without re-sorting', () => {
    const tools = [
      createMockTool('zeta_tool'),
      createMockTool('alpha_tool'),
      createMockTool('mu_tool'),
      createMockTool('beta_tool'),
      createMockTool('omega_tool', { provenanceSource: 'web', capabilities: ['search'] }),
    ];
    const registry = new ToolRegistry(tools);

    // Prime cache
    const firstList = registry.list();
    expect(firstList.map((t) => t.descriptor.name)).toEqual([
      'alpha_tool',
      'beta_tool',
      'mu_tool',
      'omega_tool',
      'zeta_tool',
    ]);

    const localeCompareSpy = vi.spyOn(String.prototype, 'localeCompare');
    try {
      const start = performance.now();
      for (let i = 0; i < 1_000; i++) {
        const list = registry.list();
        const descriptors = registry.descriptors();
        const schemasAll = registry.forModel(undefined, ['search']);
        const schemasSubset = registry.forModel(['beta_tool', 'alpha_tool'], ['search']);
        if (i === 0) {
          expect(list).toHaveLength(5);
          expect(descriptors).toHaveLength(5);
          expect(schemasAll).toHaveLength(5);
          expect(schemasSubset.map((s) => s.name)).toEqual(['alpha_tool', 'beta_tool']);
        }
      }
      const elapsedMs = performance.now() - start;
      // Zero localeCompare calls on warm cache!
      expect(localeCompareSpy).not.toHaveBeenCalled();
      expect(elapsedMs).toBeLessThan(200);
    } finally {
      localeCompareSpy.mockRestore();
    }
  });

  it('invalidates caches when register(), unregister(), or restrictToController() is called', () => {
    const registry = new ToolRegistry([
      createMockTool('b_tool'),
      createMockTool('a_tool'),
    ]);

    expect(registry.forModel().map((t) => t.name)).toEqual(['a_tool', 'b_tool']);

    // 1. register() invalidates
    registry.register(createMockTool('c_tool'));
    expect(registry.list().map((t) => t.descriptor.name)).toEqual(['a_tool', 'b_tool', 'c_tool']);
    expect(registry.descriptors().map((d) => d.name)).toEqual(['a_tool', 'b_tool', 'c_tool']);
    expect(registry.forModel().map((t) => t.name)).toEqual(['a_tool', 'b_tool', 'c_tool']);

    // 2. restrictToController() invalidates forModel cache
    registry.restrictToController('b_tool');
    expect(registry.forModel().map((t) => t.name)).toEqual(['a_tool', 'c_tool']);

    // 3. unregister() invalidates all caches
    registry.unregister('a_tool');
    expect(registry.list().map((t) => t.descriptor.name)).toEqual(['b_tool', 'c_tool']);
    expect(registry.forModel().map((t) => t.name)).toEqual(['c_tool']);
  });

  it('bounds oversized tool outputs deterministically while preserving head and tail', () => {
    const small = 'hello world';
    expect(boundToolOutput(small, 100)).toEqual({
      output: small,
      truncated: false,
      originalLength: small.length,
    });

    const headMarker = 'HEAD_START_0123456789';
    const tailMarker = '9876543210_TAIL_END';
    const oversized = `${headMarker}${'x'.repeat(250_000)}${tailMarker}`;
    const bounded = boundToolOutput(oversized, MAX_TOOL_OUTPUT_CHARS);

    expect(bounded.truncated).toBe(true);
    expect(bounded.originalLength).toBe(oversized.length);
    expect(bounded.output.startsWith(headMarker)).toBe(true);
    expect(bounded.output.endsWith(tailMarker)).toBe(true);
    expect(bounded.output).toContain('[Tool output truncated:');
    expect(bounded.output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });

  it('truncates oversized tool output in executeTool and populates truncation metadata', async () => {
    const hugeOutput = `START_${'A'.repeat(50_000)}_END`;
    const registry = new ToolRegistry([
      createMockTool('huge_reader', { output: hugeOutput, sideEffectClass: 'READ_ONLY' }),
    ]);

    const result = await executeTool(
      registry,
      'huge_reader',
      { query: 'test' },
      {
        projectRoot: process.cwd(),
        maxOutputChars: 1_000,
      } as any,
    );

    expect(result.ok).toBe(true);
    expect(result.output.startsWith('START_')).toBe(true);
    expect(result.output.endsWith('_END')).toBe(true);
    expect(result.output).toContain('[Tool output truncated:');
    expect(result.metadata).toMatchObject({
      outputTruncated: true,
      originalOutputLength: hugeOutput.length,
    });
  });

  it('fast-paths executeTool for READ_ONLY tools with minimal dispatch overhead', async () => {
    const registry = new ToolRegistry([
      createMockTool('fast_read', { output: 'fast-result', sideEffectClass: 'READ_ONLY' }),
    ]);

    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      const res = await executeTool(registry, 'fast_read', { query: 'x' }, {
        projectRoot: process.cwd(),
      });
      expect(res.ok).toBe(true);
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(500);
  });
});
