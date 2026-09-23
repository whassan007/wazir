import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { LMStudioAdapter } from '../src/index.js';

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
});

function startServer(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/v1`);
    });
  });
}

/**
 * Directive failure-matrix item: "local runtime (LM Studio/Ollama) down or
 * disconnecting mid-stream". A clean HTTP connect-refused/5xx is already
 * covered by retry.test.ts — this covers the connection succeeding, some
 * tokens actually streaming back, and then the runtime process itself
 * dying mid-response (socket destroyed with no [DONE], no clean close).
 */
describe('LMStudioAdapter.generate() — runtime disconnects mid-stream', () => {
  it('yields the tokens that arrived, then a clean error event — not a hang or an uncaught exception', async () => {
    const baseURL = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Chained through each write's own flush callback (rather than firing
      // res.socket.destroy() right after synchronous write() calls, which
      // races ahead of the OS actually pushing the buffered bytes down the
      // wire) so the client genuinely receives both frames before the
      // runtime process "dies".
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'par' } }] })}\n\n`, () => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tial' } }] })}\n\n`, () => {
          // The runtime process dies here: no [DONE], no res.end() — just
          // kill the underlying socket, exactly like a crashed/killed LM
          // Studio would.
          req.socket.destroy();
        });
      });
    });

    const adapter = new LMStudioAdapter(baseURL);
    const events = [];
    for await (const event of adapter.generate({ modelId: 'test-model', messages: [{ role: 'user', content: 'hi' }], requestId: 'disc-1' })) {
      events.push(event);
    }

    const tokenEvents = events.filter((e) => e.type === 'token');
    expect(tokenEvents.map((e) => e.content).join('')).toBe('partial');

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    // Never silently reports success on a stream that never actually completed.
    expect(events.some((e) => e.type === 'completed')).toBe(false);
  }, 10_000);

  it('does not hang waiting for a runtime that accepts the connection but never sends anything before closing', async () => {
    const baseURL = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      req.socket.destroy();
    });

    const adapter = new LMStudioAdapter(baseURL);
    const events = [];
    for await (const event of adapter.generate({ modelId: 'test-model', messages: [{ role: 'user', content: 'hi' }], requestId: 'disc-2' })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'error')).toBe(true);
  }, 10_000);
});
