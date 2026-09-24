import { effectiveContextTokens } from '../types/model.js';
import type { Computer } from '../types/computer.js';
import type { ModelInstance, ModelRecord } from '../types/model.js';
import { HOSTED_RUNTIME_TYPES } from '../types/runtime.js';
import type { Task } from '../types/task.js';
import type {
  ComputerRoutingDecision,
  ModelRoutingDecision,
  SchedulerDecision,
} from '../types/scheduler.js';
import { SchedulingError } from '../types/scheduler.js';
import type { AgentRegistry } from './agentRegistry.js';
import type { ComputerRegistry } from './computerRegistry.js';
import type { ModelRegistry } from './modelRegistry.js';
import type { ModelReliabilityTracker } from './modelReliability.js';
import type { PolicyEngine } from './policyEngine.js';
import type { RuntimeRegistry } from './runtimeRegistry.js';

export interface SchedulerDeps {
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  agents?: AgentRegistry;
  /** Gates hosted-provider placement — see `scheduleComputer()`'s hosted branch. */
  policy: PolicyEngine;
  /**
   * Per-(model, task class) circuit breaker. An OPEN circuit removes the model from
   * capability routing for that task class; an explicit pin is still honored (no
   * silent substitution) but the open circuit is stated in the decision reasons.
   */
  reliability?: ModelReliabilityTracker;
}

export interface ScheduleInput {
  task: Task;
  /** Total tokens required (input + output reserve) from the context compiler. */
  requiredContextTokens?: number;
}

interface ScoredModel {
  record: ModelRecord;
  score: number;
  reasons: string[];
  rejected: string[];
}

interface ScoredPlacement {
  instance: ModelInstance;
  /** Absent for a hosted placement (no Computer). */
  computer?: Computer;
  score: number;
  reasons: string[];
}

/**
 * Deterministic two-phase scheduler.
 *
 * Phase 1 — MODEL ROUTING: "which model is appropriate for this task?"
 * Phase 2 — COMPUTER SCHEDULING: "where should that model run?"
 *
 * Rules enforced here:
 * - explicit model/computer pins are hard requirements (no silent fallback)
 * - every decision carries human-readable reasons
 * - ties are broken lexicographically so the same input always yields the same output
 */
