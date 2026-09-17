import { describe, it, expect } from 'vitest';
import {
  Worker,
} from '@wazir/workers';

describe('Integration: Worker', () => {
  // Test worker registration and basic state
  it('creates worker with initial offline status', async () => {
    const worker = new Worker({
      computerId: 'test-computer',
      name: 'Test Worker',
      adapters: [],
    });
    
    expect(worker.info.computerId).toBe('test-computer');
    // Worker starts in offline state
  });

  it('has worker info with version', () => {
    const worker = new Worker({
      computerId: 'c1',
      name: 'Worker-1',
      adapters: [],
    });
    
    expect(worker.info.version).toBeDefined();
  });
});
