import { createHash } from 'node:crypto';
import type { TerminationReason, ToolResult } from '@wazir/core';
import { observationFingerprint } from '../diagnostics.js';
import type { ExecutedToolOutcome } from './coreToolScheduler.js';

function canonicalSignature(tool: string, input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    normalized[k] = input[k];
  }
  return `${tool}:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)}`;
}

export interface LoopAssessment {
  action: 'ok' | 'nudge' | 'synthesize' | 'stop';
  nudgeMessage?: string;
  stopReason?: TerminationReason;
  stopMessage?: string;
  escalatable?: boolean;
}

const SCAN_TOOL_NAMES = new Set(['glob', 'search']);
const READ_TOOL_NAMES = new Set(['read', 'read_many_files', 'web_fetch', 'web_search', 'glob', 'search']);
const SHELL_SCAN_CMD_RE = /^(?:ls|find|tree|dir|rg|grep|ag|fd)\b/i;

function isScanTool(toolName: string, input: Record<string, unknown>): boolean {
  if (SCAN_TOOL_NAMES.has(toolName)) return true;
  if (toolName === 'shell') {
    const cmd = String(input.command ?? input.cmd ?? '').trim();
    return SHELL_SCAN_CMD_RE.test(cmd);
  }
  return false;
}

function isReadOrScanTool(toolName: string, input: Record<string, unknown>): boolean {
  return READ_TOOL_NAMES.has(toolName) || isScanTool(toolName, input);
}

/**
 * Qwen Code 1.0 `LoopDetectionService` combined with Wazir's semantic `observationFingerprint`:
 *  1. Exact consecutive `tool + canonical(input)` repeat breaker (`toolRepeatLimit`)
 *  2. Alternating `A <-> B` 2-step cycle detector (`A, B, A, B` with no file mutation)
 *  3. Semantic no-progress streak (`maxNoProgressIterations`) across syntactically distinct calls
 *  4. Prose chanting / repetitive tool-less outputs
 */
export class LoopDetectionService {
  private lastToolSig: string | null = null;
  private consecutiveIdenticalTool = 0;
  private recentSigs: string[] = [];
  private seenToolSigs = new Set<string>();
  private seenObservations = new Set<string>();
  public noProgressStreak = 0;
  public longestNoProgressStreak = 0;
  public duplicateActionsBlocked = 0;
  public uniqueReadObservations = 0;
  public duplicateToolCalls = 0;
  private issuedNudgeForCurrentStreak = false;
  private issuedNoProgressNudge = false;
  private issuedSynthesisNudge = false;
  private synthesisTriggered = false;
  private totalReadOnlyCalls = 0;
  private lastAssistantTextHash: string | null = null;
  private identicalTextStreak = 0;

  constructor(
    private readonly options: {
      toolRepeatLimit: number;
      maxNoProgressIterations: number;
      readOnlyMode?: boolean;
      readOnlyExplorationBudget?: number;
    },
  ) {}

  resetAfterEscalation(): void {
    this.lastToolSig = null;
    this.consecutiveIdenticalTool = 0;
    this.recentSigs = [];
    this.noProgressStreak = 0;
    this.issuedNudgeForCurrentStreak = false;
    this.issuedNoProgressNudge = false;
    this.lastAssistantTextHash = null;
    this.identicalTextStreak = 0;
  }

