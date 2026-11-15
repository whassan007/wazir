import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaAdapter } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OllamaAdapter.estimateModelLoad', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('supports Gemma 4 array-valued attention.head_count_kv across layers', async () => {
    const weightBytes = 18 * 1024 ** 3;
    const contextTokens = 4096;
    // 4 layers: [2, 2, 2, 16] => 22 total KV heads across layers
    // key_length = 256, value_length = 256, 2 bytes/elem (FP16)
    // contextBytes = 22 * (256 + 256) * 2 * 4096 = 92_274_688
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return jsonResponse({
          size: weightBytes,
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.block_count': 4,
            'gemma4.embedding_length': 3840,
            'gemma4.attention.head_count': 16,
            'gemma4.attention.head_count_kv': [2, 2, 2, 16],
            'gemma4.attention.key_length': 256,
            'gemma4.attention.value_length': 256,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter('http://localhost:11434');
    const estimate = await adapter.estimateModelLoad('gemma4:26b', contextTokens);

    const expectedContextBytes = 22 * (256 + 256) * 2 * contextTokens;
    const expectedOverheadBytes = Math.max(1024 ** 3, weightBytes * 0.15);
    expect(estimate).toEqual({
      weightBytes,
      contextBytes: expectedContextBytes,
      overheadBytes: expectedOverheadBytes,
      totalMemoryBytes: weightBytes + expectedContextBytes + expectedOverheadBytes,
      vramBytes: weightBytes + expectedContextBytes + expectedOverheadBytes,
      source: 'HEURISTIC',
      confidence: 'low',
    });
  });

  it('supports scalar attention.head_count_kv with fallback head_dim = embedding / head_count', async () => {
    const weightBytes = 8 * 1024 ** 3;
    const contextTokens = 8192;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'llama3.1:8b', model: 'llama3.1:8b', size: weightBytes }] });
      }
      if (url.endsWith('/api/ps')) {
        return jsonResponse({ models: [] });
      }
      if (url.endsWith('/api/show')) {
        return jsonResponse({
          model_info: {
            'general.architecture': 'llama',
            'llama.block_count': 32,
            'llama.embedding_length': 4096,
            'llama.attention.head_count': 32,
            'llama.attention.head_count_kv': 8,
            'llama.context_length': 131072,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter('http://localhost:11434');
    await adapter.listModels();
    const estimate = await adapter.estimateModelLoad('llama3.1:8b', contextTokens);

    // 32 layers * 8 kv_heads * (128 + 128) * 2 bytes * 8192 tokens = 1 GiB
    const expectedContextBytes = 32 * 8 * 256 * 2 * contextTokens;
    const expectedOverheadBytes = Math.max(1024 ** 3, weightBytes * 0.15);
    expect(estimate.source).toBe('HEURISTIC');
    expect(estimate.weightBytes).toBe(weightBytes);
    expect(estimate.contextBytes).toBe(expectedContextBytes);
    expect(estimate.overheadBytes).toBe(expectedOverheadBytes);
    expect(estimate.totalMemoryBytes).toBe(weightBytes + expectedContextBytes + expectedOverheadBytes);
  });

  it('uses explicit attention.key_length and attention.value_length instead of embedding / heads', async () => {
    const weightBytes = 10 * 1024 ** 3;
    const contextTokens = 2048;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return jsonResponse({
          model_info: {
            'general.architecture': 'gemma4',
            'general.file_size': weightBytes,
            'gemma4.block_count': 10,
            // embedding / heads = 2048 / 8 = 256, but explicit key/value lengths differ!
            'gemma4.embedding_length': 2048,
            'gemma4.attention.head_count': 8,
            'gemma4.attention.head_count_kv': 4,
            'gemma4.attention.key_length': 512,
            'gemma4.attention.value_length': 256,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter('http://localhost:11434');
    const estimate = await adapter.estimateModelLoad('gemma4:e4b', contextTokens);

    const expectedContextBytes = 10 * 4 * (512 + 256) * 2 * contextTokens;
    expect(estimate.source).toBe('HEURISTIC');
    expect(estimate.contextBytes).toBe(expectedContextBytes);
    expect(estimate.totalMemoryBytes).toBeGreaterThan(weightBytes);
  });

  it('ignores vision tower keys (*.vision.*) in favor of LLM architecture', async () => {
    const weightBytes = 12 * 1024 ** 3;
    const contextTokens = 4096;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return jsonResponse({
          size: weightBytes,
          model_info: {
            // Vision keys intentionally placed BEFORE LLM keys, and without general.architecture
            'gemma4.vision.block_count': 27,
            'gemma4.vision.embedding_length': 1152,
            'gemma4.vision.attention.head_count': 16,
            'gemma4.vision.attention.head_count_kv': 16,
            'gemma4.vision.attention.key_length': 72,
            'gemma4.vision.attention.value_length': 72,
            'gemma4.mmproj.block_count': 1,
            // Actual LLM keys:
            'gemma4.block_count': 30,
            'gemma4.embedding_length': 2560,
            'gemma4.attention.head_count': 8,
            'gemma4.attention.head_count_kv': [2, 2, 8],
            'gemma4.attention.key_length': 256,
            'gemma4.attention.value_length': 256,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter('http://localhost:11434');
    const estimate = await adapter.estimateModelLoad('gemma4:vision', contextTokens);

    // Mean of [2, 2, 8] = 4, * 30 layers = 120 KV heads
    const expectedContextBytes = 120 * (256 + 256) * 2 * contextTokens;
    expect(estimate.source).toBe('HEURISTIC');
    expect(estimate.contextBytes).toBe(expectedContextBytes);
  });

  it('fetches /api/tags to resolve missing modelSizes cache and includes weights + KV + overhead', async () => {
    const weightBytes = 6 * 1024 ** 3;
    const contextTokens = 4096;
    let tagsCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/show')) {
        return jsonResponse({
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.block_count': 24,
            'gemma4.attention.head_count_kv': 4,
            'gemma4.attention.key_length': 256,
            'gemma4.attention.value_length': 256,
          },
        });
      }
      if (url.endsWith('/api/tags')) {
        tagsCalls += 1;
        return jsonResponse({
          models: [{ name: 'gemma4:latest', model: 'gemma4:latest', size: weightBytes }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OllamaAdapter('http://localhost:11434');
    // Note: listModels() was NOT called beforehand
    const estimate = await adapter.estimateModelLoad('gemma4', contextTokens);

    expect(tagsCalls).toBe(1);
    expect(estimate.source).toBe('HEURISTIC');
    expect(estimate.weightBytes).toBe(weightBytes);
    expect(estimate.contextBytes).toBe(24 * 4 * (256 + 256) * 2 * contextTokens);
    expect(estimate.overheadBytes).toBe(Math.max(1024 ** 3, weightBytes * 0.15));
    expect(estimate.totalMemoryBytes).toBeGreaterThan(weightBytes);
  });

  it('returns UNKNOWN for missing, zero, or invalid architecture metadata', async () => {
    const cases: Array<{ name: string; showBody: unknown; tagsBody?: unknown; contextTokens?: number }> = [
      {
        name: 'missing block_count',
        showBody: {
          size: 4 * 1024 ** 3,
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.attention.head_count_kv': [2, 2],
            'gemma4.attention.key_length': 256,
            'gemma4.attention.value_length': 256,
          },
        },
      },
      {
        name: 'zero in head_count_kv array',
        showBody: {
          size: 4 * 1024 ** 3,
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.block_count': 2,
            'gemma4.attention.head_count_kv': [2, 0],
            'gemma4.attention.key_length': 256,
            'gemma4.attention.value_length': 256,
          },
        },
      },
      {
        name: 'empty head_count_kv array',
        showBody: {
          size: 4 * 1024 ** 3,
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.block_count': 2,
            'gemma4.attention.head_count_kv': [],
            'gemma4.attention.key_length': 256,
            'gemma4.attention.value_length': 256,
          },
        },
      },
      {
        name: 'zero key_length',
        showBody: {
          size: 4 * 1024 ** 3,
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.block_count': 2,
            'gemma4.embedding_length': 2048,
            'gemma4.attention.head_count': 8,
            'gemma4.attention.head_count_kv': 2,
            'gemma4.attention.key_length': 0,
            'gemma4.attention.value_length': 256,
          },
        },
      },
      {
        name: 'only vision keys present (no LLM architecture)',
        showBody: {
          size: 4 * 1024 ** 3,
          model_info: {
            'gemma4.vision.block_count': 27,
            'gemma4.vision.embedding_length': 1152,
            'gemma4.vision.attention.head_count': 16,
            'gemma4.vision.attention.head_count_kv': 16,
          },
        },
      },
      {
        name: 'missing weightBytes everywhere',
        showBody: {
          model_info: {
            'general.architecture': 'gemma4',
            'gemma4.block_count': 4,
            'gemma4.attention.head_count_kv': [2, 2, 2, 8],
            'gemma4.attention.key_length': 256,
            'gemma4.attention.value_length': 256,
          },
        },
        tagsBody: { models: [] },
      },
      {
        name: 'invalid contextTokens <= 0',
        showBody: { size: 4 * 1024 ** 3, model_info: {} },
        contextTokens: 0,
      },
    ];

    for (const tc of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/api/show')) return jsonResponse(tc.showBody);
          if (url.endsWith('/api/tags')) return jsonResponse(tc.tagsBody ?? { models: [] });
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );

      const adapter = new OllamaAdapter('http://localhost:11434');
      const result = await adapter.estimateModelLoad('gemma4:test', tc.contextTokens ?? 4096);
      expect(result, tc.name).toEqual({ source: 'UNKNOWN', confidence: 'unknown' });
      vi.unstubAllGlobals();
    }
  });
});
