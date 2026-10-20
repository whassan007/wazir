export type ModelSelectionStrategy =
  | 'explicit'
  | 'capability_match'
  | 'context_fit'
  | 'loaded_preferred'
  | 'empirical_profile';

export interface ModelRoutingDecision {
  modelId: string;
  modelInstanceId: string;
  strategy: ModelSelectionStrategy;
  score: number;
  reasons: string[];
  empiricalExplanation?: import('./modelIntelligence.js').EmpiricalRoutingExplanation;
}

export type InferenceResourceType =
  | 'LOCAL_GPU_INFERENCE'
  | 'REMOTE_GPU_INFERENCE'
  | 'HOSTED_API_INFERENCE';

export interface ComputerRoutingDecision {
  /** Absent when `placementKind` is 'hosted' — a hosted provider has no Computer. */
  computerId?: string;
  runtimeId: string;
  /** 'local' when placed on a Computer; 'hosted' when routed to an
   *  authenticated hosted provider (Anthropic/OpenAI/Google/NVIDIA). */
  placementKind: 'local' | 'hosted';
  /** Distinguishes local GPU, remote GPU (e.g. DGX Spark), and hosted API inference. */
  resourceType?: InferenceResourceType;
  score: number;
  reasons: string[];
}

/** One model abandoned before dispatch, and why. */
export interface ModelFallback {
  from: string;
  to: string;
  reason: string;
}

export interface SchedulerDecision {
  /** Models skipped before dispatch (e.g. no longer served by their runtime), in order. */
  fallbacks?: ModelFallback[];
  readiness?: 'READY_NOW' | 'LOADABLE' | 'NOT_LOADABLE';
  agentId?: string;
  modelId: string;
  modelInstanceId: string;
  runtimeId: string;
  /** Absent for a hosted placement — see ComputerRoutingDecision.computerId. */
  computerId?: string;
  /** Distinguishes local GPU, remote GPU, and hosted API inference so hosted providers are never attributed to local/remote GPU hardware. */
  resourceType?: InferenceResourceType;
  modelDecision: ModelRoutingDecision;
  computerDecision: ComputerRoutingDecision;
  reasons: string[];
  decidedAt: Date;
}

export class SchedulingError extends Error {
  readonly modelReasons: string[];
  readonly computerReasons: string[];

  constructor(message: string, modelReasons: string[] = [], computerReasons: string[] = []) {
    super(message);
    this.name = 'SchedulingError';
    this.modelReasons = modelReasons;
    this.computerReasons = computerReasons;
  }
}