export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  plan(input: ScheduleInput): SchedulerDecision {
    const { task } = input;
    const requiredContext = input.requiredContextTokens ?? task.requirements.minimumContext ?? 0;

    let agentId: string | undefined;
    let agentReasons: string[] = [];
    if (this.deps.agents) {
      const resolution = this.deps.agents.resolveForTask(task);
      agentId = resolution.agent.descriptor.name;
      agentReasons = resolution.reasons;
    }

    const modelDecision = this.routeModel(task, requiredContext);
    const record = this.deps.models.getRequired(modelDecision.modelId);
    const instance = this.deps.models
      .instancesOf(record.id)
      .find((i) => i.id === modelDecision.modelInstanceId);
    if (!instance) {
      throw new SchedulingError(`Selected model instance '${modelDecision.modelInstanceId}' is no longer registered`);
    }

    const computerDecision = this.scheduleComputer(task, record);
    const placed = this.deps.models.instancesOf(record.id).find(i => i.runtimeId === computerDecision.runtimeId && i.computerId === computerDecision.computerId)!;
    modelDecision.modelInstanceId = placed.id;

    return {
      agentId,
      modelId: record.id,
      modelInstanceId: placed.id,
      readiness: placed.state === 'READY' ? 'READY_NOW' : 'LOADABLE',
      runtimeId: computerDecision.runtimeId,
      computerId: computerDecision.computerId,
      modelDecision,
      computerDecision,
      reasons: [
        ...agentReasons,
        `model: ${modelDecision.reasons.join(' | ')}`,
        `computer: ${computerDecision.reasons.join(' | ')}`,
      ],
      decidedAt: new Date(),
    };
  }

  // ==================== PHASE 1: MODEL ROUTING ====================

  private routeModel(task: Task, requiredContext: number): ModelRoutingDecision {
    const records = this.deps.models.list();
    if (records.length === 0) {
      throw new SchedulingError('No models are registered', ['model registry is empty']);
    }

    const requiredCapabilities = task.requirements.capabilities ?? [];
    const scored: ScoredModel[] = records.map((record) => this.scoreModel(task, record, requiredContext));

    const eligible = scored.filter((s) => s.rejected.length === 0);
    const rejected = scored.filter((s) => s.rejected.length > 0);

    const preferred = task.execution?.targetModelId;
    if (preferred) {
      const match = eligible.find((s) => s.record.id === preferred);
      if (!match) {
        const detail =
          rejected.find((s) => s.record.id === preferred)?.rejected.join('; ') ??
          `model '${preferred}' is not registered`;
        throw new SchedulingError(
          `Requested model '${preferred}' is not eligible. ${detail}. No silent fallback will be performed.`,
          [detail],
        );
      }
      const instance = this.selectInstance(match.record);
      const circuit = this.deps.reliability?.status(preferred, task.type);
      return {
        modelId: preferred,
        modelInstanceId: instance.id,
        strategy: 'explicit',
        score: match.score,
        reasons: [
          `explicitly requested model '${preferred}'`,
          ...match.reasons,
          ...(circuit && circuit.state !== 'CLOSED' ? [`warning: ${task.type} ${circuit.reason}`] : []),
        ],
      };
    }

    if (eligible.length === 0) {
      throw new SchedulingError(
        'No model satisfies the task requirements. No silent fallback will be performed.',
        rejected.flatMap((s) => [`${s.record.id}: ${s.rejected.join('; ')}`]),
      );
    }

    eligible.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
    const best = eligible[0];
    const instance = this.selectInstance(best.record);

    return {
      modelId: best.record.id,
      modelInstanceId: instance.id,
      strategy: 'capability_match',
      score: best.score,
      reasons: best.reasons,
    };
  }

  private scoreModel(task: Task, record: ModelRecord, requiredContext: number): ScoredModel {
    const reasons: string[] = [];
    const rejected: string[] = [];
    const requiredCapabilities = task.requirements.capabilities ?? [];

    for (const capability of requiredCapabilities) {
      if (record.capabilities.includes(capability)) {
        reasons.push(`${capability} capability: present`);
      } else {
        rejected.push(`${capability} capability: missing`);
      }
    }

    if (task.requirements.toolCalling && !record.toolCalling) {
      rejected.push('tool calling: required but unsupported');
    } else if (task.requirements.toolCalling && record.toolCalling) {
      reasons.push('tool calling: supported');
    }

    if (task.requirements.vision && !record.vision) {
      rejected.push('vision: required but unsupported');
    }
    if (task.requirements.reasoning === 'high' && !record.reasoning) {
      rejected.push('strong reasoning: required but unsupported');
    }

    const context = effectiveContextTokens(record);
    if (requiredContext > 0) {
      if (context >= requiredContext) {
        reasons.push(`context ${context} >= required ${requiredContext}`);
      } else {
        rejected.push(`context ${context} < required ${requiredContext}`);
      }
    }

    // A model only servable by a hosted provider must clear the hosted
    // eligibility gate here in Phase 1, not just in Phase 2's computer
    // placement. Otherwise an ineligible hosted-only model can still be
    // *selected* as the best-scoring candidate (no fallback is performed —
    // see this class's docstring) and only then fail in Phase 2 with a
    // confusing "no computer can host" error, even when a perfectly good
    // local model exists and would have been picked instead.
    if (Array.isArray(record.runtimeCompatibility) && record.runtimeCompatibility.length > 0 &&
        record.runtimeCompatibility.every((t) => HOSTED_RUNTIME_TYPES.has(t))) {
      const gate = this.deps.policy.checkHostedEligibility(task.policy, record.runtimeCompatibility[0]);
      if (!gate.allowed) {
        rejected.push(gate.reason);
      } else {
        reasons.push(gate.reason);
      }
    }

    const circuit = this.deps.reliability?.status(record.id, task.type);
    if (circuit?.state === 'OPEN' && task.execution?.targetModelId !== record.id) {
      rejected.push(`${task.type} ${circuit.reason}`);
    } else if (circuit?.state === 'HALF_OPEN') {
      reasons.push(`${task.type} ${circuit.reason}`);
    }

    if (rejected.length > 0) {
      return { record, score: 0, reasons, rejected };
    }

    let score = 0;
    score += requiredCapabilities.filter((c) => record.capabilities.includes(c)).length * 2;
    if (record.toolCalling) score += 1;
    if (requiredContext > 0 && context >= requiredContext * 2) {
      score += 1;
      reasons.push('context headroom: at least 2x the requirement');
    }

    const loadedInstance = this.deps.models
      .instancesOf(record.id)
      .find((i) => i.loaded && i.health === 'healthy');
    if (loadedInstance) {
      score += 2;
      reasons.push(`instance on '${loadedInstance.computerId ?? loadedInstance.runtimeId}' already loaded`);
    } else if (this.deps.models.instancesOf(record.id).length > 0) {
      reasons.push('available instance will be loaded on demand');
    } else {
      rejected.push('no running instance on any computer');
    }

    return { record, score, reasons, rejected };
  }

  private selectInstance(record: ModelRecord): ModelInstance {
    const instances = this.deps.models.instancesOf(record.id).filter(i => !['DRAINING', 'UNLOADING'].includes(i.state ?? ''));
    if (instances.length === 0) {
      throw new SchedulingError(
        `Model '${record.id}' is registered but has no running instance on any computer`,
        ['model has no instances'],
      );
    }

    const online = new Set(this.deps.computers.listOnline().map((c) => c.id));
    // A hosted instance has no computerId, so it is never a member of `online`
    // by construction (Set.has(undefined) is always false) — treat "no
    // computer to be online" as trivially satisfied for those instances,
    // otherwise every hosted instance would be wrongly excluded from both
    // preference passes below.
    const isOnline = (i: ModelInstance): boolean => !i.computerId || online.has(i.computerId);
    const instance =
      instances.find((i) => i.loaded && i.health === 'healthy' && isOnline(i)) ??
      instances.find((i) => i.health !== 'unavailable' && isOnline(i)) ??
      instances[0];

    return instance;
  }

  // ==================== PHASE 2: COMPUTER SCHEDULING ====================

  private scheduleComputer(task: Task, record: ModelRecord): ComputerRoutingDecision {
    const instances = this.deps.models.instancesOf(record.id);
    const failures: string[] = [];
    const placements: ScoredPlacement[] = [];

    for (const instance of instances) {
      if (['DRAINING', 'UNLOADING', 'LOADING'].includes(instance.state ?? '')) {
        failures.push(`${instance.id}: lifecycle operation in progress`); continue;
      }
      if (task.execution?.targetComputerId && instance.computerId !== task.execution.targetComputerId) continue;
      const runtime = this.deps.runtimes.get(instance.runtimeId);
      const isHosted = runtime?.runtimeKind === 'hosted' || !instance.computerId;

      if (isHosted) {
        const policy = task.policy;
        const gate = this.deps.policy.checkHostedEligibility(policy, instance.runtimeId);
        if (!gate.allowed) {
          failures.push(gate.reason);
          continue;
        }
        // allowedComputers/allowedRuntimes still apply — a hosted provider
        // simply has no computer identity to check against allowedComputers.
        if (policy?.allowedComputers) {
          failures.push(`${instance.runtimeId}: hosted provider has no computer identity, cannot satisfy allowedComputers`);
          continue;
        }
        if (policy?.allowedRuntimes && !policy.allowedRuntimes.includes(instance.runtimeId)) {
          failures.push(`${instance.runtimeId}: not in allowedRuntimes`);
          continue;
        }
        if (!runtime || runtime.health === 'unavailable') {
          failures.push(`${instance.runtimeId}: not authenticated or unreachable (run 'wa auth login ${instance.runtimeId}')`);
          continue;
        }
        if (instance.health === 'unavailable') {
          failures.push(`${instance.runtimeId}: model instance reports unavailable`);
          continue;
        }
        if (record.runtimeCompatibility && record.runtimeCompatibility !== 'any' && Array.isArray(record.runtimeCompatibility)) {
          const runtimeType = runtime.type ?? instance.runtimeId;
          if (!record.runtimeCompatibility.includes(runtimeType as any)) {
            failures.push(`${instance.runtimeId}: runtime type '${runtimeType}' incompatible with model runtimeCompatibility`);
            continue;
          }
        }

        placements.push({
          instance,
          computer: undefined,
          score: runtime.health === 'healthy' ? 2 : 1,
          reasons: [`hosted provider '${instance.runtimeId}' authenticated and eligible`, gate.reason],
        });
        continue;
      }

      const computer = this.deps.computers.get(instance.computerId!);
      if (!computer || computer.status !== 'online') {
        failures.push(`${instance.computerId}: computer is offline or unknown`);
        continue;
      }

      const policy = task.policy;
      if (policy?.allowedComputers && !policy.allowedComputers.includes(computer.id)) {
        failures.push(`${computer.id}: not in allowedComputers`);
        continue;
      }
      if (policy?.localOnly && !computer.local) {
        failures.push(`${computer.id}: local-only policy requires a local computer`);
        continue;
      }
      if (policy?.allowedRuntimes && !policy.allowedRuntimes.includes(instance.runtimeId)) {
        failures.push(`${computer.id}: runtime '${instance.runtimeId}' not in allowedRuntimes`);
        continue;
      }

      if (runtime && runtime.health === 'unavailable') {
        failures.push(`${computer.id}: runtime '${runtime.id}' is unavailable`);
        continue;
      }
      if (instance.health === 'unavailable') {
        failures.push(`${computer.id}: model instance reports unavailable`);
        continue;
      }

      if (record.runtimeCompatibility && record.runtimeCompatibility !== 'any' && Array.isArray(record.runtimeCompatibility)) {
        const runtimeType = runtime?.type ?? instance.runtimeId;
        if (!record.runtimeCompatibility.includes(runtimeType as any)) {
          failures.push(`${computer.id}: runtime type '${runtimeType}' incompatible with model runtimeCompatibility`);
          continue;
        }
      }

      const requiredSystemGB = record.memory?.minSystemGB ?? 0;
      if (requiredSystemGB > computer.hardware.memoryGB) {
        failures.push(`${computer.id}: memory ${computer.hardware.memoryGB}GB < required ${requiredSystemGB}GB`);
        continue;
      }

      if (!instance.loaded && computer.load?.memoryAvailableGB !== undefined && requiredSystemGB > computer.load.memoryAvailableGB) {
        failures.push(`${computer.id}: available memory ${computer.load.memoryAvailableGB}GB < required ${requiredSystemGB}GB`);
        continue;
      }

      const requiredGpuGB = record.memory?.minGpuGB ?? 0;
      if (requiredGpuGB > 0) {
        const gpuGB = computer.hardware.gpu?.memoryGB ?? 0;
        if (gpuGB < requiredGpuGB) {
          failures.push(`${computer.id}: GPU memory ${gpuGB}GB < required ${requiredGpuGB}GB`);
          continue;
        }
      }

      const reasons: string[] = [];
      let score = instance.health === 'healthy' ? 1 : 0;

      if (instance.state === 'READY') {
        score += 2;
        reasons.push(`model already loaded via '${instance.runtimeId}' (no load latency)`);
      } else {
        reasons.push(`model will be loaded via '${instance.runtimeId}'`);
      }

      const cpuPercent = computer.load?.cpuPercent ?? 0;
      score += Math.max(0, 1 - cpuPercent / 100);
      reasons.push(`current CPU load ${Math.round(cpuPercent)}%`);

      if (computer.load?.memoryAvailableGB !== undefined) {
        reasons.push(`available RAM ${computer.load.memoryAvailableGB}GB`);
        if (requiredSystemGB > 0 && computer.load.memoryAvailableGB >= requiredSystemGB * 2) {
          score += 0.5;
        }
      }

      if (computer.local) {
        score += 1;
        reasons.push('local computer (lowest latency)');
      }

      if (runtime?.health === 'healthy') {
        score += 1;
        reasons.push(`runtime '${runtime.id}' is healthy`);
      }

      if (computer.health === 'degraded') {
        score -= 1;
        reasons.push('computer reports degraded health');
      }

      placements.push({ instance, computer, score, reasons });
    }

    if (placements.length === 0) {
      const details = failures.length > 0 ? ` ${failures.join('; ')}.` : '';
      throw new SchedulingError(
        `No computer can host model '${record.id}'.${details} No silent fallback will be performed.`,
        [],
        failures,
      );
    }

    placements.sort(
      (a, b) => b.score - a.score || (a.computer?.id ?? a.instance.runtimeId).localeCompare(b.computer?.id ?? b.instance.runtimeId),
    );
    const best = placements[0];

    return {
      computerId: best.computer?.id,
      runtimeId: best.instance.runtimeId,
      placementKind: best.computer ? 'local' : 'hosted',
      score: best.score,
      reasons: best.reasons,
    };
  }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  return new Scheduler(deps);
}
