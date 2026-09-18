import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '@wazir/shared';
import {
  JobManager,
  ExecutionEngine,
  JobOrchestrator,
  Scheduler,
  ComputerRegistry,
  RuntimeRegistry,
  ModelRegistry,
  AgentRegistry,
  type Job,
  type ExecutionRecord,
  type JobTaskExecutor,
} from '@wazir/core';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wazir-recovery-test-'));
}

describe('Section 10: Job-Level Restart & Recovery mid-execution', () => {
  let testDir: string | undefined;

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined);
      testDir = undefined;
    }
  });

  it('persists mid-execution job state, recovers fully on process restart, and revives Date fields', async () => {
    testDir = await tempDir();
    const storeFile = path.join(testDir, 'wazir-state.json');

    // Setup Store 1 (First Process)
    const store1 = new JsonFileStore(storeFile);

    const jobsMap1 = new Map<string, Job>();
    const executionsMap1 = new Map<string, ExecutionRecord>();

    const jobManager1 = new JobManager({
      persist: async (job) => {
        jobsMap1.set(job.id, job);
        await store1.put(`jobs/${job.id}`, job);
      },
      load: async () => {
        const list = await store1.list('jobs/');
        return list.map((e) => e.value as Job);
      },
    });

    const executionEngine1 = new ExecutionEngine({
      persist: async (record) => {
        executionsMap1.set(record.execution.id, record);
        await store1.put(`executions/${record.execution.id}`, record);
      },
      load: async () => {
        const list = await store1.list('executions/');
        return list.map((e) => e.value as ExecutionRecord);
      },
    });

    // 1. Create job with 2 tasks (step-1 -> step-2)
    const originalCreatedAt = new Date('2026-03-01T12:00:00.000Z');
    const job1 = jobManager1.create({
      title: 'Crash-Recovery Job',
      description: 'Tests survival across process death',
      priority: 'high',
      tasks: [
        { task: { id: 'step-1', input: 'First task' } },
        { task: { id: 'step-2', input: 'Second task' }, dependencies: ['step-1'] },
      ],
    });
    job1.createdAt = originalCreatedAt;
    await store1.put(`jobs/${job1.id}`, job1);

    // 2. Start step-1 execution and add an event and an artifact
    const execRecord1 = await executionEngine1.create({
      task: job1.tasks[0],
      computerId: 'local',
      runtimeId: 'fake-rt',
      modelId: 'fake-model',
    });
    await executionEngine1.setStatus(execRecord1.execution.id, 'running');

    await jobManager1.updateTaskStatus(job1.id, 'step-1', 'running');
    await jobManager1.updateAgentState(job1.id, 'step-1', 'running');
    job1.status = 'running';

    await jobManager1.addMessage(job1.id, {
      id: 'msg-1',
      role: 'user',
      content: 'Initial user prompt for recovery job',
      createdAt: new Date('2026-03-01T12:01:00.000Z'),
    });

    await jobManager1.addArtifact(job1.id, {
      id: 'art-1',
      taskId: 'step-1',
      name: 'checkpoint.json',
      type: 'json',
      path: '/tmp/checkpoint.json',
      size: 1024,
      createdAt: new Date('2026-03-01T12:02:00.000Z'),
    });

    // Force flush state to store file
    await store1.put(`jobs/${job1.id}`, job1);
    await store1.put(`executions/${execRecord1.execution.id}`, execRecord1);

    // =========================================================================
    // 3. SIMULATE HARD PROCESS CRASH: All in-memory structures destroyed!
    // =========================================================================

    // New Process boots up and initializes store from the same persistence file
    const store2 = new JsonFileStore(storeFile);

    const loadedJobs = (await store2.list('jobs/')).map((e) => e.value as Job);
    const loadedExecutions = (await store2.list('executions/')).map((e) => e.value as ExecutionRecord);

    const jobManager2 = new JobManager({
      load: () => loadedJobs,
      persist: async (job) => {
        await store2.put(`jobs/${job.id}`, job);
      },
    });

    const executionEngine2 = new ExecutionEngine({
      load: () => loadedExecutions,
      persist: async (rec) => {
        await store2.put(`executions/${rec.execution.id}`, rec);
      },
    });

    await jobManager2.ready;
    await executionEngine2.ready;

    // 4. Assert Job recovery & state survival
    const recoveredJob = jobManager2.get(job1.id);
    expect(recoveredJob).toBeDefined();
    expect(recoveredJob?.id).toBe(job1.id);
    expect(recoveredJob?.title).toBe('Crash-Recovery Job');
    expect(recoveredJob?.status).toBe('running');
    expect(recoveredJob?.priority).toBe('high');

    // 5. Assert Task and DAG state survival
    const step1 = recoveredJob?.tasks.find((t) => t.id === 'step-1');
    const step2 = recoveredJob?.tasks.find((t) => t.id === 'step-2');
    expect(step1?.status).toBe('running');
    expect(step2?.status).toBe('pending');

    const step1Node = recoveredJob?.graph.nodes.find((n) => n.id === 'step-1');
    expect(step1Node?.state).toBe('running');

    // 6. Assert Date revival across process reboot
    expect(recoveredJob?.createdAt).toBeInstanceOf(Date);
    expect(recoveredJob?.createdAt.getTime()).toBe(originalCreatedAt.getTime());

    // 7. Assert Messages and Artifacts survived
    expect(recoveredJob?.messages).toHaveLength(1);
    expect(recoveredJob?.messages[0].id).toBe('msg-1');
    expect(recoveredJob?.messages[0].content).toBe('Initial user prompt for recovery job');
    expect(recoveredJob?.messages[0].createdAt).toBeInstanceOf(Date);

    expect(recoveredJob?.artifacts).toHaveLength(1);
    expect(recoveredJob?.artifacts[0].name).toBe('checkpoint.json');
    expect(recoveredJob?.artifacts[0].size).toBe(1024);
    expect(recoveredJob?.artifacts[0].createdAt).toBeInstanceOf(Date);

    // 8. Assert ExecutionRecord survival
    const recoveredExec = await executionEngine2.get(execRecord1.execution.id);
    expect(recoveredExec).toBeDefined();
    expect(recoveredExec?.execution.status).toBe('running');
    expect(recoveredExec?.execution.createdAt).toBeInstanceOf(Date);
    expect(recoveredExec?.execution.startedAt).toBeInstanceOf(Date);

    // 9. Job Completion from recovered state
    await jobManager2.updateTaskStatus(job1.id, 'step-1', 'completed');
    await jobManager2.updateAgentState(job1.id, 'step-1', 'completed', 'step-1 result');
    await jobManager2.updateTaskStatus(job1.id, 'step-2', 'completed');
    await jobManager2.updateAgentState(job1.id, 'step-2', 'completed', 'step-2 result');
    recoveredJob!.status = 'completed';
    await store2.put(`jobs/${job1.id}`, recoveredJob!);

    // Re-verify in store that completed state persists
    const finalStored = await store2.get<Job>(`jobs/${job1.id}`);
    expect(finalStored?.status).toBe('completed');
  });
});
