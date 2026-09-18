import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FakeRuntimeAdapter, createFakeRuntimeAdapter } from '../fakes/runtime.js';
import { createLMStudioAdapter, LMStudioAdapter } from '@wazir/runtimes-lmstudio';
import { createOllamaAdapter, OllamaAdapter } from '@wazir/runtimes-ollama';
import { executeRequest, type ExecutionStreamEvent } from '@wazir/workers';
import { PolicyEngine, AgentRegistry, Scheduler, ComputerRegistry, RuntimeRegistry, ModelRegistry } from '@wazir/core';
import { ExternalAgentAdapter } from '@wazir/agents';

const execFileAsync = promisify(execFile);

// Probing state
const isCI = process.env.CI === 'true' || process.env.CI === '1';
const forceLive = process.env.FORCE_LIVE_TESTS === '1';
const allowLiveDaemons = !isCI || forceLive;

let isOllamaLive = false;
let ollamaModel: string | undefined;

let isLMStudioLive = false;
let lmstudioLoadedModel: string | undefined;

let isOpenCodeInstalled = false;
let openCodeVersion: string | undefined;

// Probe endpoints before running tests
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234';

beforeAll(async () => {
  if (allowLiveDaemons) {
    // 1. Probe Ollama
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(600) });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        if (data.models && data.models.length > 0) {
          isOllamaLive = true;
          ollamaModel = data.models[0].name;
        }
      }
    } catch {
      isOllamaLive = false;
    }

    // 2. Probe LM Studio
    try {
      const res = await fetch(`${LMSTUDIO_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(600) });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        if (data.data && data.data.length > 0) {
          isLMStudioLive = true;

          // Check if a model is already loaded in memory via LM Studio's v0 API
          try {
            const v0Res = await fetch(`${LMSTUDIO_BASE_URL}/api/v0/models`, { signal: AbortSignal.timeout(600) });
            if (v0Res.ok) {
              const v0Data = (await v0Res.json()) as { data?: Array<{ id: string; state?: string }> };
              const loaded = v0Data.data?.find((m) => m.state === 'loaded');
              if (loaded?.id) {
                lmstudioLoadedModel = loaded.id;
              }
            }
          } catch {
            // No v0 API; keep undefined
          }
        }
      }
    } catch {
      isLMStudioLive = false;
    }
  }

  // 3. Probe OpenCode binary
  try {
    const { stdout } = await execFileAsync('opencode', ['--version'], { timeout: 1500 });
    isOpenCodeInstalled = true;
    openCodeVersion = stdout.trim();
  } catch {
    isOpenCodeInstalled = false;
  }
});

// =========================================================================
// Suite 1: FakeRuntimeAdapter (Deterministic CI Baseline - ALWAYS RUNS)
// =========================================================================
describe('Section 17 Matrix: Fake Runtime (Deterministic CI Baseline)', () => {
  it('discovers runtime metadata and reports healthy status', async () => {
    const adapter = createFakeRuntimeAdapter();
    const info = await adapter.discover();
    expect(info.id).toBe('fake-runtime');
    expect(info.name).toBe('Fake Runtime');

    const health = await adapter.healthCheck();
    expect(health.status).toBe('healthy');

    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe('test-model:latest');
  });

  it('validates streaming generation, tool-use calls, and required event structure', async () => {
    const adapter = createFakeRuntimeAdapter();
    const events: ExecutionStreamEvent[] = [];

    const outcome = await executeRequest(
      adapter,
      {
        taskId: 'fake-matrix-task-1',
        modelId: 'test-model:latest',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      },
      (ev) => events.push(ev),
    );

    // Assert required structure
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBeDefined();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.inputTokens).toBeGreaterThanOrEqual(0);
    expect(outcome.outputTokens).toBeGreaterThanOrEqual(0);

    // Verify stream event sequencing
    const tokenEvents = events.filter((e) => e.type === 'token');
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    const completedEvents = events.filter((e) => e.type === 'completed');

    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(toolEvents.length).toBe(1);
    expect(toolEvents[0].toolName).toBe('read_file');
    expect(completedEvents.length).toBe(1);
  });

  it('respects Policy DENY before execution occurs', async () => {
    const policy = new PolicyEngine({
      projectRoot: '/tmp',
    });

    const denied = await policy.authorize({
      tool: 'shell',
      input: { command: 'sudo rm -rf /' },
    });
    expect(denied.decision).toBe('deny');

    const allowed = await policy.authorize({
      tool: 'shell',
      input: { command: 'echo "hello"' },
    });
    expect(allowed.decision).toBe('allow');

    // Task-level policy evaluation
    const taskPolicyDenied = policy.evaluateTask({
      id: 'task-disallowed',
      type: 'coding',
      title: 'Disallowed Task',
      input: 'code',
      policy: { toolAccess: false },
      requirements: {
        capabilities: ['coding'],
        reasoning: 'low',
        vision: false,
        toolCalling: true,
        minimumContext: 1024,
        minimumMemoryGB: 4,
        minimumGPUMemoryGB: 0,
        localOnly: false,
      },
      execution: { executionMode: 'automatic' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(taskPolicyDenied.allowed).toBe(false);
  });
});

// =========================================================================
// Suite 2: LM Studio (Runs if daemon is online, gracefully skips otherwise)
// =========================================================================
describe('Section 17 Matrix: LM Studio Live Execution', () => {
  it('gracefully skips or executes live requests based on daemon availability', async () => {
    if (!isLMStudioLive || !lmstudioLoadedModel) {
      // Graceful skip when daemon is offline or no model is resident
      expect(true).toBe(true);
      return;
    }

    const adapter = createLMStudioAdapter(`${LMSTUDIO_BASE_URL}/v1`);
    const info = await adapter.discover();
    expect(info.id).toBe('lmstudio');
    expect(info.name).toBe('LM Studio');

    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === lmstudioLoadedModel)).toBe(true);

    // Execute live coding-task request with streaming
    const streamedTokens: string[] = [];
    const outcome = await executeRequest(
      adapter,
      {
        taskId: 'lmstudio-live-coding-task',
        modelId: lmstudioLoadedModel,
        messages: [{ role: 'user', content: 'Write a TypeScript function: function add(a: number, b: number): number' }],
        maxTokens: 30,
      },
      (ev) => {
        if (ev.type === 'token' && ev.content) {
          streamedTokens.push(ev.content);
        }
      },
    );

    // Section 17 assertion requirements:
    // "Do not assert exact natural-language output. Assert: response exists,
    // required structure present, tool calls valid, execution completes, policy respected."
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toBeDefined();
    expect(outcome.output.length).toBeGreaterThan(0);
    expect(outcome.durationMs).toBeGreaterThan(0);
    expect(outcome.outputTokens).toBeGreaterThan(0);
    expect(streamedTokens.length).toBeGreaterThan(0);
  });

  it('enforces policy gate on live LM Studio model dispatch', async () => {
    if (!isLMStudioLive) return;

    const policy = new PolicyEngine({
      projectRoot: '/tmp',
      denyCommands: ['restricted-script'],
    });

    const denied = await policy.authorize({
      tool: 'shell',
      input: { command: 'restricted-script --run' },
    });
    expect(denied.decision).toBe('deny');

    const networkDenied = await policy.authorize({
      tool: 'shell',
      input: { command: 'curl http://unauthorized-remote-endpoint.org' },
    });
    expect(networkDenied.decision).toBe('deny');
  });
});

// =========================================================================
// Suite 3: Ollama (Runs if daemon is online, gracefully skips otherwise)
// =========================================================================
describe('Section 17 Matrix: Ollama Live Execution', () => {
  it('gracefully skips or executes live tool-use request based on daemon availability', async () => {
    if (!isOllamaLive || !ollamaModel) {
      // Graceful skip when daemon is offline
      expect(true).toBe(true);
      return;
    }

    const adapter = createOllamaAdapter(OLLAMA_BASE_URL);
    const health = await adapter.healthCheck();
    expect(health.status).toBe('healthy');

    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);

    // Tool-use execution
    const outcome = await executeRequest(adapter, {
      taskId: 'ollama-live-tool-task',
      modelId: ollamaModel,
      messages: [{ role: 'user', content: 'Calculate 40 + 2 using calculate tool.' }],
      tools: [
        {
          name: 'calculate',
          description: 'Calculates math expressions',
          parameters: {
            type: 'object',
            properties: { expression: { type: 'string' } },
            required: ['expression'],
          },
        },
      ],
      maxTokens: 50,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.durationMs).toBeGreaterThan(0);
  });
});

// =========================================================================
// Suite 4: OpenCode External Agent (Runs if installed, gracefully skips otherwise)
// =========================================================================
describe('Section 17 Matrix: OpenCode External Agent', () => {
  it('detects OpenCode binary version or gracefully records absent status', async () => {
    if (!isOpenCodeInstalled) {
      expect(isOpenCodeInstalled).toBe(false);
      return;
    }

    expect(openCodeVersion).toBeDefined();
    expect(typeof openCodeVersion).toBe('string');
    expect(openCodeVersion!.length).toBeGreaterThan(0);
  });

  it('guarantees OpenCode external agent maintains taskTypes: [] routing isolation', () => {
    const opencode = new ExternalAgentAdapter({
      name: 'opencode',
      version: openCodeVersion ?? '1.0.0',
      description: 'OpenCode external agent',
      command: 'opencode',
      args: ['run'],
      taskTypes: [], // CRITICAL Section 11 & Section 17 invariant
      capabilities: ['coding'],
    });

    // Invariant: empty taskTypes
    expect(opencode.descriptor.taskTypes).toEqual([]);

    // Register with AgentRegistry
    const registry = new AgentRegistry();
    registry.register(opencode, 'external');

    // Register a standard native coder
    registry.register(
      {
        descriptor: {
          name: 'standard-coder',
          version: '1.0',
          description: 'Standard coder',
          capabilities: ['coding'],
          requiredTools: [],
          modelRequirements: { capabilities: ['coding'] },
          permissions: [],
          taskTypes: ['coding'],
          strategy: 'test',
        },
        async *run() {
          yield { kind: 'done', content: 'native' };
        },
      },
      'native',
    );

    // Automatic capability resolution must NEVER pick opencode
    const resolved = registry.resolveForTask({
      id: 'task-test',
      type: 'coding',
      title: 'Coding task',
      input: 'code',
      requirements: { capabilities: ['coding'], reasoning: 'low', vision: false, toolCalling: false, minimumContext: 1024, minimumMemoryGB: 4, minimumGPUMemoryGB: 0, localOnly: false },
      execution: { executionMode: 'automatic' },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(resolved).toBeDefined();
    expect(resolved.agent.descriptor.name).toBe('standard-coder');
    expect(resolved.agent.descriptor.name).not.toBe('opencode');
  });
});
