import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonFileStore } from '@wazir/shared';
import {
  ComputerRegistry,
  RuntimeRegistry,
  ModelRegistry,
  AgentRegistry,
  Scheduler,
  SchedulingError,
  PolicyEngine,
  ExecutionEngine,
  JobManager,
  JobOrchestrator,
  CheckpointService,
  WorktreeManager,
  ResourceLedger,
  AccountRegistry,
  TokenBudgetManager,
  ResourceRouter,
  DEFAULT_THRESHOLDS,
  type Task,
  type ExecutionRecord,
  type Job,
  type AgentTurn,
} from '@wazir/core';
import { ToolRegistry, defaultTools, createCodeModeTool } from '@wazir/tools';
import { CodingAgent, StepAgent } from '@wazir/agents';
import { getStatus } from '../../apps/cli/src/status.js';
import { createEngine } from '../../apps/cli/src/engine.js';
import { FleetTui } from '../../apps/cli/src/tui/fleetTui.js';
import { TerminalScreen } from '../../apps/cli/src/tui/screen.js';
import { createApiState, createApp } from '../../apps/api/src/server.js';

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve(process.cwd(), 'apps/cli/dist/index.js');

async function makeTempDir(prefix = 'wazir-live-rel-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createFakeScreen(
  cols = 120,
  rows = 40,
  presentation: 'dashboard' | 'conversation' = 'conversation',
): { screen: TerminalScreen; chunks: string[]; text: () => string } {
  const chunks: string[] = [];
  const inStream = new PassThrough();
  const fakeStream: any = {
    isTTY: true,
    columns: cols,
    rows: rows,
    write: (str: string) => {
      chunks.push(String(str));
      return true;
    },
    on: () => fakeStream,
    off: () => fakeStream,
    removeListener: () => fakeStream,
  };
  const screen = new TerminalScreen(inStream, fakeStream, presentation);
  return {
    screen,
    chunks,
    text: () => chunks.join('').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''),
  };
}

