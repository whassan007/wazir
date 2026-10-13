import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectOracleWeakening, isVerificationAsset, type CheckRunRecord, type ExecutionEngine } from '@wazir/core';
import { generateId, keepEnds } from '@wazir/shared';
import { executeTool, snapshotWorkspace, workspaceFingerprint, workspaceMutations, type ToolRegistry, type WorkspaceSnapshot } from '@wazir/tools';

/** The checks Wazir runs itself after a delegated agent changes source code, in order. */
const DELEGATION_CHECKS = ['build', 'typecheck', 'lint', 'test'] as const;
/** Verification assets larger than this are not kept for oracle comparison. */
const MAX_ASSET_BYTES = 512 * 1024;

export interface DelegationBaseline {
  snapshot: WorkspaceSnapshot;
  /** Contents of verification assets (tests, expected outputs) before the agent ran. */
  assets: Map<string, string>;
  /** package.json scripts before the agent ran; they define what the checks execute. */
  scripts: Record<string, string>;
}

async function readScripts(root: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

/** Captured before a delegated agent runs. Throws when the workspace cannot be observed. */
export async function captureDelegationBaseline(root: string): Promise<DelegationBaseline> {
  const snapshot = await snapshotWorkspace(root);
  const assets = new Map<string, string>();
  for (const rel of snapshot.keys()) {
    if (!isVerificationAsset(rel)) continue;
    const content = await readFile(path.join(root, rel)).catch(() => undefined);
    if (content && content.length <= MAX_ASSET_BYTES) assets.set(rel, content.toString('utf8'));
  }
  return { snapshot, assets, scripts: await readScripts(root) };
}

export interface DelegationVerificationContext {
  executions: ExecutionEngine;
  tools: ToolRegistry;
  executionId: string;
  projectRoot: string;
  networkAllowed: boolean;
  /** The task explicitly asks to change tests or expected outputs. */
  allowVerificationChanges: boolean;
  touchesSourceCode: (files: string[]) => boolean;
}

/**
 * A delegated agent (Claude Code, Codex, ...) edits files with its own tools, so Wazir's tool
 * layer sees none of it, and its exit code says nothing about the result. This observes what
 * changed on disk, records it as file mutations, refuses changes that weaken the checks
 * themselves, and runs the project's own checks at the new revision — so evaluation rests
 * on evidence (`checks_pass` for source changes), not on the agent's word.
 * Problems are recorded as execution errors, which fail evaluation.
 */
export async function verifyDelegatedWork(ctx: DelegationVerificationContext, baseline: DelegationBaseline): Promise<{ changed: string[]; problems: string[] }> {
  const problems: string[] = [];
  const fail = async (message: string) => {
    problems.push(message);
    await ctx.executions.recordError(ctx.executionId, message);
  };

  let after: WorkspaceSnapshot;
  try {
    after = await snapshotWorkspace(ctx.projectRoot);
  } catch (error) {
    await fail(`UNVERIFIED: cannot observe the workspace after delegation (${(error as Error).message})`);
    return { changed: [], problems };
  }
  const mutations = workspaceMutations(baseline.snapshot, after, true);
  const changed = mutations.map((m) => m.path);
  await ctx.executions.recordFileMutations(ctx.executionId, mutations, workspaceFingerprint(after));
  if (changed.length === 0) return { changed, problems };

  if (!ctx.allowVerificationChanges) {
    for (const rel of changed) {
      if (!isVerificationAsset(rel)) continue;
      const before = baseline.assets.get(rel) ?? null;
      const now = await readFile(path.join(ctx.projectRoot, rel), 'utf8').catch(() => null);
      for (const f of detectOracleWeakening(rel, before, now)) {
        await fail(`VERIFICATION_PROTECTED: delegated agent ${f.kind} in ${f.path} (${f.detail}); the task did not ask to change its tests`);
      }
    }
  }

  if (!ctx.touchesSourceCode(changed)) return { changed, problems };

  const scripts = await readScripts(ctx.projectRoot);
  for (const name of DELEGATION_CHECKS) {
    if (scripts[name] !== baseline.scripts[name]) {
      await fail(`VERIFICATION_PROTECTED: delegated agent changed the '${name}' script in package.json; its result cannot verify the agent's own work`);
      continue;
    }
    if (!(name in scripts)) continue;
    const result = await executeTool(ctx.tools, name, {}, {
      callId: generateId('call-'),
      allowedTools: [name],
      agentId: 'wazir-verifier',
      projectRoot: ctx.projectRoot,
      executionId: ctx.executionId,
      networkAllowed: ctx.networkAllowed,
    } as Parameters<typeof executeTool>[3]);
    const check: CheckRunRecord = {
      workspaceRevision: ctx.executions.getWorkspaceRevision(ctx.executionId),
      name,
      command: `npm run ${name}`,
      ok: result.ok,
      output: keepEnds(result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n'), 4000),
      durationMs: result.durationMs,
    };
    await ctx.executions.recordCheck(ctx.executionId, check);
  }
  return { changed, problems };
}
