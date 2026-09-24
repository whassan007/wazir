import { randomUUID } from 'node:crypto';
import type {
  OptimizableConfig,
  SelfImprovementDomain,
  MeasurableMetricName,
  Mutation,
  ConfigMutation,
  CandidateImplementation,
  MetaOptimizationCandidate,
  AblationPlan,
  AblationConfiguration,
  AblationRunResult,
  AblationExperimentDesign,
  CausalAttributionVerdict,
  MutationAttribution,
  InteractionEffect,
  CausalAttributionReport,
  MutationMemoryRecord,
} from '@wazir/core';
import type { KeyValueStore } from '@wazir/shared';
import type { MemoryService } from '@wazir/memory';

/**
 * Normalizes any mutation (Mutation or ConfigMutation) into standard Mutation representation.
 */
export function normalizeMutation(
  raw: ConfigMutation | Mutation,
  domain: SelfImprovementDomain = 'context_policy',
  fallbackId?: string,
): Mutation {
  const isMutation = 'target' in raw && 'id' in raw;
  if (isMutation) {
    return {
      id: raw.id,
      domain: raw.domain ?? domain,
      target: raw.target,
      before: raw.before,
      after: raw.after,
      rationale: raw.rationale,
    };
  }

  const cm = raw as ConfigMutation;
  const target = cm.path;
  const id = fallbackId ?? `mut-${target.replace(/\./g, '_')}-${randomUUID().slice(0, 6)}`;
  let derivedDomain: SelfImprovementDomain = domain;
  if (target.startsWith('routingRules')) derivedDomain = 'routing';
  else if (target.startsWith('toolPolicies')) derivedDomain = 'tool_surfaces';
  else if (target.startsWith('prompts')) derivedDomain = 'prompts';
  else if (target.startsWith('contextWeights')) derivedDomain = 'context_policy';
  else if (target.startsWith('governanceLimits')) derivedDomain = 'orchestration';

  return {
    id,
    domain: derivedDomain,
    target,
    before: cm.oldValue,
    after: cm.newValue,
    rationale: cm.rationale,
  };
}

/**
 * Applies a Mutation or ConfigMutation cleanly onto an OptimizableConfig.
 */
export function applyMutation(
  config: OptimizableConfig,
  mutation: Mutation | ConfigMutation,
): OptimizableConfig {
  const clone = structuredClone(config);
  const target = 'target' in mutation ? mutation.target : (mutation as ConfigMutation).path;
  const value = 'after' in mutation ? mutation.after : (mutation as ConfigMutation).newValue;

  const parts = target.split('.');
  let curr: any = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    curr[parts[i]] = curr[parts[i]] ?? {};
    curr = curr[parts[i]];
  }
  curr[parts[parts.length - 1]] = value;
  return clone;
}

export interface CausalAttributionOptions {
  minSampleSize?: number;
  significanceThreshold?: number;
  interactionThresholdRatio?: number;
  store?: KeyValueStore;
  memoryService?: MemoryService;
}

export class CausalAttributionService {
  private readonly minSampleSize: number;
  private readonly significanceThreshold: number;
  private readonly interactionThresholdRatio: number;
  private readonly store?: KeyValueStore;
  private readonly memoryService?: MemoryService;
  private readonly memory = new Map<string, MutationMemoryRecord>();

  constructor(options: CausalAttributionOptions = {}) {
    this.minSampleSize = options.minSampleSize ?? 2;
    this.significanceThreshold = options.significanceThreshold ?? 0.05; // 5% relative delta
    this.interactionThresholdRatio = options.interactionThresholdRatio ?? 0.5; // 50% non-additive deviation
    this.store = options.store;
    this.memoryService = options.memoryService;
  }

