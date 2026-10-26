import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentRegistry,
  ComputerRegistry,
  ExecutionEngine,
  JobOrchestrator,
  JobTaskExecutor,
  ModelRegistry,
  RuntimeRegistry,
  Scheduler,
  VerifiedIntegrationCoordinator,
  WorktreeManager,
  type AgentIntegrationManifest,
  type IntegrationCandidateInput,
} from '../src/index.js';

const exec = promisify(execFile);

function setupOrchestrator(taskExecutor?: JobTaskExecutor) {
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const agents = new AgentRegistry();
  const executions = new ExecutionEngine();

  computers.register({
    id: 'local',
    name: 'test-computer',
    type: 'workstation',
    local: true,
    os: { platform: 'darwin', architecture: 'arm64', version: '24.0' },
    hardware: { cpu: 'test-cpu', cpuCores: 8, memoryGB: 32 },
    capabilities: ['localExecution'],
  });

  runtimes.register({
    id: 'fake-runtime',
    type: 'other',
    name: 'fake-runtime',
    version: '1.0',
    computerId: 'local',
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
    contextMax: 32_768,
    capabilities: ['generalChat', 'coding'],
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
    contextTokens: 32_768,
  });

  agents.register(
    {
      descriptor: {
        name: 'test-agent',
        version: '1.0',
        description: 'Test agent',
        capabilities: ['coding'],
        requiredTools: [],
        modelRequirements: { capabilities: ['coding'] },
        permissions: [],
        taskTypes: ['coding', 'chat'],
        strategy: 'test',
      },
      async *run() {
        yield { kind: 'done', content: 'done' };
      },
    },
    'native',
  );

  const scheduler = new Scheduler({ computers, runtimes, models, agents });
  const orchestrator = new JobOrchestrator({
    scheduler,
    executionEngine: executions,
    computers,
    runtimes,
    models,
    agents,
    taskExecutor,
  });

  return { orchestrator, computers, runtimes, models, agents, executions, scheduler };
}

