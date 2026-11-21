import { describe, expect, it, vi } from 'vitest';
import type { Scheduler, Task } from '@wazir/core';
import { admissibleHardwareComputers } from '../src/tui/admissibleHardwareComputers.js';

describe('interactive admission-aware hardware distribution', () => {
  it('removes a Mac with insufficient memory while retaining ready DGX', () => {
    const plan = vi.fn(({ task }: { task: Task }) => {
      if (task.execution?.targetComputerId === 'local') {
        throw new Error('MODEL_ADMISSION_DENIED: available memory 0.15GB < required 8GB');
      }
      return { computerId: task.execution?.targetComputerId };
    });
    const scheduler = { plan } as unknown as Pick<Scheduler, 'plan'>;
    expect(admissibleHardwareComputers(scheduler, ['local', 'dgx_spark'], 'Reply with WAZIR_OK'))
      .toEqual(['dgx_spark']);
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('does not claim an available hardware pool when all hosts fail', () => {
    const scheduler = {
      plan: () => { throw new Error('No placement satisfies admission'); },
    } as unknown as Pick<Scheduler, 'plan'>;
    expect(admissibleHardwareComputers(scheduler, ['local', 'dgx_spark'], 'Question')).toEqual([]);
  });

  it('never treats hosted inference as placement on a requested host', () => {
    const scheduler = {
      plan: () => ({ modelId: 'hosted-model', computerId: undefined }),
    } as unknown as Pick<Scheduler, 'plan'>;
    expect(admissibleHardwareComputers(scheduler, ['local'], 'Question')).toEqual([]);
  });

  it('preserves routing restrictions and never repeats duplicate hosts', () => {
    const plan = vi.fn(({ task }: { task: Task }) => ({ computerId: task.execution?.targetComputerId }));
    const scheduler = { plan } as unknown as Pick<Scheduler, 'plan'>;
    expect(admissibleHardwareComputers(scheduler, ['dgx_spark', 'dgx_spark'], 'Question', 'LOCAL_ONLY'))
      .toEqual(['dgx_spark']);
    expect(plan.mock.calls[0]?.[0].task.execution?.routingMode).toBe('LOCAL_ONLY');
  });
});
