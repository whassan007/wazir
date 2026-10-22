import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from '../src/worker.js';

afterEach(() => vi.unstubAllGlobals());
describe('dispatch cancellation fencing', () => {
  it('does not execute when cancellation wins before the started-event acknowledgment', async () => {
    const worker = new Worker({ computerId: 'a', serverUrl: 'http://controller.invalid', token: 'test' });
    const execute = vi.spyOn(worker, 'execute');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/claim')) return Response.json({ token: 'lease', leaseMs: 30_000 });
      return Response.json({ error: 'LEASE_LOST' }, { status: 409 });
    }));
    const internal = worker as unknown as {
      handleDispatchedTask(request: unknown): Promise<void>;
      activeClaims: Map<string, unknown>;
    };
    await internal.handleDispatchedTask({ requestId: 'r', executionId: 'e', modelId: 'm', messages: [] }).catch(() => undefined);
    expect(execute).not.toHaveBeenCalled();
    expect(internal.activeClaims.size).toBe(0);
  });
});
