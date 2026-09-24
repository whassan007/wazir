import type { KeyValueStore } from '@wazir/shared';
import type { ExecutionRecord } from '../types/execution.js';
import type { BenchmarkRunResult, BenchmarkTask } from '../types/benchmark.js';
import {
  MODEL_CAPABILITY_CATEGORIES,
  type ModelCapabilityCategory,
  type ExecutionPhase,
  type ProgrammingLanguage,
  type ProfileSegmentationKey,
  type CategoryMeasurement,
  type ConditionalMeasurement,
  type ModelCapabilityProfile,
} from '../types/modelIntelligence.js';
import { TaskCapabilityClassifier } from './taskCapabilityClassifier.js';

export interface ModelIntelligenceServiceOptions {
  store?: KeyValueStore;
  classifier?: TaskCapabilityClassifier;
  defaultProtocolVersion?: string;
}

export class ModelIntelligenceService {
  private readonly store?: KeyValueStore;
  private readonly classifier: TaskCapabilityClassifier;
  private readonly defaultProtocolVersion: string;

  /** In-memory profile storage indexed by composite segmentation key. */
  private readonly profiles = new Map<string, ModelCapabilityProfile>();

  /** Deduplication set to avoid double-counting retries or duplicated provenance. */
  private readonly processedExecutionIds = new Set<string>();

  constructor(options: ModelIntelligenceServiceOptions = {}) {
    this.store = options.store;
    this.classifier = options.classifier ?? new TaskCapabilityClassifier();
    this.defaultProtocolVersion = options.defaultProtocolVersion ?? '1.0.0';
  }

  /**
   * Deterministic composite segmentation key.
   * Ensures evidence is segregated by model version, runtime, quantization, and protocol.
   */
  public getSegmentKey(key: ProfileSegmentationKey): string {
    const model = key.model;
    const version = key.modelVersion ?? 'default';
    const runtime = key.runtime;
    const quant = key.quantization ?? 'default';
    const proto = key.wazirProtocolVersion || this.defaultProtocolVersion;
    return `${model}::${version}::${runtime}::${quant}::${proto}`;
  }

