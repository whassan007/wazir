import { describe, expect, it, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTool } from '../src/process-tools.js';

/** Regression coverage for P0-A: the build/test/lint/typecheck tools must scope to named
 *  npm workspaces (`--workspace <name> --if-present`) when asked, instead of always running
 *  the root script across the whole repo. */
describe('check tools — workspace scoping', () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function makeFakeWorkspaceRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-check-scope-'));
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
        scripts: { build: 'node -e "console.error(\'ROOT BUILD RAN\')"' },
      }),
    );
    await fs.mkdir(path.join(dir, 'packages', 'a'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: '@fake/a', scripts: { build: 'node -e "console.error(\'A BUILD RAN\')"' } }),
    );
    await fs.mkdir(path.join(dir, 'packages', 'b'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'packages', 'b', 'package.json'),
      JSON.stringify({ name: '@fake/b', scripts: { build: 'node -e "console.error(\'B BUILD RAN\')"' } }),
    );
    return dir;
  }

  it('scoped to one workspace runs only that workspace\'s script, never the root or an unrelated workspace', async () => {
    root = await makeFakeWorkspaceRepo();
    const result = await buildTool.execute({ workspaces: ['@fake/a'] }, { projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('A BUILD RAN');
    expect(result.output).not.toContain('B BUILD RAN');
    expect(result.output).not.toContain('ROOT BUILD RAN');
    expect((result.metadata?.command as string)).toContain('--workspace @fake/a');
    expect((result.metadata?.command as string)).toContain('--if-present');
  }, 20_000);

  it('with no workspaces specified, runs the full root script as before', async () => {
    root = await makeFakeWorkspaceRepo();
    const result = await buildTool.execute({}, { projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('ROOT BUILD RAN');
  }, 20_000);
});
