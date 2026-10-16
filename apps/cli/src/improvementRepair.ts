import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WorktreeManager } from '@wazir/core';
import type { KeyValueStore } from '@wazir/shared';
import type { ImprovementMode, SupervisorResult } from '@wazir/evaluation';
import type { RookEngine } from './engine.js';

export interface ScopedPatch {
  file: string;
  oldString: string;
  newString: string;
}

export interface RepairScope {
  version: 1;
  repository: string;
  mode: ImprovementMode;
  prompt: string;
  files: string[];
  checks: Array<{ command: string; args: string[] }>;
  agent: string;
  model?: string;
  patches?: ScopedPatch[];
  authorizedFeature?: string;
  timeoutMs?: number;
  maxTurns?: number;
  allowWeakModel?: boolean;
}

const WEAK_CODING_MODELS = new Set([
  'nvidia/nemotron-3-nano-omni',
  'qwen2.5-7b-instruct',
]);

/**
 * No shell interpolation. Each subprocess has a wall-clock budget and its own
 * process group, terminated as a unit on cancellation or timeout.
 */
export async function boundedCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; durationMs: number }> {
  if (signal?.aborted) throw new Error('Interrupted');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let output = '';
    let interrupted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-256_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = (name: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    };
    const terminate = () => {
      interrupted = true;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(terminate, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', terminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      // The group can outlive its leader; do not leave grandchildren running.
      kill('SIGKILL');
      cleanup();
      resolve({
        exitCode: interrupted ? 124 : (code ?? 1),
        output,
        durationMs: Date.now() - started,
      });
    });
  });
}

function validateScope(value: any, repository: string): asserts value is RepairScope {
  if (value.version !== 1 || path.resolve(value.repository ?? '') !== path.resolve(repository)) {
    throw new Error('Scope version/repository mismatch');
  }
  if (!['harden', 'optimize', 'evolve'].includes(value.mode)) {
    throw new Error('Invalid scope mode');
  }
  if (value.mode === 'evolve' && (typeof value.authorizedFeature !== 'string' || !value.authorizedFeature.trim())) {
    throw new Error('EVOLVE scope requires authorizedFeature');
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000) {
    throw new Error('Invalid bounded repair prompt');
  }
  if (typeof value.agent !== 'string' || !value.agent) {
    throw new Error('Explicit coding agent required');
  }
  if (value.agent === 'wazir-coding' && !value.model) {
    throw new Error('Explicit coding model required');
  }
  if (
    value.agent === 'wazir-coding' &&
    value.model &&
    WEAK_CODING_MODELS.has(value.model) &&
    !value.allowWeakModel
  ) {
    throw new Error(
      `Model '${value.model}' is disqualified for multi-step source repair due to recorded tool-protocol failures`,
    );
  }
  if (value.agent === 'scoped-patch') {
    if (
      !Array.isArray(value.patches) ||
      value.patches.length === 0 ||
      value.patches.some(
        (p: any) =>
          typeof p?.file !== 'string' ||
          typeof p?.oldString !== 'string' ||
          typeof p?.newString !== 'string' ||
          !p.oldString.length,
      )
    ) {
      throw new Error('scoped-patch agent requires non-empty patches array');
    }
  }
  if (
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 20 ||
    value.files.some(
      (file: unknown) =>
        typeof file !== 'string' ||
        path.isAbsolute(file) ||
        file.split(/[\\/]/).some((part) => part === '..' || part === '.git') ||
        /(^|\/)(test|tests|__tests__)(\/|\.)|\.(test|spec)\./i.test(file),
    )
  ) {
    throw new Error('Scope must name 1..20 source files; test oracles cannot be repair targets');
  }
  if (
    !Array.isArray(value.checks) ||
    !value.checks.length ||
    value.checks.length > 10 ||
    value.checks.some(
      (check: any) =>
        typeof check.command !== 'string' ||
        !check.command ||
        !Array.isArray(check.args) ||
        check.args.some((arg: unknown) => typeof arg !== 'string'),
    )
  ) {
    throw new Error('Independent check argv required');
  }
  if (!Number.isInteger(value.maxTurns ?? 8) || (value.maxTurns ?? 8) < 1 || (value.maxTurns ?? 8) > 20) {
    throw new Error('Turn budget must be 1..20');
  }
  if (
    !Number.isInteger(value.timeoutMs ?? 120000) ||
    (value.timeoutMs ?? 120000) < 1000 ||
    (value.timeoutMs ?? 120000) > 600000
  ) {
    throw new Error('Timeout budget must be 1000..600000ms');
  }
}

