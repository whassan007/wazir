export interface HarnessBranchProfile {
  branchId: string;
  /** Keywords or task-type tags this branch specializes in. */
  domainTags: string[];
  /** Task IDs uniquely solved by this branch during dev partitioning. */
  uniquelySolvedTaskIds: string[];
  /** Validation pass rate of this branch on its niche. */
  nichePassRate: number;
}

export interface TokenTrajectoryTurn {
  turnIndex: number;
  promptTokenIds: number[];
  responseTokenIds: number[];
  reward: number;
}

export interface DistillableTrajectoryRecord {
  executionId: string;
  modelId: string;
  harnessId: string;
  turns: TokenTrajectoryTurn[];
  mergedRolloutGroups: number[][];
}

/**
 * MoSIB (Mixture of Self-Improving Branches) pre-execution input router:
 * partitions dev cases to retain uniquely solved niches and routes incoming
 * tasks to the highest-affinity specialized harness branch.
 */
export class MosibBranchRouter {
  private readonly branches = new Map<string, HarnessBranchProfile>();

  registerBranch(profile: HarnessBranchProfile): void {
    this.branches.set(profile.branchId, profile);
  }

  listBranches(): HarnessBranchProfile[] {
    return [...this.branches.values()];
  }

  /**
   * Filters out universally solved tasks across all branches, returning
   * tasks uniquely solved by each branch (MoSIB adaptive subset partitioning).
   */
  partitionUniquelySolved(branchOutcomes: Record<string, Record<string, boolean>>): Record<string, string[]> {
    const branchIds = Object.keys(branchOutcomes);
    const taskIds = new Set<string>();
    for (const b of branchIds) {
      for (const t of Object.keys(branchOutcomes[b])) taskIds.add(t);
    }

    const uniqueByBranch: Record<string, string[]> = {};
    for (const b of branchIds) uniqueByBranch[b] = [];

    for (const taskId of taskIds) {
      const solvers = branchIds.filter((b) => branchOutcomes[b]?.[taskId] === true);
      if (solvers.length === 1) {
        uniqueByBranch[solvers[0]].push(taskId);
      }
    }
    return uniqueByBranch;
  }

  routeTask(taskDescription: string): HarnessBranchProfile | undefined {
    const tokens = new Set(taskDescription.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
    let best: HarnessBranchProfile | undefined;
    let bestScore = -1;

    for (const branch of this.branches.values()) {
      const tagHits = branch.domainTags.filter((tag) => tokens.has(tag.toLowerCase())).length;
      const score = tagHits * 10 + branch.nichePassRate;
      if (score > bestScore) {
        bestScore = score;
        best = branch;
      }
    }
    return best;
  }
}

/**
 * Agent Lightning v1.0 / Harness-Zero exact-token-ID trajectory exporter:
 * merges consecutive turns into a single rollout group ONLY when token IDs
 * match exactly (preventing retokenization drift in harnessed RL/distillation).
 */
export function buildExactTokenRolloutGroups(turns: TokenTrajectoryTurn[]): number[][] {
  if (turns.length === 0) return [];
  const groups: number[][] = [[turns[0].turnIndex]];

  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const curr = turns[i];
    const expectedPrefix = [...prev.promptTokenIds, ...prev.responseTokenIds];
    const exactMatch =
      curr.promptTokenIds.length >= expectedPrefix.length &&
      expectedPrefix.every((tok, idx) => curr.promptTokenIds[idx] === tok);

    if (exactMatch) {
      groups[groups.length - 1].push(curr.turnIndex);
    } else {
      groups.push([curr.turnIndex]);
    }
  }
  return groups;
}
