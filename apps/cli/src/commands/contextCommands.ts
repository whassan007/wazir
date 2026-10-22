import type { ContextPart } from '@wazir/core';
import { tokensPerSecond } from '@wazir/shared';
import type { RookEngine } from '../engine.js';
import { color } from '../colors.js';
import {
  getBlock,
  getActiveContext,
  addContextBlock,
  removeContextBlock,
  clearContext,
} from '../blocks.js';

/** Build ContextPart[] from active context block IDs, for use in run.ts */
export async function buildContextPartsFromActive(
  engine: RookEngine,
): Promise<ContextPart[]> {
  const ids = await getActiveContext(engine);
  if (ids.length === 0) return [];

  const parts: ContextPart[] = [];
  for (const id of ids) {
    const block = await getBlock(engine, id);
    if (!block) continue;
    // Use stdout as content; if failed, use stderr or error message
    const content = block.stdout || (block.stderr ? `Error: ${block.stderr}` : 'No output');
    parts.push({
      kind: 'retrieved',
      label: `block #${id} (${block.command})`,
      content,
      priority: 'optional',
    });
  }
  return parts;
}

/** Add a block to active context */
export async function addContext(engine: RookEngine, id: string): Promise<{ code: number; output: string }> {
  const block = await getBlock(engine, id);
  if (!block) {
    return { code: 1, output: color.red(`block '${id}' not found`) };
  }
  try {
    await addContextBlock(engine, id);
    return { code: 0, output: color.green(`added block #${id} to context`) };
  } catch (err) {
    return { code: 1, output: color.red(String(err)) };
  }
}

/** Remove a block from active context */
export async function removeContext(engine: RookEngine, id: string): Promise<{ code: number; output: string }> {
  const current = await getActiveContext(engine);
  if (!current.includes(id)) {
    return { code: 1, output: color.yellow(`block '${id}' is not in active context`) };
  }
  try {
    await removeContextBlock(engine, id);
    return { code: 0, output: color.green(`removed block #${id} from context`) };
  } catch (err) {
    return { code: 1, output: color.red(String(err)) };
  }
}

/** List active context blocks with token estimate */
export async function listContext(engine: RookEngine): Promise<{ code: number; output: string }> {
  const ids = await getActiveContext(engine);
  if (ids.length === 0) {
    return { code: 0, output: color.yellow('no active context blocks') };
  }

  const lines: string[] = [];
  let totalTokens = 0;

  for (const id of ids) {
    const block = await getBlock(engine, id);
    if (!block) {
      lines.push(color.red(`  #${id} — not found`));
      continue;
    }
    // First ~60 chars of stdout or error
    let summary: string;
    if (block.stdout) {
      summary = block.stdout.slice(0, 60);
      if (block.stdout.length > 60) summary += '…';
    } else if (block.stderr) {
      summary = `Error: ${block.stderr.slice(0, 57)}…`;
    } else {
      summary = 'No output';
    }
    // Estimate tokens using same method as ContextCompiler
    const estTokens = Math.ceil((block.stdout?.length || block.stderr?.length || 0) / 4);
    totalTokens += estTokens;
    lines.push(`  #${id} (${block.command}) — ${summary} (~${estTokens} tok)`);
  }

  lines.push('');
  lines.push(color.bold(`Total token estimate: ~${totalTokens} tokens`));

  return { code: 0, output: lines.join('\n') };
}

/** Clear all active context blocks */
export async function clearContextCommand(engine: RookEngine): Promise<{ code: number; output: string }> {
  try {
    await clearContext(engine);
    return { code: 0, output: color.green('context cleared') };
  } catch (err) {
    return { code: 1, output: color.red(String(err)) };
  }
}

