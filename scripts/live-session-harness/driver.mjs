// Instrumented entry point into the same executeTask used by `wa task run`.
// No tool implementation or successful result is substituted by this driver.
import fs from 'node:fs/promises';
import path from 'node:path';
import { faultInjector } from '@wazir/shared';
import { createEngine } from '../../apps/cli/dist/engine.js';
import { executeTask } from '../../apps/cli/dist/run.js';
import { snapshot, changedPaths } from './evidence.mjs';

// `LS-19:recover` is the restart half of a crash scenario: the same WAZIR_HOME and workspace,
// a new process. createEngine() runs Wazir's own startup reconciliation; nothing is replayed here.
const [scenarioArg, model, maxTurns, prompt, artifact] = process.argv.slice(2);
const [scenario, driverPhase = 'run'] = scenarioArg.split(':');
const auditPath = path.join(artifact, 'driver.jsonl');
const audit = async event => fs.appendFile(auditPath, JSON.stringify({ ...event, scenario, phase: driverPhase, pid: process.pid, at: new Date().toISOString() }) + '\n');
const MUTATING = new Set(['write', 'edit']);
// SIGKILL: no shutdown handlers, no flush — the same as a power loss or OOM kill of Wazir.
const hardKill = () => process.kill(process.pid, 'SIGKILL');

