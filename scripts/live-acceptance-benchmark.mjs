import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLMStudioAdapter } from '../packages/runtimes/lmstudio/dist/src/index.js';
import { CodingAgent } from '../packages/agents/dist/src/codingAgent.js';
import { defaultTools } from '../packages/tools/dist/src/registry.js';
import { ToolSurfaceCompiler } from '../packages/core/dist/src/index.js';

async function runBenchmarkWorkload(protocolMode) {
  const modelId = 'qwen/qwen3-coder-next';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `wazir-live-${protocolMode}-`));
  const pkgPath = path.join(tempDir, 'package.json');
  await fs.writeFile(
    pkgPath,
    JSON.stringify(
      {
        name: 'sample-project',
        version: '1.2.3',
        description: 'Sample project for live benchmark',
        dependencies: {
          express: '^4.18.2',
          lodash: '^4.17.21',
          typescript: '^5.6.0',
        },
      },
      null,
      2,
    ),
  );

  const rawAdapter = createLMStudioAdapter('http://localhost:1234/v1');

  // Configure runtime capabilities according to protocolMode
  const capabilities =
    protocolMode === 'native'
      ? {
          nativeToolCalling: true,
          parallelToolCalling: true,
          strictJsonSchema: true,
          streamingToolCalls: true,
          structuredOutput: true,
        }
      : {
          nativeToolCalling: false,
          toolCalling: false,
          parallelToolCalling: false,
          strictJsonSchema: false,
          streamingToolCalls: false,
          structuredOutput: false,
        };

  let modelCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolSchemaTokens = 0;

  // Wrap generate to measure requests and token usage
  const runtime = {
    tools: defaultTools.map((t) => ({
      name: t.descriptor.name,
      description: t.descriptor.description,
      inputSchema: t.descriptor.inputSchema,
      descriptor: t.descriptor,
    })),
    runtimeCapabilities: capabilities,
    getCapabilities() {
      return capabilities;
    },
    async *generate(req) {
      modelCalls++;
      if (req.tools) {
        toolSchemaTokens = Math.ceil(JSON.stringify(req.tools).length / 4);
      }
      for await (const event of rawAdapter.generate(req)) {
        if (event.type === 'completed' && event.usage) {
          totalInputTokens += event.usage.inputTokens;
          totalOutputTokens += event.usage.outputTokens;
        }
        yield event;
      }
    },
    async executeTool(toolName, input) {
      if (toolName === 'read') {
        const target = path.resolve(tempDir, String(input.path));
        const content = await fs.readFile(target, 'utf8');
        return { ok: true, output: content, durationMs: 2 };
      }
      if (toolName === 'write') {
        const target = path.resolve(tempDir, String(input.path));
        await fs.writeFile(target, String(input.content), 'utf8');
        return {
          ok: true,
          output: `wrote ${Buffer.byteLength(String(input.content))} bytes`,
          fileMutations: [{ path: String(input.path), changed: true }],
          durationMs: 3,
        };
      }
      return { ok: true, output: 'done', durationMs: 1 };
    },
  };

  const agent = new CodingAgent({
    maxTurns: 10,
    modelTurnTimeoutMs: 60000,
  });

  const taskDescription =
    'Read package.json, count the dependencies, and write summary.json containing {"name": "sample-project", "version": "1.2.3", "dependencyCount": 3}. Then report done.';

  const startTime = Date.now();
  let toolCallsCount = 0;
  let malformedActionsCount = 0;
  let validationErrorsCount = 0;
  let retriesCount = 0;
  let completed = false;

  for await (const turn of agent.run(
    {
      modelId,
      taskDescription,
      taskType: 'coding',
      projectRoot: tempDir,
    },
    runtime,
  )) {
    if (turn.kind === 'tool_call') {
      toolCallsCount++;
    }
    if (turn.kind === 'message') {
      if (turn.content?.includes('action.validation_failed') || turn.content?.includes('ACTION_VALIDATION_FAILED')) {
        validationErrorsCount++;
      }
      if (turn.content?.includes('INVALID_JSON_ACTION')) {
        malformedActionsCount++;
        retriesCount++;
      }
    }
    if (turn.kind === 'done') {
      completed = true;
      break;
    }
    if (turn.kind === 'error') {
      break;
    }
  }

  const wallTimeMs = Date.now() - startTime;

  // Verify physical artifact
  const summaryPath = path.join(tempDir, 'summary.json');
  let artifactValid = false;
  try {
    const content = await fs.readFile(summaryPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed.name === 'sample-project' && parsed.version === '1.2.3' && parsed.dependencyCount === 3) {
      artifactValid = true;
    }
  } catch {
    artifactValid = false;
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  return {
    protocolMode,
    success: completed && artifactValid,
    modelCalls,
    toolCalls: toolCallsCount,
    malformedActions: malformedActionsCount,
    validationErrors: validationErrorsCount,
    retries: retriesCount,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolSchemaTokens,
    wallTimeMs,
  };
}