  /**
   * Constructs a bounded ablation experiment plan for a multi-mutation candidate.
   * - K <= 3: Full factorial (2^K combinations) to measure all main effects and interactions.
   * - K > 3: Fractional factorial (2K + 1 bounded combinations: Baseline + OFAT singletons + LOO sets + Full).
   */
  public designAblation(params: {
    experimentId: string;
    candidate: CandidateImplementation | MetaOptimizationCandidate;
    baselineConfig: OptimizableConfig;
    design?: AblationExperimentDesign;
    maxConfigurations?: number;
  }): AblationPlan {
    const { experimentId, candidate, baselineConfig } = params;
    const rawMutations = candidate.mutations ?? [];
    const allMutations: Mutation[] = rawMutations.map((m, idx) =>
      normalizeMutation(m, 'context_policy', `mut-${idx + 1}`),
    );

    const k = allMutations.length;
    let design: AblationExperimentDesign = params.design ?? (k <= 3 ? 'FULL_FACTORIAL' : 'FRACTIONAL_FACTORIAL');
    if (params.maxConfigurations && Math.pow(2, k) > params.maxConfigurations) {
      design = 'FRACTIONAL_FACTORIAL';
    }

    const configurations: AblationConfiguration[] = [];

    if (design === 'FULL_FACTORIAL') {
      // 2^K combinations
      const totalCombinations = 1 << k;
      for (let mask = 0; mask < totalCombinations; mask++) {
        const activeMutations: Mutation[] = [];
        const activeIds: string[] = [];

        for (let bit = 0; bit < k; bit++) {
          if ((mask & (1 << bit)) !== 0) {
            activeMutations.push(allMutations[bit]);
            activeIds.push(allMutations[bit].id);
          }
        }

        let config = structuredClone(baselineConfig);
        for (const m of activeMutations) {
          config = applyMutation(config, m);
        }

        const label =
          activeIds.length === 0
            ? 'Baseline (∅)'
            : activeIds.length === k
              ? 'Full Candidate'
              : activeIds.join('+');

        configurations.push({
          configId: `sub-${experimentId}-${mask.toString(16)}`,
          mutationIds: activeIds,
          label,
          config,
        });
      }
    } else {
      // FRACTIONAL_FACTORIAL (OFAT + LOO + Full + Baseline = 2K + 1 bounded design)
      // 1. Baseline
      configurations.push({
        configId: `sub-${experimentId}-base`,
        mutationIds: [],
        label: 'Baseline (∅)',
        config: structuredClone(baselineConfig),
      });

      // 2. OFAT (One-Factor-At-A-Time): Singletons
      for (let i = 0; i < k; i++) {
        const m = allMutations[i];
        const config = applyMutation(baselineConfig, m);
        configurations.push({
          configId: `sub-${experimentId}-ofat-${m.id}`,
          mutationIds: [m.id],
          label: `OFAT: ${m.id}`,
          config,
        });
      }

      // 3. LOO (Leave-One-Out): All except one
      if (k > 2) {
        for (let i = 0; i < k; i++) {
          const omitted = allMutations[i];
          const activeMutations = allMutations.filter((_, idx) => idx !== i);
          const activeIds = activeMutations.map((m) => m.id);

          let config = structuredClone(baselineConfig);
          for (const m of activeMutations) {
            config = applyMutation(config, m);
          }

          configurations.push({
            configId: `sub-${experimentId}-loo-${omitted.id}`,
            mutationIds: activeIds,
            label: `LOO: omit ${omitted.id}`,
            config,
          });
        }
      }

      // 4. Full Candidate
      let fullConfig = structuredClone(baselineConfig);
      for (const m of allMutations) {
        fullConfig = applyMutation(fullConfig, m);
      }
      configurations.push({
        configId: `sub-${experimentId}-full`,
        mutationIds: allMutations.map((m) => m.id),
        label: 'Full Candidate',
        config: fullConfig,
      });
    }

    return {
      experimentId,
      candidateId: candidate.candidateId,
      allMutations,
      design,
      configurations,
      createdAt: new Date(),
    };
  }

