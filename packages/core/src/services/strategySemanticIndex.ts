import { createHash } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type { EmbeddingProvider, SemanticIndexUnit } from '../types/semanticIndex.js';
import type { EngineeringStrategy, AntiStrategyWarning, ProblemSignature, StrategyMatchQuery, StrategyQuery } from '../types/strategyLearning.js';
import { SemanticIndexService } from './semanticIndexService.js';

export const STRATEGY_DOCUMENT_VERSION = '1';

/** Only abstract source fields are accepted; transcripts, checks and evidence are never read. */
export function normalizeStrategyText(value: string): string {
  if (/oracle|hidden[\s_-]*(?:test|acceptance)|acceptance[\s_-]*(?:oracle|secret)/i.test(value)) return '';
  return value.normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/?(?:[\w.-]+[\\/])+)[^\s,;"'`<>)]*/g, '[path]')
    .replace(/(?:~?\/)[^\s,;"'`<>)]*/g, '[path]')
    .replace(/`[^`]*`|"[^"]*"|'[^']*'/g, '[symbol]')
    .replace(/\b[\w$]+\.(?:ts|tsx|js|jsx|py|rs|go|cpp|h|java)\b/g, '[path]')
    .replace(/\b(?:[a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[\w$]+_[\w$]+)\b/g, '[symbol]')
    .replace(/\b_[\w$]+\b|\$[\w$]+|\b[\w$]+(?:::|\.)[\w$.]+\b/g, '[symbol]')
    .replace(/\b[\w$]+(?=\s*\()/g, '[symbol]')
    .replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400);
}

const terms = (values: string[]) => [...new Set(values.map(v => normalizeStrategyText(v.replace(/_/g, ' '))).filter(Boolean))].sort().join(', ');
function signatureLines(signature: ProblemSignature): string[] {
  return [
    `problem category: ${signature.category.replace(/_/g, ' ')}`,
    `problem description: ${terms([signature.category, ...(signature.domainTags ?? [])])}`,
    `failure mode: ${normalizeStrategyText(signature.failureSignature ?? '')}`,
    `languages: ${terms(signature.languages)}`,
    `architecture: ${terms(signature.repositoryCharacteristics)}`,
    `diagnostics: ${terms(signature.failureEvidenceTags ?? [])}`,
    `dependency cycles: ${signature.dependencyGraphCharacteristics?.hasCycles ?? 'unknown'}`,
  ];
}

export function buildStrategyDocument(strategy: EngineeringStrategy): string {
  return [
    ...signatureLines(strategy.problemSignature),
    `languages: ${terms(strategy.languages)}`,
    `architecture: ${terms(strategy.repositoryCharacteristics)}`,
    `failure mode: ${normalizeStrategyText(strategy.failureSignature ?? '')}`,
    `${strategy.isAntiStrategy ? 'anti-strategy' : 'verified strategy'}:`,
    ...strategy.approach.slice(0, 16).map(s => `${s.phase}: ${normalizeStrategyText(s.action)}; ${normalizeStrategyText(s.intent)}`),
    `known failure modes: ${(strategy.knownFailureModes ?? []).slice(0, 8).map(normalizeStrategyText).filter(Boolean).sort().join('; ')}`,
  ].join('\n');
}

export function buildAntiStrategyDocument(warning: AntiStrategyWarning): string {
  return [...signatureLines(warning.problemSignature),
    `anti-strategy: ${normalizeStrategyText(warning.antiPatternName.replace(/_/g, ' '))}`,
    `avoid: ${normalizeStrategyText(warning.warningMessage)}`,
    `consequences: ${warning.consequences.slice(0, 8).map(normalizeStrategyText).join('; ')}`,
    `remedy: ${normalizeStrategyText(warning.remedySuggestion ?? '')}`,
    // description can contain raw execution errors, so deliberately omit it.
  ].join('\n');
}

export interface StrategySemanticIndexOptions {
  embeddingProvider?: EmbeddingProvider;
  /** Stable runtime identity, e.g. ollama or lm-studio. */
  embeddingProviderId?: string;
  embeddingVersion?: string;
  store?: KeyValueStore;
}

export interface StrategySemanticCandidates {
  queryEmbedding?: number[];
  /** Unranked, compatible documents only. Worker 10 owns ranking and clustering. */
  documents: SemanticIndexUnit[];
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingVersion: string;
}

/** Strategy adapter over the shared vector infrastructure; contains no ranking logic. */
export class StrategySemanticIndex {
  private readonly index?: SemanticIndexService;
  private readonly version: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: StrategySemanticIndexOptions = {}) {
    this.version = `${STRATEGY_DOCUMENT_VERSION}:${options.embeddingVersion ?? '1'}`;
    if (options.embeddingProvider) this.index = new SemanticIndexService({
      ...options, embeddingProvider: options.embeddingProvider,
      embeddingVersion: this.version, storagePrefix: 'strategy-semantic/',
    });
  }

  public indexStrategy(strategy: EngineeringStrategy): Promise<SemanticIndexUnit | undefined> {
    return this.write(strategy.id, buildStrategyDocument(strategy), strategy.isAntiStrategy ? 'anti_strategy' : 'engineering_strategy');
  }

  public indexAntiStrategy(warning: AntiStrategyWarning): Promise<SemanticIndexUnit | undefined> {
    const id = warning.strategyId ?? `anti-${createHash('sha256').update(`${warning.problemSignature.category}:${warning.antiPatternName}`).digest('hex')}`;
    return this.write(id, buildAntiStrategyDocument(warning), 'anti_strategy');
  }

  private write(sourceStrategyId: string, content: string, kind: SemanticIndexUnit['kind']): Promise<SemanticIndexUnit | undefined> {
    const work = this.chain.then(async () => {
      try {
        return await this.index?.indexUnit({
          id: `${kind}:${sourceStrategyId}`, kind, content,
          repositoryScope: 'engineering-strategies', path: `${kind}/${sourceStrategyId}`,
          workspaceRevision: 0, metadata: { sourceStrategyId, documentVersion: STRATEGY_DOCUMENT_VERSION },
        });
      } catch { return undefined; } // Embeddings are optional; structured matching remains authoritative.
    });
    this.chain = work;
    return work;
  }

  public getProvider(): EmbeddingProvider | undefined {
    return this.options.embeddingProvider;
  }

  public getIndex(): SemanticIndexService | undefined {
    return this.index;
  }

  public async getCandidates(query: StrategyMatchQuery | StrategyQuery): Promise<StrategySemanticCandidates> {
    await this.chain;
    const empty: StrategySemanticCandidates = { documents: [], embeddingVersion: this.version };
    try {
      const provider = this.options.embeddingProvider;
      if (!provider || !this.index) return empty;
      const caps = provider.capabilities();
      const sig: ProblemSignature = query.problemSignature ?? {
        category: ((query as StrategyQuery).taskCategory as any) ?? 'general_repair',
        languages: (query as StrategyQuery).language ? [(query as StrategyQuery).language as any] : [],
        repositoryCharacteristics: ((query as StrategyQuery).architectureProperties as any) ?? [],
        failureSignature: (query as StrategyQuery).observedFailures?.[0],
        failureEvidenceTags: (query as StrategyQuery).observedFailures,
      };
      const promptText = (query as StrategyQuery).problemDescription ?? query.taskPrompt ?? '';
      const content = [...signatureLines(sig), normalizeStrategyText(promptText)].join('\n');
      const [result] = await provider.embed([content]);
      if (!result || result.vector.length !== caps.dimensions || !result.vector.every(Number.isFinite)) return empty;
      return {
        queryEmbedding: result.vector,
        documents: this.index.getUnits().filter(u =>
          (query.allowAntiStrategies || u.kind !== 'anti_strategy') &&
          u.embeddingModel === caps.modelName && u.embeddingVersion === this.version &&
          u.embeddingProvider === (this.options.embeddingProviderId ?? provider.constructor.name) &&
          u.embedding?.length === caps.dimensions),
        embeddingProvider: this.options.embeddingProviderId ?? provider.constructor.name,
        embeddingModel: caps.modelName, embeddingVersion: this.version,
      };
    } catch { return empty; }
  }
}
