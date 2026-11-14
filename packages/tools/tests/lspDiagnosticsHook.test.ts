import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  editTool,
  writeTool,
  multiEditTool,
  setPostEditDiagnosticsProvider,
  collectPostEditDiagnostics,
} from '../src/index.js';

describe('lspDiagnosticsHook (A053)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wazir-lsp-diag-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setPostEditDiagnosticsProvider(undefined);
  });

  it('appends TypeScript syntax diagnostics to editTool output without failing the edit', async () => {
    await writeTool.execute({ path: 'sample.ts', content: 'export const x = 1;\n' }, { projectRoot: dir });

    const res = await editTool.execute(
      { path: 'sample.ts', oldString: 'export const x = 1;', newString: 'export const x = ;' },
      { projectRoot: dir },
    );

    expect(res.ok).toBe(true);
    expect(res.output).toContain('[diagnostics]');
    expect(Array.isArray(res.metadata?.diagnostics)).toBe(true);
    expect((res.metadata?.diagnostics as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('appends JSON syntax diagnostics on writeTool and leaves valid JSON clean', async () => {
    const badRes = await writeTool.execute(
      { path: 'bad.json', content: '{"a": 1,}' },
      { projectRoot: dir },
    );

    expect(badRes.ok).toBe(true);
    expect(badRes.output).toContain('[diagnostics]');

    const goodRes = await writeTool.execute(
      { path: 'good.json', content: '{"a": 1}' },
      { projectRoot: dir },
    );

    expect(goodRes.ok).toBe(true);
    expect(goodRes.output).not.toContain('[diagnostics]');
  });

  it('appends diagnostics to multiEditTool when multi-hunk edit introduces syntax error', async () => {
    await writeTool.execute(
      { path: 'mod.ts', content: 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n' },
      { projectRoot: dir },
    );

    const res = await multiEditTool.execute(
      {
        path: 'mod.ts',
        edits: [
          {
            oldString: 'function b() {\n  return 2;\n}',
            newString: 'function b() {\n  return 2;\n',
          },
        ],
      },
      { projectRoot: dir },
    );

    expect(res.ok).toBe(true);
    expect(res.output).toContain('[diagnostics]');
  });

  it('supports custom LSP diagnostics provider and bounds slow providers via timeout', async () => {
    const customDiag = {
      line: 1,
      column: 15,
      severity: 'error' as const,
      message: 'Type string is not assignable to number',
      source: 'custom-lsp',
    };
    const mockProvider = vi.fn().mockResolvedValue([customDiag]);
    setPostEditDiagnosticsProvider(mockProvider);

    const res = await collectPostEditDiagnostics({
      projectRoot: dir,
      filePath: 'test.ts',
      resolvedPath: join(dir, 'test.ts'),
      content: 'export const x = 1;\n',
    });

    expect(mockProvider).toHaveBeenCalled();
    expect(res.entries).toEqual([customDiag]);
    expect(res.formatted).toContain('[custom-lsp]');

    const slowProvider = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return [customDiag];
    });
    setPostEditDiagnosticsProvider(slowProvider);

    const start = Date.now();
    const timeoutRes = await collectPostEditDiagnostics({
      projectRoot: dir,
      filePath: 'test.ts',
      resolvedPath: join(dir, 'test.ts'),
      content: 'export const x = 1;\n',
      timeoutMs: 80,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(600);
    expect(timeoutRes.entries).toEqual([]);
  });

  it('respects WAZIR_POST_EDIT_DIAGNOSTICS=0 opt-out in ToolExecutionContext.env', async () => {
    const res = await writeTool.execute(
      { path: 'broken.ts', content: 'export const x = ;' },
      { projectRoot: dir, env: { WAZIR_POST_EDIT_DIAGNOSTICS: '0' } },
    );

    expect(res.ok).toBe(true);
    expect(res.output).not.toContain('[diagnostics]');
  });
});
