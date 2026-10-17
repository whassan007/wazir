import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveReference } from '../src/references.js';
import type { RookEngine } from '../src/engine.js';

/** Security review F-22: `@file:` references are contained to the project. */
describe('@file: reference containment', () => {
  let sandbox: string;
  afterEach(async () => {
    if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('never reports existence of, or resolves to, a path outside the project root', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-refs-'));
    const project = path.join(sandbox, 'project');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(sandbox, 'outside.txt'), 'x');
    await fs.writeFile(path.join(project, 'inside.txt'), 'y');
    await fs.symlink(path.join(sandbox, 'outside.txt'), path.join(project, 'link.txt'));
    const engine = { projectRoot: project } as unknown as RookEngine;

    const inside = await resolveReference(engine, '@file:inside.txt');
    expect(inside).toMatchObject({ kind: 'file', exists: true });

    for (const raw of ['@file:../outside.txt', '@file:/etc/passwd', '@file:link.txt', `@file:${path.join(sandbox, 'outside.txt')}`]) {
      const resolved = await resolveReference(engine, raw);
      expect(resolved.kind, raw).toBe('file');
      expect((resolved as { exists: boolean }).exists, raw).toBe(false);
    }
  });

  it('resolves @task:<id> and @exec:<id> cross-task references deterministically', async () => {
    const fakeTask = { id: 'task-job-1-0', title: 'build api', input: 'build api', status: 'completed' };
    const fakeExec = { id: 'exec-101', taskId: 'task-job-1-0', status: 'completed' };
    const engine = {
      projectRoot: process.cwd(),
      orchestrator: {
        listJobs: () => [{ id: 'job-1', tasks: [fakeTask] }],
        getJob: (id: string) => (id === 'job-1' ? { id: 'job-1', tasks: [fakeTask] } : undefined),
      },
      executions: {
        listByTask: async (taskId: string) => (taskId === 'task-job-1-0' ? [fakeExec] : []),
        get: async (id: string) => (id === 'exec-101' ? fakeExec : undefined),
      },
    } as unknown as RookEngine;

    const taskRef = await resolveReference(engine, '@task:task-job-1-0');
    expect(taskRef).toMatchObject({
      kind: 'task',
      id: 'task-job-1-0',
      task: fakeTask,
      execution: fakeExec,
    });

    const execRef = await resolveReference(engine, '@exec:exec-101');
    expect(execRef).toMatchObject({
      kind: 'execution',
      id: 'exec-101',
      execution: fakeExec,
    });
  });
});