describe('Wazir Comprehensive Live Reliability & Systemic Failure Detectors', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  // =========================================================================
  // DETECTOR 1 & 2: Silent Failure & Lost Input (Conversation TUI)
  // Covers DEF-02: Every slash command, why <topic>, /block, and unknown /cmd
  // produces durable visible transcript output in wa chat conversation mode.
  // =========================================================================
  describe('Detectors 1 & 2: Conversation TUI Silent-Failure & Lost-Input Invariants (DEF-02)', () => {
    it('renders durable transcript output for every conversation slash command without opening invisible dashboard modals', async () => {
      const engine = await createEngine({
        projectRoot: tmpDir,
        configDir: path.join(tmpDir, '.wazir'),
        inMemory: true,
        skipDiscovery: true,
      });

      const { screen, chunks, text } = createFakeScreen(120, 40, 'conversation');
      const tui = new FleetTui({
        engine,
        screen,
        presentationMode: 'conversation',
      });

      const commandsToVerify: Array<{ cmd: string; expectedSubstring: string }> = [
        { cmd: '/help', expectedSubstring: 'Commands:' },
        { cmd: '/status', expectedSubstring: 'Status:' },
        { cmd: '/models', expectedSubstring: 'model' },
        { cmd: '/agents', expectedSubstring: 'Agents' },
        { cmd: '/runtimes', expectedSubstring: 'Runtimes' },
        { cmd: '/tasks', expectedSubstring: 'No tasks in this session' },
        { cmd: '/doctor', expectedSubstring: 'System diagnostics' },
        { cmd: '/why model', expectedSubstring: 'Model' },
        { cmd: 'why complete', expectedSubstring: 'No execution evidence loaded' },
        { cmd: '/block', expectedSubstring: 'No command blocks recorded' },
        { cmd: '/block nonexistent-blk', expectedSubstring: "Block 'nonexistent-blk' not found" },
        { cmd: '/context', expectedSubstring: 'Context utilization:' },
        { cmd: '/evidence', expectedSubstring: 'No execution evidence' },
        { cmd: '/improvement', expectedSubstring: 'Self-improvement:' },
        { cmd: '/canary', expectedSubstring: 'Canary deployments:' },
        { cmd: '/search', expectedSubstring: 'Search view available' },
        { cmd: '/worktrees', expectedSubstring: 'Worktree isolation:' },
        { cmd: '/clear', expectedSubstring: 'Screen repainted' },
        { cmd: '/clear-context', expectedSubstring: 'Cleared all active context blocks' },
        { cmd: '/pin nonexistent-model', expectedSubstring: "No registered model 'nonexistent-model'" },
        { cmd: '/unpin', expectedSubstring: 'Cleared model pin' },
        { cmd: '/cancel', expectedSubstring: 'cancel' },
        { cmd: '/retry', expectedSubstring: 'retry' },
        { cmd: '/steer', expectedSubstring: 'Usage: /steer <instruction>' },
        { cmd: '/fanout', expectedSubstring: 'Usage: /fanout' },
        { cmd: '/unknown-bogus-cmd', expectedSubstring: "Unknown command '/unknown-bogus-cmd'" },
      ];

      for (const { cmd, expectedSubstring } of commandsToVerify) {
        const beforeLen = chunks.length;
        await tui.submitCommand(cmd);
        expect(chunks.length, `Command '${cmd}' produced zero render chunks`).toBeGreaterThan(beforeLen);
        expect(tui.isWhyModalOpen(), `Command '${cmd}' opened dashboard whyModal in conversation mode`).toBe(false);
        expect(text(), `Command '${cmd}' did not render expected output '${expectedSubstring}'`).toContain(expectedSubstring);
      }
    });

    it('executes inline shell commands (!cmd and /sh cmd), records blocks, and expands them via /block in conversation mode', async () => {
      const engine = await createEngine({
        projectRoot: tmpDir,
        configDir: path.join(tmpDir, '.wazir'),
        inMemory: false,
        skipDiscovery: true,
      });

      const { screen, text } = createFakeScreen(120, 40, 'conversation');
      const tui = new FleetTui({
        engine,
        screen,
        presentationMode: 'conversation',
      });

      await tui.submitCommand('!echo WAZIR_SHELL_VISIBLE_123');
      expect(text()).toContain('WAZIR_SHELL_VISIBLE_123');
      expect(text()).toContain('Command completed · exit 0');

      const blockId = (tui as any).lastShellOutput?.blockId;
      expect(blockId).toBeDefined();

      await tui.submitCommand(`/block ${blockId}`);
      expect(text()).toContain(`Block #${blockId}`);
      expect(text()).toContain('WAZIR_SHELL_VISIBLE_123');
    });

    it('removes fabricated exp-042 data when zero experiments exist (DEF-03)', async () => {
      const engine = await createEngine({
        projectRoot: tmpDir,
        configDir: path.join(tmpDir, '.wazir'),
        inMemory: true,
        skipDiscovery: true,
      });

      const status = getStatus(engine);
      expect(status.version).toMatch(/^0\.2\./);
      expect(status.executions.active).toBe(0);
      expect(status.executions.queued).toBe(0);

      const { screen, text } = createFakeScreen(120, 40, 'dashboard');
      const tui = new FleetTui({
        engine,
        screen,
        presentationMode: 'dashboard',
      });
      await tui.submitCommand('/improvement');
      expect(text()).not.toContain('exp-042');
    });
  });

  // =========================================================================
  // DETECTOR 3: False Success (CLI Exit Codes & Verification Guards)
  // Covers DEF-04, DEF-06 & DEF-07
  // =========================================================================
  describe('Detector 3: False-Success Prevention — CLI Exit Codes & Verification Guards (DEF-04, DEF-06, DEF-07)', () => {
    it('returns non-zero exit code for missing entities across CLI inspection and mutation commands', async () => {
      const env = {
        ...process.env,
        WAZIR_HOME: path.join(tmpDir, '.wazir-cli'),
        WAZIR_IN_MEMORY: '1',
        WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
        WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:1',
      };

      const failingCommands: string[][] = [
        ['computers', 'inspect', 'nonexistent-comp-999'],
        ['task', 'status', 'nonexistent-task-999'],
        ['models', 'inspect', 'nonexistent-model-999'],
        ['executions', 'inspect', 'nonexistent-exec-999'],
        ['jobs', 'inspect', 'nonexistent-job-999'],
        ['history', 'inspect', 'nonexistent-block-999'],
        ['runtimes', 'inspect', 'nonexistent-runtime-999'],
        ['executions', 'checkpoint', 'nonexistent-exec-999'],
        ['executions', 'rollback', 'nonexistent-exec-999', '--checkpoint', 'chk-1'],
        ['improve', 'inspect', 'nonexistent-exp-999'],
        ['improve', 'promote', 'nonexistent-cand-999'],
      ];

      for (const args of failingCommands) {
        let exitCode = 0;
        let combined = '';
        try {
          const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
            cwd: tmpDir,
            env,
            timeout: 15_000,
          });
          combined = `${stdout}\n${stderr}`;
        } catch (err: any) {
          exitCode = typeof err?.code === 'number' ? err.code : 1;
          combined = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}`;
        }
        expect(exitCode, `Expected 'wa ${args.join(' ')}' to exit non-zero, got 0. Output: ${combined}`).not.toBe(0);
      }
    }, 60_000);

    it('rejects expectedArtifacts with wrong directory path instead of matching by basename alone (DEF-06)', async () => {
      // Create file in wrong directory (tmpDir/wrong/target.ts instead of tmpDir/src/target.ts)
      await fs.mkdir(path.join(tmpDir, 'wrong'), { recursive: true });
      const wrongPath = path.join(tmpDir, 'wrong', 'target.ts');

      let callCount = 0;
      const agent = new CodingAgent({ maxTurns: 2 });
      const turns: AgentTurn[] = [];

      for await (const turn of agent.run(
        {
          taskId: 'task-artifact-path',
          taskType: 'coding',
          taskDescription: 'Create src/target.ts',
          projectRoot: tmpDir,
          modelId: 'mock-model',
          expectedArtifacts: ['src/target.ts'],
          mutationRequired: true,
        },
        {
          tools: [
            { name: 'write', description: 'write file', inputSchema: {} },
            { name: 'build', description: 'build', inputSchema: {} },
            { name: 'test', description: 'test', inputSchema: {} },
            { name: 'lint', description: 'lint', inputSchema: {} },
            { name: 'typecheck', description: 'typecheck', inputSchema: {} },
          ],
          async *generate() {
            callCount++;
            if (callCount === 1) {
              yield {
                type: 'token',
                content: JSON.stringify({
                  action: 'tool',
                  tool: 'write',
                  input: { path: 'wrong/target.ts', content: 'export const x = 1;\n' },
                }),
              };
            } else {
              yield {
                type: 'token',
                content: JSON.stringify({
                  action: 'done',
                  summary: 'Created target.ts',
                }),
              };
            }
          },
          executeTool: async (name: string) => {
            if (name === 'write') {
              await fs.writeFile(wrongPath, 'export const x = 1;\n', 'utf8');
              return { ok: true, output: 'wrote wrong/target.ts', durationMs: 1 };
            }
            return { ok: true, output: 'ok', durationMs: 1 };
          },
        } as any,
      )) {
        turns.push(turn);
      }

      const doneTurn = turns.find((t) => t.kind === 'done');
      const errorTurn = turns.find((t) => t.kind === 'error');
      expect(doneTurn).toBeUndefined();
      expect(errorTurn).toBeDefined();
      expect(errorTurn?.error ?? '').toContain("Expected artifact 'src/target.ts' was not created");
    });

    it('passes toolNames into StepAgent parseAction so bare tool JSON calls are recognized (DEF-07)', async () => {
      let turn = 0;
      const executedTools: string[] = [];
      const stepAgent = new StepAgent({ maxTurns: 4 });
      const turns: AgentTurn[] = [];

      for await (const ev of stepAgent.run(
        {
          taskId: 'task-step-1',
          taskType: 'coding',
          taskDescription: 'Read README.md',
          projectRoot: tmpDir,
          modelId: 'mock-model',
        },
        {
          tools: [{ name: 'read', description: 'Read file', inputSchema: {} }],
          async *generate() {
            turn++;
            if (turn === 1) {
              // Bare tool JSON without "action":"tool" wrapper: {"name": "read", "arguments": {"path": "README.md"}}
              yield {
                type: 'token',
                content: JSON.stringify({ name: 'read', arguments: { path: 'README.md' } }),
              };
            } else {
              yield {
                type: 'token',
                content: JSON.stringify({ action: 'done', summary: 'Completed step agent read' }),
              };
            }
          },
          executeTool: async (name: string) => {
            executedTools.push(name);
            return { ok: true, output: 'hello world', durationMs: 1 };
          },
        } as any,
      )) {
        turns.push(ev);
      }

      expect(executedTools).toEqual(['read']);
      expect(turns.some((t) => t.kind === 'done')).toBe(true);
    });
  });

  // =========================================================================
  // DETECTOR 4 & 5: Infinite Execution & Duplicate Execution (JobOrchestrator)
  // Covers DEF-08
  // =========================================================================
  describe('Detectors 4 & 5: JobOrchestrator Deadlock Prevention & Single ExecutionRecord Invariant (DEF-08)', () => {
    it('creates exactly one ExecutionRecord per task and finalizes its status on completion', async () => {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();
      const agents = new AgentRegistry();
      const policy = new PolicyEngine({ projectRoot: tmpDir });

      computers.register({
        id: 'local',
        name: 'Local',
        type: 'workstation',
        local: true,
        os: { platform: 'darwin', architecture: 'arm64', version: '24.0' },
        hardware: { cpu: 'M3', cpuCores: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-local',
        name: 'Local RT',
        type: 'ollama',
        computerId: 'local',
        health: 'healthy',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      models.register({
        id: 'qwen-local',
        name: 'Qwen Local',
        provider: 'ollama',
        local: true,
        contextMax: 32768,
        capabilities: ['coding', 'generalChat'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
      });
      models.upsertInstance({
        id: 'qwen-local::local::rt-local',
        modelId: 'qwen-local',
        computerId: 'local',
        runtimeId: 'rt-local',
        loaded: true,
        state: 'READY',
        health: 'healthy',
      });
      agents.register(new CodingAgent(), 'native');

      const scheduler = new Scheduler({ computers, runtimes, models, agents, policy });
      const executions = new ExecutionEngine({ workspace: tmpDir });
      const jobManager = new JobManager();
      const orchestrator = new JobOrchestrator({
        jobManager,
        scheduler,
        executionEngine: executions,
        computers,
        models,
        taskExecutor: async (t) => {
          const recs = await executions.listByTask(t.id);
          if (recs[0]) {
            await executions.recordCheck(recs[0].execution.id, {
              name: 'test',
              command: 'npm test',
              ok: true,
              durationMs: 10,
              output: '1 passed',
            });
          }
          return {
            success: true,
            output: 'Task completed cleanly',
          };
        },
      });

      const job = jobManager.create({
        title: 'Single Record Test',
        tasks: [{ task: { id: 't-1', type: 'coding', input: 'Say hello', mutationRequired: false } }],
      });

      const finalJob = await orchestrator.runJob(job.id);
      expect(finalJob.tasks[0].error).toBeUndefined();
      expect(finalJob.status).toBe('completed');

      const records = await executions.listByTask('t-1');
      expect(records).toHaveLength(1);
      expect(records[0].execution.status).toBe('completed');
    });

    it('terminates with a clear scheduling failure instead of hanging when assignTask cannot place any ready task', async () => {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();
      const agents = new AgentRegistry();
      const policy = new PolicyEngine({ projectRoot: tmpDir });
      // Zero models registered -> scheduler.plan throws -> assignTask fails cleanly
      const scheduler = new Scheduler({ computers, runtimes, models, agents, policy });
      const executions = new ExecutionEngine({ workspace: tmpDir });
      const jobManager = new JobManager();
      const orchestrator = new JobOrchestrator({
        jobManager,
        scheduler,
        executionEngine: executions,
        computers,
        models,
        taskExecutor: async () => ({ success: true, output: 'unreachable' }),
      });

      const job = jobManager.create({
        title: 'Unschedulable Job',
        tasks: [{ task: { id: 't-unsched', type: 'coding', input: 'Impossible task' } }],
      });

      const finalJob = await orchestrator.runJob(job.id);
      expect(finalJob.status).toBe('failed');
      const task = finalJob.tasks.find((t) => t.id === 't-unsched');
      expect(task?.status).toBe('failed');
    });
  });

  // =========================================================================
  // DETECTOR 6 & 10: Lost State & Broken Recovery (Checkpoint & JobManager)
  // Covers DEF-11 & DEF-12
  // =========================================================================
  describe('Detectors 6 & 10: Durable Checkpoint Persistence & Unowned Job Resume (DEF-11, DEF-12)', () => {
    it('persists checkpoint and rollback mutations to durable storage across engine restarts', async () => {
      const storeFile = path.join(tmpDir, 'exec-state.json');
      const store1 = new JsonFileStore(storeFile);

      const engine1 = new ExecutionEngine({
        workspace: tmpDir,
        persist: async (rec) => {
          await store1.put(`executions/${rec.execution.id}`, rec);
        },
        load: async () => {
          const list = await store1.list('executions/');
          return list.map((e) => e.value as ExecutionRecord);
        },
      });
      await engine1.ready;

      const sampleFile = path.join(tmpDir, 'hello.txt');
      await fs.writeFile(sampleFile, 'v1\n', 'utf8');

      const record = await engine1.create({
        task: { id: 't-chk', type: 'coding', input: 'Checkpoint test', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
        computerId: 'local',
        runtimeId: 'rt',
        modelId: 'm',
        workspaceRoot: tmpDir,
      });
      await engine1.setStatus(record.execution.id, 'running');
      await engine1.recordFilesChanged(record.execution.id, ['hello.txt']);

      const chkSvc1 = new CheckpointService({
        store: store1,
        executionEngine: engine1,
        worktreeManager: new WorktreeManager(tmpDir),
        defaultWorkspaceRoot: tmpDir,
      });
      const chk = await chkSvc1.checkpoint(record.execution.id);
      expect(chk.id).toMatch(/^chk-/);

      // Modify hello.txt to v2, then rollback to chk
      await fs.writeFile(sampleFile, 'v2\n', 'utf8');
      await chkSvc1.rollback(record.execution.id, chk.id);
      expect(await fs.readFile(sampleFile, 'utf8')).toBe('v1\n');

      // Boot a second engine from the same store file and verify checkpoint & rollback events survived
      const store2 = new JsonFileStore(storeFile);
      const engine2 = new ExecutionEngine({
        workspace: tmpDir,
        load: async () => {
          const list = await store2.list('executions/');
          return list.map((e) => e.value as ExecutionRecord);
        },
      });
      await engine2.ready;

      const reloaded = await engine2.get(record.execution.id);
      expect(reloaded).toBeDefined();
      const events = reloaded?.events ?? [];
      expect(events.some((e) => e.type === 'execution.checkpoint.created')).toBe(true);
      expect(events.some((e) => e.type === 'execution.rollback.completed')).toBe(true);
    });

    it('resumes a paused store-backed job via JobManager.resume(jobId) without requiring a prior lease owner', async () => {
      const storeFile = path.join(tmpDir, 'jobs-state.json');
      const store = new JsonFileStore(storeFile);
      const jm = new JobManager({
        store,
        persist: async (job) => {
          await store.put(`job/${job.id}`, job);
        },
        load: async () => {
          const list = await store.list('job/');
          return list.map((e) => e.value as Job);
        },
      });
      await jm.ready;

      const job = jm.create({
        title: 'Paused Job To Resume',
        tasks: [{ task: { id: 'step-a', input: 'Do A' } }],
      });
      // Ensure initial creation is flushed to store before pause() updates `job/${job.id}`
      await store.put(`job/${job.id}`, job);

      // Pause the job (unowned in `this.claims`), then resume it from store
      await jm.pause(job.id);
      expect(jm.get(job.id)?.status).toBe('paused');

      await jm.resume(job.id);
      const resumed = jm.get(job.id);
      expect(resumed?.status).toBe('ready');
    });
  });

  // =========================================================================
  // DETECTOR 7 & 9: Invalid Routing & Resource Overrun (Scheduler & API)
  // Covers DEF-09 & DEF-10
  // =========================================================================
  describe('Detectors 7 & 9: Scheduler Resource Safety Vetoes & Remote Worker Model Registration (DEF-09, DEF-10)', () => {
    it('enforces hard resource vetoes (emergency_stop / quota_exhausted) even in NVIDIA routing mode and excludes FAILED model instances', () => {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();
      const agents = new AgentRegistry();
      const policy = new PolicyEngine({ projectRoot: tmpDir, allowHostedProvidersDefault: true });
      const ledger = new ResourceLedger(':memory:');
      const accounts = new AccountRegistry([
        {
          id: 'nvidia-api',
          provider: 'nvidia',
          kind: 'api',
          label: 'NVIDIA API',
          enabled: true,
        },
      ]);
      const budget = new TokenBudgetManager(ledger, accounts, {
        mode: 'balanced',
        allowPaid: true,
        leaseMs: 60_000,
        thresholds: DEFAULT_THRESHOLDS,
      });
      const router = new ResourceRouter({
        budget,
        resolveAccount: () => 'nvidia-api',
      });

      runtimes.register({
        id: 'nvidia',
        name: 'NVIDIA API',
        type: 'nvidia',
        runtimeKind: 'hosted',
        health: 'healthy',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: true, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
      });
      models.register({
        id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        name: 'Nemotron Super',
        provider: 'nvidia',
        local: false,
        contextMax: 128000,
        capabilities: ['coding', 'generalChat'],
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: true,
      });
      models.upsertInstance({
        id: 'nvidia/nemotron-3.5-super-vl-120b-a12b::nvidia',
        modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        runtimeId: 'nvidia',
        loaded: true,
        state: 'READY',
        health: 'healthy',
      });
      agents.register(new CodingAgent(), 'native');

      // Trigger emergency stop on the budget manager
      budget.emergencyStop('Budget ceiling reached');

      const scheduler = new Scheduler({
        computers,
        runtimes,
        models,
        agents,
        policy,
        resources: { router },
      });

      const task: Task = {
        id: 't-nvidia-veto',
        type: 'coding',
        input: 'Write code',
        requirements: {},
        policy: { allowHostedProviders: true },
        execution: { routingMode: 'NVIDIA' },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      expect(() => scheduler.plan({ task })).toThrow(SchedulingError);

      // Clear emergency stop, but mark instance as FAILED
      budget.resume();
      models.upsertInstance({
        id: 'nvidia/nemotron-3.5-super-vl-120b-a12b::nvidia',
        modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        runtimeId: 'nvidia',
        loaded: false,
        state: 'FAILED',
        health: 'healthy',
      });

      expect(() => scheduler.plan({ task })).toThrow(SchedulingError);
      ledger.close();
    });

    it('registers remote worker runtimes and model instances on POST /computers/register and heartbeat (DEF-10)', async () => {
      const prevOllama = process.env.WAZIR_OLLAMA_URL;
      const prevLm = process.env.WAZIR_LMSTUDIO_URL;
      process.env.WAZIR_OLLAMA_URL = 'http://127.0.0.1:1';
      process.env.WAZIR_LMSTUDIO_URL = 'http://127.0.0.1:1';

      let httpServer: http.Server | undefined;
      let state: Awaited<ReturnType<typeof createApiState>> | undefined;
      try {
        state = await createApiState({
          projectRoot: tmpDir,
          auth: {
            operatorToken: 'test-op-token',
            registrationToken: 'test-reg-token',
          },
        });
        const app = createApp(state);
        httpServer = http.createServer(app);
        await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', () => resolve()));
        const addr = httpServer.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${addr.port}`;

        const regRes = await fetch(`${baseUrl}/computers/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-reg-token',
          },
          body: JSON.stringify({
            id: 'dgx-spark-01',
            name: 'DGX Spark Worker',
            type: 'server',
            local: false,
            os: { platform: 'linux', architecture: 'arm64', version: '6.8' },
            hardware: { cpu: 'Grace', cpuCores: 72, memoryGB: 128, gpu: { vendor: 'nvidia', model: 'GB10', memoryGB: 128, cuda: true } },
            runtimes: ['ollama'],
            models: ['qwen2.5-coder:32b'],
          }),
        });
        expect([200, 201]).toContain(regRes.status);

        // Verify the API server created the runtime and model instance so Scheduler can place tasks on dgx-spark-01
        const instances = state.models.instancesOf('qwen2.5-coder:32b');
        expect(instances.length).toBeGreaterThan(0);
        expect(instances[0].computerId).toBe('dgx-spark-01');
        expect(instances[0].state).toBe('READY');
      } finally {
        (state?.lifecycle as any)?.stopReconciliation?.();
        if (httpServer) {
          await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        }
        process.env.WAZIR_OLLAMA_URL = prevOllama;
        process.env.WAZIR_LMSTUDIO_URL = prevLm;
      }
    });
  });

  // =========================================================================
  // DETECTOR 8: Unauthorized Execution (PolicyEngine & CodeMode Sandbox)
  // Covers DEF-05
  // =========================================================================
  describe('Detector 8: Unauthorized Execution Prevention — CodeMode Sub-Call Authorization & find -exec (DEF-05)', () => {
    it('enforces authorizeTool on every inner SDK call inside code_mode and blocks unauthorized shell/write actions', async () => {
      await fs.writeFile(path.join(tmpDir, 'README.md'), 'hello wazir\n', 'utf8');

      const policy = new PolicyEngine({ projectRoot: tmpDir, networkAllowed: false });
      const authorizedCalls: string[] = [];
      const registry = new ToolRegistry(defaultTools);
      const codeModeTool = createCodeModeTool(registry);

      const context = {
        projectRoot: tmpDir,
        workingDirectory: tmpDir,
        networkAllowed: false,
        authorizeTool: async (toolName: string, input: Record<string, unknown>) => {
          authorizedCalls.push(toolName);
          const decision = policy.classify({
            tool: toolName,
            input,
            projectRoot: tmpDir,
          });
          if (decision.decision !== 'allow') {
            return {
              allowed: false,
              error: `POLICY_DENIED: ${decision.reasons.join('; ')}`,
              failureClass: 'POLICY_DENIED',
            };
          }
          return { allowed: true };
        },
      };

      // 1. Safe read call inside code_mode succeeds
      const readRes = await codeModeTool.execute(
        { script: 'return await wazir.read("README.md");' },
        context as any,
      );
      expect(readRes.ok).toBe(true);
      expect(authorizedCalls).toContain('read');

      // 2. Dangerous write outside projectRoot inside code_mode is blocked by authorizeTool
      const writeRes = await codeModeTool.execute(
        { script: 'return await wazir.write("/etc/wazir-forbidden", "bad");' },
        context as any,
      );
      expect(writeRes.ok).toBe(false);
      expect(writeRes.error).toContain('POLICY_DENIED');
    });

    it('detects -delete after find -exec ... + and classifies inner command arguments (DEF-05)', () => {
      const policy = new PolicyEngine({ projectRoot: tmpDir, networkAllowed: false });

      // `find . -exec echo {} + -delete` must NOT be 'allow' because `-delete` follows `+`
      const decision1 = policy.classify({
        tool: 'shell',
        input: { command: 'find . -exec echo {} + -delete' },
        projectRoot: tmpDir,
      });
      expect(decision1.decision).not.toBe('allow');

      // `find . -exec cat /etc/passwd \;` must NOT be 'allow' because `/etc/passwd` is outside projectRoot
      const decision2 = policy.classify({
        tool: 'shell',
        input: { command: 'find . -exec cat /etc/passwd \\;' },
        projectRoot: tmpDir,
      });
      expect(decision2.decision).not.toBe('allow');
    });
  });
});
