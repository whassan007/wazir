import { effectiveContextTokens, SchedulingError } from '@wazir/core';
import type { ModelEscalationDecision, ModelEscalationRequest, ModelLoadOptions, ModelRecord, Scheduler, SchedulerDecision, Task } from '@wazir/core';

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
 * circuit applied). The choice may keep the current placement or need a new one —
 * another runtime or computer, or a model that must be loaded first; the plan says
 * which, and the handler below prepares it before the switch is accepted. A pinned
 * model is never substituted.
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
  const moves = next.runtimeId !== placement.runtimeId || (next.computerId ?? undefined) !== (placement.computerId ?? undefined);
  const where = `'${next.runtimeId}' on '${next.computerId ?? 'hosted'}'`;
  const placementNote = moves ? `re-placed to ${where}` : `same placement ${where}`;
  const readinessNote = next.readiness === 'READY_NOW' ? 'ready now' : 'must be loaded';
  return {
    decision: { modelId: next.modelId, reason: `scheduler: ${next.modelDecision.reasons.join(' | ')}; ${placementNote}, ${readinessNote}` },
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
    /** The execution's current generation placement (read at each escalation). */
    placement: () => { runtimeId: string; computerId?: string };
    /**
     * Makes the chosen placement serve generation — load the model, check the route
     * exists — and resolves with the context window it will serve. Throwing declines
     * the escalation with that reason; the current model keeps running.
     */
    prepare: (next: SchedulerDecision) => Promise<{ contextTokens: number }>;
    onEscalated: (request: ModelEscalationRequest, next: SchedulerDecision, contextTokens: number) => void;
    onDeclined?: (request: ModelEscalationRequest, reason: string) => void;
  },
): (request: ModelEscalationRequest) => Promise<ModelEscalationDecision> {
  return async (request) => {
    const planned = planEscalation(engine.scheduler, {
      task: params.task,
      requiredContextTokens: params.requiredContextTokens,
      placement: params.placement(),
      request,
    });
    let decision = planned.decision;
    let contextTokens = 0;
    if (planned.scheduling) {
      try {
        ({ contextTokens } = await params.prepare(planned.scheduling));
      } catch (error) {
        decision = { reason: `could not prepare '${planned.scheduling.modelId}': ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    await engine.executions.recordEvent(params.executionId, 'model.route.changed', {
      previousModel: request.currentModelId,
      newModel: decision.modelId ?? null,
      accepted: Boolean(decision.modelId),
      failureClass: request.failureClass,
      reason: request.reason,
      routeDecision: decision.reason,
      taskClass: params.task.type,
      ...(decision.modelId && planned.scheduling
        ? { runtimeId: planned.scheduling.runtimeId, computerId: planned.scheduling.computerId ?? null }
        : {}),
    });
    if (!decision.modelId) {
      params.onDeclined?.(request, decision.reason);
      return decision;
    }
    // The abandoned model failed this task class; the circuit breaker should know.
    engine.reliability?.recordTermination(request.currentModelId, params.task.type, request.failureClass);
    params.onEscalated(request, planned.scheduling!, contextTokens);
    return decision;
  };
}

/**
 * `prepare` for createEscalationHandler: readies a Scheduler placement for generation
 * the same way an execution's initial placement is readied (see run.ts / fleet
 * activation via ModelLifecycleService.ensureReady), and returns the context window it
 * will serve. Throws — declining the escalation — when the placement can't be served:
 * no adapter for a hosted runtime, a remote computer without a control-plane URL, or a
 * load the lifecycle service refuses (admission, resources, runtime health).
 */
export async function prepareGenerationPlacement(
  engine: {
    models: { getRequired(id: string): ModelRecord; instancesOf(id: string): Array<{ id: string; contextTokens?: number }> };
    runtimes: { get(id: string): { runtimeKind?: string } | undefined };
    adapters: { get(id: string): unknown };
    worker: { computerId?: string };
    config: { apiUrl?: string };
    lifecycle: { ensureReady(modelId: string, options: ModelLoadOptions): Promise<{ effectiveContext: number }> };
  },
  next: SchedulerDecision,
  options: { executionId: string; minimumContext: number },
): Promise<{ contextTokens: number }> {
  const record = engine.models.getRequired(next.modelId);
  if (!next.computerId || engine.runtimes.get(next.runtimeId)?.runtimeKind === 'hosted') {
    if (!engine.adapters.get(next.runtimeId)) throw new Error(`no adapter is configured for hosted runtime '${next.runtimeId}'`);
    return { contextTokens: effectiveContextTokens(record) };
  }
  if (next.computerId !== engine.worker.computerId && !engine.config.apiUrl) {
    throw new Error(`'${next.computerId}' is a remote computer and no control-plane API URL is configured (set WAZIR_API_URL)`);
  }
  if (next.readiness === 'READY_NOW') {
    const instance = engine.models.instancesOf(next.modelId).find((i) => i.id === next.modelInstanceId);
    return { contextTokens: instance?.contextTokens ?? effectiveContextTokens(record) };
  }
  const plan = await engine.lifecycle.ensureReady(next.modelId, {
    computerId: next.computerId,
    runtimeId: next.runtimeId,
    minimumContext: options.minimumContext,
    executionId: options.executionId,
    initiator: 'model-escalation',
  });
  return { contextTokens: plan.effectiveContext };
}