  /**
   * Analyzes ablation benchmark measurements to determine conservative causal attribution
   * and identify interactions without jumping to unfounded conclusions.
   */
  public analyzeAttribution(params: {
    plan: AblationPlan;
    baselineValue: number;
    results: Map<
      string,
      {
        metricValue: number;
        sampleCount: number;
        passRate?: number;
      }
    >;
    primaryMetric: MeasurableMetricName;
    direction?: 'decrease' | 'increase';
    minSampleSize?: number;
    significanceThreshold?: number;
  }): CausalAttributionReport {
    const { plan, baselineValue, results, primaryMetric } = params;
    const direction = params.direction ?? 'decrease';
    const minSampleSize = params.minSampleSize ?? this.minSampleSize;
    const sigThreshold = params.significanceThreshold ?? this.significanceThreshold;

    const ablationRuns: AblationRunResult[] = [];
    const configMap = new Map<string, AblationConfiguration>();
    for (const c of plan.configurations) {
      configMap.set(c.configId, c);
    }

    // Map mutation subset signature (sorted IDs joined by '+') -> metricValue & sampleCount
    const signatureMap = new Map<
      string,
      { metricValue: number; deltaVsBaseline: number; sampleCount: number; passRate: number }
    >();

    for (const [configId, res] of results.entries()) {
      const config = configMap.get(configId);
      const activeIds = config?.mutationIds ?? [];
      const sig = [...activeIds].sort().join('+');

      // Relative delta vs baseline: positive means favorable improvement in specified direction
      let rawDelta = 0;
      if (baselineValue !== 0) {
        if (direction === 'decrease') {
          rawDelta = (baselineValue - res.metricValue) / Math.abs(baselineValue);
        } else {
          rawDelta = (res.metricValue - baselineValue) / Math.abs(baselineValue);
        }
      }

      const runResult: AblationRunResult = {
        subCandidateId: configId,
        activeMutationIds: activeIds,
        metricValue: res.metricValue,
        deltaVsBaseline: rawDelta,
        sampleCount: res.sampleCount,
        passRate: res.passRate ?? 1.0,
      };

      ablationRuns.push(runResult);
      signatureMap.set(sig, {
        metricValue: res.metricValue,
        deltaVsBaseline: rawDelta,
        sampleCount: res.sampleCount,
        passRate: res.passRate ?? 1.0,
      });
    }

    // Full candidate delta
    const allSig = plan.allMutations.map((m) => m.id).sort().join('+');
    const fullRes = signatureMap.get(allSig);
    const candidateValue = fullRes?.metricValue ?? baselineValue;
    const candidateDelta = fullRes?.deltaVsBaseline ?? 0;

    // Detect pairwise interactions
    const interactions: InteractionEffect[] = [];
    const interactionPartnersMap = new Map<string, Set<string>>();

    for (let i = 0; i < plan.allMutations.length; i++) {
      for (let j = i + 1; j < plan.allMutations.length; j++) {
        const idA = plan.allMutations[i].id;
        const idB = plan.allMutations[j].id;

        const resA = signatureMap.get(idA);
        const resB = signatureMap.get(idB);
        const pairSig = [idA, idB].sort().join('+');
        const resPair = signatureMap.get(pairSig);

        if (resA && resB && resPair) {
          const sampleA = resA.sampleCount;
          const sampleB = resB.sampleCount;
          const samplePair = resPair.sampleCount;

          if (sampleA < minSampleSize || sampleB < minSampleSize || samplePair < minSampleSize) {
            interactions.push({
              mutationIds: [idA, idB],
              individualEffects: { [idA]: resA.deltaVsBaseline, [idB]: resB.deltaVsBaseline },
              jointEffect: resPair.deltaVsBaseline,
              interactionMagnitude: 0,
              verdict: 'INSUFFICIENT_EVIDENCE',
              description: `Sample size (${Math.min(sampleA, sampleB, samplePair)}) below threshold ${minSampleSize}`,
            });
            continue;
          }

          const effectA = resA.deltaVsBaseline;
          const effectB = resB.deltaVsBaseline;
          const jointEffect = resPair.deltaVsBaseline;
          const expectedAdditive = effectA + effectB;
          const interactionMagnitude = jointEffect - expectedAdditive;

          // Synergy detection: individual effects are negligible (near zero), but joint effect is substantial improvement!
          const isSynergy =
            Math.abs(effectA) < sigThreshold &&
            Math.abs(effectB) < sigThreshold &&
            jointEffect >= sigThreshold * 1.5;

          // Severe non-linear deviation
          const isSubstantialInteraction =
            isSynergy ||
            (Math.abs(interactionMagnitude) > sigThreshold * 1.5 &&
              Math.abs(interactionMagnitude) > Math.abs(expectedAdditive) * this.interactionThresholdRatio);

          if (isSubstantialInteraction) {
            interactions.push({
              mutationIds: [idA, idB],
              individualEffects: { [idA]: effectA, [idB]: effectB },
              jointEffect,
              interactionMagnitude,
              verdict: 'INTERACTION_DETECTED',
              description: isSynergy
                ? `Synergy detected: neither ${idA} (${(effectA * 100).toFixed(1)}%) nor ${idB} (${(effectB * 100).toFixed(1)}%) improved independently, but jointly produced ${(jointEffect * 100).toFixed(1)}% improvement.`
                : `Interaction detected: joint effect (${(jointEffect * 100).toFixed(1)}%) diverges from additive expectation (${(expectedAdditive * 100).toFixed(1)}%).`,
            });

            if (!interactionPartnersMap.has(idA)) interactionPartnersMap.set(idA, new Set());
            if (!interactionPartnersMap.has(idB)) interactionPartnersMap.set(idB, new Set());
            interactionPartnersMap.get(idA)!.add(idB);
            interactionPartnersMap.get(idB)!.add(idA);
          } else {
            interactions.push({
              mutationIds: [idA, idB],
              individualEffects: { [idA]: effectA, [idB]: effectB },
              jointEffect,
              interactionMagnitude,
              verdict: 'NO_INTERACTION',
              description: `Effects appear additive within bounds (magnitude: ${(interactionMagnitude * 100).toFixed(1)}%).`,
            });
          }
        }
      }
    }

    // Evaluate individual mutations
    const attributions: Record<string, MutationAttribution> = {};

    for (const m of plan.allMutations) {
      const soloRes = signatureMap.get(m.id);
      const isolatedDelta = soloRes?.deltaVsBaseline ?? 0;
      const soloSample = soloRes?.sampleCount ?? 0;

      // Marginal effect: difference between All and (All minus m.id)
      const withoutMIds = plan.allMutations.filter((x) => x.id !== m.id).map((x) => x.id).sort().join('+');
      const withoutMRes = signatureMap.get(withoutMIds);
      const marginalDelta = withoutMRes ? candidateDelta - withoutMRes.deltaVsBaseline : isolatedDelta;
      const marginalSample = withoutMRes?.sampleCount ?? soloSample;

      const effectiveSample = Math.min(soloSample, marginalSample || soloSample);
      const partners = Array.from(interactionPartnersMap.get(m.id) ?? []);

      let verdict: CausalAttributionVerdict = 'INSUFFICIENT_EVIDENCE';
      let confidence = 0.5;
      let details = '';

      if (effectiveSample < minSampleSize) {
        verdict = 'INSUFFICIENT_EVIDENCE';
        confidence = Math.max(0.1, effectiveSample / minSampleSize);
        details = `Insufficient sample size (${effectiveSample} < ${minSampleSize}). Empirical certainty cannot be claimed.`;
      } else if (partners.length > 0 && Math.abs(isolatedDelta) < sigThreshold) {
        // Mutation does not work in isolation, but has proven synergistic interaction
        verdict = 'INTERACTION_DETECTED';
        confidence = 0.85;
        details = `Demonstrated no isolated effect (${(isolatedDelta * 100).toFixed(1)}%), but contributes through joint interaction with ${partners.join(', ')}.`;
      } else if (isolatedDelta > sigThreshold || marginalDelta > sigThreshold) {
        verdict = 'SUPPORTED_CONTRIBUTOR';
        confidence = Math.min(0.98, 0.7 + effectiveSample * 0.05);
        details = `Measured positive improvement (isolated: +${(isolatedDelta * 100).toFixed(1)}%, marginal: +${(marginalDelta * 100).toFixed(1)}%).`;
      } else if (isolatedDelta < -sigThreshold || marginalDelta < -sigThreshold) {
        verdict = 'NEGATIVE_CONTRIBUTOR';
        confidence = Math.min(0.98, 0.7 + effectiveSample * 0.05);
        details = `Measured performance regression (isolated: ${(isolatedDelta * 100).toFixed(1)}%, marginal: ${(marginalDelta * 100).toFixed(1)}%).`;
      } else {
        verdict = 'NO_MEASURABLE_EFFECT';
        confidence = 0.8;
        details = `Measured effect (${(isolatedDelta * 100).toFixed(1)}%) is within neutral threshold (±${(sigThreshold * 100).toFixed(1)}%).`;
      }

      attributions[m.id] = {
        mutationId: m.id,
        target: m.target,
        domain: m.domain,
        verdict,
        isolatedDelta,
        marginalDelta,
        confidence,
        sampleCount: effectiveSample,
        interactionPartners: partners.length > 0 ? partners : undefined,
        details,
      };
    }

    const summary = this.formatSummary(plan, primaryMetric, candidateDelta, attributions, interactions);

    const report: CausalAttributionReport = {
      experimentId: plan.experimentId,
      candidateId: plan.candidateId,
      primaryMetric,
      direction,
      baselineValue,
      candidateValue,
      candidateDelta,
      design: plan.design,
      ablationRuns,
      attributions,
      interactions,
      summary,
      analyzedAt: new Date(),
    };

    return report;
  }