describe('Formal Hardening Group I — Multi-Agent Conflict, Concurrency & Context Isolation (A27)', () => {
  let root = '';
  let candidateRoot = '';
  let agentWorktrees: string[] = [];
  let candidateWorktrees: string[] = [];
  let manager: WorktreeManager;
  let coordinator: VerifiedIntegrationCoordinator;

  afterEach(async () => {
    for (const dir of candidateWorktrees) {
      await exec('git', ['worktree', 'remove', '--force', dir], { cwd: root }).catch(() => undefined);
    }
    for (const dir of agentWorktrees) {
      await exec('git', ['worktree', 'remove', '--force', dir], { cwd: root }).catch(() => undefined);
    }
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (candidateRoot) await fs.rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
    root = '';
    candidateRoot = '';
    agentWorktrees = [];
    candidateWorktrees = [];
  });

  async function setupRepo(files: Record<string, string> = { 'README.md': '# Project Base\n' }) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-groupI-repo-'));
    candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-groupI-candidates-'));
    await exec('git', ['init', '-b', 'main'], { cwd: root });
    await exec('git', ['config', 'user.name', 'Wazir Hardening Suite']);
    await exec('git', ['config', 'user.email', 'hardening@wazir.ai']);
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(root, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
    await exec('git', ['add', '-A'], { cwd: root });
    await exec('git', ['commit', '-m', 'chore: initial repository setup'], { cwd: root });

    manager = new WorktreeManager();
    coordinator = new VerifiedIntegrationCoordinator({ candidateRootDir: candidateRoot });
  }

  async function createAgentCandidate(
    taskId: string,
    agentId: string,
    edits: Record<string, string | null>,
  ): Promise<IntegrationCandidateInput> {
    const wt = await manager.createWorktree(root, `job-${taskId}`, taskId);
    agentWorktrees.push(wt.worktreeDir);
    for (const [name, content] of Object.entries(edits)) {
      const targetPath = path.join(wt.worktreeDir, name);
      if (content === null) {
        await fs.rm(targetPath, { force: true });
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content);
      }
    }
    const commitResult = await manager.commitWorktree(wt, `feat(${taskId}): apply modifications`);
    expect(commitResult.committed).toBe(true);

    const manifest: AgentIntegrationManifest = await coordinator.createManifest(wt.worktreeDir, {
      taskId,
      agentId,
      targetBranch: 'main',
      declaredOwnership: Object.keys(edits),
      testsExecuted: [{
        name: `${taskId}-unit-tests`,
        command: 'npm test',
        status: 'PASS',
        sourceSha: commitResult.commitSha!,
        runId: `run-${taskId}`,
        runnerId: `runner-${agentId}`,
        exitCode: 0,
        resultSha256: 'e'.repeat(64),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }],
      verificationEvidence: [{
        id: `ev-${taskId}`,
        status: 'PASS',
        sourceSha: commitResult.commitSha!,
        resultSha256: 'e'.repeat(64),
      }],
      outstandingRisks: [],
    });

    return {
      branch: wt.branch,
      manifest,
    };
  }

  // ============================================================================
  // Test 1: Conflicting file edits across 2 agents
  // ============================================================================
  describe('1. Conflicting file edits across 2 agents', () => {
    it('detects same-file collision when 2 concurrent agents modify overlapping files', async () => {
      await setupRepo({
        'src/config.ts': 'export const API_URL = "https://api.v1.local";\nexport const TIMEOUT = 5000;\n',
        'src/utils.ts': 'export function noop() {}\n',
      });

      // Agent A modifies src/config.ts
      const agentA = await createAgentCandidate('task-agent-a', 'agent-alpha', {
        'src/config.ts': 'export const API_URL = "https://api.v2.alpha";\nexport const TIMEOUT = 5000;\n',
      });

      // Agent B modifies src/config.ts with competing change
      const agentB = await createAgentCandidate('task-agent-b', 'agent-beta', {
        'src/config.ts': 'export const API_URL = "https://api.v3.beta";\nexport const TIMEOUT = 8000;\n',
      });

      // Coordinator plans integration for both candidates
      const plan = await coordinator.plan(root, 'main', [agentA, agentB]);

      expect(plan.conflicts.length).toBeGreaterThan(0);
      const conflict = plan.conflicts.find((c) =>
        c.files.includes('src/config.ts') &&
        c.branches.includes(agentA.branch) &&
        c.branches.includes(agentB.branch)
      );
      expect(conflict).toBeDefined();
      expect(conflict?.kind).toBe('same-file');
      expect(conflict?.syntactic).toBe('conflict');
      // Conflicting file edits must prevent readyToBuildCandidate
      expect(plan.readyToBuildCandidate).toBe(false);
    });

    it('allows disjoint file edits across 2 agents to plan cleanly', async () => {
      await setupRepo({
        'src/moduleA.ts': 'export const A = 1;\n',
        'src/moduleB.ts': 'export const B = 2;\n',
      });

      const agentA = await createAgentCandidate('task-disjoint-a', 'agent-alpha', {
        'src/moduleA.ts': 'export const A = 100;\n',
      });

      const agentB = await createAgentCandidate('task-disjoint-b', 'agent-beta', {
        'src/moduleB.ts': 'export const B = 200;\n',
      });

      const plan = await coordinator.plan(root, 'main', [agentA, agentB]);
      expect(plan.conflicts).toHaveLength(0);
      expect(plan.blockers).toHaveLength(0);
      expect(plan.readyToBuildCandidate).toBe(true);
    });
  });

  // ============================================================================
  // Test 2: Stale snapshot rejection
  // ============================================================================
  describe('2. Stale snapshot rejection', () => {
    it('rejects integration candidate based on stale snapshot when target modified the same file', async () => {
      await setupRepo({
        'src/routes.ts': 'export const routes = ["/home", "/login"];\n',
      });
      const initialHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

      // Agent branches from initialHead and edits src/routes.ts
      const agentCandidate = await createAgentCandidate('task-stale', 'agent-stale', {
        'src/routes.ts': 'export const routes = ["/home", "/login", "/dashboard"];\n',
      });
      expect(agentCandidate.manifest.baseSha).toBe(initialHead);

      // Target branch moves forward with an overlapping edit
      await fs.writeFile(path.join(root, 'src/routes.ts'), 'export const routes = ["/home", "/login", "/admin"];\n');
      await exec('git', ['add', 'src/routes.ts'], { cwd: root });
      await exec('git', ['commit', '-m', 'feat: add admin route on main'], { cwd: root });
      const currentTargetSha = (await exec('git', ['rev-parse', 'main'], { cwd: root })).stdout.trim();
      expect(currentTargetSha).not.toBe(initialHead);

      // Coordinator plan must evaluate candidate against current target HEAD
      const plan = await coordinator.plan(root, 'main', [agentCandidate]);

      expect(plan.candidates[0].staleBase).toBe(true);
      expect(plan.conflicts.length).toBeGreaterThan(0);

      const targetConflict = plan.conflicts.find((c) =>
        c.branches.includes('main') &&
        c.branches.includes(agentCandidate.branch) &&
        c.files.includes('src/routes.ts')
      );
      expect(targetConflict).toBeDefined();
      expect(targetConflict?.kind).toBe('same-file');
      expect(plan.readyToBuildCandidate).toBe(false);
    });

    it('rejects qualification if target branch moved during verification execution', async () => {
      await setupRepo({ 'test.txt': 'base\n' });
      const candidate = await createAgentCandidate('task-target-move', 'agent-move', {
        'test.txt': 'modified by agent\n',
      });
      const expectedSha = (await exec('git', ['rev-parse', 'main'], { cwd: root })).stdout.trim();

      // Target advances before qualification begins
      await fs.writeFile(path.join(root, 'other.txt'), 'other content\n');
      await exec('git', ['add', 'other.txt'], { cwd: root });
      await exec('git', ['commit', '-m', 'unrelated commit on target'], { cwd: root });

      await expect(
        coordinator.qualify(root, {
          targetBranch: 'main',
          expectedTargetSha: expectedSha,
          candidates: [candidate],
          verifyCandidate: async () => [],
        })
      ).rejects.toThrow(/target moved/);
    });
  });

  // ============================================================================
  // Test 3: Delayed agent completion
  // ============================================================================
  describe('3. Delayed agent completion', () => {
    it('prevents delayed agent from silently overwriting confirmed work of fast agent', async () => {
      await setupRepo({
        'schema.sql': 'CREATE TABLE users (id INT, email TEXT);\n',
      });
      const baseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

      // Fast Agent (Agent 1) branches from baseSha
      const fastAgent = await createAgentCandidate('task-fast', 'agent-fast', {
        'schema.sql': 'CREATE TABLE users (id INT, email TEXT, status TEXT DEFAULT "active");\n',
      });

      // Slow Agent (Agent 2) also branches from baseSha (before fast agent commits/integrates)
      const slowAgent = await createAgentCandidate('task-slow', 'agent-slow', {
        'schema.sql': 'CREATE TABLE users (id INT, email TEXT, role TEXT DEFAULT "user");\n',
      });

      // Fast Agent qualifies and successfully merges into main
      const fastMerge = await manager.mergeBranch(root, fastAgent.branch, 'main');
      expect(fastMerge.success).toBe(true);

      const targetAfterFast = (await exec('git', ['rev-parse', 'main'], { cwd: root })).stdout.trim();
      expect(targetAfterFast).not.toBe(baseSha);

      // Verify main now has Agent 1's confirmed work
      const mainContentAfterFast = await fs.readFile(path.join(root, 'schema.sql'), 'utf8');
      expect(mainContentAfterFast).toContain('status TEXT DEFAULT "active"');

      // Now, after simulated delay, Slow Agent (Agent 2) finishes and attempts to integrate
      const delayedPlan = await coordinator.plan(root, 'main', [slowAgent]);

      // Critical Invariant: Slow agent MUST NOT silently overwrite fast agent's confirmed work!
      expect(delayedPlan.candidates[0].staleBase).toBe(true);
      expect(delayedPlan.conflicts.length).toBeGreaterThan(0);

      const overwriteConflict = delayedPlan.conflicts.find((c) =>
        c.branches.includes('main') &&
        c.branches.includes(slowAgent.branch) &&
        c.files.includes('schema.sql')
      );
      expect(overwriteConflict).toBeDefined();
      expect(overwriteConflict?.kind).toBe('same-file');
      expect(delayedPlan.readyToBuildCandidate).toBe(false);

      // Verify that main content was NOT clobbered and remains intact
      const currentMain = await fs.readFile(path.join(root, 'schema.sql'), 'utf8');
      expect(currentMain).toBe(mainContentAfterFast);
    });
  });

  // ============================================================================
  // Test 4: Isolated fan-out context propagation
  // ============================================================================
  describe('4. Isolated fan-out context propagation', () => {
    it('isolates task inputs, node state, and execution context across concurrent fan-out tasks', async () => {
      const executedTasks: Array<{ taskId: string; input: string; seenMutation: boolean }> = [];
      let sharedStateContamination = false;

      const executor: JobTaskExecutor = async (task, ctx) => {
        // Verify context matches the assigned task
        expect(ctx.taskId).toBe(task.id);
        expect(ctx.node.id).toBe(task.id);

        if (task.id === 'fanout-1') {
          // Attempt adversarial in-place mutation of task and node
          (task as any).input = 'MUTATED_BY_FANOUT_1';
          (task.requirements as any).capabilities.push('ADVERSARIAL_CAPABILITY');
          (ctx.node as any).state = 'failed';
          (ctx.node as any).dependencies.push('FAKE_DEP');

          // Sleep briefly to allow concurrent tasks to run
          await new Promise((r) => setTimeout(r, 40));
        } else if (task.id === 'fanout-2') {
          await new Promise((r) => setTimeout(r, 20));
          // Check if fanout-1's mutations leaked into fanout-2
          if (
            task.input.includes('MUTATED') ||
            task.requirements.capabilities.includes('ADVERSARIAL_CAPABILITY') ||
            ctx.node.dependencies.includes('FAKE_DEP')
          ) {
            sharedStateContamination = true;
          }
        }

        executedTasks.push({
          taskId: task.id,
          input: task.input,
          seenMutation: task.requirements.capabilities.includes('ADVERSARIAL_CAPABILITY'),
        });

        return { success: true, result: `result-${task.id}` };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Concurrent Fan-Out Isolation Test',
        concurrencyLimit: 4,
        tasks: [
          {
            task: {
              id: 'fanout-1',
              input: 'initial-input-1',
              requirements: { capabilities: ['coding'] },
            },
          },
          {
            task: {
              id: 'fanout-2',
              input: 'initial-input-2',
              requirements: { capabilities: ['coding'] },
            },
          },
          {
            task: {
              id: 'fanout-3',
              input: 'initial-input-3',
              requirements: { capabilities: ['coding'] },
            },
          },
        ],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('completed');
      expect(sharedStateContamination).toBe(false);

      // Verify that fanout-2 and fanout-3 were not contaminated
      const task2 = executedTasks.find((t) => t.taskId === 'fanout-2');
      const task3 = executedTasks.find((t) => t.taskId === 'fanout-3');
      expect(task2?.input).toBe('initial-input-2');
      expect(task2?.seenMutation).toBe(false);
      expect(task3?.input).toBe('initial-input-3');
      expect(task3?.seenMutation).toBe(false);
    });

    it('isolates upstream dependency outcomes across fan-out sibling tasks (no object mutation leak)', async () => {
      let siblingContaminated = false;

      const executor: JobTaskExecutor = async (task, ctx) => {
        if (task.id === 'upstream-root') {
          return {
            success: true,
            result: {
              records: ['record-1', 'record-2'],
              config: { retries: 3 },
            },
          };
        }

        if (task.id === 'branch-mutator') {
          // Mutate previous outcome object received from upstream
          const outcome = ctx.previousOutcomes?.get('upstream-root');
          expect(outcome?.success).toBe(true);
          const res = outcome?.result as any;
          res.records.push('LEAKED_MUTATION');
          res.config.retries = 9999;
          await new Promise((r) => setTimeout(r, 30));
          return { success: true, result: 'mutator-done' };
        }

        if (task.id === 'branch-reader') {
          await new Promise((r) => setTimeout(r, 15));
          const outcome = ctx.previousOutcomes?.get('upstream-root');
          const res = outcome?.result as any;
          if (res.records.includes('LEAKED_MUTATION') || res.config.retries === 9999) {
            siblingContaminated = true;
          }
          return { success: true, result: 'reader-done' };
        }

        return { success: true };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Upstream Outcome Isolation Test',
        concurrencyLimit: 3,
        tasks: [
          { task: { id: 'upstream-root', input: 'generate records' } },
          { task: { id: 'branch-mutator', input: 'mutate' }, dependencies: ['upstream-root'] },
          { task: { id: 'branch-reader', input: 'read' }, dependencies: ['upstream-root'] },
        ],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('completed');
      expect(siblingContaminated).toBe(false);
    });

    it('propagates context specified via contextFrom cleanly to previousOutcomes', async () => {
      let receivedContextValue = '';

      const executor: JobTaskExecutor = async (task, ctx) => {
        if (task.id === 'context-source') {
          return { success: true, result: { secretFlag: 'ALPHA_FLAG_42' } };
        }
        if (task.id === 'context-consumer') {
          const outcome = ctx.previousOutcomes?.get('context-source');
          receivedContextValue = (outcome?.result as any)?.secretFlag ?? '';
          return { success: true, result: 'consumed' };
        }
        return { success: true };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'contextFrom Propagation Test',
        tasks: [
          { task: { id: 'context-source', input: 'source data' } },
          {
            task: {
              id: 'context-consumer',
              input: 'consume data',
              contextFrom: ['context-source'],
            },
            dependencies: ['context-source'],
          },
        ],
      });

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('completed');
      expect(receivedContextValue).toBe('ALPHA_FLAG_42');
    });

    it('isolates per-task steering instructions without cross-task leakage', async () => {
      const steeringSeen: Record<string, string | undefined> = {};

      const executor: JobTaskExecutor = async (task, ctx) => {
        await new Promise((r) => setTimeout(r, 30));
        steeringSeen[task.id] = ctx.getSteeringInstruction?.();
        return { success: true };
      };

      const { orchestrator } = setupOrchestrator(executor);
      const job = await orchestrator.createJob({
        title: 'Steering Isolation Test',
        concurrencyLimit: 2,
        tasks: [
          { task: { id: 'task-steered', input: 'run steered' } },
          { task: { id: 'task-unsteered', input: 'run unsteered' } },
        ],
      });

      // Steer only task-steered
      orchestrator.steerTask(job.id, 'task-steered', 'OPERATOR_INSTRUCTION_TASK1');

      const finished = await orchestrator.runJob(job.id);
      expect(finished.status).toBe('completed');
      expect(steeringSeen['task-steered']).toBe('OPERATOR_INSTRUCTION_TASK1');
      expect(steeringSeen['task-unsteered']).toBeUndefined();
    });
  });
});
