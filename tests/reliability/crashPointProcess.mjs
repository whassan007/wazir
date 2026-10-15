// Disposable child for crash-point recovery tests. Imports the shipped build and the
// real durable stores; every run is a separate OS process, so nothing survives between
// "crash" and "recovery" except what was actually persisted.
//
//   run <point> <signal> <dir>   drive one job/task/execution and die at <point>
//   recover <dir> [faultPoint]   fresh process: reconstruct, reconcile, plan; print JSON
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { JsonFileStore, faultInjector, injectFault } from '../../packages/shared/dist/src/index.js';
import { ExecutionEngine, JobManager, persistExecutionRecord } from '../../packages/core/dist/src/index.js';
import { localOutcomeInspector, planTaskResume } from '../../apps/cli/dist/recovery.js';

const LEASE_MS = 300;
const [mode, ...args] = process.argv.slice(2);
const dir = mode === 'run' ? args[2] : args[0];
const workspace = `${dir}/workspace`;
await mkdir(workspace, { recursive: true });
await mkdir(`${dir}/state`, { recursive: true });
const store = new JsonFileStore(`${dir}/state/store.json`);
const open = async () => {
  const jobs = new JobManager({ store, leaseMs: LEASE_MS });
  const engine = new ExecutionEngine({
    workspace,
    persist: (r) => persistExecutionRecord(store, `execution/${r.execution.id}`, r),
    load: async () => (await store.list('execution/')).map((e) => e.value),
  });
  await Promise.all([jobs.ready, engine.ready]);
  return { jobs, engine };
};
const log = (line) => appendFile(`${dir}/progress.log`, `${line}\n`);

