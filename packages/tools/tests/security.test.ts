import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTool, writeTool, editTool } from '../src/filesystem.js';
import { globTool } from '../src/search.js';
import { testTool, buildTool } from '../src/process-tools.js';
import { assertInsideProject, PathEscapeError } from '../src/paths.js';

let sandbox: string;
let project: string;
let outside: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-tools-'));
  project = path.join(sandbox, 'project');
  outside = path.join(sandbox, 'outside');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');
  await fs.writeFile(path.join(project, 'inside.txt'), 'hello', 'utf8');
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('check tools cannot run arbitrary commands', () => {
  it('rejects a free-form command override', async () => {
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'echo ran-test' } }), 'utf8');
    const marker = path.join(project, 'pwned');

    const result = await testTool.execute({ command: `touch ${marker}` } as Record<string, unknown>, { projectRoot: project });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('ran-test');
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('refuses script names that are not defined in package.json', async () => {
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'echo ran-test' } }), 'utf8');
    const marker = path.join(project, 'pwned');

    const result = await testTool.execute({ script: `test; touch ${marker}` }, { projectRoot: project });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing script/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('reports a missing default script instead of running a fallback', async () => {
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8');

    const result = await buildTool.execute({}, { projectRoot: project });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing script: 'build'/);
  });

  it('runs an alternative script only when it exists', async () => {
    await fs.writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ scripts: { 'test:unit': 'echo ran-unit' } }),
      'utf8',
    );

    const result = await testTool.execute({ script: 'test:unit' }, { projectRoot: project });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('ran-unit');
  });
});

describe('project containment resolves symlinks', () => {
  it('rejects a file symlink that points outside the project', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'escape.txt'));

    await expect(assertInsideProject(project, 'escape.txt')).rejects.toBeInstanceOf(PathEscapeError);

    const result = await readTool.execute({ path: 'escape.txt' }, { projectRoot: project });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes the project root/);
    expect(result.output).not.toContain('top secret');
  });

  it('rejects writes through a directory symlink that points outside the project', async () => {
    await fs.symlink(outside, path.join(project, 'escape-dir'));

    const result = await writeTool.execute({ path: 'escape-dir/dropped.txt', content: 'x' }, { projectRoot: project });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes the project root/);
    await expect(fs.access(path.join(outside, 'dropped.txt'))).rejects.toThrow();
  });

  it('rejects edits through a symlink that points outside the project', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'escape.txt'));

    const result = await editTool.execute(
      { path: 'escape.txt', oldString: 'top', newString: 'not' },
      { projectRoot: project },
    );

    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('rejects glob roots that resolve outside the project', async () => {
    await fs.symlink(outside, path.join(project, 'escape-dir'));

    const result = await globTool.execute({ pattern: '**/*', path: 'escape-dir' }, { projectRoot: project });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes the project root/);
  });

  it('still rejects lexical traversal', async () => {
    const result = await readTool.execute({ path: '../outside/secret.txt' }, { projectRoot: project });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes the project root/);
  });

  it('allows symlinks that stay inside the project', async () => {
    await fs.symlink(path.join(project, 'inside.txt'), path.join(project, 'alias.txt'));

    const result = await readTool.execute({ path: 'alias.txt' }, { projectRoot: project });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('allows creating new files in not-yet-existing directories inside the project', async () => {
    const result = await writeTool.execute({ path: 'new/dir/file.txt', content: 'created' }, { projectRoot: project });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(project, 'new', 'dir', 'file.txt'), 'utf8')).toBe('created');
  });
});