/** Explain active context selection and snapshot breakdown */
export async function explainContextCommand(
  engine: RookEngine,
  executionId: string,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const snapshot = engine.compiler.getLatestSnapshot(executionId);
  if (!snapshot) {
    const msg = `No compiled context snapshot found for execution: ${executionId}`;
    if (options.json) {
      return { code: 1, output: JSON.stringify({ error: msg }) };
    }
    return { code: 1, output: color.yellow(msg) };
  }

  if (options.json) {
    return {
      code: 0,
      output: JSON.stringify(
        {
          executionId: snapshot.executionId,
          snapshotId: snapshot.id,
          generation: snapshot.generation,
          modelId: snapshot.modelId,
          effectiveContextWindow: snapshot.effectiveContextWindow,
          estimatedTokens: snapshot.estimatedTokens,
          utilization: snapshot.tokenBudget?.utilization ?? 0,
          breakdown: {
            pinnedTokens: snapshot.pinned.reduce((s, p) => s + (p.tokens ?? 0), 0),
            activeTokens: snapshot.active.reduce((s, p) => s + (p.tokens ?? 0), 0),
            relevantTokens: (snapshot.relevant ?? []).reduce((s, p) => s + (p.tokens ?? 0), 0),
            compressedTokens: (snapshot.compressed ?? []).reduce((s, p) => s + (p.tokens ?? 0), 0),
            tailTokens: snapshot.tail.reduce((s, p) => s + (p.tokens ?? 0), 0),
          },
          includedItems: [
            ...snapshot.pinned.map((p) => ({ label: p.label, category: 'PINNED', tokens: p.tokens, reason: p.reasonIncluded })),
            ...snapshot.active.map((p) => ({ label: p.label, category: 'ACTIVE', tokens: p.tokens, reason: p.reasonIncluded })),
            ...(snapshot.relevant ?? []).map((p) => ({ label: p.label, category: 'RELEVANT', tokens: p.tokens, reason: p.reasonIncluded })),
          ],
          omittedItems: snapshot.omitted ?? [],
        },
        null,
        2,
      ),
    };
  }

  const lines: string[] = [];
  lines.push(color.bold(`Context Explanation for Execution: ${executionId}`));
  lines.push(`  Model: ${snapshot.modelId}`);
  lines.push(`  Effective context window: ${snapshot.effectiveContextWindow.toLocaleString()} tokens`);
  lines.push(`  Snapshot generation: #${snapshot.generation} (${snapshot.id})`);
  lines.push(`  Estimated active tokens: ${snapshot.estimatedTokens.toLocaleString()}`);
  if (snapshot.tokenBudget?.utilization !== undefined) {
    lines.push(`  Context utilization: ${(snapshot.tokenBudget.utilization * 100).toFixed(1)}%`);
  }
  lines.push('');
  lines.push(color.cyan('INCLUDED CONTEXT:'));
  for (const item of [...snapshot.pinned, ...snapshot.active, ...(snapshot.relevant ?? [])]) {
    lines.push(`  - [${item.category ?? item.kind}] ${item.label}`);
    if (item.reasonIncluded) lines.push(`    Reason: ${item.reasonIncluded}`);
  }
  if (snapshot.omitted && snapshot.omitted.length > 0) {
    lines.push('');
    lines.push(color.yellow('OMITTED CONTEXT:'));
    for (const omit of snapshot.omitted) {
      lines.push(`  - [${omit.category}] ${omit.label} (~${omit.estimatedTokens} tokens)`);
      lines.push(`    Reason: ${omit.reason}`);
    }
  }

  return { code: 0, output: lines.join('\n') };
}

/** Detailed inspection of model-visible context snapshot */
export async function inspectContextCommand(
  engine: RookEngine,
  executionId: string,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const snapshot = engine.compiler.getLatestSnapshot(executionId);
  if (!snapshot) {
    const msg = `No compiled context snapshot found for execution: ${executionId}`;
    if (options.json) {
      return { code: 1, output: JSON.stringify({ error: msg }) };
    }
    return { code: 1, output: color.yellow(msg) };
  }

  if (options.json) {
    return { code: 0, output: JSON.stringify(snapshot, null, 2) };
  }

  const lines: string[] = [];
  lines.push(color.bold(`Context Snapshot Inspection: ${snapshot.id}`));
  lines.push(`  Execution: ${snapshot.executionId} | Generation: #${snapshot.generation}`);
  lines.push(`  Model: ${snapshot.modelId} | Effective Window: ${snapshot.effectiveContextWindow} tokens`);
  lines.push(`  Estimated Tokens: ${snapshot.estimatedTokens}`);
  if (snapshot.revisionMetadata) {
    lines.push(`  Revision Trigger: ${snapshot.revisionMetadata.revisionTrigger ?? 'INITIAL'}`);
    lines.push(`  Layout Strategy: ${snapshot.revisionMetadata.layoutStrategy ?? 'DEFAULT'}`);
    lines.push(`  Tokens Deduped: ${snapshot.revisionMetadata.tokensDeduplicated ?? 0} | Superseded: ${snapshot.revisionMetadata.tokensSuperseded ?? 0} | Summarized: ${snapshot.revisionMetadata.tokensSummarized ?? 0}`);
  }
  lines.push('');
  lines.push(color.bold('PARTITION BREAKDOWN:'));
  lines.push(`  Pinned: ${snapshot.pinned.length} items`);
  lines.push(`  Active: ${snapshot.active.length} items`);
  lines.push(`  Relevant: ${(snapshot.relevant ?? []).length} items`);
  lines.push(`  Compressed: ${(snapshot.compressed ?? []).length} items`);
  lines.push(`  Tail: ${snapshot.tail.length} items`);
  if (snapshot.stablePrefix) {
    lines.push(`  Stable Prefix (KV Cache): ${snapshot.stablePrefix.length} items`);
  }
  if (snapshot.offloadedItems && snapshot.offloadedItems.length > 0) {
    lines.push(`  Offloaded Artifacts: ${snapshot.offloadedItems.length} items`);
    for (const off of snapshot.offloadedItems) {
      lines.push(`    - ${off.label} -> ${off.artifactId} (saved ~${off.tokensSaved} tokens)`);
    }
  }

  return { code: 0, output: lines.join('\n') };
}