  /**
   * Persists attribution results to mutation memory and records episodes in MemoryService.
   */
  public async recordAttribution(
    report: CausalAttributionReport,
    allMutations: Mutation[],
  ): Promise<void> {
    const mutationMap = new Map(allMutations.map((m) => [m.id, m]));

    for (const [mutationId, attr] of Object.entries(report.attributions)) {
      const mut = mutationMap.get(mutationId);
      const target = attr.target;

      let record = this.memory.get(target);
      if (!record) {
        record = {
          mutationId,
          target,
          domain: attr.domain,
          lastObservedVerdict: attr.verdict,
          averageEffect: attr.isolatedDelta,
          totalEvaluations: 0,
          interactionPartners: [],
          history: [],
        };
      }

      record.lastObservedVerdict = attr.verdict;
      record.totalEvaluations += attr.sampleCount;
      record.averageEffect =
        record.totalEvaluations > 0
          ? (record.averageEffect * (record.totalEvaluations - attr.sampleCount) + attr.isolatedDelta * attr.sampleCount) /
            record.totalEvaluations
          : attr.isolatedDelta;

      if (attr.interactionPartners) {
        for (const p of attr.interactionPartners) {
          if (!record.interactionPartners.includes(p)) {
            record.interactionPartners.push(p);
          }
        }
      }

      record.history.push({
        experimentId: report.experimentId,
        verdict: attr.verdict,
        delta: attr.isolatedDelta,
        timestamp: new Date(),
      });

      this.memory.set(target, record);

      if (this.store) {
        try {
          await this.store.put(`meta/mutations/${target.replace(/\./g, '_')}`, record);
        } catch {
          // Ignore store persistence errors
        }
      }

      if (this.memoryService && mut) {
        this.memoryService.recordEpisode({
          repositoryScope: 'wazir',
          taskType: 'causal_attribution',
          taskPrompt: `Ablation attribution for ${target}`,
          executionId: report.experimentId,
          attemptOutcome: attr.verdict === 'SUPPORTED_CONTRIBUTOR' ? 'success' : 'failure',
          failurePattern: attr.verdict === 'NEGATIVE_CONTRIBUTOR' ? attr.details : undefined,
          repairStrategy: mut.rationale,
          filesInvolved: [],
          workspaceRevision: 0,
          metadata: {
            mutation: mut,
            attribution: attr,
          },
        });
      }
    }
  }

