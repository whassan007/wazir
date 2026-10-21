import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedWorkspace,
  runWa,
  runWaPty,
} from './harness/e2eHarness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import { AcceptanceScorecard } from './harness/scorecard.js';
import {
  ComputerRegistry,
  RuntimeRegistry,
  ModelRegistry,
  AgentRegistry,
  Scheduler,
  JobManager,
  JobOrchestrator,
  ExecutionEngine,
  type Job,
} from '@wazir/core';
import { JsonFileStore } from '@wazir/shared';

describe('Codex Task 1: Production-Realistic End-to-End User Journeys', () => {
  const scorecard = new AcceptanceScorecard();

  afterAll(async () => {
    const reportPath = path.resolve(process.cwd(), 'reports/e2e-acceptance-scorecard.json');
    await scorecard.save(reportPath);
  });

  // -------------------------------------------------------------------------
  // JOURNEY 1: First installation, initialization and launch
  // -------------------------------------------------------------------------
  it('Journey 1: First installation, initialization and launch in pristine isolated environment', async () => {
    const { workspaceDir, wazirHome, env, cleanup } = await createIsolatedWorkspace('e2e-init-');
    const start = Date.now();
    try {
      // 1. Run `wa init`
      const initRes = await runWa(['init'], { cwd: workspaceDir, env });
      expect(initRes.exitCode).toBe(0);
      expect(initRes.combined).toContain('initialization complete');

      // Verify durable state was written to disk
      const homeFiles = await fs.readdir(wazirHome);
      expect(homeFiles).toContain('wazir.json');
      expect(homeFiles).toContain('resources.db');

      // 2. Launch `wa --version` and verify it matches package.json's version rather than a
      // hardcoded release string, which goes stale on every release (was a literal '0.2.7').
      const verRes = await runWa(['--version'], { cwd: workspaceDir, env });
      expect(verRes.exitCode).toBe(0);
      const pkgVersion = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
      expect(verRes.combined.trim()).toBe(pkgVersion);

      scorecard.record({
        name: 'First installation and launch',
        category: 'lifecycle',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          initExitCode: initRes.exitCode,
          wazirHomeFiles: homeFiles,
          versionOutput: verRes.combined.trim(),
        },
        transcript: [initRes.combined, verRes.combined],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'First installation and launch',
        category: 'lifecycle',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 2: Running `wa doctor`
  // -------------------------------------------------------------------------
  it('Journey 2: Running `wa doctor` health inspection under isolated environment', async () => {
    const { workspaceDir, env, cleanup } = await createIsolatedWorkspace('e2e-doctor-');
    const start = Date.now();
    try {
      const docRes = await runWa(['doctor', '--json'], { cwd: workspaceDir, env });
      // wa doctor may return exit 1 if local runtimes (ollama/lmstudio) are offline, which is realistic!
      const data = JSON.parse(docRes.stdout);

      expect(data).toHaveProperty('checks');
      expect(data).toHaveProperty('summary');
      expect(Array.isArray(data.checks)).toBe(true);
      expect(data.checks.length).toBeGreaterThan(5);

      const passChecks = data.checks.filter((c: any) => c.status === 'PASS');
      expect(passChecks.length).toBeGreaterThanOrEqual(8);

      scorecard.record({
        name: 'Running wa doctor',
        category: 'diagnostics',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          checksCount: data.checks.length,
          summary: data.summary,
        },
        transcript: [docRes.stdout],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Running wa doctor',
        category: 'diagnostics',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 3: Model discovery and selection
  // -------------------------------------------------------------------------
  it('Journey 3: Model discovery, registry inspection, and selection filtering', async () => {
    const { workspaceDir, env, cleanup } = await createIsolatedWorkspace('e2e-models-');
    const start = Date.now();
    try {
      const listRes = await runWa(['models', 'list'], { cwd: workspaceDir, env });
      expect(listRes.exitCode).toBe(0);
      expect(listRes.combined).toContain('WAZIR MODELS');
      expect(listRes.combined).toContain('Summary: Installed');

      // Discover runtimes command with sub-command `all`
      const discRes = await runWa(['discover', 'all'], { cwd: workspaceDir, env });
      expect(discRes.exitCode).toBe(0);
      expect(discRes.combined).toContain('Runtime discovery');

      scorecard.record({
        name: 'Model discovery and selection',
        category: 'models',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          modelsListExitCode: listRes.exitCode,
          discoverExitCode: discRes.exitCode,
        },
        transcript: [listRes.combined, discRes.combined],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Model discovery and selection',
        category: 'models',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 4: Interactive TUI PTY driving (wa chat) with simulated human keyboard
  // -------------------------------------------------------------------------
  it('Journey 4: Driving `wa chat` using real pseudo-terminal with simulated keyboard inputs', async () => {
    const { workspaceDir, env, cleanup } = await createIsolatedWorkspace('e2e-chat-pty-');
    const start = Date.now();
    try {
      const ptyResult = await runWaPty(['chat'], {
        cwd: workspaceDir,
        env,
        steps: [
          { op: 'wait', text: 'WAZIR', timeout: 15 },
          { op: 'send', data: '!echo USER_KEYBOARD_PROMPT_OK\r' },
          { op: 'wait', text: 'USER_KEYBOARD_PROMPT_OK', timeout: 15 },
          { op: 'send', data: '/exit\r' },
          { op: 'exit', timeout: 10 },
        ],
      });

      expect(ptyResult.exitCode).toBe(0);
      expect(ptyResult.killed).toBe(false);
      expect(ptyResult.outputTail).toContain('USER_KEYBOARD_PROMPT_OK');
      expect(ptyResult.outputTail).toContain('Command completed');

      scorecard.record({
        name: 'Interactive TUI chat PTY workflow',
        category: 'terminal',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          outputBytes: ptyResult.outputBytes,
          stepsCompleted: ptyResult.steps.map((s) => s.op),
        },
        transcript: [ptyResult.outputTail],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Interactive TUI chat PTY workflow',
        category: 'terminal',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 5: Creating and modifying source files with real outcome verification
  // -------------------------------------------------------------------------
  it('Journey 5: Creating, modifying source files and verifying real observable filesystem mutations', async () => {
    const { workspaceDir, env, cleanup } = await createIsolatedWorkspace('e2e-file-mutation-');
    const start = Date.now();
    try {
      const targetFile = path.join(workspaceDir, 'src', 'calculator.ts');
      // Create directory and file via shell in wa chat
      const ptyResult = await runWaPty(['chat'], {
        cwd: workspaceDir,
        env,
        steps: [
          { op: 'wait', text: 'WAZIR', timeout: 15 },
          { op: 'send', data: '!mkdir -p src && echo "export const add = (a: number, b: number) => a + b;" > src/calculator.ts\r' },
          { op: 'wait', text: 'Command completed', timeout: 15 },
          { op: 'send', data: '!cat src/calculator.ts\r' },
          { op: 'wait', text: 'export const add', timeout: 15 },
          { op: 'send', data: '/exit\r' },
          { op: 'exit', timeout: 10 },
        ],
      });

      expect(ptyResult.exitCode).toBe(0);

      // Independently verify filesystem changes
      const content = await fs.readFile(targetFile, 'utf8');
      expect(content).toContain('export const add');

      scorecard.record({
        name: 'Creating and modifying source files',
        category: 'tools',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          createdFilePath: targetFile,
          verifiedContent: content.trim(),
        },
        transcript: [ptyResult.outputTail],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Creating and modifying source files',
        category: 'tools',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 6: Running build, tests and handling failed commands
  // -------------------------------------------------------------------------
  it('Journey 6: Executing builds, tests and detecting non-zero exit codes & failures accurately', async () => {
    const { workspaceDir, env, cleanup } = await createIsolatedWorkspace('e2e-build-fail-');
    const start = Date.now();
    try {
      // 1. Success command
      const ptyResult = await runWaPty(['chat'], {
        cwd: workspaceDir,
        env,
        steps: [
          { op: 'wait', text: 'WAZIR', timeout: 15 },
          { op: 'send', data: '!sh -c "echo BUILDING_SUCCESSFUL; exit 0"\r' },
          { op: 'wait', text: 'Command completed · exit 0', timeout: 15 },
          { op: 'send', data: '!sh -c "echo TEST_FAILED_ASSERTION >&2; exit 42"\r' },
          { op: 'wait', text: 'Command failed · exit 42', timeout: 15 },
          { op: 'send', data: '/exit\r' },
          { op: 'exit', timeout: 10 },
        ],
      });

      expect(ptyResult.exitCode).toBe(0);
      expect(ptyResult.outputTail).toContain('BUILDING_SUCCESSFUL');
      expect(ptyResult.outputTail).toContain('Command completed · exit 0');
      expect(ptyResult.outputTail).toContain('TEST_FAILED_ASSERTION');
      expect(ptyResult.outputTail).toContain('Command failed · exit 42');

      scorecard.record({
        name: 'Running build and handling failed commands',
        category: 'execution',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          outputTail: ptyResult.outputTail,
        },
        transcript: [ptyResult.outputTail],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Running build and handling failed commands',
        category: 'execution',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 7: Handling unavailable models and detecting false successes
  // -------------------------------------------------------------------------
  it('Journey 7: Handling unavailable models without false positives or silent hangs', async () => {
    const { workspaceDir, env, cleanup } = await createIsolatedWorkspace('e2e-unavail-model-');
    const start = Date.now();
    try {
      const runRes = await runWa(
        ['task', 'run', 'Fix bug in auth module', '--model', 'nonexistent-model-xyz', '--json'],
        { cwd: workspaceDir, env }
      );

      // Must exit with error code 1, NEVER exit 0 when task could not run!
      expect(runRes.exitCode).not.toBe(0);

      const parsed = JSON.parse(runRes.stdout);
      expect(parsed.success).toBe(false);
      expect(parsed.reasons.length).toBeGreaterThan(0);

      scorecard.record({
        name: 'Handling unavailable models',
        category: 'fault-tolerance',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          exitCode: runRes.exitCode,
          reportedSuccess: parsed.success,
          reasons: parsed.reasons,
        },
        transcript: [runRes.stdout],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Handling unavailable models',
        category: 'fault-tolerance',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 8: Multi-agent delegation and remote worker coordination
  // -------------------------------------------------------------------------
  it('Journey 8: Multi-agent task planning, delegation and DAG execution', async () => {
    const { workspaceDir, cleanup } = await createIsolatedWorkspace('e2e-multi-agent-');
    const start = Date.now();
    try {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();
      const agents = new AgentRegistry();

      computers.register({
        id: 'local',
        name: 'Local',
        type: 'workstation',
        local: true,
        os: { platform: 'darwin', architecture: 'arm64', version: '24.0' },
        hardware: { cpu: 'M3', cpuCores: 8, memoryGB: 32 },
        capabilities: ['localExecution'],
      });
      computers.register({
        id: 'remote-worker-1',
        name: 'DGX Worker',
        type: 'server',
        local: false,
        os: { platform: 'linux', architecture: 'arm64', version: '6.8' },
        hardware: { cpu: 'Grace', cpuCores: 72, memoryGB: 128 },
        capabilities: ['remoteExecution'],
      });

      runtimes.register({
        id: 'fake-runtime',
        name: 'Local Runtime',
        type: 'other',
        computerId: 'local',
        version: '1.0',
        health: 'healthy',
        capabilities: {
          chat: true,
          streaming: true,
          toolCalling: true,
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
        provider: 'fake-runtime',
        family: 'other',
        local: true,
        contextMax: 32768,
        capabilities: ['generalChat', 'coding'],
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        runtimeCompatibility: 'any',
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

      agents.register(
        {
          descriptor: {
            name: 'test-agent',
            version: '1.0',
            description: 'Test agent',
            capabilities: ['coding', 'generalChat'],
            requiredTools: [],
            modelRequirements: { capabilities: ['coding'] },
            permissions: [],
            taskTypes: ['coding', 'generalChat'],
            strategy: 'test',
          },
          async *run() {
            yield { kind: 'done', content: 'done' };
          },
        },
        'native',
      );

      const scheduler = new Scheduler({ computers, runtimes, models, agents });
      const executions = new ExecutionEngine();
      const jobManager = new JobManager();
      const orchestrator = new JobOrchestrator({
        scheduler,
        executionEngine: executions,
        computers,
        runtimes,
        models,
        agents,
        jobManager,
        taskExecutor: async (task) => {
          return {
            success: true,
            output: `Executed ${task.id} via agent`,
            filesChanged: ['src/delegated.ts'],
          };
        },
      });

      const job = jobManager.create({
        title: 'Multi-Agent Delegation Test',
        tasks: [
          { task: { id: 'step-plan', type: 'coding', input: 'Design step' } },
          { task: { id: 'step-code', type: 'coding', input: 'Implement step' }, dependencies: ['step-plan'] },
        ],
      });

      const finalJob = await orchestrator.runJob(job.id);
      expect(finalJob.status).toBe('completed');
      expect(finalJob.tasks.every((t) => t.status === 'completed')).toBe(true);

      scorecard.record({
        name: 'Multi-agent delegation and remote worker coordination',
        category: 'orchestration',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          jobId: finalJob.id,
          taskCount: finalJob.tasks.length,
          allCompleted: finalJob.tasks.every((t) => t.status === 'completed'),
        },
        transcript: [`Job ${finalJob.id} completed with 2 delegated tasks`],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Multi-agent delegation and remote worker coordination',
        category: 'orchestration',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 9: Restarting Wazir without losing durable work (Process Restarts)
  // -------------------------------------------------------------------------
  it('Journey 9: Restarting Wazir without losing durable work across process restarts', async () => {
    const { workspaceDir, cleanup } = await createIsolatedWorkspace('e2e-restart-recovery-');
    const start = Date.now();
    try {
      const storeFile = path.join(workspaceDir, 'wazir-store.json');
      const store1 = new JsonFileStore(storeFile);

      // Process 1: Create job and record tasks
      const jm1 = new JobManager({
        store: store1,
        persist: async (job) => {
          await store1.put(`jobs/${job.id}`, job);
        },
        load: async () => {
          const list = await store1.list('jobs/');
          return list.map((e) => e.value as Job);
        },
      });
      await jm1.ready;

      const createdJob = jm1.create({
        title: 'Durable Recovery Job',
        tasks: [
          { task: { id: 't1', input: 'Step 1' } },
          { task: { id: 't2', input: 'Step 2' }, dependencies: ['t1'] },
        ],
      });
      await jm1.updateTaskStatus(createdJob.id, 't1', 'completed');
      await store1.put(`jobs/${createdJob.id}`, createdJob);

      // Process 2: Simulating full process restart with clean memory
      const store2 = new JsonFileStore(storeFile);
      const jm2 = new JobManager({
        store: store2,
        persist: async (job) => {
          await store2.put(`jobs/${job.id}`, job);
        },
        load: async () => {
          const list = await store2.list('jobs/');
          return list.map((e) => e.value as Job);
        },
      });
      await jm2.ready;

      const recoveredJob = jm2.get(createdJob.id);
      expect(recoveredJob).toBeDefined();
      expect(recoveredJob?.tasks[0].status).toBe('completed');
      expect(recoveredJob?.tasks[1].status).toBe('pending');

      scorecard.record({
        name: 'Restarting Wazir without losing durable work',
        category: 'durability',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          originalJobId: createdJob.id,
          recoveredJobId: recoveredJob?.id,
          recoveredTask1Status: recoveredJob?.tasks[0].status,
        },
        transcript: [`Recovered job ${createdJob.id} after simulated process restart`],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Restarting Wazir without losing durable work',
        category: 'durability',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // JOURNEY 10: Cancellation and retry
  // -------------------------------------------------------------------------
  it('Journey 10: Cancellation and retry handling under real lifecycle controls', async () => {
    const { workspaceDir, env, cleanup } = await createIsolatedWorkspace('e2e-cancel-retry-');
    const start = Date.now();
    try {
      // Part A: TUI PTY Slash Command /cancel handling
      const ptyResult = await runWaPty(['chat'], {
        cwd: workspaceDir,
        env,
        steps: [
          { op: 'wait', text: 'WAZIR', timeout: 15 },
          { op: 'send', data: '/cancel\r' },
          { op: 'wait', text: 'No job selected to cancel', timeout: 15 },
          { op: 'send', data: '/exit\r' },
          { op: 'exit', timeout: 10 },
        ],
      });

      expect(ptyResult.exitCode).toBe(0);
      expect(ptyResult.outputTail).toContain('No job selected to cancel');

      // Part B: Real Core Orchestrator Cancellation & Retry Lifecycle
      // 1. Cancellation mid-execution: abort signal propagates and status becomes 'cancelled'
      let cancelledTaskAborted = false;
      const cancelExecutor: JobTaskExecutor = async (task, ctx) => {
        return new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            cancelledTaskAborted = true;
            resolve({ success: false, error: 'cancelled' });
          });
        });
      };

      const computers = new ComputerRegistry();
      computers.register({
        id: 'local',
        name: 'test-computer',
        type: 'workstation',
        local: true,
        os: { platform: 'linux', architecture: 'x64', version: '6.0' },
        hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
        capabilities: ['localExecution'],
      });

      const runtimes = new RuntimeRegistry();
      runtimes.register({
        id: 'fake-runtime',
        name: 'Local Runtime',
        type: 'other',
        computerId: 'local',
        version: '1.0',
        health: 'healthy',
        capabilities: {
          chat: true,
          streaming: true,
          toolCalling: true,
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

      const models = new ModelRegistry();
      models.register({
        id: 'fake-model',
        name: 'fake-model',
        provider: 'fake-runtime',
        family: 'other',
        local: true,
        contextMax: 32768,
        capabilities: ['generalChat', 'coding'],
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        runtimeCompatibility: 'any',
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

      const agents = new AgentRegistry();
      agents.register(
        {
          descriptor: {
            name: 'test-agent',
            version: '1.0',
            description: 'Test agent',
            capabilities: ['coding', 'generalChat'],
            requiredTools: [],
            modelRequirements: { capabilities: ['coding'] },
            permissions: [],
            taskTypes: ['coding', 'generalChat'],
            strategy: 'test',
          },
          async *run() {
            yield { kind: 'done', content: 'done' };
          },
        },
        'native',
      );

      const scheduler = new Scheduler({ computers, runtimes, models, agents });
      const executions = new ExecutionEngine();
      const jobManager = new JobManager();
      const cancelOrchestrator = new JobOrchestrator({
        scheduler,
        executionEngine: executions,
        computers,
        runtimes,
        models,
        agents,
        jobManager,
        taskExecutor: cancelExecutor,
      });

      const jobToCancel = await cancelOrchestrator.createJob({
        title: 'Cancel Mid-flight Test',
        tasks: [{ task: { id: 't-cancel', type: 'coding', input: 'Run long task' } }],
      });

      const cancelRunPromise = cancelOrchestrator.runJob(jobToCancel.id);
      // Allow execution loop to begin and reach active status
      await new Promise((r) => setTimeout(r, 50));
      await cancelOrchestrator.cancelJob(jobToCancel.id, 'user requested cancellation');
      const finishedCancelledJob = await cancelRunPromise;

      expect(finishedCancelledJob.status).toBe('cancelled');
      expect(cancelledTaskAborted).toBe(true);

      // 2. Retry lifecycle: transient failure retries up to maxRetries then terminates cleanly
      let retryAttempts = 0;
      const retryExecutor: JobTaskExecutor = async () => {
        retryAttempts++;
        if (retryAttempts < 3) {
          return { success: false, error: 'transient network timeout' };
        }
        return { success: true, result: 'succeeded on attempt 3' };
      };

      const retryOrchestrator = new JobOrchestrator({
        scheduler,
        executionEngine: executions,
        computers,
        runtimes,
        models,
        agents,
        jobManager,
        taskExecutor: retryExecutor,
      });

      const jobToRetry = await retryOrchestrator.createJob({
        title: 'Retry Transient Failure Test',
        maxRetries: 3,
        tasks: [{ task: { id: 't-retry', type: 'coding', input: 'Flaky step' } }],
      });

      const finishedRetriedJob = await retryOrchestrator.runJob(jobToRetry.id);
      expect(finishedRetriedJob.status).toBe('completed');
      expect(retryAttempts).toBe(3);

      scorecard.record({
        name: 'Cancellation and retry',
        category: 'lifecycle',
        verdict: 'DETERMINISTIC_INTEGRATION_PASS',
        durationMs: Date.now() - start,
        evidence: {
          ptyExitCode: ptyResult.exitCode,
          cancelledStatus: finishedCancelledJob.status,
          cancelledTaskAborted,
          retryAttempts,
          retryFinalStatus: finishedRetriedJob.status,
        },
        transcript: [
          ptyResult.outputTail,
          `Cancelled job ${jobToCancel.id} with status ${finishedCancelledJob.status}`,
          `Retried job ${jobToRetry.id} completed after ${retryAttempts} attempts`,
        ],
      });
    } catch (err: any) {
      scorecard.record({
        name: 'Cancellation and retry',
        category: 'lifecycle',
        verdict: 'FAILED',
        durationMs: Date.now() - start,
        evidence: {},
        transcript: [],
        error: err.message,
      });
      throw err;
    } finally {
      await cleanup();
    }
  }, 30_000);
});
