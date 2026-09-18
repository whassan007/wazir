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

  it('runs a script whose package.json body contains shell metacharacters because gate is by name, not content', async () => {
    await fs.writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ scripts: { 'audit:full': 'echo start && echo finished' } }),
      'utf8',
    );

    const result = await testTool.execute({ script: 'audit:full' }, { projectRoot: project });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('start');
    expect(result.output).toContain('finished');
  });

  it('rejects script names supplied with indirection or traversal', async () => {
    await fs.writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo test' } }),
      'utf8',
    );

    const result1 = await testTool.execute({ script: '../test' }, { projectRoot: project });
    expect(result1.ok).toBe(false);
    expect(result1.error).toMatch(/missing script/);

    const result2 = await testTool.execute({ script: '$TEST_SCRIPT' }, { projectRoot: project });
    expect(result2.ok).toBe(false);
    expect(result2.error).toMatch(/missing script/);
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

  it('rejects a symlink chain where the terminal target escapes the project', async () => {
    // Chain: linkA -> linkB -> outside/secret.txt
    const linkB = path.join(project, 'linkB.txt');
    const linkA = path.join(project, 'linkA.txt');
    await fs.symlink(path.join(outside, 'secret.txt'), linkB);
    await fs.symlink(linkB, linkA);

    await expect(assertInsideProject(project, 'linkA.txt')).rejects.toBeInstanceOf(PathEscapeError);

    const result = await readTool.execute({ path: 'linkA.txt' }, { projectRoot: project });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes the project root/);
  });

  it('rejects relative path traversal combined with an internal symlink', async () => {
    // parentlink points to parent dir ('..')
    // Lexically, 'parentlink/outside/secret.txt' is inside project/parentlink/...
    // But canonically, it resolves to outside/secret.txt
    await fs.symlink('..', path.join(project, 'parentlink'));

    await expect(assertInsideProject(project, 'parentlink/outside/secret.txt')).rejects.toBeInstanceOf(PathEscapeError);

    const result = await readTool.execute({ path: 'parentlink/outside/secret.txt' }, { projectRoot: project });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes the project root/);
  });
});

describe('F-13: tool subprocesses get a minimal environment', () => {
  it('does not inherit credential-bearing variables from the operator process', async () => {
    const { shellTool } = await import('../src/process-tools.js');
    const { childEnvironment } = await import('../src/process.js');
    process.env.WAZIR_TEST_SECRET_TOKEN = 'do-not-leak';
    process.env.WAZIR_TEST_PASSTHROUGH = 'visible';
    process.env.WAZIR_CHILD_ENV = 'WAZIR_TEST_PASSTHROUGH';
    try {
      const env = childEnvironment();
      expect(env.WAZIR_TEST_SECRET_TOKEN).toBeUndefined();
      expect(env.WAZIR_TEST_PASSTHROUGH).toBe('visible');
      expect(env.PATH).toBe(process.env.PATH);

      const result = await shellTool.execute(
        { command: 'echo "secret=${WAZIR_TEST_SECRET_TOKEN:-unset} pass=${WAZIR_TEST_PASSTHROUGH:-unset}"' },
        { projectRoot: project, taskId: 't', executionId: 'e' } as never,
      );
      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe('secret=unset pass=visible');
    } finally {
      delete process.env.WAZIR_TEST_SECRET_TOKEN;
      delete process.env.WAZIR_TEST_PASSTHROUGH;
      delete process.env.WAZIR_CHILD_ENV;
    }
  });
});

describe('F-20: file tools do not follow a symlink swapped in after the containment check', () => {
  it('read and write refuse a final-component symlink that points outside the project', async () => {
    const link = path.join(project, 'link.txt');
    await fs.symlink(path.join(outside, 'secret.txt'), link);
    const read = await readTool.execute({ path: 'link.txt' }, { projectRoot: project, taskId: 't', executionId: 'e' } as never);
    expect(read.ok).toBe(false);
    const write = await writeTool.execute({ path: 'link.txt', content: 'pwned' }, { projectRoot: project, taskId: 't', executionId: 'e' } as never);
    expect(write.ok).toBe(false);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('opens with O_NOFOLLOW so even an in-project symlink is not followed at open time', async () => {
    const { readProjectFile, writeProjectFile } = await import('../src/paths.js');
    await fs.symlink(path.join(project, 'inside.txt'), path.join(project, 'alias.txt'));
    // A symlink whose target is inside the project passes the lexical/realpath
    // check, but I/O happens on the canonical target, never through the link.
    const read = await readProjectFile(project, 'alias.txt');
    expect(read.content).toBe('hello');
    await writeProjectFile(project, 'alias.txt', 'updated');
    expect(await fs.readFile(path.join(project, 'inside.txt'), 'utf8')).toBe('updated');
    expect((await fs.lstat(path.join(project, 'alias.txt'))).isSymbolicLink()).toBe(true);
  });
});
