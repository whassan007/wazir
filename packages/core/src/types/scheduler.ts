export type ModelSelectionStrategy =
  | 'explicit'
  | 'capability_match'
  | 'context_fit'
  | 'loaded_preferred'
  | 'empirical_profile';

export type InferenceResourceType = 'LOCAL_GPU_INFERENCE' | 'HOSTED_API_INFERENCE';

export interface RoutingPolicyConfig {
  mode: 'provider_only' | 'auto' | 'local_only' | 'hybrid';
  provider?: string;
  defaultModel?: string;
  allowFallback?: boolean;
}

export interface ModelRoutingDecision {
  modelId: string;
  modelInstanceId: string;
  strategy: ModelSelectionStrategy;
  score: number;
  reasons: string[];
  empiricalExplanation?: import('./modelIntelligence.js').EmpiricalRoutingExplanation;
}

export interface ComputerRoutingDecision {
  /** Absent when `placementKind` is 'hosted' — a hosted provider has no Computer. */
  computerId?: string;
  runtimeId: string;
  /** 'local' when placed on a Computer; 'hosted' when routed to an
   *  authenticated hosted provider (Anthropic/OpenAI/Google/NVIDIA). */
  placementKind: 'local' | 'hosted';
  /** Resource classification distinguishing local hardware from remote API inference. */
  resourceType?: InferenceResourceType;
  score: number;
  reasons: string[];
}

export interface SchedulerDecision {
  readiness?: 'READY_NOW' | 'LOADABLE' | 'NOT_LOADABLE';
  agentId?: string;
  modelId: string;
  modelInstanceId: string;
  runtimeId: string;
  /** Absent for a hosted placement — see ComputerRoutingDecision.computerId. */
  computerId?: string;
  /** Resource classification distinguishing local hardware from remote API inference. */
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
