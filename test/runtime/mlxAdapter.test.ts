import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createMLXAdapter, MLXAdapter } from '@wazir/runtimes-mlx';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  ModelLifecycleService,
  ModelRegistry,
  PolicyEngine,
  ProvenanceManager,
  RuntimeRegistry,
} from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import { runRuntimeAdapterContractSuite } from './adapterContract.suite.js';

const MOCK_BARE_URL = 'http://127.0.0.1:18080';
const MOCK_V1_URL = `${MOCK_BARE_URL}/v1`;
const DISCONNECT_V1_URL = 'http://127.0.0.1:18081/v1';
const OFFLINE_V1_URL = 'http://127.0.0.1:1/v1';

let thinkStreamMode = false;
const recordedRequests: any[] = [];

function sseResponse(frames: string[], signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('aborted', 'AbortError'));
        return;
      }
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function disconnectingSseResponse(): Response {
  const encoder = new TextEncoder();
  let sentFirst = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial...' } }] })}\n\n`),
        );
        return;
      }
      controller.error(new Error('socket hang up'));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

beforeAll(() => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(rawUrl);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (rawUrl.startsWith('http://127.0.0.1:1/')) {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
    }

    if (u.origin === 'http://127.0.0.1:18081') {
      if (u.pathname === '/v1/models' && method === 'GET') {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'mlx-community/Qwen3.5-9B-6bit', object: 'model', owned_by: 'mlx_lm' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.pathname === '/v1/chat/completions' && method === 'POST') {
        return disconnectingSseResponse();
      }
      return new Response('Not Found', { status: 404 });
    }

    // mlx_lm.server never exposes LM Studio's proprietary /api/v1/* endpoints.
    if (u.pathname.startsWith('/api/v1/')) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (u.pathname === '/v1/models' && method === 'GET') {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'mlx-community/Qwen3.5-9B-6bit',
              object: 'model',
              created: 1700000000,
              owned_by: 'mlx_lm',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (u.pathname === '/v1/chat/completions' && method === 'POST') {
      const parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      recordedRequests.push(parsed);

      if (parsed.model === 'nonexistent-model') {
        return new Response(JSON.stringify({ error: { message: "Model 'nonexistent-model' not found" } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (parsed.stream === false) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-mlx-sync',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const frames: string[] = [];
      if (thinkStreamMode) {
        for (const piece of ['<thi', 'nk>Analyzing Qwen3.5 ', 'step by step.</th', 'ink>\nFinal MLX answer.']) {
          frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
      } else {
        frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from mlx_lm.server!' } }] })}\n\n`);
      }
      frames.push(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
        })}\n\n`,
      );
      frames.push('data: [DONE]\n\n');
      return sseResponse(frames, init?.signal ?? undefined);
    }

    return new Response('Not Found', { status: 404 });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

runRuntimeAdapterContractSuite({
  name: '@wazir/runtimes-mlx',
  createAdapter: () => createMLXAdapter(MOCK_V1_URL),
  expectedType: 'mlx',
  simulateFailure: {
    createOfflineAdapter: () => createMLXAdapter(OFFLINE_V1_URL),
    createDisconnectingAdapter: () => createMLXAdapter(DISCONNECT_V1_URL),
  },
});

describe('MLXAdapter — mlx_lm.server specifics & ModelLifecycleService integration', () => {
  it('normalizes bare host URLs (without /v1) to /v1 endpoints', async () => {
    const adapter = createMLXAdapter(MOCK_BARE_URL);
    const info = await adapter.discover();
    expect(info.id).toBe('mlx');
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toContain('mlx-community/Qwen3.5-9B-6bit');
  });

  it('separates streamed <think>...</think> blocks into reasoning events and strips them from final content', async () => {
    thinkStreamMode = true;
    try {
      const adapter = createMLXAdapter(MOCK_V1_URL);
      const events: any[] = [];
      for await (const event of adapter.generate({
        modelId: 'mlx-community/Qwen3.5-9B-6bit',
        messages: [{ role: 'user', content: 'Solve this' }],
      })) {
        events.push(event);
      }
      const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.content).join('');
      const tokens = events.filter((e) => e.type === 'token').map((e) => e.content).join('');
      const completed = events.find((e) => e.type === 'completed');

      expect(reasoning).toContain('Analyzing Qwen3.5 step by step.');
      expect(tokens.trim()).toBe('Final MLX answer.');
      expect(completed?.content.trim()).toBe('Final MLX answer.');
      expect(completed?.content).not.toContain('<think>');
    } finally {
      thinkStreamMode = false;
    }
  });

  it('enriches Qwen3.5 multimodal nested text_config metadata from local HuggingFace hub cache', async () => {
    const hfCacheDir = mkdtempSync(path.join(os.tmpdir(), 'wazir-hf-cache-'));
    try {
      const snapDir = path.join(
        hfCacheDir,
        'models--mlx-community--Qwen3.5-9B-6bit',
        'snapshots',
        'abc123def456',
      );
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(
        path.join(snapDir, 'config.json'),
        JSON.stringify({
          model_type: 'qwen3_5',
          quantization: { group_size: 64, bits: 6 },
          vision_config: { hidden_size: 1152 },
          text_config: {
            hidden_size: 4096,
            num_hidden_layers: 36,
            num_attention_heads: 32,
            num_key_value_heads: 8,
            max_position_embeddings: 262144,
          },
        }),
      );
      writeFileSync(path.join(snapDir, 'model-00001-of-00001.safetensors'), Buffer.alloc(4096));

      const adapter = new MLXAdapter(MOCK_V1_URL, { hfCacheDir });
      const models = await adapter.listModels();
      const qwen = models.find((m) => m.id === 'mlx-community/Qwen3.5-9B-6bit');
      expect(qwen).toBeDefined();
      expect(qwen?.contextWindow).toBe(262144);
      expect(qwen?.quantization).toBe('6bit');
      expect(qwen?.vision).toBe(true);
      expect(qwen?.reasoning).toBe(true);
      expect(qwen?.toolCalling).toBe(true);
    } finally {
      rmSync(hfCacheDir, { recursive: true, force: true });
    }
  });

  it('integrates cleanly with ModelLifecycleService (discoverAndReconcile -> load -> READY -> unload)', async () => {
    const store = new MemoryStore();
    const computers = new ComputerRegistry();
    computers.register({
      id: 'macbook-pro',
      name: 'MacBook Pro',
      type: 'workstation',
      local: true,
      os: { platform: 'darwin', architecture: 'arm64', version: '24.0.0' },
      hardware: {
        cpu: 'Apple M4 Max',
        cpuCores: 16,
        memoryGB: 64,
        gpu: { vendor: 'apple', model: 'Apple M4 Max', memoryGB: 64, unifiedMemory: true },
      },
      capabilities: ['localExecution'],
    });
    computers.heartbeat('macbook-pro', {
      load: { cpuPercent: 10, memoryUsedGB: 16, memoryAvailableGB: 48 },
    });

    const runtimes = new RuntimeRegistry();
    const adapter = createMLXAdapter(MOCK_V1_URL);
    const caps = await adapter.getCapabilities();
    runtimes.register({
      id: 'mlx',
      type: 'mlx',
      name: 'MLX LM Server',
      version: 'mlx_lm',
      url: MOCK_BARE_URL,
      computerId: 'macbook-pro',
      capabilities: caps,
    });
    runtimes.update('mlx', { health: 'healthy' });

    const models = new ModelRegistry();
    const agents = new AgentRegistry();
    const policy = new PolicyEngine({ projectRoot: '/tmp' });
    const provenance = new ProvenanceManager(store);
    const executions = new ExecutionEngine({ provenanceManager: provenance, workspace: '/tmp', fastStartup: true });
    const adapters = new Map([['mlx', adapter]]);

    const lifecycle = new ModelLifecycleService({
      models,
      runtimes,
      computers,
      agents,
      adapters,
      store,
      policy,
      executions,
    });

    await lifecycle.discoverAndReconcile({ verify: false });
    expect(models.get('mlx-community/Qwen3.5-9B-6bit')).toBeDefined();

    const loadPlan = await lifecycle.load('mlx-community/Qwen3.5-9B-6bit', {
      computerId: 'macbook-pro',
      runtimeId: 'mlx',
      context: 32768,
    });
    expect(loadPlan.admissionDecision.status).toBe('ADMITTED');
    expect(loadPlan.effectiveContext).toBe(32768);

    const readyInstance = models.instancesOf('mlx-community/Qwen3.5-9B-6bit')[0];
    expect(readyInstance?.state).toBe('READY');
    expect(readyInstance?.loaded).toBe(true);
    expect(readyInstance?.contextTokens).toBe(32768);

    await lifecycle.unload('mlx-community/Qwen3.5-9B-6bit', {
      computerId: 'macbook-pro',
      runtimeId: 'mlx',
    });
    const afterUnload = models.instancesOf('mlx-community/Qwen3.5-9B-6bit')[0];
    expect(afterUnload?.loaded).toBe(false);
    expect(afterUnload?.state).toBe('UNLOADED');
  });
});