/** Show quantitative EvaluationRecord for an execution */
export async function showEvaluationCommand(
  engine: RookEngine,
  executionId: string,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  try {
    const record = engine.executions.require(executionId);
    const { EvaluationService } = await import('@wazir/evaluation');
    const evalService = new EvaluationService();
    const evalRecord = evalService.buildEvaluationRecord(record);

    if (options.json) {
      return { code: 0, output: JSON.stringify(evalRecord, null, 2) };
    }

    const lines: string[] = [];
    lines.push(color.bold(`=== Evaluation Record: ${evalRecord.identity.runId} ===`));
    lines.push(`  Execution: ${executionId} | Status: ${evalRecord.correctness.passed ? color.green('PASSED') : color.red('FAILED')}`);
    lines.push(`  Model: ${evalRecord.identity.modelId} | Runtime: ${evalRecord.identity.runtimeId}`);
    lines.push('');
    lines.push(color.cyan('MODEL METRICS:'));
    lines.push(`  Calls: ${evalRecord.model.totalCalls.value} (${evalRecord.model.totalCalls.kind})`);
    lines.push(`  Input Tokens: ${evalRecord.model.inputTokens.value.toLocaleString()} (${evalRecord.model.inputTokens.kind})`);
    lines.push(`  Output Tokens: ${evalRecord.model.outputTokens.value.toLocaleString()} (${evalRecord.model.outputTokens.kind})`);
    lines.push('');
    lines.push(color.cyan('CONTEXT METRICS:'));
    lines.push(`  Peak Context: ${evalRecord.context.peakContextTokens.value.toLocaleString()} tokens`);
    lines.push(`  Average Context: ${evalRecord.context.averageContextTokens.value.toLocaleString()} tokens`);
    lines.push(`  Snapshots: ${evalRecord.context.snapshotCount.value} | Revisions: ${evalRecord.context.revisionCount.value}`);
    lines.push(`  Reclaimed (Dedup): ${evalRecord.context.tokensRemovedDeduplication.value} tokens`);
    lines.push(`  Reclaimed (Superseded): ${evalRecord.context.tokensRemovedSuperseded.value} tokens`);
    lines.push(`  Tokens Summarized: ${evalRecord.context.tokensSummarized.value} tokens`);
    lines.push(`  Tokens Offloaded: ${evalRecord.context.tokensOffloaded.value} tokens`);
    lines.push(`  Cache Read: ${evalRecord.context.cacheReadTokens.value} (${evalRecord.context.cacheReadTokens.kind}${evalRecord.context.cacheReadTokens.note ? ` - ${evalRecord.context.cacheReadTokens.note}` : ''})`);
    lines.push(`  Cache Write: ${evalRecord.context.cacheWriteTokens.value} (${evalRecord.context.cacheWriteTokens.kind}${evalRecord.context.cacheWriteTokens.note ? ` - ${evalRecord.context.cacheWriteTokens.note}` : ''})`);
    lines.push('');
    lines.push(color.cyan('PERFORMANCE & TOOLS:'));
    lines.push(`  Wall Time: ${(evalRecord.performance.wallTimeMs.value / 1000).toFixed(1)}s | Repair Cycles: ${evalRecord.agent.repairCycles.value}`);
    lines.push(`  Tool Calls: ${evalRecord.tools.totalCalls.value} | Code Mode Calls: ${evalRecord.tools.codeModeCalls.value}`);

    return { code: 0, output: lines.join('\n') };
  } catch (err) {
    const msg = `Failed to show evaluation for ${executionId}: ${err instanceof Error ? err.message : String(err)}`;
    if (options.json) {
      return { code: 1, output: JSON.stringify({ error: msg }) };
    }
    return { code: 1, output: color.red(msg) };
  }
}

