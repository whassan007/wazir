import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
const exec = promisify(execFile);
it.skipIf(Number(process.versions.node.split('.')[0]) < 22)('P3/P4: full memory records and invalidation survive separate processes with repository isolation', async () => {
  const dir = await mkdtemp('/tmp/wazir-memory-process-');
  const child = (mode: string) => exec(process.execPath, ['test/reliability/memoryProcess.mjs', mode, `${dir}/memory.db`], {timeout:10000});
  try {
    await child('write');
    const recovered = JSON.parse((await child('read')).stdout);
    expect(recovered.episodes).toHaveLength(1);
    expect(recovered.episodes[0].taskPrompt).toContain('heliotrope-67231');
    expect(recovered.procedures[0].recipe.command).toBe('node --test');
    expect(recovered.foreign).toEqual([]);
    await child('invalidate');
    const invalidated = JSON.parse((await child('read')).stdout);
    expect(invalidated.episodes).toEqual([]);
    expect(invalidated.procedures).toEqual([]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
