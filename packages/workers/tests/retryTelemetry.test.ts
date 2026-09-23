import { expect, it } from 'vitest';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import { executeRequest } from '../src/taskExecutor.js';

it('awaits retry event durability before advancing the runtime iterator', async () => {
  let continued = false;
  let release!: () => void;
  let reported!: () => void;
  const reportedPromise = new Promise<void>(resolve => { reported = resolve; });
  const durable = new Promise<void>(resolve => { release = resolve; });
  const adapter = {
    async *generate() {
      yield { type: 'retry' as const, failureClass: 'SERVER' as const, retryAttempt: 2, retryDelayMs: 0 };
      continued = true;
      yield { type: 'completed' as const, content: 'done' };
    },
  } as RuntimeAdapter;
  const outcome = executeRequest(adapter, { executionId: 'execution', requestId: 'request', modelId: 'model', messages: [] }, async event => {
    if (event.type === 'retry') { reported(); await durable; }
  });
  await reportedPromise;
  expect(continued).toBe(false);
  release();
  expect((await outcome).ok).toBe(true);
  expect(continued).toBe(true);
});