if (driverPhase === 'recover') {
  const killed = (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'fault.fired');
  const engine = await createEngine();
  const record = killed ? await engine.executions.get?.(killed.executionId) ?? (await engine.executions.list()).find(r => r.execution.id === killed.executionId) : undefined;
  await audit({ type: 'recovery.observed', executionId: killed?.executionId ?? null,
    status: record?.execution.status ?? null, errors: record?.errors ?? [],
    checkpoints: killed ? engine.executions.toolCheckpoints(killed.executionId) : [],
    reconciled: (record?.events ?? []).filter(e => e.data?.reconciled).map(e => ({ callId: e.callId, ...e.data.reconciled })),
    workspace: await snapshot(process.cwd()) });
  const observed = [];
  for (const tool of engine.tools.list()) {
    const execute = tool.execute.bind(tool);
    tool.execute = async (input, context) => {
      observed.push(context.callId);
      await audit({ type: 'tool.observed', callId: context.callId, tool: tool.descriptor.name, input });
      return execute(input, context);
    };
  }
  try {
    const result = await executeTask(engine, prompt, { type: 'coding', model, maxTurns: Number(maxTurns), json: true, quiet: true });
    await audit({ type: 'driver.finished', executionId: result.executionId, observedCalls: observed.length });
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    await audit({ type: 'driver.error', error: String(error) });
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

const engine = await createEngine();
const runningRecord = async () => (await engine.executions.list()).find(r => r.execution.status === 'running');

if (scenario === 'LS-20') {
  // Production fault point: the tool already ran (the file changed on disk) and its result
  // is in memory, but the completion event has not been persisted.
  faultInjector.register({ point: 'AFTER_TOOL_EXECUTION_BEFORE_PERSIST',
    match: c => MUTATING.has(String(c.tool)) && c.ok === true,
    action: { type: 'custom', handler: async c => {
      await audit({ type: 'fault.fired', executionId: c.executionId, callId: c.callId, tool: c.tool, workspace: await snapshot(process.cwd()) });
      hardKill();
      await new Promise(() => {});
    } } });
}
let injected = false;
let toolSucceeded = false;
let actualGenerations = 0;
let followup;
for (const tool of engine.tools.list()) {
  const execute = tool.execute.bind(tool);
  tool.execute = async (input, context) => {
    if (scenario === 'LS-19' && !injected && MUTATING.has(tool.descriptor.name)) {
      // The call's STARTED checkpoint is already durable (recordToolStart flushes before
      // dispatch); the tool has not touched the file. Kill Wazir mid-tool.
      injected = true;
      const record = await runningRecord();
      await audit({ type: 'fault.fired', executionId: record?.execution.id, callId: context.callId, tool: tool.descriptor.name, input,
        workspace: await snapshot(context.projectRoot) });
      hardKill();
      await new Promise(() => {});
    }
    const before = await snapshot(context.projectRoot);
    try {
      const result = await execute(input, context);
      if (result?.ok) toolSucceeded = true;
      const after = await snapshot(context.projectRoot);
      await audit({ type: 'tool.observed', callId: context.callId, tool: tool.descriptor.name,
        input, ok: result.ok, changed: changedPaths(before, after), before, after });
      return result;
    } catch (error) {
      await audit({ type: 'tool.observation_error', callId: context.callId, error: String(error) });
      throw error;
    }
  };
}
// Adapters retain real model loading, generation, cancellation and runtime behavior.
for (const adapter of engine.adapters.values()) {
  const generate = adapter.generate.bind(adapter);
  adapter.generate = async function* (request) {
    const records = await engine.executions.list();
    const record = records.find(r => r.execution.status === 'running');
    if (scenario === 'LS-04' && !injected && record?.toolCalls.some(t => t.tool === 'read' && t.ok &&
      path.resolve(process.cwd(), String(t.input?.path)) === path.join(process.cwd(), 'src/average.cpp'))) {
      const source = path.join(process.cwd(), 'src/average.cpp');
      const before = await fs.readFile(source, 'utf8');
      const after = before.replace('values.size() - 1', 'values.size() - 2');
      if (before !== after) {
        await fs.writeFile(source, after);
        injected = true;
        await audit({ type: 'fault.fired', scenario, executionId: record.execution.id,
          revision: record.workspaceState?.revision, path: 'src/average.cpp' });
      }
    }
    if (scenario === 'LS-05' && !injected && record && ['build', 'test'].every(name =>
      record.checks.some(c => c.name === name && c.ok && c.workspaceRevision === record.workspaceState?.revision))) {
      const instruction = 'Additional requirement: average of an empty sample must return 0. Preserve the other behavior, add a regression test, and rebuild and retest the final revision.';
      followup = instruction;
      injected = true;
      await audit({ type: 'fault.fired', scenario, executionId: record.execution.id, revision: record.workspaceState.revision, instruction });
    }
    if (followup) request = { ...request, messages: [...request.messages, { role: 'user', content: followup }] };
    const phase = record?.events.filter(e => e.type === 'agent.phase').at(-1)?.data?.phase;
    const corrupt = !injected && ['LS-16', 'LS-17'].includes(scenario) && phase === 'implement';
    await audit({ type: 'model.request', requestId: request.requestId, model: request.modelId,
      // Explicit estimate; this is not a tokenizer measurement.
      estimatedContextTokens: Math.ceil(JSON.stringify(request.messages).length / 4) });
    let completed;
    let failed = false;
    let streamed = 0;
    const disconnect = scenario === 'LS-21' && !injected && driverPhase === 'run' && toolSucceeded;
    for await (const event of generate(request)) {
      // Native tool calling streams `tool_call` events rather than text tokens; either counts.
      // The connection drops at the first real event the runtime streams back (token,
      // reasoning, tool call or, for a non-incremental response, the completion itself),
      // so the consumer never receives that response.
      if (disconnect && event.type !== 'error') {
        streamed += event.content?.length ?? JSON.stringify(event.toolInput ?? '').length;
        await audit({ type: 'fault.event', eventType: event.type });
        {
          // The runtime connection drops mid-generation, after real tokens arrived.
          injected = true;
          actualGenerations++;
          await audit({ type: 'fault.fired', executionId: record?.execution.id ?? null, requestId: request.requestId, streamedChars: streamed, actualGenerations });
          const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          throw error;
        }
      }
      if (!corrupt) yield event;
      else if (event.type === 'error') { failed = true; yield event; }
      if (event.type === 'completed') completed = event;
    }
    actualGenerations++;
    // Inject only after a real model response. Recovery uses subsequent real calls.
    if (corrupt && completed && !failed) {
      injected = true;
      const toolName = scenario === 'LS-16' ? 'edit' : 'delete_everything_and_fix_it';
      const toolInput = scenario === 'LS-16' ? { path: 17, oldString: 'a', newString: 'b' } : {};
      await audit({ type: 'fault.fired', scenario, actualGenerations, toolName, toolInput, requestId: request.requestId });
      if (request.tools?.length) {
        yield { type: 'tool_call', toolCallId: 'live-injected-invalid', toolName, toolInput };
      } else {
        yield { type: 'token', content: JSON.stringify({ action: 'tool', tool: toolName, input: toolInput }) };
      }
      yield { ...completed, content: '' };
    }
  };
}

try {
  const result = await executeTask(engine, prompt, { type: 'coding', model, maxTurns: Number(maxTurns), json: true, quiet: true });
  await audit({ type: 'driver.finished', injected, actualGenerations, executionId: result.executionId });
  process.exitCode = result.success ? 0 : 1;
} catch (error) {
  await audit({ type: 'driver.error', error: String(error) });
  process.exitCode = 1;
}
// Production CLI also exits explicitly; services may otherwise retain timers.
process.exit(process.exitCode ?? 0);
