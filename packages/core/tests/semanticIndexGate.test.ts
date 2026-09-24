import { describe, expect, it } from 'vitest';
import { SemanticIndexService } from '../src/services/semanticIndexService.js';
import { DeterministicLocalEmbeddingProvider } from '../src/services/embeddingProvider.js';
import { SymbolGraph } from '../src/services/symbolGraph.js';
import type { EpisodicRecord, ProceduralRecipe } from '@wazir/memory';

describe('Gate 16: Semantic Code & Memory Retrieval', () => {
  it('locates conceptually related code where exact symbol or filename does not match', async () => {
    const embeddingProvider = new DeterministicLocalEmbeddingProvider({ dimensions: 64 });
    const symbolGraph = new SymbolGraph();

    // Register a symbol in symbolGraph
    symbolGraph.addNode({
      id: 'sym-reconcile-state',
      name: 'synchronizeReplicationState',
      kind: 'function',
      file: 'packages/core/src/stateReplicationEngine.ts',
      range: { start: { line: 10, character: 0 }, end: { line: 30, character: 1 } },
    });

    const index = new SemanticIndexService({
      embeddingProvider,
      defaultRepositoryScope: 'github.com/whassan007/wazir',
      symbolGraph,
    });

    // File 1: stateReplicationEngine.ts (conceptually handles distributed consensus / state syncing)
    const file1Content = `
      export async function synchronizeReplicationState(primaryNode: string, replicas: string[]): Promise<boolean> {
        // Enforces distributed consensus across replica clusters
        // Handles partition recovery, leader election quorum, and catch-up logs
        return true;
      }
    `;

    // File 2: imageOptimizer.ts (completely unrelated)
    const file2Content = `
      export function compressWebpImages(buffer: Buffer, quality: number): Buffer {
        // Compresses bitmap buffers into modern WebP format for fast web delivery
        return buffer;
      }
    `;

    await index.updateFile('packages/core/src/stateReplicationEngine.ts', file1Content, 1);
    await index.updateFile('packages/media/src/imageOptimizer.ts', file2Content, 1);

    expect(index.getUnitCount()).toBeGreaterThanOrEqual(2);

    // Query conceptually asks for "distributed quorum consensus cluster leader partition"
    // Neither "quorum" nor "partition" appears in the filename or symbol name!
    const results = await index.search({
      query: 'distributed quorum consensus cluster leader partition',
      repositoryScope: 'github.com/whassan007/wazir',
      activeSymbols: ['synchronizeReplicationState'],
    });

    expect(results.length).toBeGreaterThan(0);
    const topResult = results[0];
    expect(topResult.unit.path).toBe('packages/core/src/stateReplicationEngine.ts');
    expect(topResult.score).toBeGreaterThan(0.2);

    // Assert hybrid ranking exposes transparent component scores
    expect(topResult.breakdown.embeddingScore).toBeGreaterThan(0);
    expect(topResult.breakdown.lexicalScore).toBeGreaterThan(0);
    expect(topResult.breakdown.astScore).toBeGreaterThan(0);
    expect(topResult.breakdown.totalScore).toBe(topResult.score);
  });

  it('incrementally re-indexes on mutation and removes deleted files', async () => {
    const embeddingProvider = new DeterministicLocalEmbeddingProvider();
    const index = new SemanticIndexService({
      embeddingProvider,
      defaultRepositoryScope: 'github.com/whassan007/wazir',
    });

    const originalContent = `
      export function allocateGpuMemory(megabytes: number) {
        // Reserves dedicated VRAM on CUDA device
      }
    `;

    await index.updateFile('packages/compute/gpuAllocator.ts', originalContent, 1);
    const search1 = await index.search({
      query: 'VRAM CUDA allocation device',
      repositoryScope: 'github.com/whassan007/wazir',
    });
    expect(search1).toHaveLength(2); // module + function
    expect(search1[0].unit.path).toBe('packages/compute/gpuAllocator.ts');

    // 1. Same content hash -> no re-indexing work
    const unchanged = await index.updateFile('packages/compute/gpuAllocator.ts', originalContent, 1);
    expect(unchanged.updated).toBe(false);
    expect(unchanged.unitsIndexed).toBe(0);

    // 2. Mutated file -> re-indexes with new content
    const mutatedContent = `
      export function allocateCpuRam(megabytes: number) {
        // Reserves standard system RAM on host CPU
      }
    `;
    const mutated = await index.updateFile('packages/compute/gpuAllocator.ts', mutatedContent, 2);
    expect(mutated.updated).toBe(true);

    const search2 = await index.search({
      query: 'VRAM CUDA allocation device',
      repositoryScope: 'github.com/whassan007/wazir',
    });
    // The old GPU / CUDA function should no longer match strongly
    const oldFunc = search2.find((r) => r.unit.symbolName === 'allocateGpuMemory');
    expect(oldFunc).toBeUndefined();

    // 3. Deletion removes all semantic units
    index.deleteFile('packages/compute/gpuAllocator.ts');
    const searchDeleted = await index.search({
      query: 'CPU RAM allocation',
      repositoryScope: 'github.com/whassan007/wazir',
    });
    expect(searchDeleted).toHaveLength(0);
  });

  it('indexes episodic and procedural memories and enforces that similarity never promotes unverified episodes', async () => {
    const embeddingProvider = new DeterministicLocalEmbeddingProvider();
    const index = new SemanticIndexService({
      embeddingProvider,
      defaultRepositoryScope: 'github.com/whassan007/wazir',
    });

    // An unverified failure episode
    const failureEpisode: EpisodicRecord = {
      id: 'epi-timeout-fail-1',
      repositoryScope: 'github.com/whassan007/wazir',
      taskType: 'db_migration',
      taskPrompt: 'Apply schema migration to postgres cluster',
      executionId: 'exec-db-fail',
      attemptOutcome: 'failure',
      failurePattern: 'Lock timeout acquired on table accounts during migration',
      repairStrategy: 'Set lock_timeout = 2s and retry during off-peak hours',
      filesInvolved: ['migrations/001_accounts.sql'],
      workspaceRevision: 4,
      createdAt: new Date(),
      valid: true,
    };

    // A verified procedural recipe
    const verifiedRecipe: ProceduralRecipe = {
      id: 'proc-db-migration-verified',
      repositoryScope: 'github.com/whassan007/wazir',
      kind: 'tool_recipe',
      name: 'Safe Zero-Downtime Migration',
      triggerPattern: 'postgres migration table lock timeout',
      recipe: {
        command: 'npm run migrate:safe',
        steps: ['Set statement_timeout = 5s', 'Create index concurrently'],
      },
      verifiedByEvidenceId: 'evi-verified-mig-99',
      associatedFiles: ['migrations/001_accounts.sql'],
      createdAt: new Date(),
      lastUsedAt: new Date(),
      valid: true,
    };

    await index.indexEpisodicRecord(failureEpisode);
    await index.indexProceduralRecipe(verifiedRecipe);

    // Query for table lock timeout
    const results = await index.search({
      query: 'table lock timeout postgres migration',
      repositoryScope: 'github.com/whassan007/wazir',
    });

    expect(results.length).toBe(2);

    const episodeResult = results.find((r) => r.unit.kind === 'episodic_summary');
    const recipeResult = results.find((r) => r.unit.kind === 'procedural_recipe');

    expect(episodeResult).toBeDefined();
    expect(recipeResult).toBeDefined();

    // Critical Invariant: the episode maintains its unverified episodic kind and metadata!
    expect(episodeResult?.unit.kind).toBe('episodic_summary');
    expect(episodeResult?.unit.metadata?.attemptOutcome).toBe('failure');
    expect(episodeResult?.unit.metadata?.verifiedByEvidenceId).toBeUndefined();

    // The verified recipe retains its verifiedByEvidenceId
    expect(recipeResult?.unit.kind).toBe('procedural_recipe');
    expect(recipeResult?.unit.metadata?.verifiedByEvidenceId).toBe('evi-verified-mig-99');
  });
});
