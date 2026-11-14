import type { StrategyLearningService } from './strategyLearningService.js';
import type {
  AntiStrategyWarning,
  EngineeringStrategy,
  StrategyMatchQuery,
  StrategyQuery,
  StrategyStep,
} from '../types/strategyLearning.js';

export interface HarnessPolicyCeiling {
  readonly allowedTools: readonly string[];
  readonly sandboxMode: 'strict' | 'workspace-write' | 'unsandboxed';
  readonly networkAccess: boolean;
  readonly approvalMode: 'strict' | 'on-mutation' | 'auto-edit' | 'never';
  readonly protectedPaths?: readonly string[];
}

export interface BaseHarnessConfig {
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly policyCeiling: HarnessPolicyCeiling;
  readonly maxTurns?: number;
  readonly loopThreshold?: number;
  readonly contextBudgetTokens?: number;
}

export interface HarnessAssemblerOptions {
  /** Minimum verified evidence references required before a strategy can be included (default: 3) */
  minEvidenceThreshold?: number;
  /** Minimum empirical confidence score required before a strategy can be included (default: 0.70) */
  minConfidence?: number;
  /** Maximum number of proven strategies injected per task (default: 3) */
  maxStrategiesPerTask?: number;
}

export interface TaskAssemblyOptions {
  /** Optional monotonic narrowing of allowedTools; unauthorized tools outside baseAllowedTools are dropped */
  requestedAllowedTools?: readonly string[];
  /** Optional noisy tools to exclude while preserving core monotonic ceiling */
  excludeTools?: readonly string[];
  /** Optional override for minimum evidence count (cannot be lower than assembler floor if not specified) */
  minEvidenceThreshold?: number;
  /** Optional override for minimum confidence */
  minConfidence?: number;
}

export interface AssembledHarnessConfig {
  readonly baseSystemPrompt: string;
  readonly systemPrompt: string;
  readonly baseAllowedTools: readonly string[];
  readonly effectiveAllowedTools: readonly string[];
  readonly policyCeiling: HarnessPolicyCeiling;
  readonly strategySteps: readonly StrategyStep[];
  readonly appliedStrategies: readonly EngineeringStrategy[];
  readonly appliedStrategyIds: readonly string[];
  readonly rejectedUnprovenStrategyIds: readonly string[];
  readonly antiStrategyWarnings: readonly AntiStrategyWarning[];
  readonly droppedUnauthorizedTools: readonly string[];
  readonly maxTurns?: number;
  readonly loopThreshold?: number;
  readonly contextBudgetTokens?: number;
  readonly cleanBaseGuaranteed: true;
}

const PROMPT_INJECTION_GUARD =
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|system)\s+(?:instructions|rules|constraints|governance)|disregard\s+(?:all\s+)?(?:governance|policy|sandbox|verification)|(?:<\|im_start\|>|<\/?system>|\[INST\])/i;

function cloneAndFreezeCeiling(ceiling: HarnessPolicyCeiling): HarnessPolicyCeiling {
  const allowedTools = Object.freeze([...ceiling.allowedTools]);
  const protectedPaths = ceiling.protectedPaths
    ? Object.freeze([...ceiling.protectedPaths])
    : undefined;
  return Object.freeze({
    allowedTools,
    sandboxMode: ceiling.sandboxMode,
    networkAccess: ceiling.networkAccess,
    approvalMode: ceiling.approvalMode,
    ...(protectedPaths ? { protectedPaths } : {}),
  });
}

function cloneAndFreezeBaseConfig(config: BaseHarnessConfig): BaseHarnessConfig {
  const ceiling = cloneAndFreezeCeiling(config.policyCeiling);
  const ceilingSet = new Set(ceiling.allowedTools);
  // Base allowedTools itself is clamped to policyCeiling.allowedTools at initialization
  const allowedTools = Object.freeze(
    config.allowedTools.filter((t) => ceilingSet.has(t)),
  );

  return Object.freeze({
    systemPrompt: config.systemPrompt,
    allowedTools,
    policyCeiling: ceiling,
    maxTurns: config.maxTurns,
    loopThreshold: config.loopThreshold,
    contextBudgetTokens: config.contextBudgetTokens,
  });
}

function sanitizeGuidanceLine(line: string): string {
  const cleaned = line.replace(/\r?\n/g, ' ').trim();
  if (PROMPT_INJECTION_GUARD.test(cleaned)) {
    return '[REDACTED_UNSAFE_STRATEGY_TEXT]';
  }
  return cleaned.slice(0, 260);
}

/**
 * Clean-base cross-task Harness Assembler (`A063`).
 *
 * Enforces three non-negotiable invariants:
 * 1. Every new task starts from an immutable clean `BaseHarnessConfig` (zero unverified carryover from prior tasks).
 * 2. Pulls ONLY proven `EngineeringStrategy` lessons from `StrategyLearningService` whose
 *    `evidenceRefs.length >= minEvidenceThreshold` (default `3`) and `confidence >= 0.70`, plus relevant `AntiStrategyWarning`s.
 * 3. Enforces monotonic capability ceiling (`effectiveAllowedTools ⊆ baseAllowedTools ⊆ policyCeiling.allowedTools`,
 *    `policyCeiling` immutable) so retrieved lessons can refine strategy steps and narrow noisy tools, never expand permissions.
 */
