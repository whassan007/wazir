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

export interface ComputerRoutingDecision {
  /** Absent when `placementKind` is 'hosted' — a hosted provider has no Computer. */
  computerId?: string;
  runtimeId: string;
  /** 'local' when placed on a Computer; 'hosted' when routed to an
   *  authenticated hosted provider (Anthropic/OpenAI/Google). */
  placementKind: 'local' | 'hosted';
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
