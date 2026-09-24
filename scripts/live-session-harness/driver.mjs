// Instrumented entry point into the same executeTask used by `wa task run`.
// No tool implementation or successful result is substituted by this driver.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createEngine } from '../../apps/cli/dist/engine.js';
import { executeTask } from '../../apps/cli/dist/run.js';
import { snapshot, changedPaths } from './evidence.mjs';

const [scenario, model, maxTurns, prompt, artifact] = process.argv.slice(2);
const engine = await createEngine();
const auditPath = path.join(artifact, 'driver.jsonl');
const audit = async event => fs.appendFile(auditPath, JSON.stringify({ ...event, at: new Date().toISOString() }) + '\n');
let injected = false;
let actualGenerations = 0;
let followup;
for (const tool of engine.tools.list()) {
  const execute = tool.execute.bind(tool);
  tool.execute = async (input, context) => {
    const before = await snapshot(context.projectRoot);
    try {
      const result = await execute(input, context);
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
    for await (const event of generate(request)) {
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
