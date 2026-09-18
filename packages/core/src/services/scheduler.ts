import { effectiveContextTokens } from '../types/model.js';
import type { Computer } from '../types/computer.js';
import type { ModelInstance, ModelRecord } from '../types/model.js';
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
import type { RuntimeRegistry } from './runtimeRegistry.js';

export interface SchedulerDeps {
  computers: ComputerRegistry;
  runtimes: RuntimeRegistry;
  models: ModelRegistry;
  agents?: AgentRegistry;
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
  computer: Computer;
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

    return {
      agentId,
      modelId: record.id,
      modelInstanceId: instance.id,
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
      return {
        modelId: preferred,
        modelInstanceId: instance.id,
        strategy: 'explicit',
        score: match.score,
        reasons: [`explicitly requested model '${preferred}'`, ...match.reasons],
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
      reasons.push(`instance on '${loadedInstance.computerId}' already loaded`);
    } else if (this.deps.models.instancesOf(record.id).length > 0) {
      reasons.push('available instance will be loaded on demand');
    } else {
      rejected.push('no running instance on any computer');
    }

    return { record, score, reasons, rejected };
  }

  private selectInstance(record: ModelRecord): ModelInstance {
    const instances = this.deps.models.instancesOf(record.id);
    if (instances.length === 0) {
      throw new SchedulingError(
        `Model '${record.id}' is registered but has no running instance on any computer`,
        ['model has no instances'],
      );
    }

    const online = new Set(this.deps.computers.listOnline().map((c) => c.id));
    const instance =
      instances.find((i) => i.loaded && i.health === 'healthy' && online.has(i.computerId)) ??
      instances.find((i) => i.health !== 'unavailable' && online.has(i.computerId)) ??
      instances[0];

    return instance;
  }

  // ==================== PHASE 2: COMPUTER SCHEDULING ====================

  private scheduleComputer(task: Task, record: ModelRecord): ComputerRoutingDecision {
    const instances = this.deps.models.instancesOf(record.id);
    const failures: string[] = [];
    const placements: ScoredPlacement[] = [];

    for (const instance of instances) {
      const computer = this.deps.computers.get(instance.computerId);
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

      const runtime = this.deps.runtimes.get(instance.runtimeId);
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
      let score = 0;

      if (instance.loaded) {
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
      (a, b) => b.score - a.score || a.computer.id.localeCompare(b.computer.id),
    );
    const best = placements[0];

    return {
      computerId: best.computer.id,
      runtimeId: best.instance.runtimeId,
      score: best.score,
      reasons: best.reasons,
    };
  }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  return new Scheduler(deps);
}
