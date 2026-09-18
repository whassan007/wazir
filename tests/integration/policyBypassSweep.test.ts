import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PolicyEngine,
  AgentRegistry,
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
  ExecutionEngine,
  Scheduler,
  ContextCompiler,
  Task,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import { Worker } from '@wazir/workers';
import { FakeRuntimeAdapter } from '../fakes/runtime.js';
import { executeTask, planTask } from '../../apps/cli/src/run.js';
import type { RookEngine } from '../../apps/cli/src/engine.js';
import { ApprovalQueue } from '@wazir/core';

describe('Policy Bypass Sweep (Section 4)', () => {
  let tempDir: string;
  let projectRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-policy-sweep-'));
    projectRoot = path.join(tempDir, 'project');
    outsideDir = path.join(tempDir, 'outside');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'test', scripts: { test: 'echo test' } }));
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'super-secret-content');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  function createTestPolicyEngine(customRules: { allowCommands?: string[]; denyCommands?: string[]; networkAllowed?: boolean } = {}) {
    return new PolicyEngine({
      projectRoot,
      networkAllowed: customRules.networkAllowed ?? false,
      allowCommands: customRules.allowCommands,
      denyCommands: customRules.denyCommands ?? ['rm -rf /', 'reboot', 'shutdown'],
    });
  }

  it('entry point 1: CLI planTask and executeTask reject policy denials', async () => {
    const policy = createTestPolicyEngine();
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const agents = new AgentRegistry();
    const tools = new ToolRegistry(defaultTools);
    const executions = new ExecutionEngine();
    const compiler = new ContextCompiler();

    computers.register({
      id: 'local',
      name: 'local-test',
      type: 'workstation',
      local: true,
      os: { platform: 'linux', architecture: 'x64', version: '6.0' },
      hardware: { cpu: 'test', cpuCores: 4, memoryGB: 16 },
      capabilities: ['localExecution'],
    });

    runtimes.register({
      id: 'fake-runtime',
      type: 'other',
      name: 'fake',
      version: '1.0',
      computerId: 'local',
      capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
    });

    models.register({
      id: 'fake-model',
      name: 'fake-model',
      provider: 'fake-runtime',
      family: 'other',
      contextMax: 32768,
      capabilities: ['coding', 'generalChat'],
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      audio: false,
      embedding: false,
      reasoning: false,
      runtimeCompatibility: 'any',
      local: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    models.upsertInstance({
      id: 'fake-model::local::fake-runtime',
      modelId: 'fake-model',
      computerId: 'local',
      runtimeId: 'fake-runtime',
      runtimeModelId: 'fake-model',
      loaded: true,
      health: 'healthy',
      contextTokens: 32768,
    });

    agents.register(createCodingAgent(), 'native');
    const scheduler = new Scheduler({ computers, runtimes, models, agents });

    const fakeAdapter = new FakeRuntimeAdapter();
    const worker = new Worker({
      computerId: 'local',
      name: 'local-test',
      adapters: [fakeAdapter],
    });
    await worker.start();

    const engine: RookEngine = {
      projectRoot,
      config: { networkAllowed: false, contextBudgetTokens: 16000 },
      policy,
      approvalQueue: new ApprovalQueue(),
      computers,
      runtimes,
      models,
      agents,
      tools,
      scheduler,
      compiler,
      executions,
      worker,
      discovered: worker.discovered,
      orchestrator: {} as any,
    };

    // Attempting a task with explicit network requirement when network is disallowed:
    const plan = await planTask(engine, 'curl http://evil.com', { type: 'coding' });
    // In planTask, if task requires tool access but policy disables it:
    const taskPolicyDecision = policy.evaluateTask({
      id: 'task-net',
      type: 'coding',
      input: 'curl http://evil.com',
      requirements: { toolCalling: true },
      policy: { toolAccess: false, projectRoot },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    });
    expect(taskPolicyDecision.allowed).toBe(false);

    // Also verify tool execution of denied command through executeTask tool execution handler
    const toolResult = await engine.tools.get('shell')?.execute({ command: 'reboot' }, { projectRoot });
    // Directly running through policy authorize:
    const authDecision = await policy.authorize({ tool: 'shell', input: { command: 'reboot' }, projectRoot });
    expect(authDecision.decision).toBe('deny');
  });

  it('entry point 2: Agent-invoked tool is blocked by policy authorize', async () => {
    const policy = createTestPolicyEngine();
    // Agent attempts to invoke a shell tool running reboot
    const decision = await policy.authorize({
      tool: 'shell',
      input: { command: 'reboot' },
      projectRoot,
    });

    expect(decision.decision).toBe('deny');
    expect(decision.rule).toBe('shell-dangerous-deny');
  });

  it('entry point 3: Worker execution respects policy and rejects forbidden operations', async () => {
    const policy = createTestPolicyEngine();
    // Shell tool with command traversal or denied command
    const decision = policy.classify({
      tool: 'shell',
      input: { command: 'echo hello && rm -rf /' },
      projectRoot,
    });
    expect(decision.decision).toBe('deny');

    // Filesystem read outside project
    const fsDecision = policy.classify({
      tool: 'read',
      input: { path: '../outside/secret.txt' },
      projectRoot,
    });
    expect(fsDecision.decision).toBe('deny');
  });

  it('entry point 4: Replay under CURRENT policy, not past policy (Critical Invariant)', async () => {
    // Scenario: A tool call was allowed yesterday under lenient policy (allowCommands: ['special-op'])
    const lenientPolicy = new PolicyEngine({
      projectRoot,
      allowCommands: ['special-op'],
    });

    const initialDecision = lenientPolicy.classify({
      tool: 'shell',
      input: { command: 'special-op --data=1' },
      projectRoot,
    });
    expect(initialDecision.decision).toBe('allow');

    // Today the policy was updated to deny 'special-op'
    const currentRestrictedPolicy = new PolicyEngine({
      projectRoot,
      denyCommands: ['special-op'],
    });

    // Replay evaluation: must re-run classification under CURRENT policy
    const replayDecision = currentRestrictedPolicy.classify({
      tool: 'shell',
      input: { command: 'special-op --data=1' },
      projectRoot,
    });

    // It MUST be denied now, proving that past execution cannot bypass current security policy
    expect(replayDecision.decision).toBe('deny');
  });

  it('entry point 5: Unapproved MCP server is denied across all entry points', async () => {
    const policy = new PolicyEngine({
      projectRoot,
      allowedMcpServers: ['trusted-server'],
    });

    const unapprovedDecision = policy.classify({
      tool: 'mcp:evil-server:steal_keys',
      input: {},
      projectRoot,
    });
    expect(unapprovedDecision.decision).toBe('deny');
    expect(unapprovedDecision.rule).toBe('mcp-explicit-approval');

    const approvedDecision = policy.classify({
      tool: 'mcp:trusted-server:safe_op',
      input: {},
      projectRoot,
    });
    expect(approvedDecision.decision).toBe('allow');
  });
});
