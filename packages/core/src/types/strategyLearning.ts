import type { ProgrammingLanguage } from './modelIntelligence.js';

// ======================================================================
// 1. PROBLEM SIGNATURE & CLASSIFICATION
// ======================================================================

export type ProblemCategory =
  | 'compile_failure'
  | 'test_failure'
  | 'race_condition'
  | 'api_migration'
  | 'cross_package_feature'
  | 'dependency_upgrade'
  | 'performance_regression'
  | 'context_explosion'
  | 'tool_protocol_failure'
  | 'worker_lifecycle_failure'
  | 'general_repair';

export type RepositoryCharacteristic =
  | 'monorepo'
  | 'polyrepo'
  | 'multi_package'
  | 'single_package'
  | 'compiled'
  | 'interpreted'
  | 'typed'
  | 'dynamic'
  | 'has_ci'
  | 'heavy_dependencies'
  | 'minimal_dependencies';

export interface DependencyGraphCharacteristics {
  totalNodes?: number;
  maxDepth?: number;
  hasCycles?: boolean;
  packageCount?: number;
  internalDependenciesCount?: number;
  externalDependenciesCount?: number;
}

export interface ProblemSignature {
  /** High level category of the problem */
  category: ProblemCategory;
  /** Primary and secondary languages involved */
  languages: ProgrammingLanguage[];
  /** Repository characteristics (e.g. monorepo, compiled, typed) */
  repositoryCharacteristics: RepositoryCharacteristic[];
  /** Structural/dependency graph attributes if known */
  dependencyGraphCharacteristics?: DependencyGraphCharacteristics;
  /** Normalized failure signature (e.g., error pattern or compiler code) */
  failureSignature?: string;
  /** Normalized failure evidence or diagnostic tags */
  failureEvidenceTags?: string[];
  /** Domain tags */
  domainTags?: string[];
}

// ======================================================================
// 2. STRATEGY REPRESENTATION & VERIFIED EVIDENCE
// ======================================================================

export type StrategyPhase = 'find' | 'inspect' | 'modify' | 'compile' | 'test' | 'verify' | 'delegate' | 'repair';

export interface StrategyStep {
  phase: StrategyPhase;
  action: string;
  intent: string;
  suggestedTools?: string[];
  suggestedCapabilities?: string[];
  verificationCriteria?: string[];
  optional?: boolean;
}

export interface RecommendedCapabilityProfile {
  capabilityCategory: string;
  preferredProfileScore?: number;
  description: string;
}

export interface StrategyDistributions {
  /** Frequency of repair cycles before passing */
  repairCycles: number[];
  /** Token usage across verified executions */
  tokenUsage: number[];
  /** Execution wall time duration in milliseconds */
  durationsMs: number[];
  /** Average repair cycles */
  avgRepairCycles: number;
  /** Average tokens */
  avgTokens: number;
  /** Average duration */
  avgDurationMs: number;
}

export interface EngineeringStrategy {
  /** Unique strategy identifier */
  id: string;
  /** Problem signature that triggers/matches this strategy */
  problemSignature: ProblemSignature;
  /** Task categories this strategy applies to */
  taskCategories: string[];
  /** Languages supported by this strategy */
  languages: ProgrammingLanguage[];
  /** Repository characteristics required or matched */
  repositoryCharacteristics: RepositoryCharacteristic[];
  /** Failure signature (normalized regex, compiler code, or error family) */
  failureSignature?: string;

  /** The structural abstract approach (ordered sequence of steps, NOT filenames) */
  approach: StrategyStep[];
  /** Tools proven useful during verified executions of this strategy */
  usefulTools: string[];
  /** Agent archetypes or roles proven effective */
  usefulAgents: string[];
  /** Model capability profiles / recommendations (not hardcoded model names) */
  usefulModels: RecommendedCapabilityProfile[];
  /** Verification pattern sequence required to prove success */
  verificationPattern: string[];

  /** Number of recorded executions using or contributing to this strategy */
  executions: number;
  /** Verified success rate (successful / total attempts) */
  successRate: number;
  /** Empirical distributions across verified runs */
  repairDistribution: number[];
  tokenDistribution: number[];
  durationDistribution: number[];
  /** Calculated statistical summary */
  distributions?: StrategyDistributions;

  /** Authoritative evidence IDs from verification engine */
  evidenceRefs: string[];
  /** Statistical or empirical confidence in [0, 1] */
  confidence: number;
  /** Version number of this strategy as evidence accumulates */
  version: number;
  /** Whether this is marked as an ANTI_STRATEGY */
  isAntiStrategy?: boolean;
  /** Specific known failure modes or warnings */
  knownFailureModes?: string[];
  /** Creation and last update timestamps */
  createdAt: Date;
  updatedAt: Date;
}

