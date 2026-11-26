import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResourceConflictError,
  ResourceLeaseExpiredError,
  ResourceReservationManager,
  StaleFencingTokenError,
} from '../src/services/resourceReservationManager.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'wazir-res-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ResourceReservationManager', () => {
  it('enforces compute/GPU capacity, workspace path overlap, and dangling symlink aliases', async () => {
    const stateDir = makeTempDir();
    const mgr = new ResourceReservationManager({ stateDir });
    mgr.registerComputeCapacity('dgx', { cpuCores: 20, memoryGB: 128, gpuMemoryGB: 128, gpuCount: 1 });

    const targetDir = makeTempDir('wazir-target-');
    const danglingTarget = path.join(targetDir, 'nonexistent-file.ts');
    const symlinkAlias = path.join(targetDir, 'alias-link.ts');
    symlinkSync(danglingTarget, symlinkAlias);

    const lease1 = await mgr.acquire({
      workerId: 'w1',
      gpuSlot: { computerId: 'dgx', gpuMemoryGB: 80 },
      workspacePaths: [{ path: danglingTarget, mode: 'write' }],
    });

    await expect(
      mgr.acquire({
        workerId: 'w2',
        gpuSlot: { computerId: 'dgx', gpuMemoryGB: 64 },
      }),
    ).rejects.toBeInstanceOf(ResourceConflictError);

    await expect(
      mgr.acquire({
        workerId: 'w2',
        workspacePaths: [{ path: symlinkAlias, mode: 'write' }],
      }),
    ).rejects.toBeInstanceOf(ResourceConflictError);

    await mgr.release(lease1.leaseId, 'w1', lease1.fencingToken);
    const lease2 = await mgr.acquire({
      workerId: 'w2',
      workspacePaths: [{ path: symlinkAlias, mode: 'write' }],
    });
    expect(lease2.fencingToken).toBeGreaterThan(lease1.fencingToken);
  });

  it('rejects expired leases and stale fencing tokens on validateFence and assertFencedWrite', async () => {
    let now = 1000;
    const mgr = new ResourceReservationManager({ defaultTtlMs: 100, now: () => now });

    const lease1 = await mgr.acquire({
      workerId: 'w1',
      exclusiveResources: ['db-lock'],
    });
    await mgr.validateFence(lease1.leaseId, 'w1', lease1.fencingToken);
    await mgr.assertFencedWrite('exclusive:db-lock', lease1.fencingToken);

    now += 200;
    await expect(mgr.validateFence(lease1.leaseId, 'w1', lease1.fencingToken)).rejects.toBeInstanceOf(
      ResourceLeaseExpiredError,
    );

    const lease2 = await mgr.acquire({
      workerId: 'w2',
      exclusiveResources: ['db-lock'],
    });
    expect(lease2.fencingToken).toBeGreaterThan(lease1.fencingToken);

    await expect(mgr.assertFencedWrite('exclusive:db-lock', lease1.fencingToken)).rejects.toBeInstanceOf(
      StaleFencingTokenError,
    );
  });
});
