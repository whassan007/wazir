export type ModelSelectionStrategy =
  | 'explicit'
  | 'capability_match'
  | 'context_fit'
  | 'loaded_preferred';

export interface ModelRoutingDecision {
  modelId: string;
  modelInstanceId: string;
  strategy: ModelSelectionStrategy;
  score: number;
  reasons: string[];
}

export interface ComputerRoutingDecision {
  computerId: string;
  runtimeId: string;
  score: number;
  reasons: string[];
}

export interface SchedulerDecision {
  agentId?: string;
  modelId: string;
  modelInstanceId: string;
  runtimeId: string;
  computerId: string;
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
