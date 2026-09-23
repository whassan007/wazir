import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenOrFail } from '../src/listenOrFail.js';

describe('listenOrFail — port conflict handling', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  it('resolves once bound to an available port', async () => {
    const server = http.createServer();
    servers.push(server);
    await expect(listenOrFail(server, 0, '127.0.0.1', 'test')).resolves.toBeUndefined();
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it('rejects with EADDRINUSE (marked alreadyReported) when the port is already bound, without crashing the process', async () => {
    const first = http.createServer();
    servers.push(first);
    await listenOrFail(first, 0, '127.0.0.1', 'test');
    const port = (first.address() as AddressInfo).port;

    const second = http.createServer();
    servers.push(second);
    let caught: NodeJS.ErrnoException | undefined;
    try {
      await listenOrFail(second, port, '127.0.0.1', 'test');
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe('EADDRINUSE');
    expect((caught as unknown as { alreadyReported?: boolean })?.alreadyReported).toBe(true);
  });

  it('prints a friendly, actionable message (not a raw stack trace) for EADDRINUSE', async () => {
    const first = http.createServer();
    servers.push(first);
    await listenOrFail(first, 0, '127.0.0.1', 'test');
    const port = (first.address() as AddressInfo).port;

    const second = http.createServer();
    servers.push(second);
    const errorSpy: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errorSpy.push(msg);
    try {
      await listenOrFail(second, port, '127.0.0.1', 'test').catch(() => undefined);
    } finally {
      console.error = original;
    }

    expect(errorSpy.some((m) => m.includes(`port ${port}`) && m.includes('already in use'))).toBe(true);
  });
});
