import { constants as fsConstants, promises as fs } from 'node:fs';
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

/**
 * Like `assertInsideProject`, but also returns the canonical path so I/O can
 * be done on a name that contained no symlinks at check time.
 */
export async function resolveInsideProject(root: string, target: string): Promise<{ resolved: string; real: string }> {
  const resolved = path.resolve(root, target);
  if (!isInside(root, resolved)) {
    throw new PathEscapeError(target, root);
  }
  const realRoot = await fs.realpath(root);
  const real = await canonicalize(resolved);
  if (!isInside(realRoot, real)) {
    throw new PathEscapeError(target, root);
  }
  return { resolved, real };
}

/**
 * Reads a project file without following a symlink planted between the
 * containment check and the open (TOCTOU, security review F-20): the open
 * targets the canonical path with `O_NOFOLLOW`, and the descriptor is
 * checked to still be the inode that was verified.
 */
export async function readProjectFile(root: string, target: string): Promise<{ resolved: string; content: string; size: number }> {
  const result = await readProjectBytes(root, target);
  return { ...result, content: result.content.toString('utf8') };
}

export async function readProjectBytes(root: string, target: string, maxBytes = Infinity): Promise<{ resolved: string; content: Buffer; size: number }> {
  const { resolved, real } = await resolveInsideProject(root, target);
  const handle = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    await assertSameInode(root, target, real, stat);
    if (stat.size > maxBytes) throw Object.assign(new Error('RESOURCE_EXHAUSTED: file exceeds snapshot byte budget'), { code: 'RESOURCE_EXHAUSTED' });
    const content = await handle.readFile();
    return { resolved, content, size: stat.size };
  } finally {
    await handle.close();
  }
}

/** Write counterpart of `readProjectFile`; creates parent directories inside the project. */
export async function writeProjectFile(root: string, target: string, content: string): Promise<string> {
  const { resolved, real } = await resolveInsideProject(root, target);
  await fs.mkdir(path.dirname(real), { recursive: true });
  const handle = await fs.open(real, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
  try {
    const stat = await handle.stat();
    await assertSameInode(root, target, real, stat);
    await handle.writeFile(content, 'utf8');
    return resolved;
  } finally {
    await handle.close();
  }
}

async function assertSameInode(root: string, target: string, real: string, opened: { ino: bigint | number; dev: bigint | number }): Promise<void> {
  const now = await fs.stat(real);
  const realRoot = await fs.realpath(root);
  const recheck = await canonicalize(real);
  if (!isInside(realRoot, recheck) || now.ino !== opened.ino || now.dev !== opened.dev) {
    throw new PathEscapeError(target, root);
  }
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
