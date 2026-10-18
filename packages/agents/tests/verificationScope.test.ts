import { describe, expect, it, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveVerificationScope } from '../src/verificationScope.js';

describe('resolveVerificationScope — maps changed files to the workspace(s) that own them', () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function makeFakeMonorepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-vscope-'));
    const pkg = async (rel: string, name: string) => {
      await fs.mkdir(path.join(dir, rel), { recursive: true });
      await fs.writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name }));
    };
    await pkg('packages/agents', '@wazir/agents');
    await pkg('packages/core', '@wazir/core');
    await pkg('packages/runtimes/lmstudio', '@wazir/runtime-lmstudio');
    await pkg('apps/cli', '@wazir/cli');
    await pkg('apps/desktop', '@wazir/desktop');
    return dir;
  }

  it('maps a single changed file to its owning workspace', async () => {
    root = await makeFakeMonorepo();
    const scope = resolveVerificationScope(root, ['packages/agents/src/codingAgent.ts']);
    expect(scope.workspaces).toEqual(['@wazir/agents']);
    expect(scope.fullScopeRequired).toBe(false);
  });

  it('maps changes across multiple workspaces to all of them, and never the untouched desktop app', async () => {
    root = await makeFakeMonorepo();
    const scope = resolveVerificationScope(root, [
      'packages/agents/src/codingAgent.ts',
      'packages/core/src/services/index.ts',
    ]);
    expect(new Set(scope.workspaces)).toEqual(new Set(['@wazir/agents', '@wazir/core']));
    expect(scope.workspaces).not.toContain('@wazir/desktop');
    expect(scope.fullScopeRequired).toBe(false);
  });

  it('resolves the packages/runtimes/* nested workspace glob correctly', async () => {
    root = await makeFakeMonorepo();
    const scope = resolveVerificationScope(root, ['packages/runtimes/lmstudio/src/index.ts']);
    expect(scope.workspaces).toEqual(['@wazir/runtime-lmstudio']);
  });

  it('requires full scope when a changed file is outside every known workspace', async () => {
    root = await makeFakeMonorepo();
    const scope = resolveVerificationScope(root, ['scripts/release-verify.mjs']);
    expect(scope.fullScopeRequired).toBe(true);
  });

  it('requires full scope if even one of several changed files is outside a workspace', async () => {
    root = await makeFakeMonorepo();
    const scope = resolveVerificationScope(root, [
      'packages/agents/src/codingAgent.ts',
      'package.json',
    ]);
    expect(scope.fullScopeRequired).toBe(true);
  });

  it('is a no-op (no fallback needed) when nothing changed', async () => {
    root = await makeFakeMonorepo();
    const scope = resolveVerificationScope(root, []);
    expect(scope.workspaces).toEqual([]);
    expect(scope.fullScopeRequired).toBe(false);
  });
});
