import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MemoryStore } from '../../packages/shared/src/store.js';
import { CompetitiveExecution, raceGit, raceHash, type RacePolicy, type RaceConfiguration, type CompetitiveExecutionDependencies } from '../../packages/core/src/services/competitiveExecution.js';
import { WorktreeManager } from '../../packages/core/src/services/worktreeManager.js';
const exec = promisify(execFile);
export const policy: RacePolicy = { version: 1, writablePaths: ['src'], protectedPaths: ['acceptance.cjs'],
  checks: [{ name: 'acceptance', oracle: 'ACCEPTANCE', file: process.execPath, args: ['acceptance.cjs'] }],
  maxConcurrency: 3, timeoutMs: 15000, maxTurns: 4, maxTokens: 2048 };
export const config = (id: string): RaceConfiguration => ({ id, agent: 'fake', model: id, provider: 'fake-runtime', pricing: 'local', version: '1' });
export async function fixture(overrides: Partial<CompetitiveExecutionDependencies> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-race-fixture-'));
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Race Test'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@localhost'], { cwd: root });
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, '.wazir'));
  await fs.writeFile(path.join(root, '.gitignore'), '.wazir/\n');
  await fs.writeFile(path.join(root, 'src', 'add.cjs'), 'exports.add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(root, 'acceptance.cjs'), "const assert = require('node:assert/strict'); const {add} = require('./src/add.cjs'); assert.equal(add(2, 2), 4); assert.equal(add(-1, 1), 0); console.log('2 passed');\n");
  await raceGit(root, ['add', '-A']); await raceGit(root, ['commit', '-m', 'baseline']);
  const store = overrides.store ?? new MemoryStore(); const worktrees = overrides.worktrees ?? new WorktreeManager();
  const verificationRoots: string[] = [];
  const deps: CompetitiveExecutionDependencies = { store, worktrees,
    run: async ({ attempt, signal, event }) => {
      signal.throwIfAborted();
      await fs.writeFile(path.join(attempt.worktree!.worktreeDir, 'src/add.cjs'), 'exports.add = (a, b) => a + b;\n');
      await event('tool', { tool: 'write', ok: true });
      return { toolCalls: 1, toolFailures: 0 };
    },
    // Deliberately trusted deterministic CI fixture: no model-generated code or external APIs.
    // Production verification uses mandatory OS sandboxing in apps/cli/src/competitive.ts.
    verify: async (cwd, p, signal) => {
      verificationRoots.push(cwd);
      const started = Date.now(); let output = ''; let exitCode = 0;
      try { output = (await exec(process.execPath, ['acceptance.cjs'], { cwd, signal, env: { PATH: process.env.PATH }, timeout: 5000 })).stdout; }
      catch (e) { output = String((e as { stderr?: string }).stderr ?? e); exitCode = 1; }
      return p.checks.map(c => ({ name: c.name, passed: exitCode === 0, exitCode, output, outputHash: raceHash(output), durationMs: Date.now() - started }));
    }, ...overrides };
  const service = new CompetitiveExecution(deps);
  return { root, store, service, deps, verificationRoots,
    create: (configs = [config('a'), config('b')], p = policy) => service.create({ repository: root, task: 'Fix add in JavaScript src/add.cjs', configurations: configs, policy: p }),
    dispose: async () => {
      for (const r of await service.list()) if (r.promotion) await worktrees.removeWorktree(r.promotion.worktree);
      await fs.rm(path.join(os.tmpdir(), 'wazir-race-integration', '.wazir', 'worktrees', raceHash(root).slice(0, 16)), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
