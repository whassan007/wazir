export interface SteeringInjectedConstraints {
  protectedFiles?: string[];
  allowedTools?: string[];
  forbiddenTools?: string[];
  maxTurns?: number;
  maxExecutionTimeSeconds?: number;
}

export interface SteeringParams {
  guidance?: string;
  who?: string; // 'user' | 'supervisor' | 'operator' | string
  injectedConstraints?: SteeringInjectedConstraints;
  cancelScheduledToolCalls?: boolean;
  changeModelRouting?: {
    modelId: string;
    runtimeId?: string;
  };
  forceReverification?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SteeringResult {
  executionId: string;
  who: string;
  whatChanged: {
    guidance?: string;
    constraintsModified?: SteeringInjectedConstraints;
    toolCallsCancelled?: boolean;
    modelRoutingChanged?: { modelId: string; runtimeId?: string };
    forcedReverification?: boolean;
  };
  effectiveAt: Date;
  success: boolean;
}