export class HarnessAssembler {
  private readonly cleanBaseConfig: BaseHarnessConfig;
  private readonly strategyLearningService: StrategyLearningService;
  private readonly minEvidenceThreshold: number;
  private readonly minConfidence: number;
  private readonly maxStrategiesPerTask: number;

  constructor(
    baseConfig: BaseHarnessConfig,
    strategyLearningService: StrategyLearningService,
    options: HarnessAssemblerOptions = {},
  ) {
    this.cleanBaseConfig = cloneAndFreezeBaseConfig(baseConfig);
    this.strategyLearningService = strategyLearningService;
    this.minEvidenceThreshold = options.minEvidenceThreshold ?? 3;
    this.minConfidence = options.minConfidence ?? 0.70;
    this.maxStrategiesPerTask = options.maxStrategiesPerTask ?? 3;
  }

  /**
   * Returns the immutable clean `BaseHarnessConfig` snapshot.
   */
  public getBaseConfig(): BaseHarnessConfig {
    return this.cleanBaseConfig;
  }

  /**
   * Assembles a clean, governance-bounded harness configuration for a new task.
   * Starts strictly from `cleanBaseConfig` with zero state retained from any prior `assemble` call.
   */
  public assemble(
    query: StrategyMatchQuery | StrategyQuery,
    taskOptions: TaskAssemblyOptions = {},
  ): AssembledHarnessConfig {
    // Monotonic floor: per-task options may tighten evidence/confidence requirements, never relax below configured floor
    const requiredEvidence = Math.max(
      this.minEvidenceThreshold,
      taskOptions.minEvidenceThreshold ?? this.minEvidenceThreshold,
    );
    const requiredConfidence = Math.max(
      this.minConfidence,
      taskOptions.minConfidence ?? this.minConfidence,
    );

    // 1. Fresh copy of immutable base ceiling and baseAllowedTools
    const policyCeiling = cloneAndFreezeCeiling(this.cleanBaseConfig.policyCeiling);
    const ceilingSet = new Set(policyCeiling.allowedTools);
    const baseAllowedTools = Object.freeze(
      this.cleanBaseConfig.allowedTools.filter((t) => ceilingSet.has(t)),
    );
    const baseSet = new Set(baseAllowedTools);

    // 2. Query candidate strategies with minConfidence=0 so we can deterministically partition
    //    proven (>= threshold) vs rejected unproven (< threshold) lessons.
    const rankedMatches = this.strategyLearningService.queryStrategies({
      ...query,
      minConfidence: 0,
      maxResults: 25,
      allowAntiStrategies: false,
    });

    const appliedStrategies: EngineeringStrategy[] = [];
    const rejectedUnprovenStrategyIds: string[] = [];
    const seenIds = new Set<string>();
    const explicitQueryCategory =
      (query as StrategyQuery).taskCategory ?? query.problemSignature?.category;

    for (const match of rankedMatches) {
      if (seenIds.has(match.strategyId)) continue;

      const fullStrategy =
        this.strategyLearningService.getStrategy(match.strategyId) ??
        match.normalizedStrategy;

      if (!fullStrategy || fullStrategy.isAntiStrategy) {
        continue;
      }

      // Suppress irrelevant or orthogonal category matches so unrelated tasks stay on clean base
      if (match.relevanceClass === 'IRRELEVANT' || match.applicability < 0.40) {
        continue;
      }
      if (
        explicitQueryCategory &&
        explicitQueryCategory !== 'general_repair' &&
        fullStrategy.problemSignature.category !== explicitQueryCategory &&
        !fullStrategy.taskCategories?.includes(explicitQueryCategory) &&
        match.relevanceClass !== 'HIGH'
      ) {
        continue;
      }

      seenIds.add(match.strategyId);

      const evidenceCount = fullStrategy.evidenceRefs?.length ?? 0;
      const confidence = fullStrategy.confidence ?? 0;

      if (evidenceCount >= requiredEvidence && confidence >= requiredConfidence) {
        if (appliedStrategies.length < this.maxStrategiesPerTask) {
          appliedStrategies.push(fullStrategy);
        }
      } else {
        rejectedUnprovenStrategyIds.push(fullStrategy.id);
      }
    }

    // Also record any other strategies in the store matching the category that failed the evidence threshold
    const queryCategory =
      (query as StrategyQuery).taskCategory ?? query.problemSignature?.category;
    for (const strat of this.strategyLearningService.getAllStrategies()) {
      if (seenIds.has(strat.id) || strat.isAntiStrategy) continue;
      if (queryCategory && strat.problemSignature.category !== queryCategory) continue;
      const evidenceCount = strat.evidenceRefs?.length ?? 0;
      const confidence = strat.confidence ?? 0;
      if (evidenceCount < requiredEvidence || confidence < requiredConfidence) {
        rejectedUnprovenStrategyIds.push(strat.id);
      }
    }

    // 3. Collect relevant AntiStrategyWarnings
    const warningMap = new Map<string, AntiStrategyWarning>();
    const directWarnings = this.strategyLearningService.getRelevantWarnings(
      query as StrategyQuery,
    );
    for (const w of directWarnings) {
      warningMap.set(`${w.problemSignature.category}::${w.antiPatternName}`, w);
    }
    for (const match of rankedMatches) {
      for (const w of match.antiStrategyWarnings ?? []) {
        warningMap.set(`${w.problemSignature.category}::${w.antiPatternName}`, w);
      }
    }
    const antiStrategyWarnings = Object.freeze(Array.from(warningMap.values()));

    // 4. Enforce monotonic tool subsetting: effectiveAllowedTools ⊆ baseAllowedTools ⊆ policyCeiling.allowedTools
    const droppedUnauthorizedTools: string[] = [];
    const excludeSet = new Set(taskOptions.excludeTools ?? []);

    // Track if any proven strategy mentions tools outside baseAllowedTools (never added!)
    for (const strat of appliedStrategies) {
      for (const tool of strat.usefulTools ?? []) {
        if (!baseSet.has(tool) && !droppedUnauthorizedTools.includes(tool)) {
          droppedUnauthorizedTools.push(tool);
        }
      }
    }

    let candidateTools: string[];
    if (taskOptions.requestedAllowedTools) {
      candidateTools = [];
      for (const tool of taskOptions.requestedAllowedTools) {
        if (baseSet.has(tool) && ceilingSet.has(tool)) {
          if (!candidateTools.includes(tool)) {
            candidateTools.push(tool);
          }
        } else if (!droppedUnauthorizedTools.includes(tool)) {
          droppedUnauthorizedTools.push(tool);
        }
      }
    } else {
      candidateTools = [...baseAllowedTools];
    }

    let narrowedTools = candidateTools.filter((t) => !excludeSet.has(t));
    if (narrowedTools.length === 0 && candidateTools.length > 0) {
      narrowedTools = [...candidateTools];
    }
    const effectiveAllowedTools = Object.freeze(narrowedTools);

    // 5. Assemble clean system prompt + non-authoritative proven strategy guidance
    const strategySteps: StrategyStep[] = [];
    const promptSections: string[] = [this.cleanBaseConfig.systemPrompt];

    if (appliedStrategies.length > 0 || antiStrategyWarnings.length > 0) {
      const guidanceLines: string[] = [
        '',
        '=== PROVEN CROSS-TASK ENGINEERING GUIDANCE (CURRENT EVIDENCE DOMINATES) ===',
      ];

      for (const strat of appliedStrategies) {
        guidanceLines.push(
          `Strategy ${sanitizeGuidanceLine(strat.id)} (verified runs=${strat.evidenceRefs.length}, confidence=${strat.confidence.toFixed(2)}):`,
        );
        for (const step of strat.approach) {
          strategySteps.push({ ...step });
          guidanceLines.push(
            `  - [${sanitizeGuidanceLine(step.phase)}] ${sanitizeGuidanceLine(step.action)} (${sanitizeGuidanceLine(step.intent)})`,
          );
        }
      }

      if (antiStrategyWarnings.length > 0) {
        guidanceLines.push('Known Anti-Patterns to Avoid:');
        for (const warn of antiStrategyWarnings.slice(0, 4)) {
          guidanceLines.push(
            `  - AVOID ${sanitizeGuidanceLine(warn.antiPatternName)}: ${sanitizeGuidanceLine(warn.warningMessage)}`,
          );
          if (warn.remedySuggestion) {
            guidanceLines.push(`    REMEDY: ${sanitizeGuidanceLine(warn.remedySuggestion)}`);
          }
        }
      }

      guidanceLines.push(
        'Invariant: Past strategies guide localization only; physical verification at the final workspace revision is mandatory.',
      );
      promptSections.push(guidanceLines.join('\n'));
    }

    return Object.freeze({
      baseSystemPrompt: this.cleanBaseConfig.systemPrompt,
      systemPrompt: promptSections.join('\n'),
      baseAllowedTools,
      effectiveAllowedTools,
      policyCeiling,
      strategySteps: Object.freeze(strategySteps),
      appliedStrategies: Object.freeze(appliedStrategies),
      appliedStrategyIds: Object.freeze(appliedStrategies.map((s) => s.id)),
      rejectedUnprovenStrategyIds: Object.freeze(rejectedUnprovenStrategyIds),
      antiStrategyWarnings,
      droppedUnauthorizedTools: Object.freeze(droppedUnauthorizedTools),
      maxTurns: this.cleanBaseConfig.maxTurns,
      loopThreshold: this.cleanBaseConfig.loopThreshold,
      contextBudgetTokens: this.cleanBaseConfig.contextBudgetTokens,
      cleanBaseGuaranteed: true,
    });
  }

  /**
   * Alias for `assemble(...)` emphasizing per-task clean-base assembly.
   */
  public assembleForTask(
    query: StrategyMatchQuery | StrategyQuery,
    taskOptions: TaskAssemblyOptions = {},
  ): AssembledHarnessConfig {
    return this.assemble(query, taskOptions);
  }
}
