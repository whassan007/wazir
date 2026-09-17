import { promises as fs } from 'node:fs';
import path from 'node:path';

export function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

export const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.rook', '.wazir',
]);

/** Canonical path of `target`, or of its deepest existing ancestor joined with the missing tail. */
async function canonicalize(target: string): Promise<string> {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Verifies `target` stays inside `root` both lexically and after resolving
 * symlinks, so a link inside the project cannot point at files outside it.
 * Returns the lexically resolved path so callers keep project-relative names.
 */
export async function assertInsideProject(root: string, target: string): Promise<string> {
  const resolved = path.resolve(root, target);
  if (!isInside(root, resolved)) {
    throw new PathEscapeError(target, root);
  }
  const realRoot = await fs.realpath(root);
  const realTarget = await canonicalize(resolved);
  if (!isInside(realRoot, realTarget)) {
    throw new PathEscapeError(target, root);
  }
  return resolved;
}

export class PathEscapeError extends Error {
  constructor(target: string, root: string) {
    super(`path '${target}' escapes the project root '${root}'`);
    this.name = 'PathEscapeError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
