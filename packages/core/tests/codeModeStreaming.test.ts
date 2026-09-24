import { describe, expect, it } from 'vitest';
import { CodeModeService } from '../src/services/codeModeService.js';
import type { ToolExecutionContext, ToolResult } from '../src/types/tool.js';
import type { CodeModeStreamingEvent } from '../src/types/codeMode.js';

describe('Gate 17: Real-Time Code Mode Streaming & MCP Proxy', () => {
  it('streams operation lifecycle events in real-time preserving attribution across concurrent calls', async () => {
    const events: CodeModeStreamingEvent[] = [];
    const eventTimes: { type: string; opId?: string; time: number }[] = [];
    const started = Date.now();

    const mockToolExecutor = async (
      toolName: string,
      input: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ): Promise<ToolResult> => {
      const delay = (input.delayMs as number) ?? 10;
      await new Promise((r) => setTimeout(r, delay));
      return {
        ok: true,
        output: `Result of ${toolName} for ${(input.path as string) ?? (input.query as string) ?? 'test'} (delay ${delay}ms)`,
        durationMs: delay,
      };
    };

    const service = new CodeModeService({
      toolExecutor: mockToolExecutor,
      onStream: (ev) => {
        events.push(ev);
        eventTimes.push({ type: ev.type, opId: ev.operationId, time: Date.now() - started });
      },
    });

    const script = `
      // Concurrent operations: two fast reads, one slower search
      const [r1, r2, s1] = await Promise.all([
        wazir.read('file1.ts'),
        wazir.read('file2.ts'),
        wazir.call('search', { query: 'slow-search', delayMs: 40 }),
      ]);
      return { r1, r2, s1 };
    `;

    const result = await service.executeScript(script, {
      executionId: 'exec-stream-101',
    });

    expect(result.ok).toBe(true);

    // 1. Assert codemode.started was received
    const startEvent = events.find((e) => e.type === 'codemode.started');
    expect(startEvent).toBeDefined();
    expect(startEvent?.executionId).toBe('exec-stream-101');
    expect(startEvent?.scriptId).toMatch(/^cms-/);

    // 2. Assert codemode.completed was received
    const completedEvent = events.find((e) => e.type === 'codemode.completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.scriptId).toBe(startEvent?.scriptId);

    // 3. Assert operations started events appear BEFORE the script completed
    const opStartedEvents = events.filter((e) => e.type === 'codemode.operation.started');
    expect(opStartedEvents).toHaveLength(3);

    const completedTime = eventTimes.find((e) => e.type === 'codemode.completed')!.time;
    for (const opStart of eventTimes.filter((e) => e.type === 'codemode.operation.started')) {
      expect(opStart.time).toBeLessThanOrEqual(completedTime);
    }

    // 4. Concurrency & attribution preservation: each op has distinct operationId and tool name
    const opIds = new Set(opStartedEvents.map((e) => e.operationId));
    expect(opIds.size).toBe(3);

    for (const opId of opIds) {
      const related = events.filter((e) => e.operationId === opId);
      const start = related.find((e) => e.type === 'codemode.operation.started');
      const output = related.find((e) => e.type === 'codemode.operation.output');
      const finish = related.find((e) => e.type === 'codemode.operation.completed');

      expect(start).toBeDefined();
      expect(output).toBeDefined();
      expect(finish).toBeDefined();
      expect(output?.outputChunk).toContain(`Result of ${start?.tool}`);
      expect(finish?.result?.ok).toBe(true);
    }
  });

  it('routes dynamic wazir.mcp.<server>.<tool> calls seamlessly through MCP namespace proxy', async () => {
    const executedTools: { name: string; input: Record<string, unknown> }[] = [];

    const service = new CodeModeService({
      toolExecutor: async (toolName, input) => {
        executedTools.push({ name: toolName, input });
        return {
          ok: true,
          output: JSON.stringify({ issueCount: 42, tool: toolName }),
          durationMs: 5,
        };
      },
    });

    const script = `
      const res = await wazir.mcp.github.search_issues({ repo: 'whassan007/wazir', state: 'open' });
      return JSON.parse(res.output);
    `;

    const result = await service.executeScript(script);
    expect(result.ok).toBe(true);
    expect(result.returnValue).toEqual({ issueCount: 42, tool: 'mcp.github.search_issues' });
    expect(executedTools).toHaveLength(1);
    expect(executedTools[0].name).toBe('mcp.github.search_issues');
    expect(executedTools[0].input).toEqual({ repo: 'whassan007/wazir', state: 'open' });
  });
});
