import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FileMutationResult } from '@wazir/core';
import { IGNORED_DIRECTORIES, readProjectBytes, resolveInsideProject } from './paths.js';

export type WorkspaceSnapshot = Map<string, string>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Observe the same source tree searched by Wazir; explicit edit targets include ignored paths. */
export async function snapshotWorkspace(root: string, targets?: string[]): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  let bytes = 0;
  const capture = async (relative: string, followTarget = false): Promise<void> => {
    const absolute = path.resolve(root, relative);
    if (snapshot.size >= 50_000) throw Object.assign(new Error('RESOURCE_EXHAUSTED: workspace snapshot file budget'), { code: 'RESOURCE_EXHAUSTED' });
    let stat;
    try { stat = await fs.lstat(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() && !followTarget) {
      snapshot.set(relative, hash(`symlink:${await fs.readlink(absolute)}`));
      return;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) return;
    const actual = await readProjectBytes(root, relative, 256 * 1024 * 1024 - bytes);
    bytes += actual.size;
    snapshot.set(relative, hash(actual.content));
  };
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(path.resolve(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(relative);
      } else await capture(relative);
    }
  };
  if (targets) {
    for (const target of targets) {
      const { resolved } = await resolveInsideProject(root, target);
      await capture(path.relative(root, resolved), true);
    }
  } else await walk('');
  return snapshot;
}

export function workspaceFingerprint(snapshot: WorkspaceSnapshot): string {
  return hash(JSON.stringify([...snapshot].sort(([a], [b]) => a.localeCompare(b))));
}

export function workspaceMutations(before: WorkspaceSnapshot, after: WorkspaceSnapshot, succeeded: boolean): FileMutationResult[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(file => before.get(file) !== after.get(file)).map(file => ({
    path: file, attempted: true, succeeded, existedBefore: before.has(file), existsAfter: after.has(file),
    beforeHash: before.get(file), afterHash: after.get(file), changed: true,
  }));
}
