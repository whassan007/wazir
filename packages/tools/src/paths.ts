import path from 'node:path';

export function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

export const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.rook',
]);

export function assertInsideProject(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  if (!isInside(root, resolved)) {
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
