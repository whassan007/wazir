import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { HandoffService } from '../src/services/handoffService.js';

describe('HandoffService', () => {
  it('persists verified execution context, redacts secrets, deduplicates, and restores', async () => {
    const store = new MemoryStore(); const executions = new ExecutionEngine({ workspace: process.cwd() });
    const record = await executions.create({ task: { id: 't1', type: 'coding', input: 'Fix auth token=supersecret', requirements: {}, priority: 'normal', status: 'failed', createdAt: new Date() }, runtimeId: 'local', modelId: 'm', workspaceRoot: process.cwd() });
    record.execution.status = 'failed'; record.errors.push('provider API_KEY=secret failed'); record.filesChanged.push('src/a.ts');
    const service = new HandoffService({ store, executions, projectRoot: process.cwd() }); await service.ready;
    const one = await service.createAutomatic('failure', record.execution.id, { sourceAgent: 'agent-a' });
    expect(one.task.objective).not.toContain('supersecret'); expect(one.remaining.defects.join()).not.toContain('secret'); expect(one.completed.files).toEqual(['src/a.ts']);
    expect(await service.createAutomatic('failure', record.execution.id, { sourceAgent: 'agent-a' })).toEqual(one);
    const restored = new HandoffService({ store, executions, projectRoot: process.cwd() }); await restored.ready; expect((await restored.get(one.id))?.id).toBe(one.id);
    expect(restored.toMarkdown(one)).toContain('# Wazir Agent Handoff'); expect(await restored.resume(one.id)).toMatchObject({ executionId: record.execution.id });
  });
});
