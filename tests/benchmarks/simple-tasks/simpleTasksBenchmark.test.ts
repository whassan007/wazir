/**
 * A090 & A091 — 50-Simple-Task Comparative Reliability Benchmark Harness
 * (`WazirQwenAgent` vs `LegacyJsonCodingAgent`)
 *
 * Runs all 50 everyday software engineering tasks (`ST-001`..`ST-050`) across isolated
 * temporary workspaces for BOTH:
 *  - `WazirQwenAgent` (`nativeToolCalling: true`, parallel `read_many_files`, 3-stage `computeSmartEdit`,
 *    `multi_edit`, `ProportionalVerifier`)
 *  - `LegacyJsonCodingAgent` (`nativeToolCalling: false`, raw JSON-in-text action protocol with realistic
 *    small/local-model formatting, plan-phase, nested-quote, and single-tool serialization behavior)
 *
 * Grades all 50 tasks deterministically on disk and writes an epistemically honest comparative report to:
 *   `reports/qwen-transplant/bench-simple-comparison.json`
 * explicitly labeled `mode: "deterministic-simulated-runtime"`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@wazir/core', () => import('../../../packages/core/src/index.js'));

import type { AgentRuntime, AgentTurn, Tool, ToolResult } from '../../../packages/core/src/index.js';
import {
  LegacyJsonCodingAgent,
  WazirQwenAgent,
} from '../../../packages/agents/src/codingAgent.js';
import { editTool, readTool, writeTool } from '../../../packages/tools/src/filesystem.js';
import { multiEditTool } from '../../../packages/tools/src/multiEdit.js';
import { shellTool } from '../../../packages/tools/src/process-tools.js';
import { readManyFilesTool } from '../../../packages/tools/src/readManyFiles.js';
import { ToolRegistry, executeTool } from '../../../packages/tools/src/registry.js';
import { globTool, searchTool } from '../../../packages/tools/src/search.js';
import { todoWriteTool } from '../../../packages/tools/src/todoTool.js';
import {
  SIMPLE_TASKS_CORPUS,
  emitLegacyTurnEvents,
  emitQwenTurnEvents,
  type SimpleBenchmarkTask,
  type SimpleTaskCategory,
} from './corpus.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const REPORT_OUTPUT_PATH = join(REPO_ROOT, 'reports', 'qwen-transplant', 'bench-simple-comparison.json');

interface AgentTaskRunMetrics {
  taskId: string;
  category: SimpleTaskCategory;
  passed: boolean;
  gradeReason: string;
  agentSucceeded: boolean;
  terminationReason: string;
  turns: number;
  toolCalls: number;
  malformedActions: number;
  verificationCommandsExecuted: number;
  shellSpawns: number;
  shellCommandsSucceeded: number;
  wallClockMs: number;
}

interface CategorySummary {
  category: SimpleTaskCategory;
  totalTasks: number;
  passedTasks: number;
  passRatePct: number;
  medianTurns: number;
  meanTurns: number;
  medianToolCalls: number;
  verificationCommandsExecuted: number;
  shellSpawns: number;
  totalWallClockMs: number;
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

/**
 * Creates deterministic, fast host verification check tools (`build`, `test`, `lint`, `typecheck`)
 * for an isolated benchmark temp workspace so host verification tax is measured accurately and
 * malformed JSON config writes are caught by `build`/`typecheck`.
 */