async function main() {
  console.log('===============================================================');
  console.log('        WAZIR LIVE ACCEPTANCE: PROTOCOL COMPARISON             ');
  console.log('   Model: qwen/qwen3-coder-next (LM Studio @ localhost:1234)    ');
  console.log('===============================================================\n');

  console.log('>>> Running Protocol A: Legacy Text Action Protocol...');
  const legacyMetrics = await runBenchmarkWorkload('legacy');
  console.log('Protocol A Complete:\n', legacyMetrics);

  console.log('\n>>> Running Protocol B: Native Structured Tool Protocol...');
  const nativeMetrics = await runBenchmarkWorkload('native');
  console.log('Protocol B Complete:\n', nativeMetrics);

  console.log('\n===============================================================');
  console.log('                  COMPARATIVE RESULTS MATRIX                   ');
  console.log('===============================================================');
  console.table([
    {
      Metric: 'Success (Artifact Verified)',
      'Protocol A (Legacy Text)': legacyMetrics.success ? 'PASS' : 'FAIL',
      'Protocol B (Native Tool)': nativeMetrics.success ? 'PASS' : 'FAIL',
    },
    {
      Metric: 'Model Invocations',
      'Protocol A (Legacy Text)': legacyMetrics.modelCalls,
      'Protocol B (Native Tool)': nativeMetrics.modelCalls,
    },
    {
      Metric: 'Tool Calls Executed',
      'Protocol A (Legacy Text)': legacyMetrics.toolCalls,
      'Protocol B (Native Tool)': nativeMetrics.toolCalls,
    },
    {
      Metric: 'Malformed Actions',
      'Protocol A (Legacy Text)': legacyMetrics.malformedActions,
      'Protocol B (Native Tool)': nativeMetrics.malformedActions,
    },
    {
      Metric: 'Validation Errors',
      'Protocol A (Legacy Text)': legacyMetrics.validationErrors,
      'Protocol B (Native Tool)': nativeMetrics.validationErrors,
    },
    {
      Metric: 'Action Retries',
      'Protocol A (Legacy Text)': legacyMetrics.retries,
      'Protocol B (Native Tool)': nativeMetrics.retries,
    },
    {
      Metric: 'Total Input Tokens',
      'Protocol A (Legacy Text)': legacyMetrics.inputTokens,
      'Protocol B (Native Tool)': nativeMetrics.inputTokens,
    },
    {
      Metric: 'Tool Schema Tokens (per turn)',
      'Protocol A (Legacy Text)': legacyMetrics.toolSchemaTokens,
      'Protocol B (Native Tool)': nativeMetrics.toolSchemaTokens,
    },
    {
      Metric: 'Wall Clock Duration (ms)',
      'Protocol A (Legacy Text)': `${legacyMetrics.wallTimeMs} ms`,
      'Protocol B (Native Tool)': `${nativeMetrics.wallTimeMs} ms`,
    },
  ]);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
