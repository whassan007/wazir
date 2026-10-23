import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactRef } from '../contracts.js';
import type { WorkspaceState } from './types.js';

export const DEFAULT_DIGEST_LIMITS = { maxFiles: 10_000, maxBytes: 512 * 1024 * 1024 };
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.wazir']);

export class ArtifactPathError extends Error {}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Normalizes a graph artifact entry to a workspace-relative POSIX path, or throws. */
export function normalizeArtifactPath(entry: string): string {
  const trimmed = entry.trim().replace(/\\/g, '/');
  if (!trimmed) throw new ArtifactPathError('empty artifact path');
  if (trimmed.includes('\0')) throw new ArtifactPathError('artifact path contains NUL');
  if (path.posix.isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed)) throw new ArtifactPathError('absolute artifact paths are not allowed');
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, '');
  if (normalized === '.' || normalized === '' ) throw new ArtifactPathError('artifact path resolves to the workspace root');
  if (normalized === '..' || normalized.startsWith('../')) throw new ArtifactPathError('artifact path escapes the workspace');
  return normalized;
}

/** Resolves `relative` inside `root`, following symlinks, and refuses anything that lands outside. */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, relative);
  const real = await fs.realpath(candidate); // throws ENOENT when missing
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ArtifactPathError('artifact resolves outside the workspace (symlink escape)');
  return real;
}

interface Budget { files: number; bytes: number; maxFiles: number; maxBytes: number }

async function digestFile(file: string, budget: Budget): Promise<{ hex: string; size: number }> {
  const stat = await fs.stat(file);
  budget.files += 1;
  budget.bytes += stat.size;
  if (budget.files > budget.maxFiles) throw new ArtifactPathError(`artifact exceeds ${budget.maxFiles} files`);
  if (budget.bytes > budget.maxBytes) throw new ArtifactPathError(`artifact exceeds ${budget.maxBytes} bytes`);
  const bytes = await fs.readFile(file);
  return { hex: sha256(bytes), size: bytes.length };
}

/**
 * sha256 of the exact bytes. A directory digests to sha256 over its sorted
 * `relpath\0sha256:<hex>\n` entries (regular files only; symlinks are recorded
 * by target and never followed, so the digest cannot reach outside).
 */
export async function digestArtifact(
  root: string,
  entry: string,
  limits: { maxFiles?: number; maxBytes?: number } = {},
): Promise<{ ref?: ArtifactRef; problem?: string; fileCount: number }> {
  let relative: string;
  try {
    relative = normalizeArtifactPath(entry);
  } catch (error) {
    return { problem: (error as Error).message, fileCount: 0 };
  }
  const budget: Budget = {
    files: 0,
    bytes: 0,
    maxFiles: limits.maxFiles ?? DEFAULT_DIGEST_LIMITS.maxFiles,
    maxBytes: limits.maxBytes ?? DEFAULT_DIGEST_LIMITS.maxBytes,
  };
  let absolute: string;
  try {
    absolute = await resolveInside(root, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problem: `artifact missing: ${relative}`, fileCount: 0 };
    return { problem: (error as Error).message, fileCount: 0 };
  }
  try {
    const stat = await fs.stat(absolute);
    if (stat.isFile()) {
      const { hex, size } = await digestFile(absolute, budget);
      if (size === 0) return { ref: { uri: relative, digest: `sha256:${hex}`, sizeBytes: 0 }, problem: `artifact is empty: ${relative}`, fileCount: 1 };
      return { ref: { uri: relative, digest: `sha256:${hex}`, sizeBytes: size }, fileCount: 1 };
    }
    if (!stat.isDirectory()) return { problem: `artifact is not a regular file or directory: ${relative}`, fileCount: 0 };
    const lines: string[] = [];
    let total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const item of entries) {
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        const full = path.join(dir, item.name);
        if (item.isSymbolicLink()) {
          lines.push(`${rel}\0symlink:${sha256(await fs.readlink(full))}\n`);
        } else if (item.isDirectory()) {
          if (!IGNORED_DIRS.has(item.name)) await walk(full, rel);
        } else if (item.isFile()) {
          const { hex, size } = await digestFile(full, budget);
          total += size;
          lines.push(`${rel}\0sha256:${hex}\n`);
        }
      }
    };
    await walk(absolute, '');
    const fileCount = lines.length;
    const ref: ArtifactRef = { uri: `${relative}/`, digest: `sha256:${sha256(lines.join(''))}`, sizeBytes: total };
    if (fileCount === 0) return { ref, problem: `artifact directory is empty: ${relative}/`, fileCount };
    return { ref, fileCount };
  } catch (error) {
    return { problem: `artifact unreadable: ${relative}: ${(error as Error).message}`, fileCount: 0 };
  }
}

/** Content digest over the (uri, digest) set; this is the evidence `workspaceRevision`. */
export function workspaceRevisionOf(artifacts: ArtifactRef[], problems: Array<{ uri: string; reason: string }>): string {
  const lines = [
    ...artifacts.map((a) => `A ${a.uri} ${a.digest}`),
    ...problems.map((p) => `P ${p.uri} ${p.reason}`),
  ].sort();
  return `content:sha256:${sha256(lines.join('\n'))}`;
}

/** Digests every declared target artifact as it exists on disk now. */
export async function snapshotArtifacts(
  root: string,
  entries: string[],
  limits: { maxFiles?: number; maxBytes?: number } = {},
): Promise<WorkspaceState> {
  const artifacts: ArtifactRef[] = [];
  const problems: Array<{ uri: string; reason: string }> = [];
  for (const entry of [...new Set(entries)].sort()) {
    const result = await digestArtifact(root, entry, limits);
    if (result.ref) artifacts.push(result.ref);
    if (result.problem) problems.push({ uri: result.ref?.uri ?? entry, reason: result.problem });
  }
  return { workspaceRevision: workspaceRevisionOf(artifacts, problems), artifacts, problems };
}