export async function executeRepairScope(params: {
  scope: string;
  id: string;
  modes: ImprovementMode[];
  engine: RookEngine;
  store: KeyValueStore;
  signal: AbortSignal;
  directory: string;
}): Promise<SupervisorResult> {
  const scopeText = await fs.readFile(params.scope, 'utf8');
  if (scopeText.length > 64000) throw new Error('Scope exceeds 64KB');
  const scope: unknown = JSON.parse(scopeText);
  validateScope(scope, params.engine.projectRoot);
  if (!params.modes.includes(scope.mode)) {
    return { decision: 'INCONCLUSIVE', reason: 'Scope mode is not enabled' };
  }
  if (scope.mode === 'optimize' && !scope.patches && !scope.checks.length) {
    return { decision: 'INCONCLUSIVE', reason: 'Comparable measured optimization adapter is not configured' };
  }
  const key = 'supervisor/scopes/' + createHash('sha256').update(scopeText).digest('hex');
  const prior = await params.store.get(key);
  if (prior) {
    return {
      decision: 'INCONCLUSIVE',
      reason: 'Scope already attempted; inspect retained evidence and authorize a revised scope before retry',
    };
  }
  // Claim before any potentially mutating/external work; interrupted attempts are never replayed.
  await params.store.put(key, { attemptId: params.id, claimedAt: new Date().toISOString() });

  const timeoutMs = scope.timeoutMs ?? 120000;
  const manager = new WorktreeManager({ worktreeRootDir: path.join(params.directory, 'candidates') });
  if (!(await manager.isGitRepo(params.engine.projectRoot))) {
    throw new Error('Repair requires a Git repository');
  }
  const worktree = await manager.createWorktree(params.engine.projectRoot, `improve-${params.id}`);
  await params.store.put(`supervisor/workspaces/${params.id}`, worktree);
  const cwd = worktree.worktreeDir;

  const git = async (args: string[]) => {
    const result = await boundedCommand('git', args, cwd, 10000, params.signal);
    if (result.exitCode !== 0) throw new Error('Candidate Git inspection failed');
    return result.output.trim();
  };

  const baseSha = await git(['rev-parse', 'HEAD']);
  const runChecks = async () => {
    const results = [];
    for (const check of scope.checks) {
      results.push(await boundedCommand(check.command, check.args, cwd, Math.min(timeoutMs, 60000), params.signal));
    }
    return results;
  };

  const baseline = await runChecks();
  if (scope.mode === 'harden' && !baseline.some((result) => result.exitCode === 1)) {
    return {
      decision: 'INCONCLUSIVE',
      reason: 'Independent oracle did not reproduce the defect (expected exit 1)',
      evidence: {
        worktree,
        baseSha,
        baseline: baseline.map(({ output, ...result }) => result),
      },
    };
  }
  if (baseline.some((result) => ![0, 1].includes(result.exitCode))) {
    return {
      decision: 'INCONCLUSIVE',
      reason: 'Baseline infrastructure/check failed; repair not attempted',
    };
  }

  let agentExitCode = 0;
  if (scope.agent === 'scoped-patch' && scope.patches) {
    try {
      for (const patch of scope.patches) {
        if (!scope.files.includes(patch.file)) {
          throw new Error(`Patch target '${patch.file}' is outside authorized scope.files`);
        }
        const target = path.join(cwd, patch.file);
        const content = await fs.readFile(target, 'utf8');
        if (!content.includes(patch.oldString)) {
          throw new Error(`oldString not found in '${patch.file}'`);
        }
        await fs.writeFile(target, content.replace(patch.oldString, patch.newString), 'utf8');
      }
    } catch {
      agentExitCode = 1;
    }
  } else {
    const cliEntry = path.resolve(process.argv[1]);
    const args = [
      cliEntry,
      'task',
      'run',
      `${scope.mode.toUpperCase()} scoped repair. ${
        scope.mode === 'harden' ? 'Repair the reproduced defect; do not add features.' : scope.authorizedFeature ?? ''
      }\n${scope.prompt}\nOnly modify these source files: ${scope.files.join(
        ', ',
      )}. Preserve all independent tests and other files. Do not commit, merge, push, or alter Git metadata.`,
      '--type',
      'coding',
      '--agent',
      scope.agent,
      '--max-turns',
      String(scope.maxTurns ?? 8),
      '--json',
    ];
    if (scope.model) args.push('--model', scope.model);
    const agent = await boundedCommand(process.execPath, args, cwd, timeoutMs, params.signal);
    agentExitCode = agent.exitCode;
  }

  // Capture evidence before independent checks; narration or child exit 0 alone is insufficient.
  const changed = [
    ...new Set(
      (await git(['diff', '--name-only', baseSha]))
        .split('\n')
        .concat((await git(['ls-files', '--others', '--exclude-standard'])).split('\n')),
    ),
  ].filter(Boolean);

  if (!changed.length || changed.some((file) => !scope.files.includes(file))) {
    return {
      decision: 'REJECTED',
      reason: 'Repair changed no source or modified files outside the authorized scope',
      evidence: { worktree, baseSha, changed, agentExitCode },
    };
  }

  const digest = async () => {
    const hash = createHash('sha256');
    for (const file of scope.files) {
      const target = path.join(cwd, file);
      if (!(await fs.lstat(target)).isFile()) throw new Error('Source target must be a regular file');
      hash.update(file).update(await fs.readFile(target));
    }
    return hash.digest('hex');
  };

  const fingerprint = await digest();
  const candidate = await runChecks();
  const stable = fingerprint === (await digest());
  const passed = agentExitCode === 0 && candidate.every((result) => result.exitCode === 0) && stable;

  return {
    decision: passed ? 'STAGED' : 'REJECTED',
    reason: passed
      ? 'Real source repair passed independent checks; isolated candidate retained for review'
      : 'Agent, independent verification, or revision stability failed',
    evidence: {
      worktree,
      baseSha,
      fingerprint,
      changed,
      agentExitCode,
      baseline: baseline.map(({ output, ...result }) => result),
      candidate: candidate.map(({ output, ...result }) => result),
    },
  };
}
