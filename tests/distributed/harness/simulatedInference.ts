/**
 * Deterministic Simulated Inference Fixture
 *
 * NOTE: This fixture provides SIMULATED INFERENCE for distributed integration testing,
 * not real neural network model execution. It implements an Ollama-compatible HTTP
 * API (/api/version, /api/tags, /api/show, /api/chat) with deterministic responses,
 * controllable latencies, and request barriers to test distributed worker lifecycle,
 * lease expiry, crashes, and recoveries without requiring GPU hardware or paid model APIs.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SimulatedInferenceOptions {
  modelName?: string;
  responseContent?: string;
  delayMs?: number;
  onChatRequest?: (req: { model: string; messages: unknown[] }) => void | Promise<void>;
  onChatStart?: (req: { model: string; messages: unknown[] }) => void;
}

export interface SimulatedInferenceServer {
  port: number;
  baseUrl: string;
  setDelay(ms: number): void;
  setChatHandler(handler: (req: any) => Promise<string | void> | string | void): void;
  getRecordedRequests(): Array<{ model: string; messages: unknown[]; at: number }>;
  close(): Promise<void>;
}

export async function startSimulatedInference(
  options: SimulatedInferenceOptions = {},
): Promise<SimulatedInferenceServer> {
  const modelName = options.modelName ?? 'simulated-test-model:latest';
  let responseContent = options.responseContent ?? 'simulated model completion';
  let delayMs = options.delayMs ?? 0;
  let customChatHandler: ((req: any) => Promise<string | void> | string | void) | undefined;
  const recordedRequests: Array<{ model: string; messages: unknown[]; at: number }> = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.1.48-simulated' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              name: modelName,
              model: modelName,
              size: 1024 * 1024 * 100,
              modified_at: new Date().toISOString(),
              details: {
                parent_model: '',
                format: 'gguf',
                family: 'qwen',
                parameter_size: '7B',
                quantization_level: 'Q4_K_M',
              },
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model_info: {
            'general.architecture': 'qwen',
            'qwen.context_length': 32768,
          },
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              name: modelName,
              model: modelName,
              size: 1024 * 1024 * 100,
              size_vram: 1024 * 1024 * 100,
              context_length: 32768,
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: modelName,
          response: 'OK',
          done: true,
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const record = { model: payload.model ?? modelName, messages: payload.messages ?? [], at: Date.now() };
          recordedRequests.push(record);

          options.onChatStart?.(record);
          if (options.onChatRequest) {
            await options.onChatRequest(record);
          }

          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }

          let finalOutput = responseContent;
          if (customChatHandler) {
            const custom = await customChatHandler(payload);
            if (typeof custom === 'string') finalOutput = custom;
          }

          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Transfer-Encoding': 'chunked',
          });

          // Line 1: token chunk
          const chunk1 = JSON.stringify({
            model: modelName,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: finalOutput },
            done: false,
          }) + '\n';
          res.write(chunk1);

          // Line 2: done
          const chunk2 = JSON.stringify({
            model: modelName,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: '' },
            done: true,
            total_duration: 50_000_000,
            load_duration: 10_000_000,
            prompt_eval_count: 8,
            eval_count: 16,
          }) + '\n';
          res.end(chunk2);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Not found: ${req.method} ${url.pathname}` }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    setDelay(ms: number) {
      delayMs = ms;
    },
    setChatHandler(handler) {
      customChatHandler = handler;
    },
    getRecordedRequests() {
      return [...recordedRequests];
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
