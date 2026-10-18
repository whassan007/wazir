import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodingAgent, isConversationalFastPathRequest } from '@wazir/agents';
import { discoverRuntimes } from '@wazir/workers';
import { LMStudioAdapter } from '@wazir/runtimes-lmstudio';
import { JsonFileStore } from '@wazir/shared';
import {
  ComputerRegistry,
  ExecutionEngine,
  ModelLifecycleService,
  ModelRegistry,
  RuntimeRegistry,
} from '@wazir/core';
import type { AgentRuntime, AgentTurn } from '@wazir/core';
import type { GenerationEvent, RuntimeAdapter } from '@wazir/runtimes-interfaces';

describe('P0 Execution Pipeline Performance Repairs', () => {
  it('1. Cold-start runtime discovery runs concurrently and does not block on slow/unrelated runtimes', async () => {
    const makeDelayedAdapter = (id: string, delayMs: number, healthy: boolean): RuntimeAdapter => ({
      id,
      type: id as any,
      getCapabilities: async () => ({
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embeddings: false,
        functionCalling: true,
        jsonMode: true,
        systemPrompt: true,
        contextCaching: false,
        local: true,
        remote: false,
        modelLoadUnload: true,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      }),
      discover: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return { id, name: id, version: '1.0.0' };
      },
      healthCheck: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return { status: healthy ? 'healthy' : 'unavailable', latencyMs: delayMs };
      },
      listModels: async () =>
        healthy
          ? [
              {
                id: `${id}-model`,
                name: `${id}-model`,
                loaded: true,
                contextWindow: 32768,
              },
            ]
          : [],
      loadModel: async () => {},
      unloadModel: async () => {},
      estimateModelLoad: async () => ({ estimatedTotalMemory: 0, contextLength: 8192 }),
      generate: async function* () {},
    });

    const t0 = performance.now();
    const discovered = await discoverRuntimes([
      makeDelayedAdapter('ollama', 70, false),
      makeDelayedAdapter('lmstudio', 70, true),
      makeDelayedAdapter('vllm', 70, false),
    ]);
    const elapsedMs = performance.now() - t0;

    expect(discovered).toHaveLength(3);
    // Each adapter takes ~140ms (discover + healthCheck); concurrent execution across 3 adapters
    // takes ~145ms instead of sequential 420ms+.
    expect(elapsedMs).toBeLessThan(320);
  });

  it('2. Unavailable Ollama does not delay LM Studio execution during fastStartup reconciliation and READY reuse', async () => {
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const executions = new ExecutionEngine();

    computers.register({
      id: 'comp-local',
      name: 'local',
      type: 'workstation',
      local: true,
      os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
      hardware: { cpu: 'ARM', cpuCores: 20, memoryGB: 128 },
      capabilities: ['localExecution'],
    });

    runtimes.register({
      id: 'ollama',
      name: 'ollama',
      type: 'ollama',
      endpoint: 'http://localhost:11434',
      computerId: 'comp-local',
      status: 'unavailable',
      health: 'unavailable',
      capabilities: {
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        embeddings: false,
        contextWindowManagement: false,
        parallelRequests: true,
        localExecution: true,
      },
      models: [],
    });

    runtimes.register({
      id: 'lmstudio',
      name: 'lmstudio',
      type: 'lmstudio',
      endpoint: 'http://localhost:1234/v1',
      computerId: 'comp-local',
      status: 'running',
      health: 'healthy',
      capabilities: {
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        embeddings: false,
        contextWindowManagement: true,
        parallelRequests: true,
        localExecution: true,
      },
      models: ['gemma-4-26b-a4b-it-qat'],
    });

    runtimes.update('ollama', { health: 'unavailable' });
    runtimes.update('lmstudio', { health: 'healthy' });

    let ollamaCalls = 0;
    let lmstudioProbeCalls = 0;
    let lmstudioEstimateCalls = 0;

    const ollamaAdapter: RuntimeAdapter = {
      id: 'ollama',
      type: 'ollama',
      getCapabilities: async () => runtimes.get('ollama')!.capabilities as any,
      discover: async () => {
        ollamaCalls += 1;
        return { id: 'ollama', name: 'Ollama', version: '0.0' };
      },
      healthCheck: async () => {
        ollamaCalls += 1;
        await new Promise((r) => setTimeout(r, 500));
        return { status: 'unavailable', latencyMs: 500 };
      },
      listModels: async () => [],
      loadModel: async () => {},
      unloadModel: async () => {},
      estimateModelLoad: async () => ({ estimatedTotalMemory: 0, contextLength: 8192 }),
      generate: async function* () {},
    };

    const lmstudioAdapter: RuntimeAdapter = {
      id: 'lmstudio',
      type: 'lmstudio',
      getCapabilities: async () => runtimes.get('lmstudio')!.capabilities as any,
      discover: async () => ({ id: 'lmstudio', name: 'LM Studio', version: '1.0' }),
      healthCheck: async () => ({ status: 'healthy', latencyMs: 1 }),
      listModels: async () => [
        {
          id: 'gemma-4-26b-a4b-it-qat',
          name: 'gemma-4-26b-a4b-it-qat',
          loaded: true,
          contextWindow: 262144,
          effectiveContext: 32768,
          weightBytes: 15 * 1024 ** 3,
          toolCalling: true,
          structuredOutput: true,
        },
      ],
      inspectModel: async () => ({
        loaded: true,
        effectiveContext: 32768,
        memoryBytes: 15 * 1024 ** 3,
      }),
      probeModel: async () => {
        lmstudioProbeCalls += 1;
        return true;
      },
      loadModel: async () => {},
      unloadModel: async () => {},
      estimateModelLoad: async () => {
        lmstudioEstimateCalls += 1;
        return { estimatedTotalMemory: 15 * 1024 ** 3, contextLength: 32768 };
      },
      generate: async function* () {
        yield { type: 'token', content: 'OK' };
        yield { type: 'completed', content: 'OK' };
      },
    };

    const lifecycle = new ModelLifecycleService({
      computers,
      runtimes,
      models,
      executions,
      adapters: new Map([
        ['ollama', ollamaAdapter],
        ['lmstudio', lmstudioAdapter],
      ]),
    });

    await lifecycle.discoverAndReconcile({ fastStartup: true });
    expect(ollamaCalls).toBe(0);
    expect(lmstudioProbeCalls).toBe(0);

    const instances = models.instancesOf('gemma-4-26b-a4b-it-qat');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.state).toBe('READY');

    // Verify activateExecution reuses the READY model with 0 estimateModelLoad or probeModel calls
    const rec = await executions.create({
      task: {
        id: 'task-fast-1',
        type: 'coding',
        input: 'What is 12 + 19? Return only the number.',
        requirements: { minimumContext: 8192 },
        policy: { networkAccess: false },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      },
      agentId: 'wazir-coding',
      computerId: 'comp-local',
      runtimeId: 'lmstudio',
      modelId: 'gemma-4-26b-a4b-it-qat',
      workerId: 'worker-1',
    });

    const effectiveContext = await lifecycle.activateExecution(rec.execution.id, 8192);
    expect(effectiveContext).toBe(32768);
    expect(lmstudioEstimateCalls).toBe(0);
    expect(lmstudioProbeCalls).toBe(0);
  });

  it('3. Explicit Gemma model selection (google/gemma-4-12b-qat) resolves to resident Gemma 4 QAT in LMStudioAdapter and caches native discovery', async () => {
    let nativeFetchCount = 0;
    let chatRequestModel = '';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/api/v1/models')) {
        nativeFetchCount += 1;
        return new Response(
          JSON.stringify({
            models: [
              {
                type: 'llm',
                key: 'gemma-4-26b-a4b-it-qat',
                display_name: 'Gemma 4 26B A4B IT QAT',
                architecture: 'gemma4',
                quantization: { name: 'Q4_0', bits_per_weight: 4 },
                size_bytes: 15641472288,
                max_context_length: 262144,
                loaded_instances: [
                  {
                    id: 'gemma-4-26b-a4b-it-qat',
                    config: { context_length: 32768 },
                  },
                ],
                capabilities: { vision: true, trained_for_tool_use: true },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (urlStr.endsWith('/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        chatRequestModel = body.model;
        const sse = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: '31' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('Not found', { status: 404 });
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const adapter = new LMStudioAdapter('http://localhost:1234/v1');
      const hc = await adapter.healthCheck();
      expect(hc.status).toBe('healthy');

      const disc1 = await adapter.listModels();
      const disc2 = await adapter.listModels();
      // Both healthCheck and repeated listModels() calls share the short-lived nativeModels cache
      expect(nativeFetchCount).toBe(1);
      expect(disc1.some((m) => m.id === 'google/gemma-4-12b-qat')).toBe(true);
      expect(disc2.some((m) => m.id === 'gemma-4-26b-a4b-it-qat')).toBe(true);
      const inspected = await adapter.inspectModel('google/gemma-4-12b-qat');
      expect(inspected.loaded).toBe(true);
      expect(inspected.effectiveContext).toBe(32768);

      const events: GenerationEvent[] = [];
      for await (const ev of adapter.generate({
        modelId: 'google/gemma-4-12b-qat',
        messages: [{ role: 'user', content: 'What is 12 + 19? Return only the number.' }],
        stream: false,
      })) {
        events.push(ev);
      }
      expect(chatRequestModel).toBe('gemma-4-26b-a4b-it-qat');
      expect(events.filter((e) => e.type === 'token').map((e) => e.content).join('')).toBe('31');

      // Cache invalidation on unloadModel
      await adapter.unloadModel('gemma-4-26b-a4b-it-qat').catch(() => {});
      await adapter.listModels();
      expect(nativeFetchCount).toBeGreaterThan(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('4 & 5. Simple arithmetic and benchmark prompts execute in a single model call with zero tool invocations', async () => {
    const benchmarkPrompts = [
      { id: 'P01', prompt: 'What is 12 + 19? Return only the number.', reply: '31' },
      { id: 'P02', prompt: 'Reverse the string WAZIR.', reply: 'RIZAW' },
      { id: 'P03', prompt: 'What is 8 multiplied by 7?', reply: '56' },
      { id: 'P04', prompt: 'Write a Python function that adds two integers.', reply: 'def add(a: int, b: int) -> int:\n    return a + b' },
      { id: 'P05', prompt: 'Explain a queue in one sentence.', reply: 'A queue is a FIFO data structure where elements are added at the back and removed from the front.' },
    ];

    for (const item of benchmarkPrompts) {
      expect(isConversationalFastPathRequest(item.prompt)).toBe(true);

      let generateCalls = 0;
      let toolCalls = 0;
      let passedToolsSchema: unknown = 'unset';

      const runtime: AgentRuntime = {
        tools: [
          {
            name: 'read',
            description: 'Read file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
          {
            name: 'write',
            description: 'Write file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          },
          {
            name: 'shell',
            description: 'Run shell',
            inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          },
        ],
        runtimeCapabilities: { toolCalling: true, nativeToolCalling: true, structuredOutput: true },
        getCapabilities: () => ({ toolCalling: true, nativeToolCalling: true, structuredOutput: true }),
        generate: async function* (req) {
          generateCalls += 1;
          passedToolsSchema = req.tools;
          yield { type: 'token', content: item.reply };
          yield { type: 'completed', content: item.reply, finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
        },
        executeTool: async () => {
          toolCalls += 1;
          return { ok: true, output: '', durationMs: 1 };
        },
      };

      const agent = new CodingAgent();
      const turns: AgentTurn[] = [];
      for await (const turn of agent.run(
        {
          modelId: 'google/gemma-4-12b-qat',
          taskDescription: item.prompt,
          projectRoot: '/tmp',
        },
        runtime,
      )) {
        turns.push(turn);
      }

      expect(generateCalls).toBe(1);
      expect(toolCalls).toBe(0);
      expect(passedToolsSchema).toBeUndefined();
      const doneTurn = turns.find((t) => t.kind === 'done');
      expect(doneTurn).toBeDefined();
      expect(doneTurn?.content).toBe(item.reply);
      expect(doneTurn?.terminationReason).toBe('VERIFICATION_PASSED');
      expect(doneTurn?.runStats?.turns).toBe(1);
      expect(doneTurn?.runStats?.toolCalls).toBe(0);
    }
  });

  it('6. Coding or tool-requiring prompts retain full agent and tool orchestration', async () => {
    const codingPrompts = [
      'write a hello file',
      'write a c++ program',
      'write and compile a c++ program',
      'try to write outside the project',
      'create hello.txt containing "hi"',
      'Fix the bug in apps/cli/src/run.ts',
      'Run npm test and report failures',
      'Write a Python function in math_utils.py that adds two integers.',
    ];
    for (const p of codingPrompts) {
      expect(isConversationalFastPathRequest(p)).toBe(false);
    }

    let generateCalls = 0;
    const executedTools: string[] = [];
    const scriptedResponses = [
      JSON.stringify({ action: 'plan', content: 'Write hello.txt' }),
      JSON.stringify({ action: 'tool', tool: 'write', input: { path: 'hello.txt', content: 'hello' } }),
      JSON.stringify({ action: 'done', summary: 'Created hello.txt' }),
    ];

    const runtime: AgentRuntime = {
      tools: [
        {
          name: 'write',
          description: 'Write file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
      ],
      runtimeCapabilities: { toolCalling: false, nativeToolCalling: false, structuredOutput: false },
      getCapabilities: () => ({ toolCalling: false, nativeToolCalling: false, structuredOutput: false }),
      generate: async function* () {
        const reply = scriptedResponses[generateCalls] ?? JSON.stringify({ action: 'done', summary: 'done' });
        generateCalls += 1;
        yield { type: 'token', content: reply };
        yield { type: 'completed', content: reply, finishReason: 'stop' };
      },
      executeTool: async (name) => {
        executedTools.push(name);
        if (name === 'write') {
          return { ok: true, output: 'wrote hello.txt', durationMs: 1, fileMutations: [{ path: 'hello.txt', action: 'created', changed: true }] };
        }
        return { ok: false, output: 'missing script', error: 'missing script', durationMs: 1 };
      },
    };

    const agent = new CodingAgent();
    const turns: AgentTurn[] = [];
    for await (const turn of agent.run(
      {
        modelId: 'google/gemma-4-12b-qat',
        taskDescription: 'write a hello file',
        projectRoot: '/tmp',
      },
      runtime,
    )) {
      turns.push(turn);
    }

    expect(generateCalls).toBe(3);
    expect(executedTools).toContain('write');
    expect(turns.find((t) => t.kind === 'done')?.terminationReason).toBe('VERIFICATION_PASSED');
  });

  it('8. JsonFileStore stat-snapshot cache avoids redundant disk re-reads and invalidates when file changes on disk', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-store-perf-'));
    const storeFile = path.join(tmpDir, 'records.json');
    try {
      const store = new JsonFileStore(storeFile);
      await store.put('item-1', { id: 'item-1', count: 1 });
      await store.put('item-2', { id: 'item-2', count: 2 });

      const readFileSpy = vi.spyOn(fs, 'readFile');
      const countStoreReads = () =>
        readFileSpy.mock.calls.filter((call) => String(call[0]) === storeFile).length;

      // Repeated reads and writes from the same process when file has not changed externally
      // should not trigger fs.readFile on the store file.
      await store.get('item-1');
      await store.put('item-1', { id: 'item-1', count: 3 });
      await store.put('item-2', { id: 'item-2', count: 4 });
      await store.get('item-2');
      expect(countStoreReads()).toBe(0);

      // External modification on disk invalidates the stat snapshot and triggers reload
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(
        storeFile,
        JSON.stringify({
          'item-1': { id: 'item-1', count: 99 },
          'item-2': { id: 'item-2', count: 4 },
        }),
        'utf8',
      );
      const updated = (await store.get('item-1')) as { id: string; count: number } | undefined;
      expect(countStoreReads()).toBe(1);
      expect(updated?.count).toBe(99);
      readFileSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
