import type { TrajectoryContrastReport } from '../trajectoryContrastService.js';
import {
  GovernanceFence,
  GovernanceFenceError,
  type CapabilityCeiling,
  type GovernanceValidationResult,
} from './governanceFence.js';

export interface ContextBudgetWeights {
  localization: number;
  activeFiles: number;
  diagnostics: number;
  historySummary: number;
}

export interface LoopDetectionThresholds {
  maxConsecutiveIdenticalToolCalls: number;
  maxTotalDuplicateToolCalls: number;
  maxRepairCyclesBeforePivot: number;
}

export interface BehavioralHarnessOverlay {
  editorKind: 'behavioral_mechanics';
  systemPromptHints: string[];
  promptOverlay: string;
  contextBudgetWeights: ContextBudgetWeights;
  loopDetectionThresholds: LoopDetectionThresholds;
  allowedTools?: string[];
  droppedUnauthorizedTools: string[];
  prunedNoisyTools: string[];
  blockedInjections: string[];
  governanceValidation: GovernanceValidationResult;
}

export interface BehavioralEditorOptions {
  baseCeiling?: CapabilityCeiling;
  requestedAllowedTools?: readonly string[];
  excludeNoisyTools?: readonly string[];
  candidateHints?: readonly string[];
  maxHints?: number;
}

const CORE_ESSENTIAL_TOOLS = new Set([
  'read_file',
  'read_many_files',
  'grep',
  'glob',
  'edit',
  'edit_file',
  'write_file',
  'shell',
]);

