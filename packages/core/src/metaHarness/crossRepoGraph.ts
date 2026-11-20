export interface RepoNode {
  repoId: string;
  rootPath: string;
  defaultBranch?: string;
  /** IDs of upstream repositories this repo depends on. */
  dependsOn: string[];
  /** Optional package/artifact names exposed by this repo. */
  provides?: string[];
}

export interface CrossRepoWorktreePlan {
  planId: string;
  changedRepos: string[];
  /** Topological order (upstream -> downstream) for coordinated build/PR/CI. */
  executionOrder: string[];
  /** Downstream repos impacted transitively by the changed repos. */
  downstreamImpacted: string[];
  branchName: string;
}

/**
 * Synthetic monorepo dependency graph across separate repositories
 * (Nx Polygraph pattern). Indexes cross-repo dependencies, detects cycles,
 * and computes topological PR/CI validation order without merging repos.
 */
export class CrossRepoGraph {
  private readonly nodes = new Map<string, RepoNode>();

  registerRepo(node: RepoNode): void {
    this.nodes.set(node.repoId, {
      ...node,
      dependsOn: [...new Set(node.dependsOn)],
    });
  }

  getRepo(repoId: string): RepoNode | undefined {
    return this.nodes.get(repoId);
  }

  listRepos(): RepoNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Returns all repositories that transitively depend on any repo in `seedRepoIds`.
   */
  getDownstreamImpact(seedRepoIds: string[]): string[] {
    const reverseEdges = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      for (const dep of node.dependsOn) {
        const list = reverseEdges.get(dep) ?? [];
        list.push(node.repoId);
        reverseEdges.set(dep, list);
      }
    }

    const visited = new Set<string>();
    const queue = [...seedRepoIds];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const child of reverseEdges.get(curr) ?? []) {
        if (!visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }
    return [...visited];
  }

  /**
   * Computes a topological ordering (upstream before downstream) for the
   * subgraph of `targetRepoIds`. Throws if a dependency cycle exists.
   */
  topologicalOrder(targetRepoIds?: string[]): string[] {
    const subset = new Set(targetRepoIds ?? this.nodes.keys());
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const id of subset) {
      inDegree.set(id, 0);
      adj.set(id, []);
    }

    for (const id of subset) {
      const node = this.nodes.get(id);
      if (!node) continue;
      for (const dep of node.dependsOn) {
        if (!subset.has(dep)) continue;
        adj.get(dep)!.push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    queue.sort();

    const order: string[] = [];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      order.push(curr);
      for (const next of adj.get(curr) ?? []) {
        const nextDeg = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, nextDeg);
        if (nextDeg === 0) {
          queue.push(next);
          queue.sort();
        }
      }
    }

    if (order.length !== subset.size) {
      throw new Error('CrossRepoGraph contains a dependency cycle');
    }
    return order;
  }

  buildWorktreePlan(planId: string, changedRepoIds: string[], branchName: string): CrossRepoWorktreePlan {
    const downstreamImpacted = this.getDownstreamImpact(changedRepoIds);
    const allInvolved = [...new Set([...changedRepoIds, ...downstreamImpacted])];
    const executionOrder = this.topologicalOrder(allInvolved);
    return {
      planId,
      changedRepos: [...changedRepoIds],
      executionOrder,
      downstreamImpacted,
      branchName,
    };
  }
}
