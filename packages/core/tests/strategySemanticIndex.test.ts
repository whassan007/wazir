import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, JsonFileStore } from '@wazir/shared';
import type { ExecutionRecord } from '../src/types/execution.js';
import { StrategyLearningService } from '../src/services/strategyLearningService.js';
import { DeterministicLocalEmbeddingProvider } from '../src/services/embeddingProvider.js';
import { StrategySemanticIndex, buildStrategyDocument, buildAntiStrategyDocument, normalizeStrategyText } from '../src/services/strategySemanticIndex.js';
import type { EngineeringStrategy, AntiStrategyWarning } from '../src/types/strategyLearning.js';

function strategy(): EngineeringStrategy {
  return {
    id: 'strategy-1', problemSignature: { category: 'race_condition', languages: ['typescript'], repositoryCharacteristics: ['typed', 'monorepo'], domainTags: ['queue', 'react'] },
    taskCategories: ['coding'], languages: ['typescript'], repositoryCharacteristics: ['monorepo', 'typed'],
    approach: [{ phase: 'modify', action: 'Serialize concurrent writes', intent: 'Prevent lost updates' }],
    usefulTools: [], usefulAgents: [], usefulModels: [], verificationPattern: ['test'],
    executions: 2, successRate: 1, repairDistribution: [], tokenDistribution: [], durationDistribution: [],
    evidenceRefs: ['verified-evidence'], confidence: 0.8, version: 1, createdAt: new Date(), updatedAt: new Date(),
  };
}
const warning = (): AntiStrategyWarning => ({
  problemSignature: strategy().problemSignature, antiPatternName: 'blind_replacement',
  description: 'RAW TRANSCRIPT /private/repo.ts Hidden acceptance oracle: SECRET',
  observedFailureCount: 2, failureRate: 1, warningMessage: 'Do not edit before reproducing',
  consequences: ['Lost updates'], remedySuggestion: 'Reproduce then serialize writes',
});