const ADVERSARIAL_HINT_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|system)\s+(?:instructions|rules|constraints|governance|directives)/i,
  /disregard\s+(?:all\s+|any\s+)?(?:governance|policy|sandbox|safety|verification|fencing)/i,
  /\b(?:bypass|disable)\s+(?:the\s+)?(?:sandbox|governance|policy|permission|verification)/i,
  /(?:<\|im_start\|>|<\/?system>|\[INST\]|###\s*System\s*Override)/i,
  /(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/(?:datasets|spaces)\b/i,
  /(?:https?:\/\/)?raw\.githubusercontent\.com\b/i,
  /\b(?:SKIP_TESTS|CI_SKIP_TESTS|NODE_TLS_REJECT_UNAUTHORIZED)\s*=/i,
  /(?:\$\([^)]*\)|`[^`]+`)/,
];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function normalizeWeights(raw: ContextBudgetWeights): ContextBudgetWeights {
  const clamped = {
    localization: clamp(raw.localization, 0.1, 0.55),
    activeFiles: clamp(raw.activeFiles, 0.1, 0.55),
    diagnostics: clamp(raw.diagnostics, 0.1, 0.55),
    historySummary: clamp(raw.historySummary, 0.05, 0.4),
  };
  const total =
    clamped.localization +
    clamped.activeFiles +
    clamped.diagnostics +
    clamped.historySummary;

  const localization = Number((clamped.localization / total).toFixed(4));
  const activeFiles = Number((clamped.activeFiles / total).toFixed(4));
  const diagnostics = Number((clamped.diagnostics / total).toFixed(4));
  const historySummary = Number((1 - (localization + activeFiles + diagnostics)).toFixed(4));

  return {
    localization,
    activeFiles,
    diagnostics,
    historySummary,
  };
}

/**
 * Harness² Editor 1: General Agent Mechanics (`A058`).
 * Consumes a `TrajectoryContrastReport` from probe/reference runs and proposes bounded,
 * task-agnostic behavioral adjustments (read-before-edit hints, immediate post-edit check,
 * context budget weights, loop thresholds, and monotonic tool subsetting).
 * Every proposal MUST pass `GovernanceFence.validateProposal(...)` before returning.
 */
export class BehavioralHarnessEditor {
  private readonly governanceFence: GovernanceFence;

  constructor(governanceFence: GovernanceFence = new GovernanceFence()) {
    this.governanceFence = governanceFence;
  }

  public propose(
    contrastReport: TrajectoryContrastReport,
    options: BehavioralEditorOptions = {},
  ): BehavioralHarnessOverlay {
    const deltas = contrastReport.behavioralDeltas;
    const verDelta = contrastReport.verificationDelta;
    const maxHints = clamp(options.maxHints ?? 6, 1, 10);

    const systemPromptHints: string[] = [];
    const blockedInjections: string[] = [];

    // 1. Deterministic task-agnostic behavioral guidance derived from trajectory contrast
    if (deltas.blindEditExecutionIds.length > 0 || deltas.meanReadBeforeEditScore < 0.95) {
      systemPromptHints.push(
        'Read target and caller files via read_many_files or read_file before editing.',
      );
    }

    if (deltas.unverifiedMutationExecutionIds.length > 0 || !verDelta.allVerified) {
      systemPromptHints.push(
        'Run targeted check immediately after edit to confirm build and test status on the latest workspace revision.',
      );
    }

    if (deltas.highLoopExecutionIds.length > 0) {
      systemPromptHints.push(
        'Do not repeat identical tool calls; if a tool invocation fails or yields no new signal, pivot localization strategy.',
      );
    }

    if (deltas.sprawlingEditExecutionIds.length > 0) {
      systemPromptHints.push(
        'Keep changes minimal and localized to files directly implicated by failure diagnostics.',
      );
    }

    if (systemPromptHints.length === 0) {
      systemPromptHints.push(
        'Read target and caller files via read_many_files before editing, and run targeted check immediately after edit.',
      );
    }

    // Sanitize and filter any optional candidate hints against adversarial injection
    for (const rawHint of options.candidateHints ?? []) {
      const trimmed = rawHint.trim();
      if (!trimmed) continue;
      if (ADVERSARIAL_HINT_PATTERNS.some((rx) => rx.test(trimmed))) {
        blockedInjections.push(trimmed.slice(0, 160));
        continue;
      }
      if (!systemPromptHints.includes(trimmed)) {
        systemPromptHints.push(trimmed.slice(0, 240));
      }
    }

    const boundedHints = systemPromptHints.slice(0, maxHints);

    // 2. Bounded context budget weights
    let rawWeights: ContextBudgetWeights = {
      localization: 0.28,
      activeFiles: 0.34,
      diagnostics: 0.23,
      historySummary: 0.15,
    };

    if (deltas.blindEditExecutionIds.length > 0) {
      rawWeights.localization += 0.07;
      rawWeights.historySummary -= 0.04;
    }
    if (!verDelta.allVerified || deltas.highLoopExecutionIds.length > 0) {
      rawWeights.diagnostics += 0.07;
      rawWeights.historySummary -= 0.04;
    }
    if (deltas.meanTotalTokens > 25000) {
      rawWeights.historySummary -= 0.04;
      rawWeights.activeFiles += 0.04;
    }

    const contextBudgetWeights = normalizeWeights(rawWeights);

    // 3. Bounded loop detection thresholds
    const hasLoops = deltas.highLoopExecutionIds.length > 0;
    const loopDetectionThresholds: LoopDetectionThresholds = {
      maxConsecutiveIdenticalToolCalls: hasLoops ? 2 : 3,
      maxTotalDuplicateToolCalls: hasLoops ? 3 : 5,
      maxRepairCyclesBeforePivot: hasLoops ? 2 : 3,
    };

    // 4. Monotonic subsetting of allowedTools (never adding unauthorized tools)
    const baseTools = options.baseCeiling?.allowedTools;
    let allowedTools: string[] | undefined;
    const droppedUnauthorizedTools: string[] = [];
    const prunedNoisyTools: string[] = [];

    if (baseTools) {
      const baseSet = new Set(baseTools);
      const noisySet = new Set([
        ...deltas.noisyFailedTools,
        ...(options.excludeNoisyTools ?? []),
      ]);

      let candidateTools: string[];
      if (options.requestedAllowedTools) {
        candidateTools = [];
        for (const tool of options.requestedAllowedTools) {
          if (baseSet.has(tool)) {
            candidateTools.push(tool);
          } else {
            droppedUnauthorizedTools.push(tool);
          }
        }
      } else {
        candidateTools = [...baseTools];
      }

      allowedTools = candidateTools.filter((tool) => {
        if (noisySet.has(tool) && !CORE_ESSENTIAL_TOOLS.has(tool)) {
          prunedNoisyTools.push(tool);
          return false;
        }
        return true;
      });

      // Ensure we never prune down to an empty toolset if baseTools was non-empty
      if (allowedTools.length === 0 && baseTools.length > 0) {
        allowedTools = baseTools.filter((t) => CORE_ESSENTIAL_TOOLS.has(t));
        if (allowedTools.length === 0) {
          allowedTools = [baseTools[0]];
        }
      }
    }

    const promptOverlay = [
      '=== HARNESS BEHAVIORAL MECHANICS ===',
      ...boundedHints.map((h, i) => `${i + 1}. ${h}`),
    ].join('\n');

    // 5. Mandatory GovernanceFence check before returning
    const governanceValidation = this.governanceFence.validateProposal(
      {
        allowedTools,
        systemPromptHints: boundedHints,
        promptOverlay,
      },
      options.baseCeiling,
    );

    if (!governanceValidation.allowed) {
      throw new GovernanceFenceError(
        `BehavioralHarnessEditor proposal rejected by GovernanceFence: ${governanceValidation.violations.map((v) => v.message).join('; ')}`,
        governanceValidation.violations,
      );
    }

    return {
      editorKind: 'behavioral_mechanics',
      systemPromptHints: boundedHints,
      promptOverlay,
      contextBudgetWeights,
      loopDetectionThresholds,
      allowedTools,
      droppedUnauthorizedTools,
      prunedNoisyTools,
      blockedInjections,
      governanceValidation,
    };
  }
}
