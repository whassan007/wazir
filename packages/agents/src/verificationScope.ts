import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

interface WorkspaceDir {
  dir: string;
  name: string;
}

function readPackageName(pkgJsonPath: string): string | undefined {
  try {
    const name = (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Mirrors this repo's `package.json` `workspaces` globs: `packages/*`, `packages/runtimes/*`, `apps/*`. */
function listWorkspaceDirs(projectRoot: string): WorkspaceDir[] {
  const out: WorkspaceDir[] = [];
  for (const container of ['packages', 'apps']) {
    const containerPath = path.join(projectRoot, container);
    let entries: string[] = [];
    try {
      entries = readdirSync(containerPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(containerPath, entry);
      if (entry === 'runtimes' && container === 'packages') {
        // packages/runtimes/* is its own workspace glob, one level deeper.
        let runtimeEntries: string[] = [];
        try {
          runtimeEntries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const runtimeEntry of runtimeEntries) {
          const runtimeDir = path.join(dir, runtimeEntry);
          const name = readPackageName(path.join(runtimeDir, 'package.json'));
          if (name) out.push({ dir: runtimeDir, name });
        }
        continue;
      }
      const name = readPackageName(path.join(dir, 'package.json'));
      if (name) out.push({ dir, name });
    }
  }
  return out;
}

export interface VerificationScope {
  /** Workspace package names actually touched by the changed files. */
  workspaces: string[];
  /** True when at least one changed file falls outside every known workspace (repo root,
   *  `scripts/`, docs, etc.) — scoping can't be justified, caller should fall back to a full,
   *  unscoped run rather than silently narrow verification. */
  fullScopeRequired: boolean;
}

/**
 * Maps a task's changed files to the workspace package(s) they belong to, so VERIFY can scope
 * build/test/lint/typecheck to only what the task actually touched instead of the whole
 * monorepo (see test/agy-mac-gemma/issues-ranked.md P0-5: a one-file Python/JS change was
 * triggering a Tauri desktop build that needs network access this environment doesn't have).
 */
export function resolveVerificationScope(projectRoot: string, changedFiles: Iterable<string>): VerificationScope {
  const files = [...changedFiles];
  if (files.length === 0) return { workspaces: [], fullScopeRequired: false };
  const dirs = listWorkspaceDirs(projectRoot);
  const matched = new Set<string>();
  let fullScopeRequired = false;
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    const owner = dirs.find((d) => abs === d.dir || abs.startsWith(d.dir + path.sep));
    if (owner) matched.add(owner.name);
    else fullScopeRequired = true;
  }
  return { workspaces: [...matched], fullScopeRequired };
}
