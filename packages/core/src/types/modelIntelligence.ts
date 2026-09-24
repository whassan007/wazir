import type { Task } from './task.js';

/**
 * Empirical Model Capability Taxonomy.
 *
 * Defines measurable engineering capability categories grounded in
 * benchmark and execution verification evidence, avoiding subjective
 * or global scalar model rankings.
 */
export type ModelCapabilityCategory =
  | 'repository_navigation'
  | 'code_comprehension'
  | 'architecture_reasoning'
  | 'bug_localization'
  | 'implementation'
  | 'compile_repair'
  | 'test_repair'
  | 'tool_use'
  | 'structured_action_reliability'
  | 'long_horizon_execution'
  | 'context_efficiency'
  | 'delegation'
  | 'verification_reasoning';

export const MODEL_CAPABILITY_CATEGORIES: readonly ModelCapabilityCategory[] = [
  'repository_navigation',
  'code_comprehension',
  'architecture_reasoning',
  'bug_localization',
  'implementation',
  'compile_repair',
  'test_repair',
  'tool_use',
  'structured_action_reliability',
  'long_horizon_execution',
  'context_efficiency',
  'delegation',
  'verification_reasoning',
] as const;

export type ExecutionPhase = 'PLAN' | 'ACT' | 'REPAIR' | 'VERIFY' | 'DELEGATE';

export const EXECUTION_PHASES: readonly ExecutionPhase[] = [
  'PLAN',
  'ACT',
  'REPAIR',
  'VERIFY',
  'DELEGATE',
] as const;

export type ProgrammingLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'cpp'
  | 'rust'
  | 'go'
  | 'java'
  | 'other';

export const SUPPORTED_LANGUAGES: readonly ProgrammingLanguage[] = [
  'typescript',
  'javascript',
  'python',
  'cpp',
  'rust',
  'go',
  'java',
  'other',
] as const;

/**
 * Segmentation key ensuring evidence is segregated by version, runtime,
 * quantization, and protocol. Models or runtimes that change do not
 * contaminate existing profiles with incompatible measurements.
 */
export interface ProfileSegmentationKey {
  model: string;
  runtime: string;
  quantization?: string;
  hardwareClass?: string;
  modelVersion?: string;
  wazirProtocolVersion: string;
}

/**
 * Metric breakdown for an individual capability category measurement.
 */
export interface CategoryMetrics {
  successRate: number;
  firstPassRate?: number | null;
  avgRepairCycles?: number | null;
  protocolFailureRate?: number;
  avgTokenEfficiency?: number | null; // Tokens used per successful step/assertion
  toolErrorRate?: number;
  avgLatencyMs?: number | null;
}

/**
 * Empirically measured capability in a single taxonomy category.
 */
export interface CategoryMeasurement {
  category: ModelCapabilityCategory;
  /** Normalized capability score in [0, 1] derived strictly from evidence. */
  score: number;
  sampleCount: number;
  verifiedSuccessCount: number;
  failureCount: number;
  /** Statistical confidence in [0, 1] based on sample size and variance. */
  confidence: number;
  metrics: CategoryMetrics;
  lastEvaluated: Date;
}

/**
 * Conditional measurement across an auxiliary dimension (phase or programming language).
 */
export interface ConditionalMeasurement {
  dimension: 'phase' | 'language';
  key: string; // e.g. 'PLAN', 'REPAIR', 'typescript', 'python'
  category: ModelCapabilityCategory;
  score: number;
  sampleCount: number;
  verifiedSuccessCount: number;
  failureCount: number;
  confidence: number;
  lastEvaluated: Date;
}

/**
 * First-class Empirical Model Intelligence Profile.
 *
 * Captures multidimensional task-specific capabilities without reducing
 * the model to a single scalar score or subjective ranking.
 */
export interface ModelCapabilityProfile {
  id: string;
  model: string;
  runtime: string;
  quantization?: string;
  hardwareClass?: string;
  modelVersion?: string;
  wazirProtocolVersion: string;

  /** Measurements across the capability taxonomy. */
  categoryMeasurements: CategoryMeasurement[];

  /**
   * Phase-specific and language-specific performance breakdowns.
   * e.g. A model may be strong at PLAN in TypeScript, but weak at REPAIR in Rust.
   */
  conditionalMeasurements: {
    byPhase: Record<string, ConditionalMeasurement[]>;
    byLanguage: Record<string, ConditionalMeasurement[]>;
  };

  /** Aggregate sample volumes. */
  sampleCounts: {
    total: number;
    verifiedSuccess: number;
    failed: number;
    byCategory: Record<ModelCapabilityCategory, number>;
  };

  /** Aggregate statistical confidence based on sample diversity and volume. */
  confidence: number;

  /** Flagged when model version, runtime, or protocol drift renders profile obsolete. */
  isStale?: boolean;
  staleReason?: string;

  lastUpdated: Date;
}

/**
 * Classification of a task's capability requirements used by the router.
 */
export interface TaskCapabilityClassification {
  primaryCategory: ModelCapabilityCategory;
  secondaryCategories: ModelCapabilityCategory[];
  phase?: ExecutionPhase;
  language?: ProgrammingLanguage;
  confidence: number;
  reasons: string[];
}

/**
 * Candidate evaluation report within the empirical routing decision.
 */
export interface EvaluatedCandidate {
  modelId: string;
  runtimeId: string;
  profileFound: boolean;
  isStale: boolean;
  staleReason?: string;
  categoryScore?: number;
  conditionalScore?: number;
  effectiveScore?: number;
  confidence?: number;
  sampleCount?: number;
  policyAllowed: boolean;
  policyRejection?: string;
  resourceAllowed: boolean;
  resourceRejection?: string;
  eligible: boolean;
  reasons: string[];
}

/**
 * Complete, human-auditable explanation for empirical model routing decisions.
 */
export interface EmpiricalRoutingExplanation {
  requiredCapability: ModelCapabilityCategory;
  phase?: ExecutionPhase;
  language?: ProgrammingLanguage;
  candidateModels: string[];
  evaluatedCandidates: EvaluatedCandidate[];
  selectedModelId: string;
  selectionReason: string;
  policyConstraintsApplied: string[];
  resourceConstraintsApplied: string[];
}
