import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeProjectFile } from '../src/paths.js';

/**
 * writeProjectFile is atomic (temp file + rename), so an interrupted write can never
 * leave a truncated target — the property recovery's outcome inspection relies on.
 */
describe('writeProjectFile atomicity', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wazir-atomic-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('replaces content completely and leaves no temp files behind', async () => {
    await writeFile(join(root, 'a.txt'), 'old content that is longer');
    await writeProjectFile(root, 'a.txt', 'new');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['a.txt']);
  });

  it('keeps an existing file\'s permission bits', async () => {
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho old\n');
    await chmod(join(root, 'run.sh'), 0o755);
    await writeProjectFile(root, 'run.sh', '#!/bin/sh\necho new\n');
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755);
  });

  it('creates new files and parent directories', async () => {
    await writeProjectFile(root, 'src/deep/new.ts', 'export {}');
    expect(await readFile(join(root, 'src/deep/new.ts'), 'utf8')).toBe('export {}');
  });

  it('a failed write leaves the target untouched and cleans up its temp file', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir', 'keep.txt'), 'keep');
    await expect(writeProjectFile(root, 'dir', 'content')).rejects.toThrow();
    expect(await readdir(root)).toEqual(['dir']);
    expect(await readFile(join(root, 'dir', 'keep.txt'), 'utf8')).toBe('keep');
  });
});
