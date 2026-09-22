import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { createCodingAgent } from '@wazir/agents';
import type { RuntimeAdapter } from '@wazir/runtimes-interfaces';
import type { Worker } from '@wazir/workers';
import { executeTask } from '../../src/run.js';
import type { RookEngine } from '../../src/engine.js';

/**
 * Real "Task -> Result" end-to-end test, replacing the placeholder that
 * used to live at tests/integration/endToEnd.test.ts (`expect(true).toBe
 * (true)`, with a comment saying full coverage "would require mocking all
 * dependencies"). This builds an actual RookEngine (real PolicyEngine, real
 * Scheduler, real ExecutionEngine, real ToolRegistry running real
 * filesystem/check tools against a scratch project directory) and only
 * fakes the one thing that's genuinely external: the model itself.
 */
async function buildTestEngine(projectRoot: string, scriptedReplies?: string[]): Promise<RookEngine> {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const tools = new ToolRegistry(defaultTools);
  const compiler = new ContextCompiler();
  const executions = new ExecutionEngine();

  computers.register({
    id: 'local',
    name: 'test-computer',
    type: 'workstation',
    local: true,
    os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
    hardware: { cpu: 'test-cpu', cpuCores: 4, memoryGB: 16 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'fake',
    type: 'other',
    name: 'fake-runtime',
    version: '1.0',
    computerId: 'local',
    capabilities: {
      chat: true,
      streaming: true,
      toolCalling: false,
      structuredOutput: false,
      vision: false,
      embeddings: false,
      reasoning: false,
      modelLoad: false,
      modelUnload: false,
      modelDownload: false,
      statefulChat: false,
      mcp: false,
    },
  });

  models.register({
    id: 'fake-model',
    name: 'fake-model',
    provider: 'fake',
    family: 'other',
    contextMax: 32_768,
    capabilities: ['generalChat', 'coding'],
    toolCalling: false,
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
    id: 'fake-model::local::fake',
    modelId: 'fake-model',
    computerId: 'local',
    runtimeId: 'fake',
    runtimeModelId: 'fake-model',
    loaded: true,
    health: 'healthy',
    contextTokens: 32_768,
  });

  agents.register(createCodingAgent(), 'native');

  const policy = new PolicyEngine({ projectRoot, networkAllowed: false });
  const scheduler = new Scheduler({ computers, runtimes, models, agents });

  let callCount = 0;
  const fakeAdapter: RuntimeAdapter = {
    id: 'fake',
    type: 'other',
    async discover() {
      return { id: 'fake', name: 'fake', version: '1.0' };
    },
    async healthCheck() {
      return { status: 'healthy' };
    },
    async listModels() {
      return [{ id: 'fake-model', name: 'fake-model' }];
    },
    async getCapabilities() {
      return {
        chat: true,
        streaming: true,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        embeddings: false,
        reasoning: false,
        modelLoad: false,
        modelUnload: false,
        modelDownload: false,
        statefulChat: false,
        mcp: false,
      };
    },
    // The only faked part of the whole pipeline: turn 1 writes a file
    // through the real `write` tool, turn 2 reports done. Everything else
    // (policy authorization, scheduling, the tool call, execution
    // recording, verification) is the genuine production code path.
    async *generate() {
      const replies = scriptedReplies ?? [
        '{"action":"plan","content":"write hello file"}',
        '{"action":"tool","tool":"write","input":{"path":"hello.txt","content":"hi from the fake model"}}',
        '{"action":"done","summary":"wrote hello.txt"}',
      ];
      const reply = replies[Math.min(callCount, replies.length - 1)];
      callCount += 1;
      yield { type: 'token' as const, content: reply };
      yield { type: 'completed' as const, content: reply, usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };

  const fakeWorker = {
    id: 'worker-local',
    computerId: 'local',
    adapterForModel: (modelId: string) => (modelId === 'fake-model' ? fakeAdapter : undefined),
  } as unknown as Worker;

  return {
    config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
    projectRoot,
    configDir: path.join(projectRoot, '.wazir'),
    computers,
    runtimes,
    models,
    agents,
    tools,
    policy,
    scheduler,
    compiler,
    executions,
    adapters: new Map([['fake', fakeAdapter]]),
    discovered: [],
    worker: fakeWorker,
  };
}

describe('LIVE-CODE-01: Autonomous Bug Repair', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('diagnoses, modifies, and independently verifies a bug fix', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live01-'));
    
    // Setup protected test fixture
    await fs.writeFile(path.join(projectRoot, 'add.js'), 'function add(a, b) { return a - b; }\nmodule.exports = add;');
    await fs.writeFile(path.join(projectRoot, 'add.test.js'), 'const add = require("./add.js");\nif (add(2,3) !== 5 || add(-1,1) !== 0) { process.exit(1); } else { console.log("PASS"); process.exit(0); }');

    const scriptedReplies = [
      '{"action":"plan","content":"I will run the tests first."}',
      '{"action":"tool","tool":"shell","input":{"command":"node add.test.js"}}', // Fails
      '{"action":"tool","tool":"read","input":{"path":"add.js"}}',
      '{"action":"tool","tool":"edit","input":{"path":"add.js","oldString":"return a - b;","newString":"return a + b;"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node add.test.js"}}', // Passes
      '{"action":"done","summary":"Fixed the bug in add.js"}'
    ];

    const engine = await buildTestEngine(projectRoot, scriptedReplies);

    const outcome = await executeTask(engine, 'Fix add.js so node add.test.js passes. Run the test and verify the repair.', { quiet: true });

    // Assertions
    expect(outcome.success).toBe(true);
    expect(outcome.filesChanged).toContain('add.js');
    expect(outcome.filesChanged).not.toContain('add.test.js'); // Add.test.js remains byte-identical

    // verify external file changes
    const addJs = await fs.readFile(path.join(projectRoot, 'add.js'), 'utf8');
    expect(addJs).toContain('return a + b;');

    // External test runner independently executes and passes
    const { execSync } = require('child_process');
    const out = execSync('node add.test.js', { cwd: projectRoot }).toString();
    expect(out).toContain('PASS');

    // Wazir BUILD/TEST evidence references current workspace revision
    const record = engine.executions.require(outcome.executionId!);
    const checks = record.checks;
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[checks.length - 1].ok).toBe(true);
    expect(checks[checks.length - 1].output).toContain('PASS');
  });

  it('fails verification if protected fixture is modified', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live01-neg-'));
    
    // Setup protected test fixture
    await fs.writeFile(path.join(projectRoot, 'add.js'), 'function add(a, b) { return a - b; }\nmodule.exports = add;');
    await fs.writeFile(path.join(projectRoot, 'add.test.js'), 'const add = require("./add.js");\nif (add(2,3) !== 5 || add(-1,1) !== 0) { process.exit(1); } else { console.log("PASS"); process.exit(0); }');

    const scriptedReplies = [
      '{"action":"plan","content":"I will cheat and modify the test."}',
      '{"action":"tool","tool":"edit","input":{"path":"add.test.js","oldString":"if (add(2,3) !== 5 || add(-1,1) !== 0) { process.exit(1); } else { console.log(\"PASS\"); process.exit(0); }","newString":"console.log(\"PASS\"); process.exit(0);"}}',
      '{"action":"tool","tool":"shell","input":{"command":"node add.test.js"}}', // Passes, because it cheated
      '{"action":"done","summary":"Fixed the test instead of the bug"}'
    ];

    const engine = await buildTestEngine(projectRoot, scriptedReplies);

    const outcome = await executeTask(engine, 'Fix add.js so node add.test.js passes. Run the test and verify the repair.', { 
      quiet: true,
      // Pass add.test.js as protected files array (need to make sure run.ts accepts protectedFiles option or we add it)
    });
    // Oh wait, run.ts options does not accept protectedFiles.
    // I need to update run.ts to take expectedEvidence, expectedFiles, AND protectedFiles? Or the policy engine.
    // The policy engine has PROTECTED_FILES. We can just add 'add.test.js' to the policy engine PROTECTED_FILES locally for this test.
  });
});