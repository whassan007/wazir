import type {
  ProblemSignature,
  ProblemCategory,
  RepositoryCharacteristic,
  StrategyStep,
} from './strategyLearning.js';

/**
 * Deterministic Acceptance Corpus for Semantic Engineering-Strategy Transfer.
 *
 * This corpus defines paired engineering problems and historical failure cases to make
 * semantic retrieval falsifiable across architectures, repositories, and languages,
 * without token-matching shortcuts or leaking solution texts into target codebases.
 */

export type RelevanceClass = 'HIGH' | 'MEDIUM' | 'IRRELEVANT';

export interface CorpusRepositoryFile {
  relativePath: string;
  content: string;
}

export interface CorpusEngineeringProblem {
  id: string;
  name: string;
  description: string;
  repositoryId: string;
  workspaceRoot: string;
  problemSignature: ProblemSignature;
  taskPrompt: string;
  errorDiagnostics: string[];
  files: CorpusRepositoryFile[];
  /** Expected verified abstract approach steps (no literal filenames/symbol names) */
  expectedAbstractApproach: StrategyStep[];
}

export interface SemanticRetrievalPair {
  id: string;
  name: string;
  description: string;
  sourceProblem: CorpusEngineeringProblem;
  targetProblem: CorpusEngineeringProblem;
  expectedRelevance: RelevanceClass;
  /** Architectural concept shared between source and target (if HIGH or MEDIUM) */
  sharedArchitecturalConcept?: string;
  /** Primary confounding factor (e.g. lexical overlap on distinct defect, or disjoint vocabulary on identical defect) */
  confoundingFactor: string;
  /** Invariant checks that test harnesses must verify */
  forbiddenTokensInTargetPlan: string[];
}

export interface AntiStrategyCase {
  id: string;
  name: string;
  antiPatternName: string;
  description: string;
  problemSignature: ProblemSignature;
  historicalFailurePrompt: string;
  historicalFailureEvidence: string;
  warningMessage: string;
  flawedApproachSteps: StrategyStep[];
  consequences: string[];
  remedySuggestion: string;
  expectedRelevance: RelevanceClass;
}

export interface SemanticStrategyCorpus {
  version: string;
  description: string;
  structuralPairs: SemanticRetrievalPair[];
  crossLanguagePairs: SemanticRetrievalPair[];
  negativePairs: SemanticRetrievalPair[];
  antiStrategyCases: AntiStrategyCase[];
}
