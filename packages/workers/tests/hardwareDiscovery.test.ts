import { describe, expect, it } from 'vitest';
import { macAvailableMemoryGB } from '../src/hardwareDiscovery.js';

describe('macOS unified memory telemetry', () => {
  it('includes reclaimable pages when reporting available shared memory', () => {
    const available = macAvailableMemoryGB(`Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\nPages purgeable: 1.`);
    expect(available).toBe(35 * 4096 / (1024 ** 3));
    // Purgeability is an attribute of pages already counted in other queues.
    expect(macAvailableMemoryGB(`page size of 4096 bytes\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\nPages purgeable: 20.`)).toBe(available);
  });

  it('leaves the caller to use the conservative fallback when vm_stat is unavailable or malformed', () => {
    expect(macAvailableMemoryGB('vm_stat output unavailable')).toBeUndefined();
    expect(macAvailableMemoryGB('page size of 0 bytes')).toBeUndefined();
    expect(macAvailableMemoryGB('page size of 4096 bytes')).toBeUndefined();
  });
});
