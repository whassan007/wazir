import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  benchmarkFastLocalModels,
  discoverFastLocalEndpoints,
  getFastLatencyFilePath,
  getFastModelCachePath,
  loadCachedFastModels,
  resolveConfiguredFastModelOverride,
  saveCachedFastModels,
  streamFastLocalCompletion,
} from '../src/fastLlm.js';

interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>,
): Promise<StartedServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      Promise.resolve(handler(req, res, body)).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock HTTP server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function getUnusedPortUrl(): Promise<string> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  const port = addr && typeof addr !== 'string' ? addr.port : 59999;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('fastLlm zero-RookEngine local discovery, benchmarking, caching, and streaming', () => {
  const cleanupDirs: string[] = [];
  const cleanupServers: StartedServer[] = [];

  const makeWazirHome = (config?: Record<string, unknown>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-fast-llm-'));
    cleanupDirs.push(dir);
    if (config) {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    }
    return dir;
  };

  afterEach(async () => {
    while (cleanupServers.length > 0) {
      const srv = cleanupServers.pop()!;
      await srv.close();
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves path helpers and override precedence while honoring auto and local routing rules', () => {
    const home = makeWazirHome({
      routing: {
        mode: 'provider_only',
        provider: 'nvidia',
        defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      },
      models: {
        fastLocalModel: 'qwen3-4b',
      },
    });

    expect(getFastLatencyFilePath(home)).toBe(path.join(home, 'shell_latency.json'));
    expect(getFastModelCachePath(home)).toBe(path.join(home, 'fast-model-cache.json'));

    // models.fastLocalModel applies; hosted defaultModel in provider_only does not
    expect(resolveConfiguredFastModelOverride({ wazirHome: home, env: {} })).toBe('qwen3-4b');
    expect(resolveConfiguredFastModelOverride({ wazirHome: home, env: { WAZIR_FAST_MODEL: 'llama3.2:3b' } })).toBe(
      'llama3.2:3b',
    );
    expect(
      resolveConfiguredFastModelOverride({
        wazirHome: home,
        sessionModel: 'qwen3-8b',
        env: { WAZIR_FAST_MODEL: 'llama3.2:3b' },
      }),
    ).toBe('qwen3-8b');
    // 'auto' means no override at that tier
    expect(
      resolveConfiguredFastModelOverride({
        wazirHome: home,
        sessionModel: 'auto',
        env: { WAZIR_FAST_MODEL: 'auto' },
      }),
    ).toBe('qwen3-4b');

    const hostedOnlyHome = makeWazirHome({
      routing: {
        mode: 'provider_only',
        provider: 'nvidia',
        defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      },
    });
    expect(resolveConfiguredFastModelOverride({ wazirHome: hostedOnlyHome, env: {} })).toBeUndefined();

    const localOnlyDefaultHome = makeWazirHome({
      routing: {
        mode: 'local_only',
        defaultModel: 'qwen3-8b',
      },
    });
    expect(resolveConfiguredFastModelOverride({ wazirHome: localOnlyDefaultHome, env: {} })).toBe('qwen3-8b');
  });

  it('discovers loaded/unloaded models, parameter sizes, and skips unreachable endpoints', async () => {
    const lmStudio = await startMockServer((req, res) => {
      if (req.url === '/api/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            models: [
              {
                key: 'qwen/qwen3-4b',
                display_name: 'Qwen3 4B',
                params_string: '4B',
                size_bytes: 2_500_000_000,
                max_context_length: 32768,
                capabilities: { reasoning: true, trained_for_tool_use: true },
                loaded_instances: [{ id: 'inst-1', config: { context_length: 16384 } }],
              },
              {
                key: 'qwen/qwen3-32b',
                display_name: 'Qwen3 32B',
                params_string: '32B',
                loaded_instances: [],
              },
              {
                key: 'text-embedding-nomic-embed-text-v1.5',
                type: 'embedding',
                params_string: '137M',
                loaded_instances: [{ id: 'emb-1' }],
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(lmStudio);

    const ollama = await startMockServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/ps') {
        res.end(
          JSON.stringify({
            models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b', size: 2_000_000_000 }],
          }),
        );
        return;
      }
      if (req.url === '/api/tags') {
        res.end(
          JSON.stringify({
            models: [
              { name: 'llama3.2:3b', model: 'llama3.2:3b', size: 2_000_000_000, details: { parameter_size: '3.2B', family: 'llama' } },
              { name: 'llama3.3:70b', model: 'llama3.3:70b', size: 40_000_000_000, details: { parameter_size: '70B', family: 'llama' } },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(ollama);

    const deadUrl = await getUnusedPortUrl();
    const wazirHome = makeWazirHome({
      lmstudioUrl: `${lmStudio.url}/v1`,
      ollamaUrl: ollama.url,
      mlxUrl: `${deadUrl}/v1`,
    });

    const entries = await discoverFastLocalEndpoints({ wazirHome, env: {} });
    const byId = new Map(entries.map((e) => [e.candidate.id, e]));

    expect(byId.get('qwen/qwen3-4b')).toMatchObject({
      runtimeType: 'lmstudio',
      supportsReasoningToggle: true,
      candidate: { loaded: true, parameters: '4B', parameterBillions: 4, embedding: false },
    });
    expect(byId.get('qwen/qwen3-32b')?.candidate).toMatchObject({
      loaded: false,
      parameters: '32B',
      parameterBillions: 32,
    });
    expect(byId.get('text-embedding-nomic-embed-text-v1.5')?.candidate.embedding).toBe(true);
    expect(byId.get('llama3.2:3b')?.candidate).toMatchObject({
      provider: 'ollama',
      loaded: true,
      parameters: '3.2B',
      parameterBillions: 3.2,
    });
    expect(byId.get('llama3.3:70b')?.candidate).toMatchObject({
      provider: 'ollama',
      loaded: false,
      parameters: '70B',
      parameterBillions: 70,
    });

    const skipped = await discoverFastLocalEndpoints({
      wazirHome,
      env: { WAZIR_SKIP_RUNTIME_DISCOVERY: '1' },
    });
    expect(skipped).toEqual([]);
  });

  it('benchmarks loaded models, ranks faster model over slower/unloaded models, and writes cache', async () => {
    const slowLmStudio = await startMockServer(async (req, res) => {
      if (req.url === '/api/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            models: [
              {
                key: 'slow-8b',
                params_string: '8B',
                loaded_instances: [{ id: 'slow-inst' }],
              },
              {
                key: 'nomic-embed-text',
                type: 'embedding',
                loaded_instances: [{ id: 'emb-inst' }],
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.setHeader('Content-Type', 'text/event-stream');
        await sleep(80);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'O' } }] })}\n\n`);
        await sleep(40);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'K' }, finish_reason: 'stop' }], usage: { completion_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(slowLmStudio);

    const fastOllama = await startMockServer((req, res) => {
      if (req.url === '/api/ps') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'fast-3b' }] }));
        return;
      }
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            models: [
              { name: 'fast-3b', details: { parameter_size: '3B' } },
              { name: 'cold-14b', details: { parameter_size: '14B' } },
            ],
          }),
        );
        return;
      }
      if (req.url === '/api/chat') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'OK' }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 1, load_duration: 0 })}\n`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(fastOllama);

    const deadUrl = await getUnusedPortUrl();
    const wazirHome = makeWazirHome({
      lmstudioUrl: `${slowLmStudio.url}/v1`,
      ollamaUrl: fastOllama.url,
      mlxUrl: `${deadUrl}/v1`,
    });

    const bench = await benchmarkFastLocalModels({ wazirHome, env: {} });
    expect(bench.errors).toEqual([]);
    expect(bench.selected?.candidate.id).toBe('fast-3b');
    expect(bench.entries.some((e) => e.candidate.id === 'nomic-embed-text')).toBe(false);

    const fastEntry = bench.entries.find((e) => e.candidate.id === 'fast-3b')!;
    const slowEntry = bench.entries.find((e) => e.candidate.id === 'slow-8b')!;
    expect(fastEntry.candidate.measuredTtftMs!).toBeLessThan(slowEntry.candidate.measuredTtftMs!);

    const cached = loadCachedFastModels(wazirHome);
    expect(cached.map((c) => c.candidate.id)).toContain('fast-3b');
    expect(cached.find((c) => c.candidate.id === 'fast-3b')?.candidate.measuredTtftMs).toBeGreaterThan(0);
  });

  it('streams SSE tokens immediately, strips <think> blocks, records TTFT/TPS, and reuses warm cache', async () => {
    let discoveryHits = 0;
    let seenSystemPrompt = '';

    const lmStudio = await startMockServer(async (req, res, body) => {
      if (req.url === '/api/v1/models') {
        discoveryHits += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            models: [
              {
                key: 'qwen3-8b',
                params_string: '8B',
                capabilities: { reasoning: true },
                loaded_instances: [{ id: 'qwen3-8b-inst' }],
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
        seenSystemPrompt = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
        res.setHeader('Content-Type', 'text/event-stream');
        const chunks = [
          '<thi',
          'nk>secret reasoning\nline 2</thi',
          'nk>\n\n',
          'chmod 755 ',
          'sets rwxr-xr-x.',
        ];
        for (let i = 0; i < chunks.length; i += 1) {
          await sleep(5);
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: chunks[i] }, finish_reason: i === chunks.length - 1 ? 'stop' : null }],
              ...(i === chunks.length - 1 ? { usage: { completion_tokens: 6 } } : {}),
            })}\n\n`,
          );
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(lmStudio);

    const deadUrl = await getUnusedPortUrl();
    const wazirHome = makeWazirHome({
      lmstudioUrl: `${lmStudio.url}/v1`,
      ollamaUrl: deadUrl,
      mlxUrl: `${deadUrl}/v1`,
    });

    const received1: string[] = [];
    const res1 = await streamFastLocalCompletion('explain chmod 755', {
      wazirHome,
      env: {},
      onToken: (tok) => received1.push(tok),
    });

    expect(res1.status).toBe('success');
    expect(res1.model).toBe('qwen3-8b');
    expect(res1.provider).toBe('lmstudio');
    expect(res1.output).toBe('chmod 755 sets rwxr-xr-x.');
    expect(received1).toEqual(['chmod 755 ', 'sets rwxr-xr-x.']);
    expect(seenSystemPrompt).toContain('/no_think');
    expect(res1.firstTokenMs).toBeGreaterThan(0);
    expect(res1.providerConnectionMs).toBeGreaterThanOrEqual(0);
    expect(res1.tokenThroughputTps).toBeGreaterThan(0);
    expect(res1.outputTokens).toBe(6);
    expect(discoveryHits).toBe(1);

    // Second call uses warm cache without re-hitting /api/v1/models
    const received2: string[] = [];
    const res2 = await streamFastLocalCompletion('explain umask 022', {
      wazirHome,
      env: {},
      onToken: (tok) => received2.push(tok),
    });
    expect(res2.status).toBe('success');
    expect(res2.output).toBe('chmod 755 sets rwxr-xr-x.');
    expect(discoveryHits).toBe(1);
    expect(res2.modelSelectionMs).toBeLessThan(20);
  });

  it('honors explicit model overrides and fails explicitly when requested model is unavailable', async () => {
    const ollama = await startMockServer((req, res, body) => {
      if (req.url === '/api/ps') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [{ name: 'fast-3b' }] }));
        return;
      }
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            models: [
              { name: 'fast-3b', details: { parameter_size: '3B' } },
              { name: 'pinned-14b', details: { parameter_size: '14B' } },
            ],
          }),
        );
        return;
      }
      if (req.url === '/api/chat') {
        const parsed = JSON.parse(body) as { model: string };
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(`${JSON.stringify({ message: { content: `from:${parsed.model}` }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { content: '' }, done: true, eval_count: 2 })}\n`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(ollama);

    const deadUrl = await getUnusedPortUrl();
    const wazirHome = makeWazirHome({
      ollamaUrl: ollama.url,
      lmstudioUrl: `${deadUrl}/v1`,
      mlxUrl: `${deadUrl}/v1`,
    });

    // Honor WAZIR_FAST_MODEL override even over faster loaded model
    const pinnedRes = await streamFastLocalCompletion('hello', {
      wazirHome,
      env: { WAZIR_FAST_MODEL: 'pinned-14b' },
    });
    expect(pinnedRes.status).toBe('success');
    expect(pinnedRes.model).toBe('pinned-14b');
    expect(pinnedRes.output).toBe('from:pinned-14b');

    // Never silently fall back when requested override model does not exist
    const missingRes = await streamFastLocalCompletion('hello', {
      wazirHome,
      sessionModel: 'missing-model-99b',
      env: {},
    });
    expect(missingRes.status).toBe('error');
    expect(missingRes.error).toBe(
      "Requested fast model 'missing-model-99b' is not registered or reachable on local/fleet endpoints.",
    );
  });

  it('falls back once when primary fails connection, reports unreachable errors, and cancels cleanly via AbortSignal', async () => {
    const deadUrl = await getUnusedPortUrl();
    const emptyHome = makeWazirHome({
      ollamaUrl: deadUrl,
      lmstudioUrl: `${deadUrl}/v1`,
      mlxUrl: `${deadUrl}/v1`,
    });

    const unreachable = await streamFastLocalCompletion('what is DNS', {
      wazirHome: emptyHome,
      env: {},
    });
    expect(unreachable.status).toBe('error');
    expect(unreachable.error).toBe(
      'No fast local LLM is reachable in this environment. Start LM Studio, Ollama, or MLX, or configure a fleet host.',
    );

    // Fallback once from dead primary cached entry to healthy secondary cached entry
    const backupServer = await startMockServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'backup ok' }, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(backupServer);

    const fallbackHome = makeWazirHome();
    await saveCachedFastModels(
      [
        {
          candidate: { id: 'primary-dead', provider: 'lmstudio', local: true, loaded: true, measuredTtftMs: 10, measuredTps: 150 },
          endpoint: 'local:lmstudio',
          runtimeType: 'lmstudio',
          baseUrl: `${deadUrl}/v1`,
          updatedAt: new Date().toISOString(),
        },
        {
          candidate: { id: 'secondary-live', provider: 'mlx', local: true, loaded: true, measuredTtftMs: 40, measuredTps: 90 },
          endpoint: 'local:mlx',
          runtimeType: 'mlx',
          baseUrl: `${backupServer.url}/v1`,
          updatedAt: new Date().toISOString(),
        },
      ],
      fallbackHome,
    );

    const fallbackRes = await streamFastLocalCompletion('hello', {
      wazirHome: fallbackHome,
      env: {},
    });
    expect(fallbackRes.status).toBe('success');
    expect(fallbackRes.model).toBe('secondary-live');
    expect(fallbackRes.output).toBe('backup ok');
    expect(fallbackRes.fallbackFrom).toBe('primary-dead');

    // AbortSignal cancellation mid-stream
    const slowStream = await startMockServer(async (req, res) => {
      if (req.url === '/v1/chat/completions') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] })}\n\n`);
        await sleep(500);
        if (!res.writableEnded) {
          res.end('data: [DONE]\n\n');
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(slowStream);

    const abortHome = makeWazirHome();
    await saveCachedFastModels(
      [
        {
          candidate: { id: 'slow-stream-model', provider: 'lmstudio', local: true, loaded: true },
          endpoint: 'local:lmstudio',
          runtimeType: 'lmstudio',
          baseUrl: `${slowStream.url}/v1`,
          updatedAt: new Date().toISOString(),
        },
      ],
      abortHome,
    );

    const ac = new AbortController();
    const cancelPromise = streamFastLocalCompletion('count to ten', {
      wazirHome: abortHome,
      env: {},
      signal: ac.signal,
      onToken: () => ac.abort(),
    });
    const cancelRes = await cancelPromise;
    expect(cancelRes.status).toBe('cancelled');

    // Timeout sets timedOut: true and returns error
    const hangingServer = await startMockServer((_req, _res) => {
      // Intentionally leave response open until client aborts/times out
    });
    cleanupServers.push(hangingServer);

    const timeoutHome = makeWazirHome();
    await saveCachedFastModels(
      [
        {
          candidate: { id: 'hanging-model', provider: 'mlx', local: true, loaded: true },
          endpoint: 'local:mlx',
          runtimeType: 'mlx',
          baseUrl: `${hangingServer.url}/v1`,
          updatedAt: new Date().toISOString(),
        },
      ],
      timeoutHome,
    );

    const timedOutRes = await streamFastLocalCompletion('hello', {
      wazirHome: timeoutHome,
      env: {},
      timeoutMs: 60,
    });
    expect(timedOutRes.status).toBe('error');
    expect(timedOutRes.timedOut).toBe(true);
  });

  it('discovers MLX and fleetHosts, respects strictLoopbackOnly, and benchmarks <=10B unloaded fallback when nothing is loaded', async () => {
    const mlxServer = await startMockServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mlx-community/Qwen2.5-3B-Instruct-4bit' }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(mlxServer);

    const fleetOllama = await startMockServer((req, res) => {
      if (req.url === '/api/ps') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            models: [
              { name: 'small-4b', details: { parameter_size: '4B' } },
              { name: 'huge-70b', details: { parameter_size: '70B' } },
            ],
          }),
        );
        return;
      }
      if (req.url === '/api/chat') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(`${JSON.stringify({ message: { content: 'OK' }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { content: '' }, done: true, eval_count: 1 })}\n`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    cleanupServers.push(fleetOllama);

    const deadUrl = await getUnusedPortUrl();
    const wazirHome = makeWazirHome({
      lmstudioUrl: `${deadUrl}/v1`,
      ollamaUrl: deadUrl,
      mlxUrl: `${mlxServer.url}/v1`,
      fleetHosts: [{ id: 'mac_studio', ollamaUrl: fleetOllama.url }],
    });

    const discovered = await discoverFastLocalEndpoints({ wazirHome, env: {} });
    expect(discovered.find((e) => e.runtimeType === 'mlx')?.candidate.loaded).toBe(true);
    expect(discovered.find((e) => e.endpoint === 'mac_studio:ollama' && e.candidate.id === 'small-4b')?.candidate.loaded).toBe(false);

    // strictLoopbackOnly filters out non-loopback fleet endpoints
    const nonLoopbackHome = makeWazirHome({
      lmstudioUrl: `${deadUrl}/v1`,
      ollamaUrl: deadUrl,
      mlxUrl: `${deadUrl}/v1`,
      strictLoopbackOnly: true,
      fleetHosts: [{ id: 'remote_box', ollamaUrl: 'http://100.64.0.99:11434' }],
    });
    expect(await discoverFastLocalEndpoints({ wazirHome: nonLoopbackHome, env: {} })).toEqual([]);

    // Unloaded <=10B fallback benchmark when no model is loaded
    const unloadedOnlyHome = makeWazirHome({
      lmstudioUrl: `${deadUrl}/v1`,
      ollamaUrl: fleetOllama.url,
      mlxUrl: `${deadUrl}/v1`,
    });
    const bench = await benchmarkFastLocalModels({ wazirHome: unloadedOnlyHome, env: {} });
    expect(bench.selected?.candidate.id).toBe('small-4b');
    expect(bench.entries.find((e) => e.candidate.id === 'small-4b')?.candidate.measuredTtftMs).toBeGreaterThan(0);
    expect(bench.entries.find((e) => e.candidate.id === 'huge-70b')?.candidate.measuredTtftMs).toBeUndefined();
  });
});
