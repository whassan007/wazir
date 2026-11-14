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
  action: 'ok' | 'nudge' | 'stop';
  nudgeMessage?: string;
  stopReason?: TerminationReason;
  stopMessage?: string;
  escalatable?: boolean;
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
  private seenObservations = new Set<string>();
  public noProgressStreak = 0;
  public longestNoProgressStreak = 0;
  public duplicateActionsBlocked = 0;
  private issuedNudgeForCurrentStreak = false;
  private lastAssistantTextHash: string | null = null;
  private identicalTextStreak = 0;

  constructor(
    private readonly options: {
      toolRepeatLimit: number;
      maxNoProgressIterations: number;
    },
  ) {}

  resetAfterEscalation(): void {
    this.lastToolSig = null;
    this.consecutiveIdenticalTool = 0;
    this.recentSigs = [];
    this.noProgressStreak = 0;
    this.issuedNudgeForCurrentStreak = false;
    this.lastAssistantTextHash = null;
    this.identicalTextStreak = 0;
  }

  recordToolOutcomes(outcomes: ExecutedToolOutcome[]): LoopAssessment {
    for (const outcome of outcomes) {
      if (!outcome.executed) continue;

      const sig = canonicalSignature(outcome.canonicalName, outcome.input);
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
      const isNovelObservation = !this.seenObservations.has(fp);
      this.seenObservations.add(fp);

      if (mutated || (outcome.result.ok && isNovelObservation)) {
        this.noProgressStreak = 0;
        this.issuedNudgeForCurrentStreak = false;
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

      // 3. Semantic no-progress streak
      if (this.noProgressStreak >= this.options.maxNoProgressIterations) {
        return {
          action: 'stop',
          stopReason: 'NO_PROGRESS',
          stopMessage: `NO_PROGRESS: ${this.noProgressStreak} consecutive tool calls produced no file changes and no new information`,
          escalatable: true,
        };
      }
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
