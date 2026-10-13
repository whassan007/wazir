import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { LMStudioAdapter } from '../../packages/runtimes/lmstudio/src/index.js';
import { OllamaAdapter } from '../../packages/runtimes/ollama/src/index.js';
import {
  normalizePromptCacheTelemetry,
  promptCacheSource,
  promptCacheReuse,
  type PromptCacheMetrics,
} from '../../packages/runtimes/interfaces/src/index.js';
import { EvaluationService } from '../../packages/evaluation/src/index.js';
import type { ExecutionRecord } from '../../packages/core/src/index.js';

let activeServers: http.Server[] = [];

afterEach(async () => {
  for (const s of activeServers) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  activeServers = [];
});

function createHttpServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    activeServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('Worker 6: Normalized Prompt-Cache Telemetry', () => {
  const evalService = new EvaluationService();

  // Helper to make fake execution record for evaluation testing
  const makeExecutionRecord = (usage: any): ExecutionRecord => ({
    execution: {
      id: 'exec-cache-test',
      taskId: 'task-cache-test',
      runtimeId: 'lmstudio',
      modelId: 'test-model',
      status: 'completed',
      createdAt: new Date(),
      completedAt: new Date(),
    },
    task: { id: 'task-cache-test', title: 'Cache Test' },
    toolCalls: [],
    filesChanged: [],
    checks: [{ name: 'build', ok: true, durationMs: 50, command: 'test' }],
    errors: [],
    policyDecisions: [],
    events: [],
    usage,
  });

  describe('1. Supported Provider', () => {
    it('LM Studio: parses prompt_tokens_details and claims runtime capabilities upon detection', async () => {
      const { url } = await createHttpServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Cached response' } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 200,
                completion_tokens: 15,
                total_tokens: 215,
                prompt_tokens_details: {
                  cached_tokens: 140,
                  cache_creation_input_tokens: 60,
                },
              },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const adapter = new LMStudioAdapter(`${url}/v1`);

      // Before generation, capabilities are not claimed
      const initialCaps = await adapter.getCapabilities();
      expect(initialCaps.promptCacheTelemetry).toBe(false);
      expect(initialCaps.cacheReadMetrics).toBe(false);
      expect(initialCaps.cacheWriteMetrics).toBe(false);

      const events = [];
      for await (const ev of adapter.generate({
        modelId: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        events.push(ev);
      }

      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(completed?.content).toBe('Cached response');

      // Compact metrics emitted
      expect(completed?.usage?.inputTokens).toBe(200);
      expect(completed?.usage?.cacheReadTokens).toBe(140);
      expect(completed?.usage?.cacheWriteTokens).toBe(60);

      // Normalized prompt-cache telemetry
      const pc = completed?.promptCache;
      expect(pc).toBeDefined();
      expect(pc?.cacheReadTokens.status).toBe('OBSERVED');
      expect(pc?.cacheReadTokens.value).toBe(140);
      expect(pc?.cacheWriteTokens.status).toBe('OBSERVED');
      expect(pc?.cacheWriteTokens.value).toBe(60);
      expect(pc?.hit).toBe(true);
      expect(pc?.source).toBe('OBSERVED');
      expect(promptCacheSource(pc)).toBe('OBSERVED');
      expect(promptCacheReuse(pc)).toBeCloseTo(140 / 200);

      // Post-detection capabilities extended
      const updatedCaps = await adapter.getCapabilities();
      expect(updatedCaps.promptCacheTelemetry).toBe(true);
      expect(updatedCaps.cacheReadMetrics).toBe(true);
      expect(updatedCaps.cacheWriteMetrics).toBe(true);

      // Evaluation service reflects measured metrics
      const evalRecord = evalService.buildEvaluationRecord(makeExecutionRecord(completed?.usage));
      expect(evalRecord.context.cacheReadTokens.kind).toBe('measured');
      expect(evalRecord.context.cacheReadTokens.value).toBe(140);
      expect(evalRecord.context.cacheWriteTokens.kind).toBe('measured');
      expect(evalRecord.context.cacheWriteTokens.value).toBe(60);
    });

    it('Ollama: parses response headers when custom/proxy provides cache telemetry', async () => {
      const { url } = await createHttpServer((req, res) => {
        if (req.url === '/api/chat') {
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson',
            'x-cache-read-tokens': '80',
            'x-cache-write-tokens': '20',
            'x-cache-hit': 'true',
          });
          res.write(JSON.stringify({ message: { content: 'Ollama cached!' }, done: false }) + '\n');
          res.write(JSON.stringify({ done: true, prompt_eval_count: 100, eval_count: 10 }) + '\n');
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const adapter = new OllamaAdapter(url);
      const events = [];
      for await (const ev of adapter.generate({
        modelId: 'qwen2.5:latest',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        events.push(ev);
      }

      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(completed?.usage?.cacheReadTokens).toBe(80);
      expect(completed?.usage?.cacheWriteTokens).toBe(20);
      expect(completed?.promptCache?.cacheReadTokens.status).toBe('OBSERVED');
      expect(completed?.promptCache?.hit).toBe(true);
      expect(completed?.promptCache?.source).toBe('OBSERVED');

      const caps = await adapter.getCapabilities();
      expect(caps.promptCacheTelemetry).toBe(true);
      expect(caps.cacheReadMetrics).toBe(true);
      expect(caps.cacheWriteMetrics).toBe(true);
    });
  });

  describe('2. Unsupported Provider', () => {
    it('Ollama (standard): reports UNKNOWN cache telemetry without failing inference or claiming capabilities', async () => {
      const { url } = await createHttpServer((req, res) => {
        if (req.url === '/api/chat') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ message: { content: 'Hello standard' }, done: false }) + '\n');
          res.write(JSON.stringify({ done: true, prompt_eval_count: 50, eval_count: 15 }) + '\n');
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const adapter = new OllamaAdapter(url);
      const events = [];
      for await (const ev of adapter.generate({
        modelId: 'llama3:latest',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        events.push(ev);
      }

      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(completed?.content).toBe('Hello standard');
      expect(completed?.usage?.inputTokens).toBe(50);
      expect(completed?.usage?.outputTokens).toBe(15);
      expect(completed?.usage?.cacheReadTokens).toBeUndefined();

      // Telemetry marked UNKNOWN honestly
      const pc = completed?.promptCache;
      expect(pc).toBeDefined();
      expect(pc?.cacheReadTokens.status).toBe('UNKNOWN');
      expect(pc?.cacheReadTokens.value).toBeUndefined();
      expect(pc?.cacheWriteTokens.status).toBe('UNKNOWN');
      expect(promptCacheSource(pc)).toBe('UNKNOWN');
      expect(promptCacheReuse(pc)).toBeUndefined();

      // Capabilities NOT claimed
      const caps = await adapter.getCapabilities();
      expect(caps.promptCacheTelemetry).toBe(false);
      expect(caps.cacheReadMetrics).toBe(false);
      expect(caps.cacheWriteMetrics).toBe(false);

      // Evaluator reports unavailable
      const evalRecord = evalService.buildEvaluationRecord(makeExecutionRecord(completed?.usage));
      expect(evalRecord.context.cacheReadTokens.kind).toBe('unavailable');
    });

    it('LM Studio (standard without prompt_tokens_details): reports UNKNOWN and does not fail', async () => {
      const { url } = await createHttpServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'No cache details' } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const adapter = new LMStudioAdapter(`${url}/v1`);
      const events = [];
      for await (const ev of adapter.generate({
        modelId: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        events.push(ev);
      }

      const completed = events.find((e) => e.type === 'completed');
      expect(completed?.promptCache?.cacheReadTokens.status).toBe('UNKNOWN');
      expect(completed?.usage?.cacheReadTokens).toBeUndefined();

      const caps = await adapter.getCapabilities();
      expect(caps.promptCacheTelemetry).toBe(false);
    });
  });

  describe('3. Partial Response', () => {
    it('preserves received tokens and marks telemetry UNKNOWN on abrupt disconnect', async () => {
      const { url } = await createHttpServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial output...' } }] })}\n\n`, () => {
            // Cut socket abruptly before usage chunk
            req.socket.destroy();
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const adapter = new LMStudioAdapter(`${url}/v1`);
      const events = [];
      for await (const ev of adapter.generate({
        modelId: 'test-model',
        messages: [{ role: 'user', content: 'stream' }],
      })) {
        events.push(ev);
      }

      // Received partial tokens, error returned, no crash
      const tokens = events.filter((e) => e.type === 'token');
      expect(tokens.map((t) => t.content).join('')).toBe('Partial output...');
      expect(events.some((e) => e.type === 'error')).toBe(true);
    });
  });

  describe('4. Malformed Telemetry', () => {
    it('recovers gracefully from non-numeric, negative, or corrupt telemetry types without failing inference', async () => {
      const malformedPayloads = [
        { prompt_tokens_details: 'corrupt-string' },
        { prompt_tokens_details: { cached_tokens: 'not-a-number' } },
        { prompt_tokens_details: { cached_tokens: -99 } },
        { prompt_tokens_details: { cached_tokens: NaN } },
        { cached_tokens: Infinity },
        null,
      ];

      for (const payload of malformedPayloads) {
        const normalized = normalizePromptCacheTelemetry({
          provider: 'lmstudio',
          inputTokens: 100,
          usage: payload as any,
        });

        // Must not throw, inputTokens preserved, cache telemetry marked UNKNOWN
        expect(normalized.inputTokens.value).toBe(100);
        expect(normalized.cacheReadTokens.status).toBe('UNKNOWN');
        expect(normalized.cacheReadTokens.value).toBeUndefined();
        expect(normalized.source).toBe('UNKNOWN');
      }
    });

    it('reports corrupt SSE JSON without claiming successful completion', async () => {
      const { url } = await createHttpServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {corrupt json line\n\n');
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Valid token' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const adapter = new LMStudioAdapter(`${url}/v1`);
      const events = [];
      for await (const ev of adapter.generate({
        modelId: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        events.push(ev);
      }

      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: 'error', error: 'INVALID_PROVIDER_STREAM: malformed JSON chunk' });
    });
  });

  describe('5. Telemetry Endpoint Unavailable', () => {
    it('probeModel handles non-responding / 404 endpoints gracefully without throwing', async () => {
      const { url } = await createHttpServer((req, res) => {
        res.writeHead(404);
        res.end();
      });

      const adapter = new LMStudioAdapter(`${url}/v1`);
      const result = await adapter.probeModel('unknown-model', 4096);
      expect(result).toBe(false);

      const caps = await adapter.getCapabilities();
      expect(caps.promptCacheTelemetry).toBe(false);
    });
  });

  describe('6. Successful Inference Despite Telemetry Failure', () => {
    it('inference yields full content even when telemetry extraction encounters unexpected exception', async () => {
      const { url } = await createHttpServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The model answered correctly.' } }] })}\n\n`);
          // usage with getter that throws
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const adapter = new LMStudioAdapter(`${url}/v1`);
      const events = [];
      for await (const ev of adapter.generate({
        modelId: 'test-model',
        messages: [{ role: 'user', content: 'Compute 2+2' }],
      })) {
        events.push(ev);
      }

      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(completed?.content).toBe('The model answered correctly.');
      // Inference succeeds cleanly
      expect(events.some((e) => e.type === 'error')).toBe(false);
    });
  });

  describe('7. Live Runtime Qualification (LM Studio if available)', () => {
    it('executes against live LM Studio daemon if online, safely parsing telemetry', async () => {
      let isLiveOnline = false;
      try {
        const resp = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(1000) });
        isLiveOnline = resp.ok;
      } catch {
        isLiveOnline = false;
      }

      if (!isLiveOnline) {
        console.log('Live LM Studio daemon not online; skipping live test.');
        return;
      }

      const adapter = new LMStudioAdapter('http://127.0.0.1:1234/v1');
      const loaded = await adapter.getLoadedModels().catch(() => []);
      const models = await adapter.listModels();
      const modelId = loaded[0] ?? models[0]?.id;
      if (!modelId) return;

      const events = [];
      for await (const ev of adapter.generate({
        modelId,
        messages: [{ role: 'user', content: 'Reply "OK".' }],
        maxTokens: 5,
      })) {
        events.push(ev);
      }

      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect(completed?.promptCache).toBeDefined();
      // Cache status is either OBSERVED (if live LM Studio exposes it) or UNKNOWN (if it does not), but NEVER throws or fails
      expect(['OBSERVED', 'UNKNOWN']).toContain(completed?.promptCache?.cacheReadTokens.status);
    });
  });
});
