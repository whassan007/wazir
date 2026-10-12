// Disposable child used by restart/crash regression tests; imports the shipped build.
import { CheckpointService, ExecutionEngine, WorktreeManager } from '../../packages/core/dist/src/index.js';
import { JsonFileStore, faultInjector } from '../../packages/shared/dist/src/index.js';
import { writeFile } from 'node:fs/promises';
const [mode, dir, checkpointId] = process.argv.slice(2);
const store = new JsonFileStore(`${dir}/state/store.json`);
const engine = new ExecutionEngine({ workspace: `${dir}/workspace` });
const service = new CheckpointService({ store, executionEngine: engine, worktreeManager: new WorktreeManager(), defaultWorkspaceRoot: `${dir}/workspace` });
await service.ready;
if (mode === 'read') {
  const checkpoint = service.getCheckpoint(checkpointId);
  if (!checkpoint) throw new Error('MISSING_CHECKPOINT');
  console.log(JSON.stringify({ checkpoint, dateRevived: checkpoint.createdAt instanceof Date }));
} else {
  const record = await engine.create({ task: { id: mode, type: 'coding', input: 'checkpoint', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() }, computerId: 'local', runtimeId: 'test', modelId: 'none', workspaceRoot: `${dir}/workspace` });
  if (mode === 'crash') faultInjector.register({ point: 'DURING_STORE_WRITE', action: { type: 'custom', handler: () => process.kill(process.pid, 'SIGKILL') } });
  const checkpoint = await service.checkpoint(record.execution.id);
  await writeFile(`${dir}/checkpoint-id`, checkpoint.id);
  console.log(JSON.stringify({ id: checkpoint.id }));
}
