import { describe, expect, it, vi } from 'vitest';
import { ComputerRegistry } from '../src/services/computerRegistry.js';

describe('computer heartbeat recovery', () => {
  it('does not resurrect a restored offline registration without a heartbeat', () => {
    const computers = new ComputerRegistry();
    computers.register({ id: 'worker', name: 'worker', type: 'workstation',
      os: { platform: 'linux', architecture: 'arm64', version: 'test' }, hardware: { cpu: 'test', cpuCores: 1, memoryGB: 1 } });
    computers.setOffline('worker');
    expect(computers.checkHeartbeats().offline).toEqual(['worker']);
    expect(computers.get('worker')?.status).toBe('offline');
    computers.heartbeat('worker');
    expect(computers.checkHeartbeats().healthy).toEqual(['worker']);
  });
  it('marks a worker offline at the real threshold and restores it after a heartbeat', () => {
    vi.useFakeTimers();
    try {
      const computers = new ComputerRegistry();
      computers.register({ id: 'worker', name: 'worker', type: 'workstation',
        os: { platform: 'linux', architecture: 'arm64', version: 'test' }, hardware: { cpu: 'test', cpuCores: 1, memoryGB: 1 } });
      vi.advanceTimersByTime(60_000);
      expect(computers.checkHeartbeats().offline).toEqual(['worker']);
      computers.heartbeat('worker');
      expect(computers.checkHeartbeats().healthy).toEqual(['worker']);
    } finally { vi.useRealTimers(); }
  });
});