function createInstrumentedCheckTools(workspaceRoot: string, onCheckInvoked: (checkName: string) => void): Tool[] {
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

async function runSingleTask(
  task: SimpleBenchmarkTask,
  variant: 'qwen' | 'legacy',
): Promise<AgentTaskRunMetrics> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), `wazir-st-${variant}-${task.id}-`));
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

    let scriptCursor = 0;
    const runtime: AgentRuntime = {
      tools: registry.forModel(),
      runtimeCapabilities: {
        nativeToolCalling: variant === 'qwen',
      },
      async *generate() {
        modelTurns += 1;
        if (variant === 'qwen') {
          const step = task.qwenTurns[scriptCursor] ?? { text: 'Completed.' };
          scriptCursor += 1;
          for (const ev of emitQwenTurnEvents(step)) {
            yield ev;
          }
        } else {
          const raw =
            task.legacyRawTurns[scriptCursor] ??
            '{"action":"done","summary":"Fallback completion after retries."}';
          scriptCursor += 1;
          for (const ev of emitLegacyTurnEvents(raw)) {
            yield ev;
          }
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

    const agent =
      variant === 'qwen'
        ? new WazirQwenAgent({ maxTurns: 14, maxRepairCycles: 2 })
        : new LegacyJsonCodingAgent({ maxTurns: 14, maxRepairCycles: 2 });

    const t0 = performance.now();
    const turns: AgentTurn[] = [];
    for await (const turn of agent.run(
      {
        modelId: variant === 'qwen' ? 'qwen3-coder-30b-sim' : 'legacy-json-local-sim',
        taskDescription: task.prompt,
        taskType: 'coding', // simulates standard `wa run "<prompt>"` without manual flags
        projectRoot: workspaceRoot,
      },
      runtime,
    )) {
      turns.push(turn);
    }
    const wallClockMs = Number((performance.now() - t0).toFixed(2));

    const terminalTurn = turns.at(-1);
    const agentSucceeded = terminalTurn?.kind === 'done';
    const finalContent = terminalTurn?.content ?? '';
    const terminationReason = terminalTurn?.terminationReason ?? (agentSucceeded ? 'VERIFICATION_PASSED' : 'UNKNOWN');
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
      passed: grade.passed,
      gradeReason: grade.reason,
      agentSucceeded,
      terminationReason,
      turns: modelTurns,
      toolCalls: totalToolCallsDispatched,
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

function summarizeByCategory(
  results: readonly AgentTaskRunMetrics[],
  categories: readonly SimpleTaskCategory[],
): Record<SimpleTaskCategory, CategorySummary> {
  const out = {} as Record<SimpleTaskCategory, CategorySummary>;
  for (const category of categories) {
    const slice = results.filter((r) => r.category === category);
    const passed = slice.filter((r) => r.passed).length;
    out[category] = {
      category,
      totalTasks: slice.length,
      passedTasks: passed,
      passRatePct: Number(((passed / Math.max(1, slice.length)) * 100).toFixed(2)),
      medianTurns: median(slice.map((r) => r.turns)),
      meanTurns: mean(slice.map((r) => r.turns)),
      medianToolCalls: median(slice.map((r) => r.toolCalls)),
      verificationCommandsExecuted: slice.reduce((s, r) => s + r.verificationCommandsExecuted, 0),
      shellSpawns: slice.reduce((s, r) => s + r.shellSpawns, 0),
      totalWallClockMs: Number(slice.reduce((s, r) => s + r.wallClockMs, 0).toFixed(2)),
    };
  }
  return out;
}

describe('A089–A091 — 50-Simple-Task Everyday Reliability Benchmark (WazirQwenAgent vs LegacyJsonCodingAgent)', () => {
  it('1. Validates the 50-task corpus covers all 7 required categories with exact task counts (ST-001..ST-050)', () => {
    expect(SIMPLE_TASKS_CORPUS).toHaveLength(50);

    const ids = SIMPLE_TASKS_CORPUS.map((t) => t.id);
    const expectedIds = Array.from({ length: 50 }, (_, idx) => `ST-${String(idx + 1).padStart(3, '0')}`);
    expect(ids).toEqual(expectedIds);

    const countsByCategory = new Map<SimpleTaskCategory, number>();
    for (const task of SIMPLE_TASKS_CORPUS) {
      countsByCategory.set(task.category, (countsByCategory.get(task.category) ?? 0) + 1);
    }

    expect(Object.fromEntries(countsByCategory)).toEqual({
      read_only_qa: 8,
      one_line_bugfix: 8,
      symbol_rename: 7,
      new_helper_function: 7,
      config_json_edit: 7,
      multi_file_read_edit: 7,
      targeted_shell_check: 6,
    });
  });

  it('2. Executes all 50 tasks on BOTH WazirQwenAgent and LegacyJsonCodingAgent, writes bench-simple-comparison.json, and achieves >= 98% (50/50) with 0 Q&A check/shell spawns', async () => {
    const categories: readonly SimpleTaskCategory[] = [
      'read_only_qa',
      'one_line_bugfix',
      'symbol_rename',
      'new_helper_function',
      'config_json_edit',
      'multi_file_read_edit',
      'targeted_shell_check',
    ];

    const qwenResults: AgentTaskRunMetrics[] = [];
    const legacyResults: AgentTaskRunMetrics[] = [];

    const suiteStart = performance.now();
    for (const task of SIMPLE_TASKS_CORPUS) {
      qwenResults.push(await runSingleTask(task, 'qwen'));
      legacyResults.push(await runSingleTask(task, 'legacy'));
    }
    const totalBenchmarkWallClockMs = Number((performance.now() - suiteStart).toFixed(2));

    const qwenByCategory = summarizeByCategory(qwenResults, categories);
    const legacyByCategory = summarizeByCategory(legacyResults, categories);

    const qwenPassed = qwenResults.filter((r) => r.passed).length;
    const legacyPassed = legacyResults.filter((r) => r.passed).length;
    const qwenPassRatePct = Number(((qwenPassed / 50) * 100).toFixed(2));
    const legacyPassRatePct = Number(((legacyPassed / 50) * 100).toFixed(2));

    const qwenQaResults = qwenResults.filter((r) => r.category === 'read_only_qa');
    const qwenEditResults = qwenResults.filter((r) => r.category !== 'read_only_qa');
    const legacyQaResults = legacyResults.filter((r) => r.category === 'read_only_qa');
    const legacyEditResults = legacyResults.filter((r) => r.category !== 'read_only_qa');

    const cpuInfo = os.cpus();
    const report = {
      schemaVersion: '1.0.0',
      benchmarkId: 'wazir-qwen-transplant-simple-50',
      mode: 'deterministic-simulated-runtime',
      epistemicNote:
        'Deterministic simulated-runtime benchmark: LLM token/tool-call generation is deterministically scripted per agent protocol (native structured toolCalls for WazirQwenAgent vs raw JSON-in-text with realistic small/local-model formatting, plan-phase, and escaping friction for LegacyJsonCodingAgent), while 100% of agent orchestration, CoreToolScheduler batching, 3-stage smart edit, multi_edit, read_many_files, ProportionalVerifier, Node.js shell checks, and on-disk grading execute live.',
      generatedAt: new Date().toISOString(),
      hardware: {
        cpuModel: cpuInfo[0]?.model ?? 'unknown',
        cpuCores: cpuInfo.length,
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
      },
      totalTasks: 50,
      totalSuiteWallClockMs: totalBenchmarkWallClockMs,
      comparison: {
        wazirQwenAgent: {
          passedTasks: qwenPassed,
          failedTasks: 50 - qwenPassed,
          passRatePct: qwenPassRatePct,
          medianTurns: median(qwenResults.map((r) => r.turns)),
          meanTurns: mean(qwenResults.map((r) => r.turns)),
          medianToolCalls: median(qwenResults.map((r) => r.toolCalls)),
          meanToolCalls: mean(qwenResults.map((r) => r.toolCalls)),
          totalMalformedActions: qwenResults.reduce((s, r) => s + r.malformedActions, 0),
          verificationCommandsOnQaTasks: qwenQaResults.reduce((s, r) => s + r.verificationCommandsExecuted, 0),
          verificationCommandsOnEditTasks: qwenEditResults.reduce((s, r) => s + r.verificationCommandsExecuted, 0),
          shellSpawnsOnQaTasks: qwenQaResults.reduce((s, r) => s + r.shellSpawns, 0),
          shellSpawnsOnEditTasks: qwenEditResults.reduce((s, r) => s + r.shellSpawns, 0),
          totalWallClockMs: Number(qwenResults.reduce((s, r) => s + r.wallClockMs, 0).toFixed(2)),
          medianTaskWallClockMs: median(qwenResults.map((r) => r.wallClockMs)),
          byCategory: qwenByCategory,
        },
        legacyJsonCodingAgent: {
          passedTasks: legacyPassed,
          failedTasks: 50 - legacyPassed,
          passRatePct: legacyPassRatePct,
          medianTurns: median(legacyResults.map((r) => r.turns)),
          meanTurns: mean(legacyResults.map((r) => r.turns)),
          medianToolCalls: median(legacyResults.map((r) => r.toolCalls)),
          meanToolCalls: mean(legacyResults.map((r) => r.toolCalls)),
          totalMalformedActions: legacyResults.reduce((s, r) => s + r.malformedActions, 0),
          verificationCommandsOnQaTasks: legacyQaResults.reduce((s, r) => s + r.verificationCommandsExecuted, 0),
          verificationCommandsOnEditTasks: legacyEditResults.reduce((s, r) => s + r.verificationCommandsExecuted, 0),
          shellSpawnsOnQaTasks: legacyQaResults.reduce((s, r) => s + r.shellSpawns, 0),
          shellSpawnsOnEditTasks: legacyEditResults.reduce((s, r) => s + r.shellSpawns, 0),
          totalWallClockMs: Number(legacyResults.reduce((s, r) => s + r.wallClockMs, 0).toFixed(2)),
          medianTaskWallClockMs: median(legacyResults.map((r) => r.wallClockMs)),
          byCategory: legacyByCategory,
        },
        deltas: {
          passRateDeltaPct: Number((qwenPassRatePct - legacyPassRatePct).toFixed(2)),
          additionalTasksPassed: qwenPassed - legacyPassed,
          medianTurnsReduction: Number(
            (median(legacyResults.map((r) => r.turns)) - median(qwenResults.map((r) => r.turns))).toFixed(2),
          ),
          malformedActionsEliminated:
            legacyResults.reduce((s, r) => s + r.malformedActions, 0) -
            qwenResults.reduce((s, r) => s + r.malformedActions, 0),
        },
      },
      tasks: SIMPLE_TASKS_CORPUS.map((task, i) => ({
        id: task.id,
        category: task.category,
        title: task.title,
        wazirQwenAgent: qwenResults[i],
        legacyJsonCodingAgent: legacyResults[i],
      })),
    };

    mkdirSync(dirname(REPORT_OUTPUT_PATH), { recursive: true });
    writeFileSync(REPORT_OUTPUT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

    // Hard benchmark assertions (`A090`, `A091`):
    // 1. WazirQwenAgent achieves >= 98% (50/50 = 100%) pass rate across all 50 tasks
    const failedQwenTasks = qwenResults.filter((r) => !r.passed);
    expect(failedQwenTasks).toEqual([]);
    expect(qwenPassRatePct).toBeGreaterThanOrEqual(98);
    expect(qwenPassed).toBe(50);

    // 2. Zero unnecessary build/test/lint/typecheck OR shell spawns on the 8 read-only Q&A tasks!
    expect(report.comparison.wazirQwenAgent.verificationCommandsOnQaTasks).toBe(0);
    expect(report.comparison.wazirQwenAgent.shellSpawnsOnQaTasks).toBe(0);
    expect(qwenByCategory.read_only_qa.passedTasks).toBe(8);

    // 3. Zero malformed protocol actions on WazirQwenAgent vs documented protocol/verification failures on LegacyJsonCodingAgent
    expect(report.comparison.wazirQwenAgent.totalMalformedActions).toBe(0);
    expect(qwenPassRatePct).toBeGreaterThan(legacyPassRatePct);
    expect(legacyByCategory.read_only_qa.passedTasks).toBe(0);
    expect(report.comparison.wazirQwenAgent.medianTurns).toBeLessThan(
      report.comparison.legacyJsonCodingAgent.medianTurns,
    );

    // 4. Report file exists on disk and carries explicit epistemic mode label
    expect(existsSync(REPORT_OUTPUT_PATH)).toBe(true);
    const persistedReport = JSON.parse(readFileSync(REPORT_OUTPUT_PATH, 'utf8'));
    expect(persistedReport.mode).toBe('deterministic-simulated-runtime');
    expect(persistedReport.tasks).toHaveLength(50);
  }, 30_000);
});
