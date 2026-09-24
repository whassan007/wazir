import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  BenchmarkTask,
  BenchmarkTaskCategory,
  BenchmarkRunner,
  BenchmarkRunResult,
  BenchmarkSuiteResult,
  ComparativeBenchmarkResult,
  BenchmarkExecutionContext,
} from '@wazir/core';
import { EvaluationService } from './evaluationService.js';

export const BENCHMARK_CATEGORIES: BenchmarkTaskCategory[] = [
  'CODE_REPAIR',
  'FEATURE_IMPLEMENTATION',
  'REPOSITORY_NAVIGATION',
  'CODE_INTELLIGENCE',
  'TOOL_USE',
  'CONTEXT_STRESS',
  'RECOVERY',
];

export class BenchmarkService {
  private readonly tasks = new Map<string, BenchmarkTask>();

  constructor(
    private readonly evaluationService: EvaluationService = new EvaluationService(),
  ) {
    this.registerCanonicalTasks();
  }

  /**
   * Registers a single benchmark task.
   */
  public register(task: BenchmarkTask): void {
    this.tasks.set(task.id, task);
  }

  /**
   * Registers an array of benchmark tasks.
   */
  public registerSuite(category: BenchmarkTaskCategory, tasks: BenchmarkTask[]): void {
    for (const task of tasks) {
      if (task.category !== category) {
        throw new Error(
          `Task ${task.id} category '${task.category}' does not match suite category '${category}'`,
        );
      }
      this.register(task);
    }
  }

  /**
   * Retrieves a registered task by ID.
   */
  public getTask(id: string): BenchmarkTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Lists registered benchmark tasks, optionally filtered by category.
   */
  public listTasks(category?: BenchmarkTaskCategory): BenchmarkTask[] {
    const all = Array.from(this.tasks.values());
    if (!category) return all;
    return all.filter((t) => t.category === category);
  }

