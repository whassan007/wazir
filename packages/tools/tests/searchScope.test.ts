import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool, ToolRegistry } from '../src/registry.js';

/**
 * Found by the Phase 24 live run (exec-muf57lmt-1): `search` with a nonexistent `path`
 * returned whole-project matches, the model concluded the directory existed, and it
 * re-globbed it until the repeated-action breaker stopped the run.
 */
describe('search and glob honor their directory scope', () => {
  let root: string;
  const registry = new ToolRegistry();
  const run = (tool: string, input: Record<string, unknown>) => executeTool(registry, tool, input, { projectRoot: root });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wazir-search-'));
    await mkdir(join(root, 'pkg/a'), { recursive: true });
    await mkdir(join(root, 'pkg/b'), { recursive: true });
    await writeFile(join(root, 'pkg/a/one.ts'), 'export const needle = 1;\n');
    await writeFile(join(root, 'pkg/b/two.ts'), 'export const needle = 2;\n');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('search only returns matches under the requested path', async () => {
    const result = await run('search', { pattern: 'needle', path: 'pkg/a' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('pkg/a/one.ts');
    expect(result.output).not.toContain('pkg/b/two.ts');
  });

  it('search without a path still covers the whole project', async () => {
    const result = await run('search', { pattern: 'needle' });
    expect(result.output).toContain('pkg/a/one.ts');
    expect(result.output).toContain('pkg/b/two.ts');
  });

  it('search and glob on a missing directory say so instead of answering', async () => {
    for (const [tool, input] of [['search', { pattern: 'needle', path: 'pkg/missing' }], ['glob', { pattern: '**/*.ts', path: 'pkg/missing' }]] as const) {
      const result = await run(tool, input);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("'pkg/missing' does not exist");
    }
  });
});
