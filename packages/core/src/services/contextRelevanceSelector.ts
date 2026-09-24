import type {
  ContextCandidate,
  ContextRelevanceSelector,
  ContextRequest,
} from '../types/context.js';

export interface RelevanceSignalConfig {
  activeFileBonus: number;
  importReferenceBonus: number;
  errorLocationBonus: number;
  phaseMatchBonus: number;
  agentRoleBonus: number;
}

export const DEFAULT_RELEVANCE_SIGNALS: RelevanceSignalConfig = {
  activeFileBonus: 40,
  errorLocationBonus: 50,
  importReferenceBonus: 30,
  phaseMatchBonus: 25,
  agentRoleBonus: 20,
};

export class HeuristicContextRelevanceSelector implements ContextRelevanceSelector {
  private readonly signals: RelevanceSignalConfig;

  constructor(signals: Partial<RelevanceSignalConfig> = {}) {
    this.signals = { ...DEFAULT_RELEVANCE_SIGNALS, ...signals };
  }

  rank(candidates: ContextCandidate[], request: ContextRequest): ContextCandidate[] {
    const activeFiles = new Set(
      (request.activeFiles ?? []).map((f) => f.replace(/\\/g, '/').toLowerCase()),
    );
    const activeErrors = (request.activeErrors ?? []).map((e) => e.toLowerCase());
    const phase = request.phase?.toLowerCase();
    const role = request.agentRole?.toLowerCase();
    const taskWords = new Set(
      request.taskDescription
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((w) => w.length >= 3),
    );

    const scored = candidates.map((candidate) => {
      let score = typeof candidate.priority === 'number' ? candidate.priority : 50;
      const lowerContent = candidate.content.toLowerCase();
      const lowerLabel = candidate.label.toLowerCase();
      const lowerUri = candidate.sourceUri?.toLowerCase() ?? '';

      // 1. PINNED always stays at the maximum tier
      if (candidate.category === 'PINNED') {
        return { candidate, score: score + 1000 };
      }

      // 2. Active file bonus
      for (const af of activeFiles) {
        if (lowerUri.includes(af) || lowerLabel.includes(af)) {
          score += this.signals.activeFileBonus;
          break;
        }
      }

      // 3. Error / stack trace location bonus
      for (const err of activeErrors) {
        if (lowerUri && err.includes(lowerUri)) {
          score += this.signals.errorLocationBonus;
          break;
        }
        if (lowerContent && err.includes(lowerLabel)) {
          score += this.signals.errorLocationBonus;
          break;
        }
      }

      // 4. Phase-aware alignment
      if (phase === 'plan') {
        if (candidate.kind === 'repository' || lowerLabel.includes('architecture') || lowerLabel.includes('readme')) {
          score += this.signals.phaseMatchBonus;
        }
      } else if (phase === 'implement') {
        if (candidate.kind === 'repository' || lowerLabel.includes('source') || lowerLabel.includes('diff')) {
          score += this.signals.phaseMatchBonus;
        }
      } else if (phase === 'repair' || phase === 'debug') {
        if (candidate.category === 'ACTIVE' || lowerLabel.includes('error') || lowerLabel.includes('failure') || lowerLabel.includes('test')) {
          score += this.signals.phaseMatchBonus * 1.5;
        }
      } else if (phase === 'verify') {
        if (lowerLabel.includes('acceptance') || lowerLabel.includes('test') || lowerLabel.includes('check')) {
          score += this.signals.phaseMatchBonus * 1.5;
        }
      }

      // 5. Agent role alignment
      if (role === 'planner') {
        if (lowerLabel.includes('plan') || lowerLabel.includes('architecture') || lowerLabel.includes('instruction')) {
          score += this.signals.agentRoleBonus;
        }
      } else if (role === 'coder') {
        if (candidate.kind === 'repository' || lowerLabel.includes('source') || lowerLabel.includes('test')) {
          score += this.signals.agentRoleBonus;
        }
      } else if (role === 'reviewer') {
        if (lowerLabel.includes('diff') || lowerLabel.includes('verification') || lowerLabel.includes('acceptance')) {
          score += this.signals.agentRoleBonus;
        }
      }

      // 6. Task keyword relevance
      let keywordHits = 0;
      for (const word of taskWords) {
        if (lowerLabel.includes(word) || lowerUri.includes(word)) {
          keywordHits += 2;
        } else if (lowerContent.includes(word)) {
          keywordHits += 0.5;
        }
      }
      score += Math.min(20, keywordHits * 2);

      return { candidate, score };
    });

    // Sort descending by calculated score
    scored.sort((a, b) => b.score - a.score);

    return scored.map((s) => s.candidate);
  }
}
