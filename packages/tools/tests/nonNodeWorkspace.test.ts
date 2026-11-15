import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PolicyEngine } from '@wazir/core';
import { readTool } from '../src/filesystem.js';
import { assertInsideProject, PathEscapeError, resolveInsideProject } from '../src/paths.js';
import { buildTool, lintTool, testTool, typecheckTool } from '../src/process-tools.js';
import { globTool, searchTool } from '../src/search.js';

let sandbox: string;
let project: string;
let outside: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-nonnode-'));
  project = path.join(sandbox, 'sim-repo');
  outside = path.join(sandbox, 'outside');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'main.py'), 'def hello():\n    return "sim"\n', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8');
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('non-Node workspace check tools (no root package.json)', () => {
  it('returns a structured not-applicable result instead of crashing with ENOENT when no manifest exists', async () => {
    for (const tool of [testTool, lintTool, typecheckTool, buildTool]) {
      const result = await tool.execute({}, { projectRoot: project });
      expect(result.ok, result.error).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('not applicable');
      expect(result.output).toContain('no package.json');
      expect(result.metadata?.applicable).toBe(false);
      expect(result.metadata?.reason).toBe('no_package_json');
    }
  });

  it('detects Python projects (pyproject.toml) without package.json and still rejects arbitrary script overrides', async () => {
    await fs.writeFile(path.join(project, 'pyproject.toml'), '[project]\nname = "sim"\nversion = "0.1.0"\n', 'utf8');

    const buildRes = await buildTool.execute({}, { projectRoot: project });
    expect(buildRes.ok, buildRes.error).toBe(true);
    expect(buildRes.output).toContain('not applicable');
    expect(buildRes.metadata?.projectType).toBe('python');

    const lintRes = await lintTool.execute({}, { projectRoot: project });
    expect(lintRes.ok, lintRes.error).toBe(true);
    expect(lintRes.metadata?.projectType).toBe('python');

    const typecheckRes = await typecheckTool.execute({}, { projectRoot: project });
    expect(typecheckRes.ok, typecheckRes.error).toBe(true);
    expect(typecheckRes.metadata?.projectType).toBe('python');

    const overrideRes = await testTool.execute({ script: 'rm -rf /' }, { projectRoot: project });
    expect(overrideRes.ok).toBe(false);
    expect(overrideRes.error).toMatch(/no package\.json/);
  });

  it('detects Makefile targets when package.json is absent', async () => {
    await fs.writeFile(path.join(project, 'Makefile'), 'test:\n\t@echo makefile-test-ok\n', 'utf8');

    const result = await testTool.execute({}, { projectRoot: project });
    expect(result.ok, result.error).toBe(true);
    expect(result.output).toContain('makefile-test-ok');
    expect(result.metadata?.projectType).toBe('make');
  }, 15_000);
});

describe('worktree and authorized workspace path resolution', () => {
  it('resolves relative paths, ".", and repo-root paths cleanly inside a worktree root', async () => {
    const worktreeRoot = path.join(project, '.wazir', 'worktrees', 'wt-1');
    await fs.mkdir(path.join(worktreeRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(worktreeRoot, 'src', 'app.py'), 'VALUE = 42\n', 'utf8');

    const dotResolved = await assertInsideProject(worktreeRoot, '.');
    expect(dotResolved).toBe(path.resolve(worktreeRoot));

    const relResolved = await resolveInsideProject(worktreeRoot, './src/app.py');
    expect(relResolved.resolved).toBe(path.resolve(worktreeRoot, 'src/app.py'));

    const readRes = await readTool.execute({ path: 'src/app.py' }, { projectRoot: worktreeRoot });
    expect(readRes.ok, readRes.error).toBe(true);
    expect(readRes.output).toContain('VALUE = 42');

    const globRes = await globTool.execute({ pattern: '**/*.py', path: '.' }, { projectRoot: worktreeRoot });
    expect(globRes.ok, globRes.error).toBe(true);
    expect(globRes.output).toContain('src/app.py');

    const searchRes = await searchTool.execute({ regex: 'VALUE', path: '.' }, { projectRoot: worktreeRoot });
    expect(searchRes.ok, searchRes.error).toBe(true);
    expect(searchRes.output).toContain('src/app.py:1:');
  });

  it('resolves canonicalized paths inside a symlinked worktree root back to the authorized root', async () => {
    const realWorktree = path.join(sandbox, 'real-worktree');
    const symlinkWorktree = path.join(sandbox, 'linked-worktree');
    await fs.mkdir(path.join(realWorktree, 'src'), { recursive: true });
    await fs.writeFile(path.join(realWorktree, 'src', 'lib.rs'), 'pub fn ok() -> bool { true }\n', 'utf8');
    await fs.symlink(realWorktree, symlinkWorktree);

    const canonicalTarget = path.join(await fs.realpath(realWorktree), 'src', 'lib.rs');
    const { resolved, real } = await resolveInsideProject(symlinkWorktree, canonicalTarget);
    expect(resolved).toBe(path.resolve(symlinkWorktree, 'src/lib.rs'));
    expect(real).toBe(await fs.realpath(path.join(realWorktree, 'src', 'lib.rs')));

    const readRes = await readTool.execute({ path: canonicalTarget }, { projectRoot: symlinkWorktree });
    expect(readRes.ok, readRes.error).toBe(true);
    expect(readRes.output).toContain('pub fn ok()');
  });
});

describe('unauthorized path traversal and outside-workspace access remain blocked', () => {
  it('blocks ../, /etc/passwd, /workspace, and outside symlinks in paths.ts and file tools', async () => {
    await expect(assertInsideProject(project, '../outside/secret.txt')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(assertInsideProject(project, '/etc/passwd')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(assertInsideProject(project, '/workspace/secret.txt')).rejects.toBeInstanceOf(PathEscapeError);

    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'escape.txt'));
    await expect(assertInsideProject(project, 'escape.txt')).rejects.toBeInstanceOf(PathEscapeError);

    const readOutside = await readTool.execute({ path: '/etc/passwd' }, { projectRoot: project });
    expect(readOutside.ok).toBe(false);
    expect(readOutside.error).toMatch(/escapes the project root/);

    const readWorkspace = await readTool.execute({ path: '/workspace/secret.txt' }, { projectRoot: project });
    expect(readWorkspace.ok).toBe(false);
    expect(readWorkspace.error).toMatch(/escapes the project root/);
  });

  it('PolicyEngine allows authorized workspace paths and denies ../, /etc/passwd, and /workspace outside projectRoot', () => {
    const engine = new PolicyEngine({ projectRoot: project });

    expect(engine.classify({ tool: 'glob', input: {} }).decision).toBe('allow');
    expect(engine.classify({ tool: 'search', input: { regex: 'hello', path: '.' } }).decision).toBe('allow');
    expect(engine.classify({ tool: 'read', input: { path: 'src/main.py' } }).decision).toBe('allow');

    for (const badPath of ['../outside/secret.txt', '/etc/passwd', '/workspace', '/workspace/main.py']) {
      const decision = engine.classify({ tool: 'read', input: { path: badPath } });
      expect(decision.decision, badPath).toBe('deny');
      expect(decision.rule, badPath).toBe('filesystem-outside-deny');
    }
  });
});
