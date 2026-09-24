import { describe, it, expect, beforeEach } from 'vitest';
import { ContextCompiler } from '@wazir/core';
import { explainContextCommand } from '../src/commands.js';
import type { RookEngine } from '../src/engine.js';

describe('explainContextCommand (wa context explain)', () => {
  let compiler: ContextCompiler;
  let fakeEngine: RookEngine;

  beforeEach(() => {
    compiler = new ContextCompiler();
    fakeEngine = {
      compiler,
    } as unknown as RookEngine;
  });

  it('explains included, omitted, and breakdown for a compiled snapshot', async () => {
    const request = {
      executionId: 'exec-explain-1',
      agentId: 'wazir-coder',
      modelId: 'qwen3-coder-next',
      taskDescription: 'Fix crash in scheduler router',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
      activeFiles: ['packages/scheduler/src/router.ts'],
      activeErrors: ['TypeError: Cannot read properties of undefined'],
      recentHistory: [
        {
          kind: 'repository' as const,
          label: 'packages/scheduler/src/router.ts (old)',
          content: 'old router content',
          priority: 30,
          sourceUri: 'packages/scheduler/src/router.ts',
        },
        {
          kind: 'repository' as const,
          label: 'packages/scheduler/src/router.ts (new)',
          content: 'new router content with fix',
          priority: 85,
          sourceUri: 'packages/scheduler/src/router.ts',
        },
      ],
    };

    await compiler.compileSnapshot(request);

    const res = await explainContextCommand(fakeEngine, 'exec-explain-1');
    expect(res.code).toBe(0);
    expect(res.output).toContain('Context Explanation for Execution: exec-explain-1');
    expect(res.output).toContain('Model: qwen3-coder-next');
    expect(res.output).toContain('INCLUDED CONTEXT:');
    expect(res.output).toContain('OMITTED CONTEXT:');
    expect(res.output).toContain('Superseded by newer revision of packages/scheduler/src/router.ts');
  });

  it('supports --json output yielding valid parseable JSON with all metrics', async () => {
    const request = {
      executionId: 'exec-explain-json',
      agentId: 'wazir-coder',
      modelId: 'qwen3-coder-next',
      taskDescription: 'JSON diagnostics verification',
      projectRoot: '/tmp',
      effectiveContextWindow: 96000,
      activeErrors: ['Assertion failure at line 42'],
    };

    await compiler.compileSnapshot(request);

    const res = await explainContextCommand(fakeEngine, 'exec-explain-json', { json: true });
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.output);

    expect(parsed.executionId).toBe('exec-explain-json');
    expect(parsed.modelId).toBe('qwen3-coder-next');
    expect(parsed.breakdown).toBeDefined();
    expect(parsed.includedItems.length).toBeGreaterThan(0);
    expect(parsed.utilization).toBeGreaterThan(0);
  });
});