  /**
   * Retrieves an empirical capability profile for the specified segmentation.
   * Enforces Gate 56 Drift Invariant: If a model or runtime has changed version,
   * stale evidence is NEVER silently returned as current evidence.
   */
  public getProfile(key: ProfileSegmentationKey): ModelCapabilityProfile | undefined {
    const targetKey = this.getSegmentKey(key);
    const exact = this.profiles.get(targetKey);
    if (exact) {
      return exact;
    }

    // Check if there is an existing profile for the same model/runtime with a DIFFERENT version (drift)
    for (const [existingKey, prof] of this.profiles.entries()) {
      if (prof.model === key.model && prof.runtime === key.runtime) {
        if (
          prof.modelVersion !== (key.modelVersion ?? 'default') ||
          prof.quantization !== (key.quantization ?? 'default') ||
          prof.wazirProtocolVersion !== (key.wazirProtocolVersion || this.defaultProtocolVersion)
        ) {
          // Stale profile detected! Return it with explicit staleness annotation
          return {
            ...prof,
            isStale: true,
            staleReason: `Profile configuration drift: existing profile [ver=${prof.modelVersion}, quant=${prof.quantization}, proto=${prof.wazirProtocolVersion}] does not match requested [ver=${key.modelVersion ?? 'default'}, quant=${key.quantization ?? 'default'}, proto=${key.wazirProtocolVersion}]`,
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Lists all tracked capability profiles.
   */
  public listProfiles(): ModelCapabilityProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Online Learning: Records verified execution evidence into the model profile.
   * Deduplicates execution IDs to avoid double-counting retries or duplicate provenance.
   */
  public recordExecution(
    record: ExecutionRecord,
    segment: ProfileSegmentationKey,
  ): ModelCapabilityProfile {
    const execId = record.execution?.id;
    if (execId && this.processedExecutionIds.has(execId)) {
      // Deduplication guard: ignore already counted execution
      const existing = this.getProfile(segment);
      if (existing) return existing;
    }
    if (execId) {
      this.processedExecutionIds.add(execId);
    }

    const profile = this.getOrCreateProfile(segment);

    // 1. Classify task requirements
    const classification = this.classifier.classify(record.task);
    const category = classification.primaryCategory;
    const phase = classification.phase ?? 'ACT';
    const language = classification.language ?? 'other';

    // 2. Assess physical verification outcome
    const checks = record.checks ?? [];
    const checksPassed = checks.length > 0 && checks.every((c) => c.ok);
    const errors = record.errors ?? [];
    const filesChanged = record.filesChanged ?? [];
    const isSuccess = checksPassed && errors.length === 0 && filesChanged.length > 0;

    // 3. Extract fine-grained performance facts
    const buildCheck = checks.find((c) => c.name === 'build' || c.name === 'typecheck');
    const testCheck = checks.find((c) => c.name === 'test');
    const firstPass = buildCheck ? buildCheck.ok : checksPassed;
    const repairCycles = record.events
      ? record.events.filter((e) => (e.type || (e as { eventType?: string }).eventType) === 'repair.cycle').length
      : 0;

    const protocolFailures = errors.filter((e) =>
      /protocol|schema|malformed|unparseable|invalid action/i.test(e),
    ).length;

    const toolCalls = record.toolCalls ?? [];
    const failedTools = toolCalls.filter((t) => !t.ok).length;
    const toolErrorRate = toolCalls.length > 0 ? failedTools / toolCalls.length : 0;

    const totalTokens = (record.usage?.input ?? 0) + (record.usage?.output ?? 0);
    const tokenEfficiency = totalTokens > 0 ? totalTokens / Math.max(1, toolCalls.length) : null;

    // 4. Update Primary Category Measurement
    this.updateMeasurement(profile, category, {
      success: isSuccess,
      firstPass,
      repairCycles,
      protocolFailures,
      toolErrorRate,
      tokenEfficiency,
    });

    // 5. Update secondary categories where evidence was directly observed
    if (buildCheck && !buildCheck.ok && category !== 'compile_repair') {
      this.updateMeasurement(profile, 'compile_repair', { success: false, repairCycles: 1 });
    } else if (buildCheck && buildCheck.ok && repairCycles > 0 && category !== 'compile_repair') {
      this.updateMeasurement(profile, 'compile_repair', { success: true, repairCycles });
    }

    if (testCheck && !testCheck.ok && category !== 'test_repair') {
      this.updateMeasurement(profile, 'test_repair', { success: false });
    }

    if (toolCalls.length > 0 && category !== 'tool_use') {
      this.updateMeasurement(profile, 'tool_use', {
        success: failedTools === 0,
        toolErrorRate,
      });
    }

    if (protocolFailures > 0 && category !== 'structured_action_reliability') {
      this.updateMeasurement(profile, 'structured_action_reliability', {
        success: false,
        protocolFailures,
      });
    }

    // 6. Update Conditional Measurements (Phase & Language)
    this.updateConditionalMeasurement(profile, 'phase', phase, category, isSuccess);
    if (language !== 'other') {
      this.updateConditionalMeasurement(profile, 'language', language, category, isSuccess);
    }

    // 7. Update profile aggregates
    profile.sampleCounts.total += 1;
    if (isSuccess) {
      profile.sampleCounts.verifiedSuccess += 1;
    } else {
      profile.sampleCounts.failed += 1;
    }
    profile.sampleCounts.byCategory[category] =
      (profile.sampleCounts.byCategory[category] ?? 0) + 1;

    profile.confidence = this.computeConfidence(profile.sampleCounts.total);
    profile.lastUpdated = new Date();

    return profile;
  }

  /**
   * Updates model capability profile from benchmark task results.
   */
  public recordBenchmarkResult(
    result: BenchmarkRunResult,
    task: BenchmarkTask,
    segment: ProfileSegmentationKey,
  ): ModelCapabilityProfile {
    const profile = this.getOrCreateProfile(segment);
    const category = this.mapBenchmarkCategory(task);
    const isSuccess = result.scoreReport.passed;

    const metrics = result.scoreReport.metrics;
    this.updateMeasurement(profile, category, {
      success: isSuccess,
      firstPass: isSuccess && (metrics.repairCycles ?? 0) === 0,
      repairCycles: metrics.repairCycles ?? 0,
      protocolFailures: 0,
      toolErrorRate: 0,
      tokenEfficiency: metrics.compactedTokens ?? null,
      latencyMs: metrics.modelLatencyMs ?? null,
    });

    profile.sampleCounts.total += 1;
    if (isSuccess) {
      profile.sampleCounts.verifiedSuccess += 1;
    } else {
      profile.sampleCounts.failed += 1;
    }
    profile.sampleCounts.byCategory[category] =
      (profile.sampleCounts.byCategory[category] ?? 0) + 1;

    profile.confidence = this.computeConfidence(profile.sampleCounts.total);
    profile.lastUpdated = new Date();

    return profile;
  }

  private mapBenchmarkCategory(task: BenchmarkTask): ModelCapabilityCategory {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    if (meta.capabilityCategory && typeof meta.capabilityCategory === 'string') {
      return meta.capabilityCategory as ModelCapabilityCategory;
    }
    switch (task.category) {
      case 'CODE_REPAIR':
        return 'compile_repair';
      case 'REPOSITORY_NAVIGATION':
        return 'repository_navigation';
      case 'CODE_INTELLIGENCE':
        return 'code_comprehension';
      case 'TOOL_USE':
        return 'tool_use';
      case 'CONTEXT_STRESS':
        return 'context_efficiency';
      case 'FEATURE_IMPLEMENTATION':
      default:
        return 'implementation';
    }
  }

  private getOrCreateProfile(segment: ProfileSegmentationKey): ModelCapabilityProfile {
    const key = this.getSegmentKey(segment);
    let prof = this.profiles.get(key);
    if (!prof) {
      const initialMeasurements: CategoryMeasurement[] = MODEL_CAPABILITY_CATEGORIES.map((cat) => ({
        category: cat,
        score: 0.5, // Unmeasured neutral baseline
        sampleCount: 0,
        verifiedSuccessCount: 0,
        failureCount: 0,
        confidence: 0,
        metrics: {
          successRate: 0,
          firstPassRate: null,
          avgRepairCycles: null,
          protocolFailureRate: 0,
          avgTokenEfficiency: null,
          toolErrorRate: 0,
          avgLatencyMs: null,
        },
        lastEvaluated: new Date(),
      }));

      prof = {
        id: key,
        model: segment.model,
        runtime: segment.runtime,
        quantization: segment.quantization ?? 'default',
        hardwareClass: segment.hardwareClass ?? 'local',
        modelVersion: segment.modelVersion ?? 'default',
        wazirProtocolVersion: segment.wazirProtocolVersion || this.defaultProtocolVersion,
        categoryMeasurements: initialMeasurements,
        conditionalMeasurements: {
          byPhase: {},
          byLanguage: {},
        },
        sampleCounts: {
          total: 0,
          verifiedSuccess: 0,
          failed: 0,
          byCategory: {
            repository_navigation: 0,
            code_comprehension: 0,
            architecture_reasoning: 0,
            bug_localization: 0,
            implementation: 0,
            compile_repair: 0,
            test_repair: 0,
            tool_use: 0,
            structured_action_reliability: 0,
            long_horizon_execution: 0,
            context_efficiency: 0,
            delegation: 0,
            verification_reasoning: 0,
          },
        },
        confidence: 0,
        lastUpdated: new Date(),
      };
      this.profiles.set(key, prof);
    }
    return prof;
  }

  private updateMeasurement(
    profile: ModelCapabilityProfile,
    category: ModelCapabilityCategory,
    obs: {
      success: boolean;
      firstPass?: boolean;
      repairCycles?: number;
      protocolFailures?: number;
      toolErrorRate?: number;
      tokenEfficiency?: number | null;
      latencyMs?: number | null;
    },
  ): void {
    let m = profile.categoryMeasurements.find((item) => item.category === category);
    if (!m) {
      m = {
        category,
        score: 0.5,
        sampleCount: 0,
        verifiedSuccessCount: 0,
        failureCount: 0,
        confidence: 0,
        metrics: {
          successRate: 0,
          firstPassRate: null,
          avgRepairCycles: null,
          protocolFailureRate: 0,
          avgTokenEfficiency: null,
          toolErrorRate: 0,
          avgLatencyMs: null,
        },
        lastEvaluated: new Date(),
      };
      profile.categoryMeasurements.push(m);
    }

    const n = m.sampleCount;
    m.sampleCount += 1;
    if (obs.success) {
      m.verifiedSuccessCount += 1;
    } else {
      m.failureCount += 1;
    }

    const succRate = m.verifiedSuccessCount / m.sampleCount;
    m.metrics.successRate = Number(succRate.toFixed(3));

    if (obs.firstPass !== undefined) {
      const prevFirst = m.metrics.firstPassRate ?? (obs.firstPass ? 1 : 0);
      m.metrics.firstPassRate = Number(((prevFirst * n + (obs.firstPass ? 1 : 0)) / (n + 1)).toFixed(3));
    }

    if (obs.repairCycles !== undefined) {
      const prevCycles = m.metrics.avgRepairCycles ?? obs.repairCycles;
      m.metrics.avgRepairCycles = Number(((prevCycles * n + obs.repairCycles) / (n + 1)).toFixed(2));
    }

    if (obs.protocolFailures !== undefined) {
      const prevProto = m.metrics.protocolFailureRate ?? 0;
      m.metrics.protocolFailureRate = Number(((prevProto * n + (obs.protocolFailures > 0 ? 1 : 0)) / (n + 1)).toFixed(3));
    }

    if (obs.toolErrorRate !== undefined) {
      const prevToolErr = m.metrics.toolErrorRate ?? 0;
      m.metrics.toolErrorRate = Number(((prevToolErr * n + obs.toolErrorRate) / (n + 1)).toFixed(3));
    }

    m.confidence = this.computeConfidence(m.sampleCount);
    m.score = this.computeScore(m);
    m.lastEvaluated = new Date();
  }

  private updateConditionalMeasurement(
    profile: ModelCapabilityProfile,
    dimension: 'phase' | 'language',
    dimKey: string,
    category: ModelCapabilityCategory,
    isSuccess: boolean,
  ): void {
    const store =
      dimension === 'phase'
        ? profile.conditionalMeasurements.byPhase
        : profile.conditionalMeasurements.byLanguage;

    if (!store[dimKey]) {
      store[dimKey] = [];
    }

    let cm = store[dimKey].find((item) => item.category === category);
    if (!cm) {
      cm = {
        dimension,
        key: dimKey,
        category,
        score: isSuccess ? 1.0 : 0.0,
        sampleCount: 1,
        verifiedSuccessCount: isSuccess ? 1 : 0,
        failureCount: isSuccess ? 0 : 1,
        confidence: this.computeConfidence(1),
        lastEvaluated: new Date(),
      };
      store[dimKey].push(cm);
      return;
    }

    cm.sampleCount += 1;
    if (isSuccess) {
      cm.verifiedSuccessCount += 1;
    } else {
      cm.failureCount += 1;
    }
    cm.score = Number((cm.verifiedSuccessCount / cm.sampleCount).toFixed(3));
    cm.confidence = this.computeConfidence(cm.sampleCount);
    cm.lastEvaluated = new Date();
  }

  private computeScore(m: CategoryMeasurement): number {
    const successRate = m.sampleCount > 0 ? m.verifiedSuccessCount / m.sampleCount : 0.5;
    const firstPass = m.metrics.firstPassRate ?? successRate;
    const repairCycles = m.metrics.avgRepairCycles ?? 0;
    const repairCycleFactor = Math.max(0, 1 - repairCycles / 5);
    const protocolFactor = 1 - (m.metrics.protocolFailureRate ?? 0);
    const toolFactor = 1 - (m.metrics.toolErrorRate ?? 0);

    const raw =
      successRate * 0.5 +
      firstPass * 0.2 +
      repairCycleFactor * 0.15 +
      protocolFactor * 0.1 +
      toolFactor * 0.05;

    return Number(Math.min(1.0, Math.max(0.0, raw)).toFixed(3));
  }

  private computeConfidence(sampleCount: number): number {
    if (sampleCount <= 0) return 0;
    // Asymptotic confidence curve based on sample volume:
    // 1 sample -> ~0.25, 3 samples -> ~0.50, 10 samples -> ~0.77, 30 samples -> ~0.91
    return Number((1 - 1 / Math.sqrt(1 + sampleCount / 1.5)).toFixed(3));
  }
}
