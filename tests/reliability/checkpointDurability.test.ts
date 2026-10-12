import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { CheckpointService, ExecutionEngine, WorktreeManager } from '@wazir/core';
import { JsonFileStore } from '@wazir/shared';
const exec = promisify(execFile);
const child = (mode: string, dir: string, id = '') => exec(process.execPath, ['tests/reliability/checkpointProcess.mjs', mode, dir, id], { timeout: 15000 });
it('P1/P6: committed checkpoint survives process exit and SIGKILL during the next write', async () => {
  const dir = await mkdtemp('/tmp/wazir-checkpoint-process-');
  try {
    await mkdir(`${dir}/workspace`);
    await writeFile(`${dir}/workspace/fact.txt`, 'unique-fact-67231');
    const { id } = JSON.parse((await child('create', dir)).stdout);
    const recovered = JSON.parse((await child('read', dir, id)).stdout);
    expect(recovered.checkpoint.worktreeState.filesSnapshot['fact.txt']).toBe('unique-fact-67231');
    expect(recovered.dateRevived).toBe(true);
    await expect(child('crash', dir)).rejects.toMatchObject({ signal: 'SIGKILL' });
    expect(JSON.parse((await child('read', dir, id)).stdout).checkpoint.id).toBe(id);
    const entries = await new JsonFileStore(`${dir}/state/store.json`).list('checkpoint/');
    expect(entries).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('P8: rejects unsupported versions and corrupted snapshots without overwriting evidence', async () => {
  const dir = await mkdtemp('/tmp/wazir-checkpoint-schema-');
  try {
    await mkdir(`${dir}/workspace`);
    const { id } = JSON.parse((await child('create', dir)).stdout);
    const store = new JsonFileStore(`${dir}/state/store.json`);
    const envelope: any = await store.get(`checkpoint/${id}`);
    await store.put(`checkpoint/${id}`, { ...envelope, version: 2 });
    const opts = { store, executionEngine: new ExecutionEngine(), worktreeManager: new WorktreeManager() };
    await expect(new CheckpointService(opts).ready).rejects.toThrow('INVALID_CHECKPOINT');
    envelope.checkpoint.worktreeState.filesSnapshot['tampered.txt'] = 'not committed';
    await store.put(`checkpoint/${id}`, envelope);
    await expect(new CheckpointService(opts).ready).rejects.toThrow('CHECKPOINT_DIGEST_MISMATCH');
    expect(await store.get(`checkpoint/${id}`)).toEqual(envelope);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
