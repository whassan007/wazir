import { randomUUID, createHash } from 'node:crypto';

export interface EpisodicRecord {
  id: string;
  repositoryScope: string;
  taskType: string;
  taskPrompt: string;
  executionId: string;
  attemptOutcome: 'success' | 'failure';
  failurePattern?: string;
  repairStrategy?: string;
  verificationEvidenceId?: string;
  filesInvolved: string[];
  workspaceRevision: number;
  fingerprint?: string;
  createdAt: Date;
  valid: boolean;
  metadata?: Record<string, unknown>;
}

export type ProcedureKind = 'build' | 'test' | 'lint' | 'tool_recipe' | 'repo_quirk';

export interface ProceduralRecipe {
  id: string;
  repositoryScope: string;
  kind: ProcedureKind;
  name: string;
  triggerPattern: string;
  recipe: {
    command?: string;
    steps?: string[];
    expectedOutputPattern?: string;
    workaroundNotes?: string;
  };
  verifiedByEvidenceId?: string;
  associatedFiles: string[];
  associatedFileHash?: string;
  createdAt: Date;
  lastUsedAt: Date;
  valid: boolean;
  metadata?: Record<string, unknown>;
}

export interface EpisodicQueryOptions {
  repositoryScope: string;
  taskType?: string;
  queryText?: string;
  file?: string;
  onlyValid?: boolean;
  limit?: number;
}

export interface ProceduralQueryOptions {
  repositoryScope: string;
  kind?: ProcedureKind;
  trigger?: string;
  file?: string;
  onlyValid?: boolean;
  limit?: number;
}

export class MemoryService {
  private readonly episodes = new Map<string, EpisodicRecord>();
  private readonly procedures = new Map<string, ProceduralRecipe>();

  /**
   * Records an episodic memory of a past run, failure, repair attempt, and outcome.
   */
  public recordEpisode(
    params: Omit<EpisodicRecord, 'id' | 'createdAt' | 'valid'> & {
      valid?: boolean;
    },
  ): EpisodicRecord {
    if (!params.repositoryScope) {
      throw new Error('repositoryScope is required for episodic memory');
    }

    const id = `epi-${randomUUID()}`;
    const episode: EpisodicRecord = {
      id,
      repositoryScope: params.repositoryScope,
      taskType: params.taskType,
      taskPrompt: params.taskPrompt,
      executionId: params.executionId,
      attemptOutcome: params.attemptOutcome,
      failurePattern: params.failurePattern,
      repairStrategy: params.repairStrategy,
      verificationEvidenceId: params.verificationEvidenceId,
      filesInvolved: [...params.filesInvolved],
      workspaceRevision: params.workspaceRevision,
      fingerprint: params.fingerprint ?? this.hashFiles(params.filesInvolved),
      createdAt: new Date(),
      valid: params.valid ?? true,
      metadata: params.metadata,
    };

    this.episodes.set(id, episode);
    return episode;
  }

  /**
   * Records a verified procedural memory (build command, test pattern, tool recipe, repo quirk).
   */
  public recordProcedure(
    params: Omit<ProceduralRecipe, 'id' | 'createdAt' | 'lastUsedAt' | 'valid'> & {
      valid?: boolean;
    },
  ): ProceduralRecipe {
    if (!params.repositoryScope) {
      throw new Error('repositoryScope is required for procedural memory');
    }

    const id = `proc-${randomUUID()}`;
    const now = new Date();
    const recipe: ProceduralRecipe = {
      id,
      repositoryScope: params.repositoryScope,
      kind: params.kind,
      name: params.name,
      triggerPattern: params.triggerPattern,
      recipe: params.recipe,
      verifiedByEvidenceId: params.verifiedByEvidenceId,
      associatedFiles: [...params.associatedFiles],
      associatedFileHash: params.associatedFileHash ?? this.hashFiles(params.associatedFiles),
      createdAt: now,
      lastUsedAt: now,
      valid: params.valid ?? true,
      metadata: params.metadata,
    };

    this.procedures.set(id, recipe);
    return recipe;
  }