describe('Strategy semantic storage', () => {
  it('persists extracted strategies and embeddings across a disk-backed restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strategy-semantic-'));
    try {
      const file = join(dir, 'store.json');
      const provider = new DeterministicLocalEmbeddingProvider();
      const embed = vi.spyOn(provider, 'embed');
      const service = new StrategyLearningService({ store: new JsonFileStore(file), embeddingProvider: provider });
      const run = {
        execution: { id: 'run-1', taskId: 'task-1', runtimeId: 'test', status: 'completed', createdAt: new Date() },
        task: { id: 'task-1', type: 'coding', prompt: 'Fix a compile failure' },
        toolCalls: [], filesChanged: [], errors: [], events: [], checks: [], policyDecisions: [],
        evidence: [{ id: 'proof', type: 'BUILD', status: 'PASS', exitCode: 0, revision: 1 }],
      } as unknown as ExecutionRecord;
      const learned = (await service.extractFromExecution(run)).strategy!;
      expect(learned).toBeDefined();
      expect(embed).toHaveBeenCalledTimes(1);
      const restored = new StrategyLearningService({ store: new JsonFileStore(file), embeddingProvider: provider });
      await restored.initialize();
      expect(embed).toHaveBeenCalledTimes(1);
      expect(restored.queryStrategies({ problemSignature: learned.problemSignature })[0].strategy.id).toBe(learned.id);
      expect((await restored.semanticIndex.getCandidates({ problemSignature: learned.problemSignature })).documents[0].metadata?.sourceStrategyId).toBe(learned.id);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed provider vectors without interrupting structured matching', async () => {
    const provider = new DeterministicLocalEmbeddingProvider();
    vi.spyOn(provider, 'embed').mockResolvedValue([{ text: '', vector: [NaN], dimensions: 1 }]);
    const store = new MemoryStore(); const source = strategy();
    await store.put(`strategy/${source.id}`, source);
    const service = new StrategyLearningService({ store, embeddingProvider: provider });
    await service.initialize();
    expect(await store.list('strategy-semantic/')).toEqual([]);
    expect(service.queryStrategies({ problemSignature: source.problemSignature })).toHaveLength(1);
  });

  it('normalizes documents, unordered traits and excludes evidence and execution metadata', () => {
    const first = strategy();
    const second = strategy();
    second.repositoryCharacteristics.reverse(); second.problemSignature.repositoryCharacteristics.reverse();
    second.version = 20; second.executions = 100; second.confidence = 1;
    second.evidenceRefs = ['Hidden acceptance oracle: SECRET'];
    second.verificationPattern = ['SECRET'];
    expect(buildStrategyDocument(first)).toBe(buildStrategyDocument(second));
    expect(buildStrategyDocument(first)).toContain('problem category: race condition');
    expect(buildStrategyDocument(first)).toContain('react');
    expect(buildStrategyDocument(second)).not.toContain('SECRET');
    expect(normalizeStrategyText('  Serialize   concurrent WRITES  ')).toBe('serialize concurrent writes');
  });

  it('removes paths, quoted, camel-case and snake-case symbols and oracle fields', () => {
    const text = normalizeStrategyText('Inspect /home/private/repo.ts C:\\private\\repo.ts src/module.ts `PrivateSymbol` internalMethod secret_symbol "private" before testing');
    for (const secret of ['home', 'repo.ts', 'PrivateSymbol', 'internalMethod', 'secret_symbol', 'private']) expect(text).not.toContain(secret);
    expect(text).toContain('before testing');
    expect(normalizeStrategyText('hidden acceptance oracle: secret')).toBe('');
  });

  it('persists identity, digest and vectors and restores without recomputing metadata changes', async () => {
    const store = new MemoryStore();
    const provider = new DeterministicLocalEmbeddingProvider();
    const embed = vi.spyOn(provider, 'embed');
    const options = { store, embeddingProvider: provider, embeddingProviderId: 'test-local' };
    const index = new StrategySemanticIndex(options);
    const source = strategy();
    const unit = await index.indexStrategy(source);
    expect(unit).toMatchObject({ embeddingProvider: 'test-local', embeddingVersion: '1:1', metadata: { sourceStrategyId: source.id } });
    expect(unit?.embeddingModel).toBe(provider.capabilities().modelName);
    expect(unit?.contentHash).toBe(createHash('sha256').update(buildStrategyDocument(source)).digest('hex'));
    expect(await store.get(`strategy-semantic/${unit!.id}`)).toEqual(unit);
    source.confidence = 0.9; source.version++; source.updatedAt = new Date();
    const restored = await new StrategySemanticIndex(options).indexStrategy(source);
    expect(restored?.embedding).toEqual(unit?.embedding);
    expect(embed).toHaveBeenCalledTimes(1);
    source.approach[0].action = 'Use atomic compare and swap';
    const changed = await index.indexStrategy(source);
    expect(changed?.contentHash).not.toBe(unit?.contentHash);
    expect(embed).toHaveBeenCalledTimes(2);
    await new StrategySemanticIndex({ ...options, embeddingVersion: '2' }).indexStrategy(source);
    expect(embed).toHaveBeenCalledTimes(3);
    await new StrategySemanticIndex({ ...options, embeddingProviderId: 'another-provider' }).indexStrategy(source);
    expect(embed).toHaveBeenCalledTimes(4);
    const otherModel = new DeterministicLocalEmbeddingProvider({ modelName: 'new-model' });
    const otherEmbed = vi.spyOn(otherModel, 'embed');
    await new StrategySemanticIndex({ ...options, embeddingProvider: otherModel }).indexStrategy(source);
    expect(otherEmbed).toHaveBeenCalledTimes(1);
  });

  it.each(['embed', 'capabilities'] as const)('invalidates stale vectors if %s fails during refresh', async (method) => {
    const store = new MemoryStore(); const provider = new DeterministicLocalEmbeddingProvider();
    const index = new StrategySemanticIndex({ store, embeddingProvider: provider });
    const source = strategy(); const original = await index.indexStrategy(source);
    const failure = method === 'embed'
      ? vi.spyOn(provider, 'embed').mockRejectedValueOnce(new Error('offline'))
      : vi.spyOn(provider, 'capabilities').mockImplementationOnce(() => { throw new Error('offline'); });
    source.approach[0].action = 'Use transactions';
    expect(await index.indexStrategy(source)).toBeUndefined();
    expect(await store.get(`strategy-semantic/${original!.id}`)).toBeUndefined();
    expect((await index.getCandidates({ problemSignature: source.problemSignature })).documents).toEqual([]);
    failure.mockRestore();
  });

  it('keeps structured retrieval available without embeddings and after provider failure', async () => {
    const store = new MemoryStore(); const source = strategy();
    await store.put(`strategy/${source.id}`, source);
    const provider = new DeterministicLocalEmbeddingProvider();
    vi.spyOn(provider, 'embed').mockRejectedValue(new Error('offline'));
    for (const embeddingProvider of [undefined, provider]) {
      const service = new StrategyLearningService({ store, embeddingProvider });
      await service.initialize();
      expect(service.queryStrategies({ problemSignature: source.problemSignature })[0].strategy.id).toBe(source.id);
      expect((await service.semanticIndex.getCandidates({ problemSignature: source.problemSignature })).documents).toEqual([]);
    }
  });

  it('constructs, persists and restores anti-strategy documents without raw failure output', async () => {
    const store = new MemoryStore(); const provider = new DeterministicLocalEmbeddingProvider();
    const service = new StrategyLearningService({ store, embeddingProvider: provider });
    const anti = warning(); await service.recordAntiStrategy(anti);
    const text = buildAntiStrategyDocument(anti);
    expect(text).toContain('anti-strategy: blind replacement');
    expect(text).toContain('remedy: reproduce then serialize writes');
    expect(text).not.toMatch(/RAW|SECRET|private/);
    const restored = new StrategyLearningService({ store, embeddingProvider: provider }); await restored.initialize();
    expect(restored.getAntiStrategies()).toHaveLength(1);
    const query = { problemSignature: anti.problemSignature, allowAntiStrategies: true };
    const candidates = await restored.semanticIndex.getCandidates(query);
    expect(candidates.documents).toHaveLength(1);
    expect(candidates.documents[0].kind).toBe('anti_strategy');
    expect((await restored.semanticIndex.getCandidates({ ...query, allowAntiStrategies: false })).documents).toEqual([]);
  });
});
