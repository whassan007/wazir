import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '@wazir/shared';
import { createApiState, createApp } from '../src/server.js';

describe('worker task stream lifecycle', () => {
  it('releases the stream when the worker disconnects while subscribe() is still redelivering', async () => {
    const store = new MemoryStore();
    let slow = false;
    const list = store.list.bind(store);
    (store as any).list = async (prefix: string) => {
      if (slow && prefix === 'dispatch/') await new Promise((r) => setTimeout(r, 300));
      return list(prefix);
    };
    const state = await createApiState({ auth: { allowUnauthenticated: true }, store });
    const server = createApp(state).listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const reg = await fetch(`${baseUrl}/computers/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'w1', name: 'w1', type: 'workstation', local: true }),
      });
      const regStatus = reg.status;
      const { token } = (await reg.json()) as { token?: string };
      expect(regStatus).toBe(200);
      slow = true;
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/computers/w1/tasks/stream`, {
        signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      expect(res.status).toBe(200);
      controller.abort(); // disconnect while redeliver() is still waiting on the store
      await new Promise((r) => setTimeout(r, 600));
      expect(state.dispatcher.activeStreamsCount).toBe(0);
      expect(state.dispatcher.isConnected('w1')).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
