import { describe, expect, it } from 'vitest';
import { MemoryService } from '../src/index.js';

describe('Gate 8: Episodic & Procedural Memory Subsystem', () => {
  it('records episodic memories and queries them scoped to repository and task context', () => {
    const memory = new MemoryService();

    const episode1 = memory.recordEpisode({
      repositoryScope: 'github.com/org/repo-a',
      taskType: 'build_fix',
      taskPrompt: 'Fix typescript compilation error TS2339 in worktreeManager.ts',
      executionId: 'exec-1',
      attemptOutcome: 'failure',
      failurePattern: 'TS2339: Property cleanupDirectory does not exist',
      repairStrategy: 'Define cleanupDirectory on WorktreeManager class',
      filesInvolved: ['packages/core/src/services/worktreeManager.ts'],
      workspaceRevision: 1,
    });

    expect(episode1.id).toMatch(/^epi-/);
    expect(episode1.valid).toBe(true);

    const episode2 = memory.recordEpisode({
      repositoryScope: 'github.com/org/repo-b',
      taskType: 'build_fix',
      taskPrompt: 'Fix python indentation in worker.py',
      executionId: 'exec-2',
      attemptOutcome: 'success',
      filesInvolved: ['src/worker.py'],
      workspaceRevision: 3,
    });

    // Query scoped to repo-a
    const queryA = memory.queryEpisodic({
      repositoryScope: 'github.com/org/repo-a',
      queryText: 'TS2339 cleanupDirectory',
    });
    expect(queryA).toHaveLength(1);
    expect(queryA[0]?.id).toBe(episode1.id);
    expect(queryA[0]?.repairStrategy).toContain('cleanupDirectory');

    // Repo-b query returns only episode2
    const queryB = memory.queryEpisodic({
      repositoryScope: 'github.com/org/repo-b',
    });
    expect(queryB).toHaveLength(1);
    expect(queryB[0]?.id).toBe(episode2.id);
  });

  it('records verified procedural recipes and matches them by kind and trigger pattern', () => {
    const memory = new MemoryService();

    const proc = memory.recordProcedure({
      repositoryScope: 'github.com/org/wazir',
      kind: 'build',
      name: 'Standalone CLI bundling recipe',
      triggerPattern: 'bundle executable bin/wa.js',
      recipe: {
        command: 'node scripts/bundle.mjs',
        steps: ['Run esbuild on apps/cli/src/index.ts', 'Mark chmod +x on bin/wa.js'],
      },
      associatedFiles: ['scripts/bundle.mjs', 'apps/cli/src/index.ts'],
      verifiedByEvidenceId: 'evi-build-success-42',
    });

    expect(proc.id).toMatch(/^proc-/);
    expect(proc.kind).toBe('build');

    const matched = memory.queryProcedural({
      repositoryScope: 'github.com/org/wazir',
      trigger: 'bundle executable',
    });

    expect(matched).toHaveLength(1);
    expect(matched[0]?.name).toBe('Standalone CLI bundling recipe');
    expect(matched[0]?.recipe.command).toBe('node scripts/bundle.mjs');
  });

  it('invalidates episodic and procedural memories when associated files mutate', () => {
    const memory = new MemoryService();

    const episode = memory.recordEpisode({
      repositoryScope: 'github.com/org/wazir',
      taskType: 'refactor',
      taskPrompt: 'Refactor store file locking',
      executionId: 'exec-lock-1',
      attemptOutcome: 'success',
      filesInvolved: ['packages/shared/src/store.ts'],
      workspaceRevision: 10,
    });

    const procedure = memory.recordProcedure({
      repositoryScope: 'github.com/org/wazir',
      kind: 'test',
      name: 'Run store tests',
      triggerPattern: 'store unit tests',
      recipe: {
        command: 'npx vitest run packages/shared/tests/store.test.ts',
      },
      associatedFiles: ['packages/shared/src/store.ts'],
    });

    expect(episode.valid).toBe(true);
    expect(procedure.valid).toBe(true);

    // Invalidate due to mutation in store.ts
    const invalidation = memory.invalidateOnMutation('github.com/org/wazir', [
      'packages/shared/src/store.ts',
    ]);

    expect(invalidation.invalidatedEpisodes).toBe(1);
    expect(invalidation.invalidatedProcedures).toBe(1);

    // Default queries with onlyValid: true should return empty
    const epQuery = memory.queryEpisodic({ repositoryScope: 'github.com/org/wazir' });
    expect(epQuery).toHaveLength(0);

    const procQuery = memory.queryProcedural({ repositoryScope: 'github.com/org/wazir' });
    expect(procQuery).toHaveLength(0);

    // Querying with onlyValid: false includes the invalidated memories
    const epQueryAll = memory.queryEpisodic({
      repositoryScope: 'github.com/org/wazir',
      onlyValid: false,
    });
    expect(epQueryAll).toHaveLength(1);
    expect(epQueryAll[0]?.valid).toBe(false);
  });
});
