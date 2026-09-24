import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@wazir/core';
import { executeTool, ToolRegistry } from '../src/registry.js';
import { shellTool, testTool } from '../src/process-tools.js';

/**
 * A tool timeout must stop the tool's process. Before this contract the shell and
 * check tools never received the abort signal: the registry reported
 * TOOL_OUTCOME_UNKNOWN while the process kept running unobserved, and every later
 * write (including the next verification check) was blocked on reconciliation.
 */
describe('tool timeout terminates the process and determines the outcome', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wazir-timeout-')); });
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

  it('kills a timed-out shell command: TOOL_TIMEOUT with observed mutations, and no later side effect', async () => {
    const quickShell: Tool = { descriptor: { ...shellTool.descriptor, name: 'quick_shell', timeoutMs: 300 }, execute: shellTool.execute };
    const registry = new ToolRegistry([quickShell]);
    const result = await executeTool(registry, 'quick_shell', { command: 'echo early > early.txt; sleep 2; echo late > late.txt' }, { projectRoot: root, verifyWorkspace: true });

    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('TOOL_TIMEOUT');
    expect(result.metadata?.processTerminated).toBe(true);
    // The write that happened before the timeout is recorded as a physical mutation...
    expect(result.fileMutations?.map(m => m.path)).toEqual(['early.txt']);
    // ...and the killed process can never add one after the result was recorded.
    await new Promise(r => setTimeout(r, 2500));
    expect(existsSync(join(root, 'late.txt'))).toBe(false);
  });

  it('a tool that cannot confirm termination still reports TOOL_OUTCOME_UNKNOWN', async () => {
    vi.useFakeTimers();
    const ignoresAbort: Tool = {
      descriptor: { name: 'stubborn', description: 'ignores abort', inputSchema: { type: 'object' }, permissions: ['shell_execute'], riskLevel: 'high', environment: 'local', timeoutMs: 100, terminatesOnAbort: true },
      execute: () => new Promise(() => undefined),
    };
    const pending = executeTool(new ToolRegistry([ignoresAbort]), 'stubborn', {}, { projectRoot: root });
    await vi.advanceTimersByTimeAsync(100 + 10_000);
    const result = await pending;
    expect(result.failureClass).toBe('TOOL_OUTCOME_UNKNOWN');
  });

  it('a write-capable tool without the contract is never assumed terminated', async () => {
    const noContract: Tool = {
      descriptor: { name: 'legacy', description: 'no contract', inputSchema: { type: 'object' }, permissions: ['shell_execute'], riskLevel: 'high', environment: 'local', timeoutMs: 50 },
      execute: (_input, ctx) => new Promise(resolve => ctx.signal?.addEventListener('abort', () => resolve({ ok: false, output: '', durationMs: 0 }))),
    };
    const result = await executeTool(new ToolRegistry([noContract]), 'legacy', {}, { projectRoot: root });
    expect(result.failureClass).toBe('TOOL_OUTCOME_UNKNOWN');
  });

  it('check tools get the registry ceiling they advertise (300s), not the 120s default', () => {
    const registry = new ToolRegistry([testTool]);
    expect(registry.get('test')!.descriptor.timeoutMs).toBe(300_000);
    expect(registry.get('test')!.descriptor.terminatesOnAbort).toBe(true);
  });
});
