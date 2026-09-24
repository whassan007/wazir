import { SchedulingError } from '@wazir/core';
import type { ModelEscalationDecision, ModelEscalationRequest, Scheduler, SchedulerDecision, Task } from '@wazir/core';

export interface EscalationPlan {
  decision: ModelEscalationDecision;
  /** The scheduler decision behind an accepted escalation. */
  scheduling?: SchedulerDecision;
}

/**
 * Host side of failure-based model escalation for a single execution.
 *
 * Routing stays with the Scheduler: the replacement is its capability-routing
 * choice with every model this run already tried excluded (and any open reliability
 * circuit applied). The execution keeps its placement, so the candidate must be
 * servable right now by the same runtime on the same computer — re-placing a running
 * execution (another computer, a model load) is not done mid-run and is declined with
 * that reason rather than silently attempted. A pinned model is never substituted.
 */
export function planEscalation(
  scheduler: Pick<Scheduler, 'plan'>,
  params: {
    task: Task;
    requiredContextTokens?: number;
    placement: { runtimeId: string; computerId?: string };
    request: ModelEscalationRequest;
  },
): EscalationPlan {
  const { task, placement, request } = params;
  const pinned = task.execution?.targetModelId;
  if (pinned) {
    return { decision: { reason: `task pins model '${pinned}'; no silent substitution` } };
  }
  let next: SchedulerDecision;
  try {
    next = scheduler.plan({
      task: { ...task, execution: { ...task.execution, targetModelId: undefined } },
      requiredContextTokens: params.requiredContextTokens,
      excludeModelIds: request.triedModelIds,
    });
  } catch (error) {
    const reasons = error instanceof SchedulingError ? [...error.modelReasons, ...error.computerReasons] : [];
    const detail = reasons.length ? ` (${reasons.join('; ')})` : '';
    return { decision: { reason: `no alternative model: ${error instanceof Error ? error.message : String(error)}${detail}` } };
  }
  if (next.runtimeId !== placement.runtimeId || (next.computerId ?? undefined) !== (placement.computerId ?? undefined)) {
    return {
      decision: {
        reason: `best alternative '${next.modelId}' runs via '${next.runtimeId}' on '${next.computerId ?? 'hosted'}'; ` +
          'mid-run re-placement is not supported',
      },
    };
  }
  if (next.readiness !== 'READY_NOW') {
    return { decision: { reason: `best alternative '${next.modelId}' is not loaded; mid-run model loading is not supported` } };
  }
  return {
    decision: { modelId: next.modelId, reason: `scheduler: ${next.modelDecision.reasons.join(' | ')}` },
    scheduling: next,
  };
}

/**
 * `AgentRuntime.escalate` for one execution, shared by `wa run` and fleet tasks.
 * Plans through the Scheduler (see planEscalation), records every decision —
 * accepted or declined — as `model.route.changed`, charges an accepted switch to the
 * abandoned model in the circuit breaker, and reports the new model to the caller so
 * later bookkeeping (termination attribution, subagents) follows the switch.
 */
export function createEscalationHandler(
  engine: {
    scheduler: Pick<Scheduler, 'plan'>;
    executions: { recordEvent(executionId: string, type: 'model.route.changed', data?: unknown): Promise<void> };
    reliability?: { recordTermination(modelId: string, taskClass: string, reason: string | undefined): unknown };
  },
  params: {
    executionId: string;
    task: Task;
    requiredContextTokens?: number;
    placement: { runtimeId: string; computerId?: string };
    onEscalated: (request: ModelEscalationRequest, modelId: string) => void;
    onDeclined?: (request: ModelEscalationRequest, reason: string) => void;
  },
): (request: ModelEscalationRequest) => Promise<ModelEscalationDecision> {
  return async (request) => {
    const { decision } = planEscalation(engine.scheduler, {
      task: params.task,
      requiredContextTokens: params.requiredContextTokens,
      placement: params.placement,
      request,
    });
    await engine.executions.recordEvent(params.executionId, 'model.route.changed', {
      previousModel: request.currentModelId,
      newModel: decision.modelId ?? null,
      accepted: Boolean(decision.modelId),
      failureClass: request.failureClass,
      reason: request.reason,
      routeDecision: decision.reason,
      taskClass: params.task.type,
    });
    if (!decision.modelId) {
      params.onDeclined?.(request, decision.reason);
      return decision;
    }
    // The abandoned model failed this task class; the circuit breaker should know.
    engine.reliability?.recordTermination(request.currentModelId, params.task.type, request.failureClass);
    params.onEscalated(request, decision.modelId);
    return decision;
  };
}
