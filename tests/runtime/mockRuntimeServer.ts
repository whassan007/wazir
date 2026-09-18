import http from 'node:http';

export interface MockServerHandle {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
  simulateDisconnectOnChat?: boolean;
  lastRequestBody?: any;
  recordedRequests?: any[];
}

export async function createMockOllamaServer(): Promise<MockServerHandle> {
  const handle: Partial<MockServerHandle> = { simulateDisconnectOnChat: false, recordedRequests: [] };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    if (url === '/api/version' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.3.10' }));
      return;
    }

    if (url === '/api/tags' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'qwen2.5:latest',
              model: 'qwen2.5:latest',
              size: 4_000_000_000,
              details: { family: 'qwen', parameter_size: '7B', quantization_level: 'Q4_K_M' },
            },
          ],
        }),
      );
      return;
    }

    if (url === '/api/ps' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5:latest' }] }));
      return;
    }

    if (url === '/api/chat' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (handle.simulateDisconnectOnChat) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ message: { content: 'Partial...' }, done: false }) + '\n');
          // Abruptly destroy socket
          req.socket.destroy();
          return;
        }

        const parsed = JSON.parse(body || '{}');
        handle.lastRequestBody = parsed;
        handle.recordedRequests?.push(parsed);
        if (parsed.model === 'nonexistent-model') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "model 'nonexistent-model' not found" }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: 'Hello from Ollama!' }, done: false }) + '\n');
        res.write(JSON.stringify({ done: true, prompt_eval_count: 8, eval_count: 12 }) + '\n');
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;

  handle.server = server;
  handle.url = url;
  handle.close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return handle as MockServerHandle;
}

export async function createMockLMStudioServer(): Promise<MockServerHandle> {
  const handle: Partial<MockServerHandle> = { simulateDisconnectOnChat: false, recordedRequests: [] };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    if ((url === '/models' || url === '/v1/models') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: 'qwen2.5-coder-7b-instruct', object: 'model', owned_by: 'user' }],
        }),
      );
      return;
    }

    if ((url === '/chat/completions' || url === '/v1/chat/completions') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (handle.simulateDisconnectOnChat) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial...' } }] })}\n\n`);
          req.socket.destroy();
          return;
        }

        const parsed = JSON.parse(body || '{}');
        handle.lastRequestBody = parsed;
        handle.recordedRequests?.push(parsed);
        if (parsed.model === 'nonexistent-model') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: "Model 'nonexistent-model' not found" } }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from LM Studio!' } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 15 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}/v1`;

  handle.server = server;
  handle.url = url;
  handle.close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return handle as MockServerHandle;
}