/** Multi-dimensional comparison of baseline vs candidate execution */
export async function compareEvaluationCommand(
  engine: RookEngine,
  baselineId: string,
  candidateId: string,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  try {
    const baseRecord = engine.executions.require(baselineId);
    const candRecord = engine.executions.require(candidateId);
    const { EvaluationService } = await import('@wazir/evaluation');
    const evalService = new EvaluationService();

    const baseEval = evalService.buildEvaluationRecord(baseRecord);
    const candEval = evalService.buildEvaluationRecord(candRecord);
    const comparison = evalService.compareDimensions(baseEval, candEval);

    if (options.json) {
      return { code: 0, output: JSON.stringify(comparison, null, 2) };
    }

    return { code: 0, output: comparison.summary };
  } catch (err) {
    const msg = `Failed to compare evaluations ${baselineId} vs ${candidateId}: ${err instanceof Error ? err.message : String(err)}`;
    if (options.json) {
      return { code: 1, output: JSON.stringify({ error: msg }) };
    }
    return { code: 1, output: color.red(msg) };
  }
}

const BENCHMARK_PROMPT =
  'Write a short haiku (17 syllables) about a TypeScript compiler checking types.';

async function runBenchmarkLegacy(engine: RookEngine, modelId?: string, prompt?: string): Promise<string> {
  const models = engine.models.list();
  if (models.length === 0) {
    return color.yellow('no models registered — cannot benchmark');
  }

  const target = modelId ? models.find((m) => m.id === modelId) : models[0];
  if (!target) {
    return color.red(`model '${modelId}' not found`);
  }
  if (modelId && target.id !== modelId) {
    return color.red(`model '${modelId}' not found`);
  }

  const text = prompt ?? BENCHMARK_PROMPT;
  const lines: string[] = [];
  lines.push(color.bold(`Benchmark: ${target.id}`));
  lines.push(color.gray(`  prompt: ${text.slice(0, 80)}`));
  lines.push('');

  const started = Date.now();
  let firstTokenMs: number | undefined;
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;

  const adapter = engine.adapters.get(target.provider) ?? engine.worker.adapterForModel(target.id);
  if (!adapter) {
    return color.red(`no runtime can serve '${target.id}'`);
  }

  for await (const event of adapter.generate({
    modelId: target.id,
    messages: [{ role: 'user', content: text }],
    maxTokens: 256,
    temperature: 0.3,
    stream: true,
  })) {
    if (event.type === 'token' && event.content) {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
      output += event.content;
    } else if (event.type === 'completed') {
      if (event.content) output = event.content;
      inputTokens = event.usage?.inputTokens ?? 0;
      outputTokens = event.usage?.outputTokens ?? 0;
    } else if (event.type === 'error') {
      error = event.error;
    }
  }

  const elapsedMs = Date.now() - started;

  lines.push(`  first token: ${firstTokenMs !== undefined ? `${firstTokenMs}ms` : '—'}`);
  lines.push(`  total time:  ${elapsedMs}ms`);
  lines.push(`  input:       ${inputTokens} tokens`);
  lines.push(`  output:      ${outputTokens} tokens`);
  lines.push(`  throughput:  ${tokensPerSecond(outputTokens, elapsedMs).toFixed(1)} tok/s`);
  if (error) {
    lines.push(color.red(`  error: ${error}`));
  }
  lines.push('');
  lines.push(color.bold('  Output:'));
  lines.push(color.gray(`  ${output.slice(0, 400)}`));

  return lines.join('\n');
}

/** Programmatic provider/benchmark API used by the CLI and integration tests. */
export async function runBenchmark(
  engine: RookEngine,
  request?: string | { models?: string[]; json?: boolean },
  prompt?: string,
): Promise<string | { exitCode: number; output: string }> {
  if (typeof request === 'object') {
    const modelIds = request.models ?? [];
    const runs = [];
    for (const modelId of modelIds) {
      const output = await runBenchmarkLegacy(engine, modelId);
      runs.push({ modelId, passed: !/failed|error|no runtime/i.test(output), output });
    }
    const report = { models: modelIds, runs };
    return request.json ? { exitCode: 0, output: JSON.stringify(report) } : { exitCode: 0, output: JSON.stringify(report, null, 2) };
  }
  return runBenchmarkLegacy(engine, request, prompt);
}
