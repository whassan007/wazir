import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * LIVE-CODE-06: Non-Interactive CLI Subprocess (Release Gate G1)
 *
 * Verifies that `wa` / non-interactive CLI task execution runs in a real child
 * subprocess without requiring a TTY, emits structured NDJSON events (`start`,
 * `dispatch`, `first_token`, `done`, `complete`) on stdout, and exits with
 * deterministic exit code 0 on success and non-zero on failure.
 */
describe('LIVE-CODE-06: Non-Interactive CLI Subprocess (Release Gate G1)', () => {
  let scratchDir: string;

  afterEach(async () => {
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function runSubprocessScript(scriptPath: string, args: string[] = []): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: scratchDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolve({ exitCode, stdout, stderr });
      });
    });
  }

  it('executes a non-interactive CLI subprocess, emits NDJSON stream on stdout, and exits 0', async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live06-cli-'));
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const repoRoot = path.resolve(__dirname, '../../../..');
    const runnerPath = path.join(scratchDir, 'run-cli-subproc.mjs');

    await fs.writeFile(
      runnerPath,
      `
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  ModelLifecycleService,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
} from ${JSON.stringify(req.resolve('@wazir/core'))};
import { ToolRegistry, defaultTools } from ${JSON.stringify(req.resolve('@wazir/tools'))};
import { ChatAgent, createCodingAgent } from ${JSON.stringify(req.resolve('@wazir/agents'))};
import { executeTask } from ${JSON.stringify(path.join(repoRoot, 'apps/cli/dist/run.js'))};

const projectRoot = process.cwd();
const computers = new ComputerRegistry();
const runtimes = new RuntimeRegistry();
const models = new ModelRegistry();
const agents = new AgentRegistry();
const tools = new ToolRegistry(defaultTools);
const compiler = new ContextCompiler();
const executions = new ExecutionEngine();

computers.register({
  id: 'local',
  name: 'local',
  type: 'workstation',
  local: true,
  os: { platform: os.platform(), architecture: os.arch(), version: os.release() },
  hardware: { cpu: 'cpu', cpuCores: 4, memoryGB: 16 },
  capabilities: ['localExecution'],
});
runtimes.register({
  id: 'fake',
  type: 'other',
  name: 'fake',
  version: '1.0',
  computerId: 'local',
  capabilities: {
    chat: true, streaming: true, toolCalling: false, structuredOutput: false,
    vision: false, embeddings: false, reasoning: false, modelLoad: false,
    modelUnload: false, modelDownload: false, statefulChat: false, mcp: false,
  },
});
runtimes.update('fake', { health: 'healthy' });
models.register({
  id: 'fake-model',
  name: 'fake-model',
  provider: 'fake',
  family: 'other',
  contextMax: 32768,
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
  state: 'READY',
  health: 'healthy',
  contextTokens: 32768,
});
agents.register(createCodingAgent(), 'native');
agents.register(new ChatAgent(), 'native');

const fakeAdapter = {
  id: 'fake',
  type: 'other',
  async inspectModel(modelId) { return { modelId, loaded: true, effectiveContext: 32768 }; },
  async probeModel() { return true; },
  async discover() { return { id: 'fake', name: 'fake', version: '1.0' }; },
  async healthCheck() { return { status: 'healthy' }; },
  async listModels() { return [{ id: 'fake-model', name: 'fake-model' }]; },
  async getCapabilities() { return runtimes.get('fake').capabilities; },
  async *generate() {
    yield { type: 'token', content: 'SUBPROC_OK' };
    yield { type: 'completed', content: 'SUBPROC_OK', usage: { inputTokens: 4, outputTokens: 2 } };
  },
};

const engine = {
  config: { modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] },
  projectRoot,
  configDir: path.join(projectRoot, '.wazir'),
  lifecycle: new ModelLifecycleService({ models, runtimes, computers, executions, adapters: new Map([['fake', fakeAdapter]]) }),
  computers,
  runtimes,
  models,
  agents,
  tools,
  policy: new PolicyEngine({ projectRoot, networkAllowed: false }),
  scheduler: new Scheduler({ computers, runtimes, models, agents }),
  compiler,
  executions,
  adapters: new Map([['fake', fakeAdapter]]),
  discovered: [],
  worker: { id: 'worker-local', computerId: 'local', adapterForModel: () => fakeAdapter },
};

const mode = process.argv[2] ?? 'success';
const outcome = await executeTask(
  engine,
  mode === 'fail-model' ? 'Test unknown model' : 'Reply SUBPROC_OK',
  {
    type: 'chat',
    model: mode === 'fail-model' ? 'missing-model-id' : undefined,
    json: true,
    quiet: true,
  },
);
process.exit(outcome.success ? 0 : 1);
`,
    );

    const okRun = await runSubprocessScript(runnerPath, ['success']);
    expect(okRun.exitCode).toBe(0);

    const events = okRun.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l));

    const types = events.map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('dispatch');
    expect(types).toContain('first_token');
    expect(types).toContain('done');
    expect(types).toContain('complete');
    expect(events.find((e) => e.type === 'complete')?.success).toBe(true);

    const failRun = await runSubprocessScript(runnerPath, ['fail-model']);
    expect(failRun.exitCode).toBe(1);
  });
});