  /**
   * Queries episodic memories scoped to a repository and task context.
   */
  public queryEpisodic(options: EpisodicQueryOptions): EpisodicRecord[] {
    const onlyValid = options.onlyValid ?? true;
    let list = Array.from(this.episodes.values()).filter(
      (e) => e.repositoryScope === options.repositoryScope,
    );

    if (onlyValid) {
      list = list.filter((e) => e.valid);
    }

    if (options.taskType) {
      list = list.filter((e) => e.taskType === options.taskType);
    }

    if (options.file) {
      const target = options.file.replace(/\\/g, '/');
      list = list.filter((e) =>
        e.filesInvolved.some((f) => f.replace(/\\/g, '/') === target),
      );
    }

    if (options.queryText) {
      const qTokens = options.queryText.toLowerCase().split(/\s+/).filter(Boolean);
      list.sort((a, b) => {
        const scoreA = this.scoreMatch(a.taskPrompt + ' ' + (a.failurePattern ?? '') + ' ' + (a.repairStrategy ?? ''), qTokens);
        const scoreB = this.scoreMatch(b.taskPrompt + ' ' + (b.failurePattern ?? '') + ' ' + (b.repairStrategy ?? ''), qTokens);
        return scoreB - scoreA;
      });
    }

    const limit = options.limit ?? 10;
    return list.slice(0, limit);
  }

  /**
   * Queries procedural recipes scoped to a repository and trigger/kind.
   */
  public queryProcedural(options: ProceduralQueryOptions): ProceduralRecipe[] {
    const onlyValid = options.onlyValid ?? true;
    let list = Array.from(this.procedures.values()).filter(
      (p) => p.repositoryScope === options.repositoryScope,
    );

    if (onlyValid) {
      list = list.filter((p) => p.valid);
    }

    if (options.kind) {
      list = list.filter((p) => p.kind === options.kind);
    }

    if (options.file) {
      const target = options.file.replace(/\\/g, '/');
      list = list.filter((p) =>
        p.associatedFiles.some((f) => f.replace(/\\/g, '/') === target),
      );
    }

    if (options.trigger) {
      const lower = options.trigger.toLowerCase();
      list = list.filter(
        (p) =>
          p.triggerPattern.toLowerCase().includes(lower) ||
          p.name.toLowerCase().includes(lower),
      );
    }

    const now = new Date();
    for (const item of list) {
      item.lastUsedAt = now;
    }

    const limit = options.limit ?? 10;
    return list.slice(0, limit);
  }

  /**
   * Automatically invalidates episodic and procedural memories when associated
   * files or dependencies mutate, preventing stale memory contamination.
   */
  public invalidateOnMutation(
    repositoryScope: string,
    changedFiles: string[],
  ): { invalidatedEpisodes: number; invalidatedProcedures: number } {
    const normalizedChanged = new Set(changedFiles.map((f) => f.replace(/\\/g, '/')));
    let invalidatedEpisodes = 0;
    let invalidatedProcedures = 0;

    // Check episodes
    for (const episode of this.episodes.values()) {
      if (episode.repositoryScope === repositoryScope && episode.valid) {
        const overlaps = episode.filesInvolved.some((f) =>
          normalizedChanged.has(f.replace(/\\/g, '/')),
        );
        if (overlaps) {
          episode.valid = false;
          invalidatedEpisodes += 1;
        }
      }
    }

    // Check procedures
    for (const procedure of this.procedures.values()) {
      if (procedure.repositoryScope === repositoryScope && procedure.valid) {
        const overlaps = procedure.associatedFiles.some((f) =>
          normalizedChanged.has(f.replace(/\\/g, '/')),
        );
        if (overlaps) {
          procedure.valid = false;
          invalidatedProcedures += 1;
        }
      }
    }

    return { invalidatedEpisodes, invalidatedProcedures };
  }

  private hashFiles(files: string[]): string {
    return createHash('sha256').update(files.sort().join(';')).digest('hex');
  }

  private scoreMatch(text: string, tokens: string[]): number {
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (lower.includes(t)) score += 1;
    }
    return score;
  }
}