// ======================================================================
// 3. NEGATIVE EXPERIENCE & ANTI-STRATEGY
// ======================================================================

export interface AntiStrategyWarning {
  strategyId?: string;
  problemSignature: ProblemSignature;
  antiPatternName: string;
  description: string;
  observedFailureCount: number;
  failureRate: number;
  warningMessage: string;
  consequences: string[];
  remedySuggestion?: string;
}

// ======================================================================
// 4. RETRIEVAL & PLANNING INPUT/OUTPUT
// ======================================================================

export interface StrategyMatchQuery {
  problemSignature: ProblemSignature;
  taskPrompt?: string;
  repositoryScope?: string;
  minConfidence?: number;
  maxResults?: number;
  allowAntiStrategies?: boolean;
}

export interface StrategyQuery {
  /** Concise problem description (no entire transcripts embedded) */
  problemDescription: string;
  /** Task category */
  taskCategory: ProblemCategory | string;
  /** Observed physical failures, errors, or diagnostic tags */
  observedFailures: string[];
  /** Repository / architecture properties */
  architectureProperties: (RepositoryCharacteristic | string)[];
  /** Programming language if applicable */
  language?: ProgrammingLanguage | string;
  /** Framework or runtime if applicable */
  framework?: string;
  /** Strategy phase if querying for a specific stage */
  phase?: StrategyPhase;
  /** Available physical evidence tags */
  availableEvidence?: string[];
  /** Optional structured problem signature */
  problemSignature?: ProblemSignature;
  /** Task prompt */
  taskPrompt?: string;
  /** Repository scope or root if applicable */
  repositoryScope?: string;
  minConfidence?: number;
  maxResults?: number;
  allowAntiStrategies?: boolean;
}

export interface RelevantStrategy {
  strategyId: string;
  normalizedStrategy: EngineeringStrategy;
  applicability: number;
  semanticSimilarity: number;
  structuralSimilarity: number;
  evidenceQuality: number;
  verifiedUses: number;
  verifiedFailures: number;
  antiStrategyWarnings: AntiStrategyWarning[];

  // StrategyMatchResult backwards-compatibility aliases:
  strategy: EngineeringStrategy;
  matchScore: number;
  confidence: number;
  historicalEvidenceCount: number;
  warnings: AntiStrategyWarning[];
  relevanceExplanation: string;
  suggestedPlanAdaptations?: string[];

  // Diagnostics, clustering, and cross-language transfer metadata:
  relevanceClass?: 'HIGH' | 'MEDIUM' | 'IRRELEVANT';
  clusterId?: string;
  clusterLabel?: string;
  crossLanguageTransferrable?: boolean;
  architectureTransferrable?: boolean;
  scoreBreakdown?: {
    semantic: number;
    structural: number;
    architecture: number;
    failureTraits: number;
    languageCompatibility: number;
    evidenceQuality: number;
    confidence: number;
    falsePositivePenalty?: number;
  };
}

export type StrategyMatchResult = RelevantStrategy;

export interface StrategyCluster {
  id: string;
  label: string;
  description: string;
  conceptKeywords: string[];
  strategies: string[]; // strategy IDs
  representativeStrategyId?: string;
}

export interface StrategyBenchmarkMetrics {
  taskSuccess: boolean;
  localizationCalls: number;
  modelCalls: number;
  tokens: number;
  repairCycles: number;
  falseRetrievalRate: number;
  verificationSuccess: boolean;
  wallTimeMs: number;
}

export interface StrategyRetrievalBenchmarkReport {
  modeA: StrategyBenchmarkMetrics & { name: string };
  modeB: StrategyBenchmarkMetrics & { name: string };
  delta: {
    taskSuccess: boolean;
    localizationReduction: number;
    modelCallsRatio: number;
    tokenImprovementRatio: number;
    repairCyclesSaved: number;
    falseRetrievalReduction: number;
    verificationSuccess: boolean;
    wallTimeImprovementRatio: number;
  };
}

export interface StrategyTransferReport {
  sourceRepository: string;
  targetRepository: string;
  transferredStrategyId: string;
  problemSignatureMatchScore: number;
  literalFileTokensAvoided: boolean;
  independentVerificationPassed: boolean;
  metricsComparison: {
    withStrategy: {
      modelCalls: number;
      repoReads: number;
      repairCycles: number;
      tokens: number;
      wallTimeMs: number;
    };
    withoutStrategy: {
      modelCalls: number;
      repoReads: number;
      repairCycles: number;
      tokens: number;
      wallTimeMs: number;
    };
    improvementRatio: {
      modelCalls: number;
      repoReads: number;
      repairCycles: number;
      tokens: number;
      wallTimeMs: number;
    };
  };
}
