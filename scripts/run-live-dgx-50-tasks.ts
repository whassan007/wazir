/**
 * A090 — Live DGX Spark 50-Simple-Task Hardware Reliability Benchmark
 *
 * Executes all 50 everyday software engineering tasks (`ST-001`..`ST-050`) against a
 * LIVE Ollama runtime (`qwen3-coder:30b` on NVIDIA DGX Spark GB10 Grace Blackwell)
 * through `WazirQwenAgent` + real `@wazir/tools` (`read`, `read_many_files`, `write`,
 * `edit`, `multi_edit`, `todo_write`, `search`, `glob`, `shell` + post-edit diagnostics).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, hostname, totalmem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AgentRuntime, AgentTurn, Tool, ToolResult } from '../packages/core/src/index.js';
import { WazirQwenAgent } from '../packages/agents/src/codingAgent.js';
import { OllamaAdapter } from '../packages/runtimes/ollama/src/index.js';
import { editTool, readTool, writeTool } from '../packages/tools/src/filesystem.js';
import { multiEditTool } from '../packages/tools/src/multiEdit.js';
import { shellTool } from '../packages/tools/src/process-tools.js';
import { readManyFilesTool } from '../packages/tools/src/readManyFiles.js';
import { ToolRegistry, executeTool } from '../packages/tools/src/registry.js';
import { globTool, searchTool } from '../packages/tools/src/search.js';
import { todoWriteTool } from '../packages/tools/src/todoTool.js';
import {
  SIMPLE_TASKS_CORPUS,
  type SimpleBenchmarkTask,
  type SimpleTaskCategory,
} from '../tests/benchmarks/simple-tasks/corpus.js';

const REPO_ROOT = process.cwd();
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL_ID = process.env.QWEN_BENCH_MODEL ?? 'qwen3-coder:30b';
const CONTEXT_TOKENS = Number(process.env.QWEN_BENCH_CTX ?? 32768);
const CONCURRENCY = Math.max(1, Number(process.env.QWEN_BENCH_CONCURRENCY ?? 3));
const OUTPUT_PATH =
  process.env.QWEN_BENCH_OUT ?? join(REPO_ROOT, 'reports', 'qwen-transplant', 'bench-simple-dgx.json');

interface LiveTaskRunMetrics {
  taskId: string;
  category: SimpleTaskCategory;
  title: string;
  passed: boolean;
  gradeReason: string;
  agentSucceeded: boolean;
  terminationReason: string;
  turns: number;
  toolCalls: number;
  tokensUsed: number;
  malformedActions: number;
  verificationCommandsExecuted: number;
  shellSpawns: number;
  shellCommandsSucceeded: number;
  wallClockMs: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Number(val.toFixed(2));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return Number((sum / values.length).toFixed(2));
}

function walkJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkJsonFiles(full));
    } else if (entry.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

function createInstrumentedCheckTools(
  workspaceRoot: string,
  onCheckInvoked: (checkName: string) => void,
): Tool[] {
  const checkNames = ['build', 'test', 'lint', 'typecheck'] as const;
  return checkNames.map((name) => ({
    descriptor: {
      name,
      description: `Run project ${name} verification check`,
      sideEffectClass: 'READ_ONLY',
      inputSchema: {
        type: 'object',
        properties: {
          workspaces: { type: 'array', items: { type: 'string' } },
        },
      },
      permissions: [name === 'test' ? 'test_run' : 'build_run'],
      riskLevel: 'low',
      environment: 'local',
    },
    async execute(): Promise<ToolResult> {
      onCheckInvoked(name);
      if (name === 'build' || name === 'typecheck') {
        for (const jsonPath of walkJsonFiles(workspaceRoot)) {
          try {
            JSON.parse(readFileSync(jsonPath, 'utf8'));
          } catch (err) {
            return {
              ok: false,
              output: '',
              error: `Invalid JSON in ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`,
              durationMs: 1,
            };
          }
        }
      }
      return {
        ok: true,
        output: `${name}: ok`,
        durationMs: 1,
      };
    },
  }));
}

async function runSingleLiveTask(
  task: SimpleBenchmarkTask,
  ollama: OllamaAdapter,
): Promise<LiveTaskRunMetrics> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), `wazir-live-${task.id}-`));
  try {
    for (const [relPath, content] of Object.entries(task.initialFiles)) {
      const full = join(workspaceRoot, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }

    let verificationCommandsExecuted = 0;
    let shellSpawns = 0;
    let shellCommandsSucceeded = 0;
    let modelTurns = 0;
    let totalToolCallsDispatched = 0;
    let totalTokensUsed = 0;

    const checkTools = createInstrumentedCheckTools(workspaceRoot, () => {
      verificationCommandsExecuted += 1;
    });

    const registry = new ToolRegistry([
      readTool,
      readManyFilesTool,
      writeTool,
      editTool,
      multiEditTool,
      todoWriteTool,
      searchTool,
      globTool,
      shellTool,
      ...checkTools,
    ]);

    const runtime: AgentRuntime = {
      tools: registry.forModel(),
      runtimeCapabilities: {
        nativeToolCalling: true,
      },
      getContextTokens: () => CONTEXT_TOKENS,
      async *generate(req) {
        modelTurns += 1;
        for await (const ev of ollama.generate({
          modelId: req.modelId,
          messages: req.messages,
          tools: req.tools,
          temperature: req.temperature ?? 0.05,
          maxTokens: req.maxTokens ?? 4096,
          contextTokens: CONTEXT_TOKENS,
        })) {
          if (ev.type === 'completed' && ev.usage?.totalTokens) {
            totalTokensUsed += ev.usage.totalTokens;
          }
          yield ev;
        }
      },
      async executeTool(name, input) {
        if (!['build', 'test', 'lint', 'typecheck'].includes(name)) {
          totalToolCallsDispatched += 1;
        }
        if (name === 'shell') {
          shellSpawns += 1;
        }
        const res = await executeTool(registry, name, input, {
          projectRoot: workspaceRoot,
          allowVerificationChanges: true,
        });
        if (name === 'shell' && res.ok) {
          shellCommandsSucceeded += 1;
        }
        return res;
      },
    };

    const agent = new WazirQwenAgent({
      maxTurns: 12,
      maxRepairCycles: 2,
      temperature: 0.05,
      maxTokensPerTurn: 4096,
    });

    const t0 = performance.now();
    const turns: AgentTurn[] = [];
    for await (const turn of agent.run(
      {
        modelId: MODEL_ID,
        taskDescription: task.prompt,
        taskType: 'coding',
        projectRoot: workspaceRoot,
        contextTokens: CONTEXT_TOKENS,
      },
      runtime,
    )) {
      turns.push(turn);
    }
    const wallClockMs = Number((performance.now() - t0).toFixed(2));

    const terminalTurn = turns.at(-1);
    const agentSucceeded = terminalTurn?.kind === 'done';
    const finalContent = terminalTurn?.content ?? '';
    const terminationReason =
      terminalTurn?.terminationReason ?? (agentSucceeded ? 'VERIFICATION_PASSED' : 'UNKNOWN');
    const malformedActions = terminalTurn?.protocolMetrics?.malformedActions ?? 0;

    const grade = task.grade({
      workspaceRoot,
      agentSucceeded,
      finalContent,
      shellCommandsSucceeded,
    });

    return {
      taskId: task.id,
      category: task.category,
      title: task.title,
      passed: grade.passed,
      gradeReason: grade.reason,
      agentSucceeded,
      terminationReason,
      turns: modelTurns,
      toolCalls: totalToolCallsDispatched,
      tokensUsed: totalTokensUsed,
      malformedActions,
      verificationCommandsExecuted,
      shellSpawns,
      shellCommandsSucceeded,
      wallClockMs,
    };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const ollama = new OllamaAdapter(OLLAMA_URL);
  const runtimeInfo = await ollama.discover();
  const modelState = await ollama.inspectModel(MODEL_ID).catch(() => ({
    modelId: MODEL_ID,
    loaded: false,
    effectiveContext: CONTEXT_TOKENS,
  }));

  const host = {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemoryGB: Number((totalmem() / 1024 ** 3).toFixed(1)),
  };

  console.log(
    `[A090] Running ${SIMPLE_TASKS_CORPUS.length} live everyday tasks on ${host.hostname} (${host.platform}-${host.arch})`,
  );
  console.log(
    `[A090] Model=${MODEL_ID} | Ollama=${runtimeInfo.url} (v${runtimeInfo.version}) | ctx=${CONTEXT_TOKENS} | concurrency=${CONCURRENCY}`,
  );

  const startedAt = performance.now();
  const results: LiveTaskRunMetrics[] = [];
  let completed = 0;

  const queue = [...SIMPLE_TASKS_CORPUS];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      const metrics = await runSingleLiveTask(task, ollama);
      results.push(metrics);
      completed += 1;
      const tag = metrics.passed ? 'PASS' : 'FAIL';
      console.log(
        `[${completed}/${SIMPLE_TASKS_CORPUS.length}] ${metrics.taskId} (${metrics.category}) -> ${tag} in ${(metrics.wallClockMs / 1000).toFixed(2)}s (turns=${metrics.turns}, tools=${metrics.toolCalls}, tokens=${metrics.tokensUsed})${metrics.passed ? '' : ` | reason: ${metrics.gradeReason}`}`,
      );
    }
  });

  await Promise.all(workers);
  const suiteWallClockMs = Number((performance.now() - startedAt).toFixed(2));
  results.sort((a, b) => a.taskId.localeCompare(b.taskId));

  const readOnlyTasks = results.filter((r) => r.category === 'read_only_qa');
  const summary = {
    totalTasks: results.length,
    passedTasks: results.filter((r) => r.passed).length,
    passRatePct: Number(((results.filter((r) => r.passed).length / results.length) * 100).toFixed(2)),
    medianTurns: median(results.map((r) => r.turns)),
    meanTurns: mean(results.map((r) => r.turns)),
    medianToolCalls: median(results.map((r) => r.toolCalls)),
    meanToolCalls: mean(results.map((r) => r.toolCalls)),
    totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
    totalMalformedActions: results.reduce((sum, r) => sum + r.malformedActions, 0),
    readOnlyQaVerificationSpawns: readOnlyTasks.reduce((sum, r) => sum + r.verificationCommandsExecuted, 0),
    readOnlyQaShellSpawns: readOnlyTasks.reduce((sum, r) => sum + r.shellSpawns, 0),
    medianTaskWallClockMs: median(results.map((r) => r.wallClockMs)),
    suiteWallClockMs,
  };

  const categories = [...new Set(SIMPLE_TASKS_CORPUS.map((t) => t.category))];
  const byCategory = Object.fromEntries(
    categories.map((cat) => {
      const slice = results.filter((r) => r.category === cat);
      const passed = slice.filter((r) => r.passed).length;
      return [
        cat,
        {
          totalTasks: slice.length,
          passedTasks: passed,
          passRatePct: Number(((passed / slice.length) * 100).toFixed(2)),
          medianTurns: median(slice.map((r) => r.turns)),
          meanTurns: mean(slice.map((r) => r.turns)),
          medianToolCalls: median(slice.map((r) => r.toolCalls)),
          verificationCommandsExecuted: slice.reduce((s, r) => s + r.verificationCommandsExecuted, 0),
          shellSpawns: slice.reduce((s, r) => s + r.shellSpawns, 0),
          medianWallClockMs: median(slice.map((r) => r.wallClockMs)),
        },
      ];
    }),
  );

  const report = {
    benchmarkId: 'A090-live-dgx-50-simple-tasks',
    mode: 'live-dgx-spark-hardware',
    generatedAt: new Date().toISOString(),
    host,
    runtime: {
      ...runtimeInfo,
      modelId: MODEL_ID,
      contextTokens: CONTEXT_TOKENS,
      concurrency: CONCURRENCY,
      modelResidency: modelState,
    },
    summary,
    byCategory,
    tasks: results,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(
    `\n[A090] Completed: ${summary.passedTasks}/${summary.totalTasks} (${summary.passRatePct}%) in ${(suiteWallClockMs / 1000).toFixed(1)}s -> ${OUTPUT_PATH}`,
  );
}

main().catch((err) => {
  console.error('[A090] Fatal error:', err);
  process.exit(1);
});
