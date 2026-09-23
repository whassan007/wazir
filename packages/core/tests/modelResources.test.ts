import { describe, it, expect } from 'vitest';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
const GiB = 1024 ** 3;
export function computer(free = 64, unified = true) {
  const computers = new ComputerRegistry();
  computers.register({ id: 'node', name: 'node', type: 'server', local: false,
    os: { platform: 'linux', architecture: 'arm64', version: '1' },
    hardware: { cpu: 'cpu', cpuCores: 8, memoryGB: 128, gpu: { vendor: 'nvidia', model: 'gpu', memoryGB: 128, unifiedMemory: unified } } });
  computers.heartbeat('node', { load: { cpuPercent: 0, memoryUsedGB: 128 - free, memoryAvailableGB: free, gpuMemoryAvailableGB: free } });
  return computers;
}
describe('observed computer resources', () => {
  it('uses one pool for unified memory', () => {
    const snapshot = computer().resourceSnapshot('node');
    expect(snapshot.availableMemoryBytes).toBe(64 * GiB);
    expect(snapshot.availableVramBytes).toBeUndefined();
  });
  it('atomically prevents reservations consuming the same capacity', () => {
    const c = computer(60);
    expect(c.reserve('node', 'a', 40 * GiB, 0, 10, 8 * GiB)).toBeDefined();
    expect(c.reserve('node', 'b', 40 * GiB, 0, 10, 8 * GiB)).toBeUndefined();
  });
  it('never substitutes control-plane memory for missing remote telemetry', () => {
    const c = computer(); c.get('node')!.resourceObservedAt = new Date(0);
    expect(c.resourceSnapshot('node').availableMemoryBytes).toBeUndefined();
    expect(c.reserve('node', 'a', GiB, 0, 10, 8 * GiB)).toBeUndefined();
  });
  it('does not equate residency with readiness', () => {
    const m = new ModelRegistry();
    m.upsertInstance({ id: 'i', modelId: 'm', computerId: 'node', runtimeId: 'r', runtimeModelId: 'm', loaded: true, state: 'LOADED', health: 'healthy' });
    expect(m.isModelReady('m')).toBe(false);
    expect(m.getModelState('m')).toBe('LOADED');
  });
});
