export interface EmbeddingCapabilities {
  dimensions: number;
  maxBatchSize: number;
  modelName: string;
  supportsNormalizedVectors: boolean;
}

export interface EmbeddingResult {
  text: string;
  vector: number[];
  dimensions: number;
}

export interface EmbeddingProvider {
  capabilities(): EmbeddingCapabilities;
  embed(texts: string[]): Promise<EmbeddingResult[]>;
}

export type SemanticUnitKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'module'
  | 'doc'
  | 'config'
  | 'procedural_recipe'
  | 'episodic_summary';

export interface SemanticIndexUnit {
  id: string;
  kind: SemanticUnitKind;
  repositoryScope: string;
  path: string;
  symbolName?: string;
  language?: string;
  content: string;
  contentHash: string;
  workspaceRevision: number;
  embedding?: number[];
  artifactOrPackage?: string;
  embeddingModel?: string;
  embeddingVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface HybridRankingWeights {
  wAst: number;
  wLexical: number;
  wEmbedding: number;
  wDependency: number;
  wContext: number;
}

export interface DiagnosticScoreBreakdown {
  totalScore: number;
  astScore: number;
  lexicalScore: number;
  embeddingScore: number;
  dependencyScore: number;
  contextScore: number;
  details?: Record<string, unknown>;
}

export interface SemanticSearchResult {
  unit: SemanticIndexUnit;
  score: number;
  breakdown: DiagnosticScoreBreakdown;
}

export interface SemanticQueryOptions {
  query: string;
  repositoryScope: string;
  kinds?: SemanticUnitKind[];
  weights?: Partial<HybridRankingWeights>;
  limit?: number;
  minScore?: number;
  activeContextFiles?: string[];
  activeSymbols?: string[];
}