if (mode === 'run') {
  const [point, signal] = args;
  const { jobs, engine } = await open();
  let jobId; let executionId;
  // SIGTERM is the graceful path: settle what can be settled (the execution is recorded
  // cancelled, the job lease released), then exit 0. SIGKILL gets no say at all.
  process.on('SIGTERM', async () => {
    try {
      if (executionId) {
        const status = engine.require(executionId).execution.status;
        if (!['completed', 'failed', 'cancelled'].includes(status)) await engine.setStatus(executionId, 'cancelled');
      }
      if (jobId) await jobs.release(jobId);
    } finally { await log('sigterm-settled'); process.exit(0); }
  });
  // Keeps the event loop alive so a handled SIGTERM runs its handler (a bare pending
  // promise would let Node exit 13 first).
  const die = async () => { await log(`dying at ${point}`); setInterval(() => {}, 1_000); process.kill(process.pid, signal); await new Promise(() => {}); };
  const at = async (p) => { if (p === point) await die(); };
  if (point === 'before-task-commit') {
    faultInjector.register({ point: 'DURING_STORE_WRITE', action: { type: 'custom', handler: die } });
  }

  const job = jobs.create({ title: 'crash', tasks: [{ task: { id: 'task-1', input: 'do the work', maxRetries: 3 } }] });
  jobId = job.id;
  await jobs.save(job.id);
  await writeFile(`${dir}/job-id`, job.id);
  await at('after-persist');

  await jobs.acquire(job.id);
  await jobs.setJobStatus(job.id, 'running', { startedAt: new Date() });
  await jobs.updateAgentState(job.id, 'task-1', 'running');
  await jobs.updateTaskStatus(job.id, 'task-1', 'running');
  const task = jobs.get(job.id).tasks[0];
  const record = await engine.create({ task, jobId: job.id, computerId: 'local', runtimeId: 'fixture', modelId: 'none', workspaceRoot: workspace });
  executionId = record.execution.id;
  await writeFile(`${dir}/execution-id`, executionId);
  await engine.setStatus(executionId, 'running');

  // Model generation.
  await engine.recordEvent(executionId, 'generation.started', { requestId: 'gen-1' });
  for (let i = 0; i < 3; i++) {
    await log(`token ${i}`);
    if (i === 1) await at('during-generation');
  }

  if (point === 'before-tool') {
    faultInjector.register({ point: 'BEFORE_TOOL_EXECUTION', action: { type: 'custom', handler: die } });
  }
  // A non-idempotent shell side effect.
  const shell = { command: `echo once >> ${dir}/effect` };
  const shellCall = await engine.recordToolStart(executionId, 'shell', shell, { callId: 'shell-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
  const proc = spawn('sh', ['-c', `${shell.command}; sleep ${point === 'during-shell' ? 3 : 0}`], { stdio: 'ignore' });
  if (point === 'during-shell') {
    while (!(await readFile(`${dir}/effect`, 'utf8').catch(() => '')).includes('once')) await new Promise((r) => setTimeout(r, 10));
    await die();
  }
  await new Promise((resolve) => proc.on('exit', resolve));
  await at('before-result-persist');
  await engine.recordToolCall(executionId, { id: shellCall, callId: shellCall, tool: 'shell', input: shell, ok: true, output: 'ok', policyEffect: 'allow', policyRule: 'test', durationMs: 1, at: new Date() });

  // A file mutation (idempotent: sets exact content).
  const write = { path: 'out.txt', content: 'final content\n' };
  const writeCall = await engine.recordToolStart(executionId, 'write', write, { callId: 'write-1', sideEffectClass: 'IDEMPOTENT_WRITE' });
  await writeFile(`${workspace}/out.txt`, write.content);
  await at('after-fs-mutation');
  await engine.recordToolCall(executionId, { id: writeCall, callId: writeCall, tool: 'write', input: write, ok: true, output: 'written', policyEffect: 'allow', policyRule: 'test', durationMs: 1, at: new Date() });

  // Verification (read-only).
  const verifyCall = await engine.recordToolStart(executionId, 'read', { path: 'out.txt' }, { callId: 'verify-1', sideEffectClass: 'READ_ONLY' });
  await at('during-verification');
  await engine.recordToolCall(executionId, { id: verifyCall, callId: verifyCall, tool: 'read', input: { path: 'out.txt' }, ok: true, output: write.content, policyEffect: 'allow', policyRule: 'test', durationMs: 1, at: new Date() });

  // Terminal settlement.
  if (point === 'during-settlement') {
    faultInjector.register({ point: 'DURING_COMPLETION', action: { type: 'custom', handler: die } });
  }
  await engine.setStatus(executionId, 'completed');
  await jobs.completeTask(job.id, 'task-1', 'done');
  await jobs.setJobStatus(job.id, 'completed', { completedAt: new Date() });
  await jobs.release(job.id);
  await log('finished');
  console.log(JSON.stringify({ finished: true }));
} else if (mode === 'recover') {
  const [, faultPoint] = args;
  await new Promise((r) => setTimeout(r, LEASE_MS + 100)); // the crashed owner's lease lapses
  if (faultPoint) {
    // "<point>:<n>": SIGKILL this recovery process on the n-th time it reaches <point>.
    const [point, nth = '1'] = faultPoint.split(':');
    let seen = 0;
    faultInjector.register({ point, maxTimes: Infinity, action: { type: 'custom', handler: async () => {
      if (++seen < Number(nth)) return;
      await log(`recovery dying at ${point} #${seen}`); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {});
    } } });
  }
  const { jobs, engine } = await open();
  const jobId = await readFile(`${dir}/job-id`, 'utf8').catch(() => undefined);
  const executionId = await readFile(`${dir}/execution-id`, 'utf8').catch(() => undefined);
  const out = { jobs: jobs.list().length };
  if (jobId && jobs.get(jobId)) {
    const before = jobs.get(jobId);
    out.jobStatusBefore = before.status;
    out.taskStatusBefore = before.tasks[0].status;
    let acquire = 'ok';
    try { await jobs.acquire(jobId); } catch (e) { acquire = e.message; }
    const after = jobs.get(jobId);
    Object.assign(out, { acquire, jobStatus: after.status, taskStatus: after.tasks[0].status, nodeState: after.graph.nodes[0].state, retryCount: after.graph.nodes[0].retryCount ?? 0 });
    if (acquire === 'ok') await jobs.release(jobId);
  }
  if (executionId && engine.get && (await engine.get(executionId))) {
    out.executionStatusBefore = engine.require(executionId).execution.status;
    out.errors = engine.require(executionId).errors;
    const plan = await planTaskResume(engine, executionId, localOutcomeInspector(workspace, 'local'));
    out.plan = { action: plan.action, reasons: plan.reasons, reconciled: plan.action === 'resume' ? plan.resume.reconciled : [] };
    out.checkpoints = engine.toolCheckpoints(executionId).map((c) => ({ callId: c.callId, state: c.state }));
    const { state } = engine.reconstruct(executionId);
    out.consumedModelRequests = state.consumed.modelRequests;
    out.unresolved = state.unresolvedToolCalls.map((c) => c.callId);
    // What the retry does next: re-open the execution and dispatch another non-idempotent
    // write. When the plan refused, this simulates a caller that ignores the refusal and
    // forces the execution open anyway; the unresolved call must still block the write.
    try {
      if (plan.action !== 'resume' && out.executionStatusBefore !== 'completed') await engine.recordEvent(executionId, 'execution.resumed', { forced: true });
      await engine.setStatus(executionId, 'running');
      await engine.recordToolStart(executionId, 'shell', { command: 'probe' }, { callId: 'probe-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' });
      out.nextWrite = 'allowed';
    } catch (e) { out.nextWrite = e.message; }
    out.reconcileEvents = (await engine.events(executionId)).filter((e) => (e.eventId ?? '').endsWith(':reconciled')).map((e) => e.eventId);
  }
  out.effect = await readFile(`${dir}/effect`, 'utf8').catch(() => '');
  out.outFile = await readFile(`${workspace}/out.txt`, 'utf8').catch(() => null);
  console.log(JSON.stringify(out));
}
