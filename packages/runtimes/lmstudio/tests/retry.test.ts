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

function sseChatCompletion(): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
    `data: [DONE]\n\n`
  );
}

async function collect(adapter: LMStudioAdapter, requestId: string) {
  const events = [];
  for await (const event of adapter.generate({ modelId: 'test-model', messages: [{ role: 'user', content: 'hi' }], requestId })) {
    events.push(event);
  }
  return events;
}

describe('LMStudioAdapter.generate() retry behavior (real HTTP server)', () => {
  it('retries a 503 and succeeds once the server recovers, yielding a retry event in between', async () => {
    let requestCount = 0;
    const baseURL = await startServer((req, res) => {
      requestCount += 1;
      if (requestCount < 3) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('service unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseChatCompletion());
    });

    const adapter = new LMStudioAdapter(baseURL);
    const events = await collect(adapter, 'req-1');

    expect(requestCount).toBe(3);
    const retryEvents = events.filter((e) => e.type === 'retry');
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0].retryAttempt).toBe(2);
    expect(retryEvents[1].retryAttempt).toBe(3);

    const tokenEvents = events.filter((e) => e.type === 'token');
    expect(tokenEvents.map((e) => e.content).join('')).toBe('hi');
    expect(events.some((e) => e.type === 'completed')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 15_000);

  it('gives up after 4 attempts and yields a single error event, not a retry event for the last failure', async () => {
    let requestCount = 0;
    const baseURL = await startServer((req, res) => {
      requestCount += 1;
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error');
    });

    const adapter = new LMStudioAdapter(baseURL);
    const events = await collect(adapter, 'req-2');

    expect(requestCount).toBe(4);
    expect(events.filter((e) => e.type === 'retry').length).toBe(3);
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].error).toContain('500');
  }, 15_000);

  it('does not retry a non-retryable 4xx error', async () => {
    let requestCount = 0;
    const baseURL = await startServer((req, res) => {
      requestCount += 1;
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request');
    });

    const adapter = new LMStudioAdapter(baseURL);
    const events = await collect(adapter, 'req-3');

    expect(requestCount).toBe(1);
    expect(events.filter((e) => e.type === 'retry').length).toBe(0);
    expect(events.filter((e) => e.type === 'error').length).toBe(1);
  }, 15_000);
});