  recordToolOutcomes(outcomes: ExecutedToolOutcome[]): LoopAssessment {
    for (const outcome of outcomes) {
      if (!outcome.executed) continue;

      const sig = canonicalSignature(outcome.canonicalName, outcome.input);
      const isDuplicateCall = this.seenToolSigs.has(sig);
      this.seenToolSigs.add(sig);

      if (sig === this.lastToolSig) {
        this.consecutiveIdenticalTool += 1;
      } else {
        this.lastToolSig = sig;
        this.consecutiveIdenticalTool = 1;
      }

      this.recentSigs.push(sig);
      if (this.recentSigs.length > 8) {
        this.recentSigs.shift();
      }

      // Check physical mutation or novel observation
      const mutated = this.didMutate(outcome.canonicalName, outcome.result);
      const fp = observationFingerprint(outcome.result);
      const isEmptyObservation = fp === 'ok:EMPTY' || fp === 'fail:EMPTY';
      const isNovelObservation = !this.seenObservations.has(fp);
      this.seenObservations.add(fp);

      if (!mutated && (isDuplicateCall || !isNovelObservation)) {
        this.duplicateToolCalls += 1;
      }

      if (
        outcome.result.ok &&
        isNovelObservation &&
        !isEmptyObservation &&
        isReadOrScanTool(outcome.canonicalName, outcome.input)
      ) {
        this.uniqueReadObservations += 1;
      }

      if (this.options.readOnlyMode) {
        this.totalReadOnlyCalls += 1;
      }

      if (mutated || (outcome.result.ok && isNovelObservation)) {
        this.noProgressStreak = 0;
        this.issuedNudgeForCurrentStreak = false;
        this.issuedNoProgressNudge = false;
      } else {
        this.noProgressStreak += 1;
        if (this.noProgressStreak > this.longestNoProgressStreak) {
          this.longestNoProgressStreak = this.noProgressStreak;
        }
      }

      // 1. Exact consecutive tool repeat check
      if (this.consecutiveIdenticalTool >= this.options.toolRepeatLimit) {
        this.duplicateActionsBlocked += 1;
        if (!this.issuedNudgeForCurrentStreak && this.options.toolRepeatLimit >= 3) {
          // If we already hit limit after a nudge on limit-1, stop; otherwise check below
        }
        return {
          action: 'stop',
          stopReason: 'REPEATED_ACTION',
          stopMessage: `REPEATED_ACTION: tool '${outcome.canonicalName}' called ${this.consecutiveIdenticalTool} times consecutively with identical arguments`,
          escalatable: true,
        };
      }

      if (
        !this.issuedNudgeForCurrentStreak &&
        this.options.toolRepeatLimit >= 3 &&
        this.consecutiveIdenticalTool === this.options.toolRepeatLimit - 1 &&
        !mutated
      ) {
        this.issuedNudgeForCurrentStreak = true;
        return {
          action: 'nudge',
          nudgeMessage:
            `[loop warning] You just called '${outcome.canonicalName}' twice with identical arguments and got the same result. ` +
            'Do not repeat the identical call again — adjust your approach or proceed to the next step.',
        };
      }

      // 2. Alternating A <-> B <-> A <-> B cycle without mutation
      if (!mutated && this.recentSigs.length >= 6) {
        const n = this.recentSigs.length;
        const a1 = this.recentSigs[n - 6];
        const b1 = this.recentSigs[n - 5];
        const a2 = this.recentSigs[n - 4];
        const b2 = this.recentSigs[n - 3];
        const a3 = this.recentSigs[n - 2];
        const b3 = this.recentSigs[n - 1];
        if (a1 !== b1 && a1 === a2 && a2 === a3 && b1 === b2 && b2 === b3) {
          this.duplicateActionsBlocked += 1;
          return {
            action: 'stop',
            stopReason: 'REPEATED_ACTION',
            stopMessage: 'REPEATED_ACTION: detected alternating 2-tool loop with no workspace progress',
            escalatable: true,
          };
        }
      }

      // 3. Read-only review / exploration budget & early duplicate-scan handling
      if (this.options.readOnlyMode) {
        const readOnlyMaxNoProgress = Math.min(this.options.maxNoProgressIterations, 4);
        const explorationBudget = this.options.readOnlyExplorationBudget ?? 16;
        const budgetExhausted =
          (this.totalReadOnlyCalls >= explorationBudget && this.duplicateToolCalls > 0) ||
          this.totalReadOnlyCalls >= explorationBudget + 4;

        if (this.noProgressStreak >= readOnlyMaxNoProgress || budgetExhausted) {
          if (this.uniqueReadObservations > 0 && !this.synthesisTriggered) {
            this.synthesisTriggered = true;
            return {
              action: 'synthesize',
              nudgeMessage:
                'Synthesize your findings from the files already read instead of repeating directory scans. Provide your final response now.',
            };
          }
          if (this.noProgressStreak >= readOnlyMaxNoProgress) {
            return {
              action: 'stop',
              stopReason: 'NO_PROGRESS',
              stopMessage: `NO_PROGRESS: ${this.noProgressStreak} consecutive read-only tool calls produced no new information`,
              escalatable: true,
            };
          }
        }
      }

      // 4. Semantic no-progress streak
      if (this.noProgressStreak >= this.options.maxNoProgressIterations) {
        return {
          action: 'stop',
          stopReason: 'NO_PROGRESS',
          stopMessage: `NO_PROGRESS: ${this.noProgressStreak} consecutive tool calls produced no file changes and no new information`,
          escalatable: true,
        };
      }
    }

    if (this.options.readOnlyMode && !this.issuedSynthesisNudge) {
      const readOnlyMaxNoProgress = Math.min(this.options.maxNoProgressIterations, 4);
      const explorationBudget = this.options.readOnlyExplorationBudget ?? 16;
      const shouldNudgeSynthesis =
        this.noProgressStreak >= Math.max(2, readOnlyMaxNoProgress - 2) ||
        (this.duplicateToolCalls >= 2 && this.noProgressStreak >= 1) ||
        this.totalReadOnlyCalls >= explorationBudget;
      if (shouldNudgeSynthesis) {
        this.issuedSynthesisNudge = true;
        return {
          action: 'nudge',
          nudgeMessage:
            this.uniqueReadObservations > 0
              ? '[loop warning] Synthesize your findings from the files already read instead of repeating directory scans.'
              : '[loop warning] Repeated directory scans returned empty or identical results. Switch strategy: read a specific file directly or synthesize your findings.',
        };
      }
    }

    if (
      !this.issuedNoProgressNudge &&
      this.options.maxNoProgressIterations >= 4 &&
      this.noProgressStreak >= this.options.maxNoProgressIterations - 2
    ) {
      this.issuedNoProgressNudge = true;
      const remaining = Math.max(1, this.options.maxNoProgressIterations - this.noProgressStreak);
      return {
        action: 'nudge',
        nudgeMessage:
          `[loop warning] Your last ${this.noProgressStreak} tool calls returned empty or duplicate observations with no workspace changes (${remaining} attempt(s) remaining before halt). ` +
          'Stop repeating empty searches — synthesize what you have observed and provide your response, or switch to a concrete action.',
      };
    }

    return { action: 'ok' };
  }

  recordProseTurn(text: string): LoopAssessment {
    const trimmed = text.trim();
    if (!trimmed) return { action: 'ok' };
    const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
    if (hash === this.lastAssistantTextHash) {
      this.identicalTextStreak += 1;
      if (this.identicalTextStreak >= 3) {
        return {
          action: 'stop',
          stopReason: 'NO_PROGRESS',
          stopMessage: 'NO_PROGRESS: model emitted identical text across 3 consecutive turns',
          escalatable: true,
        };
      }
    } else {
      this.lastAssistantTextHash = hash;
      this.identicalTextStreak = 1;
    }
    return { action: 'ok' };
  }

  private didMutate(toolName: string, result: ToolResult): boolean {
    if (result.fileMutations?.some((m) => m.changed)) return true;
    if (result.ok && (toolName === 'write' || toolName === 'edit' || toolName === 'multi_edit') && !result.fileMutations) {
      return true;
    }
    return false;
  }
}
