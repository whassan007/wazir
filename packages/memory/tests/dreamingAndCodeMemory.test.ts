import { describe, it, expect } from 'vitest';
import { MemoryDreamer, CodeMemoryIndex } from '../src/index.js';
import type { EpisodicRecord } from '../src/memoryService.js';

describe('MemoryDreamer & CodeMemoryIndex', () => {
  it('consolidates episodic records into semantic facts and supersedes older facts', () => {
    const dreamer = new MemoryDreamer();
    const ep1: EpisodicRecord = {
      id: 'epi-1',
      repositoryScope: 'org/repo',
      taskType: 'bugfix',
      taskPrompt: 'fix vitest timeout',
      executionId: 'exec-1',
      attemptOutcome: 'success',
      repairStrategy: 'increase_hook_timeout',
      filesInvolved: ['tests/a.test.ts'],
      workspaceRevision: 1,
      createdAt: new Date(),
      valid: true,
    };

    const r1 = dreamer.consolidate([ep1], 'org/repo');
    expect(r1.consolidatedFacts).toHaveLength(1);
    expect(r1.consolidatedFacts[0].confidence).toBe(1);

    const ep2: EpisodicRecord = { ...ep1, id: 'epi-2', executionId: 'exec-2', attemptOutcome: 'failure' };
    const r2 = dreamer.consolidate([ep1, ep2], 'org/repo');
    expect(r2.supersededFactIds).toHaveLength(1);
    expect(dreamer.listFacts('org/repo')).toHaveLength(1);
    expect(dreamer.listFacts('org/repo')[0].confidence).toBe(0.5);
  });

  it('links code line ranges to originating agent execution and rejected alternatives', () => {
    const index = new CodeMemoryIndex();
    index.recordProvenance({
      repositoryScope: 'org/repo',
      filePath: 'src/retry.ts',
      startLine: 10,
      endLine: 25,
      executionId: 'exec-99',
      taskPrompt: 'Add exponential backoff',
      rationale: 'Preserves 50ms jitter to avoid thundering herd on local Ollama',
      rejectedAlternatives: ['fixed 10ms sleep'],
    });

    const hits = index.queryByLocation('org/repo', 'src/retry.ts', 15, 18);
    expect(hits).toHaveLength(1);
    expect(hits[0].executionId).toBe('exec-99');
    expect(hits[0].rejectedAlternatives).toContain('fixed 10ms sleep');
  });
});
