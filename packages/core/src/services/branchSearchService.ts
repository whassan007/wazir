import { randomUUID } from 'node:crypto';
import type {
  SolutionStrategy,
  BranchExecutionCandidate,
  BranchSearchResult,
  BranchSearchOptions,
  ExecutionRecord,
  ExecutionCheckpoint,
  EvaluationScoreReport,
} from '../types/index.js';
import type { WorktreeManager } from './worktreeManager.js';
import type { CheckpointService } from './checkpointService.js';

export interface BranchSearchServiceOptions {
  worktreeManager: WorktreeManager;
  checkpointService?: CheckpointService;
  evaluationService: {
    evaluate: (record: ExecutionRecord, options?: Record<string, unknown>) => EvaluationScoreReport;
  };
}

export class BranchSearchService {
  private readonly worktreeManager: WorktreeManager;
  private readonly checkpointService?: CheckpointService;
  private readonly evaluationService: {
    evaluate: (record: ExecutionRecord, options?: Record<string, unknown>) => EvaluationScoreReport;
  };

  constructor(options: BranchSearchServiceOptions) {
    this.worktreeManager = options.worktreeManager;
    this.checkpointService = options.checkpointService;
    this.evaluationService = options.evaluationService;
  }

  /**
   * Executes parallel/speculative branch search across solution strategies.
   * Ranks candidates purely by verification evidence and cleans up discarded branches.
   */
  public async search(params: {
    taskId: string;
    projectRoot: string;
    checkpoint?: ExecutionCheckpoint;
    strategies: SolutionStrategy[];
    runner: (
      strategy: SolutionStrategy,
      context: { worktreePath: string; branchName: string },
    ) => Promise<ExecutionRecord>;
    options?: BranchSearchOptions;
  }): Promise<BranchSearchResult> {
    const { taskId, projectRoot, checkpoint, strategies, runner, options } = params;
    const autoCleanup = options?.autoCleanupDiscarded ?? true;

    const candidates: BranchExecutionCandidate[] = [];
    const worktreesToCleanup: Array<{ worktreeDir: string; branch: string; isGit: boolean; jobId: string }> = [];

    // Execute speculative branches
    for (const strategy of strategies) {
      const branchId = `branch-${randomUUID().slice(0, 8)}`;
      let worktreePath = projectRoot;
      let branchName = `wazir/spec/${strategy.id}`;

      if (checkpoint && this.checkpointService) {
        const forkRes = await this.checkpointService.fork(checkpoint.id, branchId);
        worktreePath = forkRes.forkedWorktreePath;
        branchName = forkRes.branch;
        worktreesToCleanup.push({
          worktreeDir: worktreePath,
          branch: branchName,
          isGit: false,
          jobId: `job-${branchId}`,
        });
      } else {
        const info = await this.worktreeManager.createWorktree(projectRoot, `job-${branchId}`, branchId);
        worktreePath = info.worktreeDir;
        branchName = info.branch;
        worktreesToCleanup.push(info);
      }

      try {
        const record = await runner(strategy, { worktreePath, branchName });
        const scoreReport = this.evaluationService.evaluate(record, {
          taskId,
          projectRoot: worktreePath,
          requirePhysicalVerification: true,
        });

        candidates.push({
          branchId,
          strategy,
          executionRecord: record,
          scoreReport,
          worktreePath,
          branchName,
        });
      } catch (err) {
        // Disqualified failing branch
      }
    }

    // Rank candidates by physical verification evidence, then efficiency
    const ranked = [...candidates].sort((a, b) => {
      // 1. Task + Physical verification passed
      if (a.scoreReport.passed !== b.scoreReport.passed) {
        return a.scoreReport.passed ? -1 : 1;
      }
      if (a.scoreReport.metrics.physicalVerificationSuccess !== b.scoreReport.metrics.physicalVerificationSuccess) {
        return a.scoreReport.metrics.physicalVerificationSuccess ? -1 : 1;
      }

      // 2. Fewer repair cycles
      if (a.scoreReport.metrics.repairCycles !== b.scoreReport.metrics.repairCycles) {
        return a.scoreReport.metrics.repairCycles - b.scoreReport.metrics.repairCycles;
      }

      // 3. Fewer tool calls
      if (a.scoreReport.metrics.totalToolCalls !== b.scoreReport.metrics.totalToolCalls) {
        return a.scoreReport.metrics.totalToolCalls - b.scoreReport.metrics.totalToolCalls;
      }

      // 4. Lower cost
      if (a.scoreReport.metrics.costEstimateUsd !== b.scoreReport.metrics.costEstimateUsd) {
        return a.scoreReport.metrics.costEstimateUsd - b.scoreReport.metrics.costEstimateUsd;
      }

      // 5. Faster wall time
      return a.scoreReport.metrics.totalWallTimeMs - b.scoreReport.metrics.totalWallTimeMs;
    });

    const winningBranch = ranked.find((c) => c.scoreReport.passed && c.scoreReport.metrics.physicalVerificationSuccess);
    const discardedBranchIds: string[] = [];

    // Cleanup discarded branches
    for (const c of candidates) {
      if (!winningBranch || c.branchId !== winningBranch.branchId) {
        discardedBranchIds.push(c.branchId);
        if (autoCleanup) {
          const wt = worktreesToCleanup.find((w) => w.worktreeDir === c.worktreePath);
          if (wt) {
            await this.worktreeManager.removeWorktree(wt as any).catch(() => {});
          }
        }
      }
    }

    let selectionReason = 'No candidate branch passed physical verification';
    if (winningBranch) {
      selectionReason = `Selected branch '${winningBranch.branchId}' (${winningBranch.strategy.name}) based on verified evidence: ` +
        `checks pass, ${winningBranch.scoreReport.metrics.totalToolCalls} tool calls, ${winningBranch.scoreReport.metrics.repairCycles} repair cycles, $${winningBranch.scoreReport.metrics.costEstimateUsd.toFixed(4)}`;
    }

    return {
      taskId,
      totalBranches: strategies.length,
      winningBranch,
      rankedCandidates: ranked,
      discardedBranchIds,
      selectionReason,
    };
  }
}