  /**
   * Runs a single benchmark task under controlled conditions and scores the result
   * using EvaluationService.
   */
  public async runTask(
    taskId: string,
    runner: BenchmarkRunner,
    customContext?: Partial<BenchmarkExecutionContext>,
  ): Promise<BenchmarkRunResult> {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Benchmark task '${taskId}' not found`);
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `wazir-bench-${task.id}-`));
    const timeoutMs = customContext?.timeoutMs ?? task.timeoutMs ?? 60_000;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

    const context: BenchmarkExecutionContext = {
      workspaceRoot: customContext?.workspaceRoot ?? tempDir,
      timeoutMs,
      abortSignal: abortController.signal,
    };

    const startTime = Date.now();
    try {
      // 1. Run workspace setup if specified
      if (task.workspaceSetup) {
        await task.workspaceSetup(context.workspaceRoot);
      }

      // 2. Execute runner under controlled conditions
      const record = await runner.run(task, context);

      // 3. Clear timeout
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;

      // 4. Score execution using EvaluationService (strictly separated from runner execution)
      const scoreReport = this.evaluationService.evaluate(record, {
        expectedFiles: task.expectedFiles,
        expectedEvidence: task.expectedEvidence,
        protectedFiles: task.protectedFiles,
        mutationRequired: task.mutationRequired,
        acceptanceContract: task.acceptanceContract,
        projectRoot: context.workspaceRoot,
        category: task.category,
        taskId: task.id,
      });

      return {
        taskId: task.id,
        taskName: task.name,
        category: task.category,
        runnerId: runner.id,
        scoreReport,
        durationMs,
      };
    } catch (err) {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Construct a synthetic failing execution record for scoring
      const syntheticReport = this.evaluationService.evaluate(
        {
          execution: {
            id: `err-${task.id}-${Date.now()}`,
            taskId: task.id,
            runtimeId: 'unknown',
            modelId: 'unknown',
            status: 'failed',
            createdAt: new Date(startTime),
            completedAt: new Date(),
          },
          task: {
            id: task.id,
            type: 'benchmark',
            title: task.name,
            input: task.prompt,
            requirements: {},
            priority: 'normal',
            status: 'failed',
            createdAt: new Date(startTime),
          },
          policyDecisions: [],
          toolCalls: [],
          filesChanged: [],
          checks: [],
          errors: [errorMsg],
          events: [],
        },
        {
          category: task.category,
          taskId: task.id,
          projectRoot: context.workspaceRoot,
        },
      );

      return {
        taskId: task.id,
        taskName: task.name,
        category: task.category,
        runnerId: runner.id,
        scoreReport: syntheticReport,
        durationMs,
        error: errorMsg,
      };
    } finally {
      // Clean up temp directory if we created it
      if (!customContext?.workspaceRoot) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Runs an entire suite of benchmark tasks for a given category.
   */
  public async runSuite(
    category: BenchmarkTaskCategory,
    runner: BenchmarkRunner,
  ): Promise<BenchmarkSuiteResult> {
    const tasks = this.listTasks(category);
    const results: BenchmarkRunResult[] = [];

    for (const task of tasks) {
      const res = await this.runTask(task.id, runner);
      results.push(res);
    }

    const passedTasks = results.filter((r) => r.scoreReport.passed).length;
    const failedTasks = results.length - passedTasks;

    let totalWallTimeMs = 0;
    let totalModelCalls = 0;
    let totalToolCalls = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let totalRepairCycles = 0;

    for (const r of results) {
      const m = r.scoreReport.metrics;
      totalWallTimeMs += m.totalWallTimeMs;
      totalModelCalls += m.totalModelCalls;
      totalToolCalls += m.totalToolCalls;
      totalTokens += m.inputTokens + m.outputTokens;
      totalCostUsd += m.costEstimateUsd;
      totalRepairCycles += m.repairCycles;
    }

    const aggregateMetrics = {
      totalWallTimeMs,
      totalModelCalls,
      totalToolCalls,
      totalTokens,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      averageRepairCycles: tasks.length > 0 ? totalRepairCycles / tasks.length : 0,
    };

    const summary = [
      `=== Benchmark Suite: ${category} ===`,
      `Runner: ${runner.name} (${runner.id})`,
      `Tasks: ${passedTasks}/${results.length} passed (${failedTasks} failed)`,
      `Total Tokens: ${totalTokens} | Total Cost: $${totalCostUsd.toFixed(4)}`,
      `Total Wall Time: ${totalWallTimeMs}ms | Avg Repair Cycles: ${aggregateMetrics.averageRepairCycles.toFixed(2)}`,
    ].join('\n');

    return {
      category,
      runnerId: runner.id,
      totalTasks: results.length,
      passedTasks,
      failedTasks,
      results,
      aggregateMetrics,
      summary,
    };
  }

  /**
   * Runs comparative evaluation between a baseline runner and a candidate runner
   * on a specific task.
   */
  public async runComparative(
    taskId: string,
    baselineRunner: BenchmarkRunner,
    candidateRunner: BenchmarkRunner,
  ): Promise<ComparativeBenchmarkResult> {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Benchmark task '${taskId}' not found`);
    }

    const baselineResult = await this.runTask(taskId, baselineRunner);
    const candidateResult = await this.runTask(taskId, candidateRunner);

    const comparison = this.evaluationService.compare(
      baselineResult.scoreReport,
      candidateResult.scoreReport,
    );

    return {
      taskId,
      category: task.category,
      baseline: baselineResult,
      candidate: candidateResult,
      comparison,
    };
  }

  /**
   * Registers canonical tasks covering all 7 benchmark categories.
   */
  private registerCanonicalTasks(): void {
    // 1. CODE_REPAIR
    this.register({
      id: 'repair-failing-math-test',
      name: 'Repair Failing Math Utility',
      category: 'CODE_REPAIR',
      description: 'Fix a broken division utility that fails with DivideByZero error on zero input.',
      prompt: 'Fix the divide function in src/math.ts so it returns null when dividing by zero.',
      expectedFiles: ['src/math.ts'],
      mutationRequired: true,
      acceptanceContract: {
        taskType: 'CODE_REPAIR',
        requiredEvidence: ['TEST'],
      },
      workspaceSetup: async (root) => {
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'src/math.ts'),
          'export function divide(a: number, b: number): number | null {\n  return a / b;\n}\n',
        );
      },
    });

    // 2. FEATURE_IMPLEMENTATION
    this.register({
      id: 'feature-lru-cache',
      name: 'Implement LRU Cache',
      category: 'FEATURE_IMPLEMENTATION',
      description: 'Implement a thread-safe LRU Cache with capacity limit and eviction.',
      prompt: 'Implement LRUCache in src/lru.ts with get(k), put(k, v), and capacity.',
      expectedFiles: ['src/lru.ts'],
      mutationRequired: true,
      acceptanceContract: {
        taskType: 'FEATURE_IMPLEMENTATION',
        requiredEvidence: ['BUILD', 'TEST'],
      },
      workspaceSetup: async (root) => {
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'src/lru.ts'),
          'export class LRUCache<K, V> {\n  constructor(public readonly capacity: number) {}\n}\n',
        );
      },
    });

    // 3. REPOSITORY_NAVIGATION
    this.register({
      id: 'nav-symbol-references',
      name: 'Locate Symbol Usages',
      category: 'REPOSITORY_NAVIGATION',
      description: 'Find all usages and callers of LoggerService across the repository.',
      prompt: 'Find all call sites of LoggerService.warn and report them in findings.md.',
      expectedFiles: ['findings.md'],
      mutationRequired: true,
      workspaceSetup: async (root) => {
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'src/logger.ts'),
          'export class LoggerService { warn(msg: string) {} }\n',
        );
        await fs.writeFile(
          path.join(root, 'src/consumer.ts'),
          'import { LoggerService } from "./logger.js";\nnew LoggerService().warn("test");\n',
        );
      },
    });

    // 4. CODE_INTELLIGENCE
    this.register({
      id: 'intel-dependency-cycles',
      name: 'Detect Dependency Cycles',
      category: 'CODE_INTELLIGENCE',
      description: 'Query the symbol graph to identify circular imports between modules.',
      prompt: 'Analyze import cycles between src/a.ts, src/b.ts, and src/c.ts and report resolution.',
      expectedFiles: ['analysis.json'],
      mutationRequired: true,
      workspaceSetup: async (root) => {
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(path.join(root, 'src/a.ts'), 'import "./b.js";\n');
        await fs.writeFile(path.join(root, 'src/b.ts'), 'import "./c.js";\n');
        await fs.writeFile(path.join(root, 'src/c.ts'), 'import "./a.js";\n');
      },
    });

    // 5. TOOL_USE
    this.register({
      id: 'tool-batch-file-audit',
      name: 'Batch File Audit via Code Mode',
      category: 'TOOL_USE',
      description: 'Inspect 10 configuration files and compute an audit checksum in a single turn.',
      prompt: 'Read all configs in config/*.json and output audit.json containing file hash map.',
      expectedFiles: ['audit.json'],
      mutationRequired: true,
      workspaceSetup: async (root) => {
        const cfgDir = path.join(root, 'config');
        await fs.mkdir(cfgDir, { recursive: true });
        for (let i = 1; i <= 10; i++) {
          await fs.writeFile(
            path.join(cfgDir, `env.${i}.json`),
            JSON.stringify({ port: 3000 + i, enabled: true }),
          );
        }
      },
    });

    // 6. CONTEXT_STRESS
    this.register({
      id: 'stress-large-repository-context',
      name: 'Large Context Compilation & Compaction',
      category: 'CONTEXT_STRESS',
      description: 'Test context compiler and compaction under 100+ files and 200k token context budget.',
      prompt: 'Perform refactoring across multiple files with deep dependency chains within budget.',
      expectedFiles: ['src/index.ts'],
      mutationRequired: true,
      workspaceSetup: async (root) => {
        const srcDir = path.join(root, 'src');
        await fs.mkdir(srcDir, { recursive: true });
        await fs.writeFile(path.join(srcDir, 'index.ts'), '// root index\n');
        for (let i = 0; i < 20; i++) {
          await fs.writeFile(
            path.join(srcDir, `module_${i}.ts`),
            `export const value_${i} = ${i};\n`,
          );
        }
      },
    });

    // 7. RECOVERY
    this.register({
      id: 'recovery-broken-syntax',
      name: 'Recover From Broken Syntax',
      category: 'RECOVERY',
      description: 'Agent encounters a syntax error during tool run, detects failure, and repairs code.',
      prompt: 'Fix the syntax error in src/broken.ts so that build passes cleanly.',
      expectedFiles: ['src/broken.ts'],
      mutationRequired: true,
      acceptanceContract: {
        taskType: 'RECOVERY',
        requiredEvidence: ['BUILD'],
      },
      workspaceSetup: async (root) => {
        await fs.mkdir(path.join(root, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'src/broken.ts'),
          'export function broken( { return 42; }\n',
        );
      },
    });
  }
}