  /**
   * Queries historical attribution record for a given parameter target.
   */
  public getMutationRecord(target: string): MutationMemoryRecord | undefined {
    return this.memory.get(target);
  }

  /**
   * Lists all stored mutation memory records.
   */
  public listMutationRecords(): MutationMemoryRecord[] {
    return Array.from(this.memory.values());
  }

  /**
   * Checks if a proposed parameter adjustment is known to be historically harmful.
   */
  public isKnownHarmful(target: string): boolean {
    const rec = this.memory.get(target);
    return rec !== undefined && rec.lastObservedVerdict === 'NEGATIVE_CONTRIBUTOR';
  }

  private formatSummary(
    plan: AblationPlan,
    primaryMetric: MeasurableMetricName,
    candidateDelta: number,
    attributions: Record<string, MutationAttribution>,
    interactions: InteractionEffect[],
  ): string {
    const lines: string[] = [
      `Causal Attribution Analysis for Candidate '${plan.candidateId}' (Design: ${plan.design})`,
      `Overall Candidate Delta on ${primaryMetric}: ${(candidateDelta * 100).toFixed(1)}%`,
      '',
      'Mutation Attributions:',
    ];

    for (const [id, attr] of Object.entries(attributions)) {
      lines.push(
        `  • ${id} (${attr.target}): ${attr.verdict} [isolated: ${(attr.isolatedDelta * 100).toFixed(1)}%, marginal: ${(attr.marginalDelta * 100).toFixed(1)}%] (confidence: ${(attr.confidence * 100).toFixed(0)}%)`,
      );
      lines.push(`    - ${attr.details}`);
    }

    const detectedInteractions = interactions.filter((i) => i.verdict === 'INTERACTION_DETECTED');
    if (detectedInteractions.length > 0) {
      lines.push('');
      lines.push('Interactions Detected:');
      for (const inter of detectedInteractions) {
        lines.push(`  ⚠ ${inter.mutationIds.join(' <-> ')}: ${inter.description}`);
      }
    }

    return lines.join('\n');
  }
}
