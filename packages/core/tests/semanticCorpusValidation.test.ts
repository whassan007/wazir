import { describe, it, expect } from 'vitest';
import {
  DETERMINISTIC_SEMANTIC_CORPUS,
  type SemanticRetrievalPair,
  type CorpusEngineeringProblem,
} from '../src/fixtures/deterministicSemanticCorpus.js';
import type { StrategyStep } from '../src/types/strategyLearning.js';

describe('Deterministic Semantic Strategy Acceptance Corpus', () => {
  const corpus = DETERMINISTIC_SEMANTIC_CORPUS;

  it('verifies top-level corpus integrity and versioning', () => {
    expect(corpus.version).toBe('1.0.0');
    expect(corpus.description).toBeDefined();
    expect(corpus.structuralPairs.length).toBeGreaterThanOrEqual(1);
    expect(corpus.crossLanguagePairs.length).toBeGreaterThanOrEqual(1);
    expect(corpus.negativePairs.length).toBeGreaterThanOrEqual(1);
    expect(corpus.antiStrategyCases.length).toBeGreaterThanOrEqual(3);
  });

  // ========================================================================
  // 1. STRUCTURAL PAIR VALIDATION: SAME DEFECT, DISJOINT VOCABULARY/LAYOUT
  // ========================================================================
  describe('Structural Positive Pairs (High Relevance)', () => {
    const pair = corpus.structuralPairs.find((p) => p.id === 'pair-structural-lease-ownership');

    it('exists and is classified as HIGH relevance', () => {
      expect(pair).toBeDefined();
      expect(pair?.expectedRelevance).toBe('HIGH');
      expect(pair?.sharedArchitecturalConcept).toBeDefined();
    });

    it('confirms source and target problems share the same underlying defect category and signature', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, targetProblem } = pair!;
      expect(sourceProblem.problemSignature.category).toBe(targetProblem.problemSignature.category);
      expect(sourceProblem.problemSignature.failureSignature).toBe(targetProblem.problemSignature.failureSignature);
    });

    it('enforces disjoint repository layouts and distinct filenames', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, targetProblem } = pair!;
      expect(sourceProblem.repositoryId).not.toBe(targetProblem.repositoryId);
      expect(sourceProblem.workspaceRoot).not.toBe(targetProblem.workspaceRoot);

      const sourcePaths = sourceProblem.files.map((f) => f.relativePath);
      const targetPaths = targetProblem.files.map((f) => f.relativePath);

      // Verify no common file paths
      for (const sp of sourcePaths) {
        expect(targetPaths).not.toContain(sp);
      }
    });

    it('enforces disjoint error wording while representing the same defect', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, targetProblem } = pair!;
      const sourceErrorText = sourceProblem.errorDiagnostics.join(' ').toLowerCase();
      const targetErrorText = targetProblem.errorDiagnostics.join(' ').toLowerCase();

      // Check distinct diagnostic vocabularies
      expect(sourceErrorText).toContain('lease');
      expect(sourceErrorText).not.toContain('epoch');

      expect(targetErrorText).toContain('epoch');
      expect(targetErrorText).not.toContain('lease');
    });

    it('proves anti-leakage: forbidden source tokens do not appear anywhere in target files', () => {
      expect(pair).toBeDefined();
      const { targetProblem, forbiddenTokensInTargetPlan } = pair!;
      const targetCorpusContent = targetProblem.files.map((f) => f.content).join(' ');

      expect(forbiddenTokensInTargetPlan.length).toBeGreaterThan(0);
      for (const token of forbiddenTokensInTargetPlan) {
        expect(targetCorpusContent).not.toContain(token);
      }
    });

    it('validates abstract approach steps do not leak source filenames or literal symbols', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, forbiddenTokensInTargetPlan } = pair!;
      for (const step of sourceProblem.expectedAbstractApproach) {
        for (const token of forbiddenTokensInTargetPlan) {
          expect(step.action).not.toContain(token);
          expect(step.intent).not.toContain(token);
        }
      }
    });
  });

  // ========================================================================
  // 2. CROSS-LANGUAGE FIXTURE: ARCHITECTURE EQUIVALENCE ACROSS LANGUAGES
  // ========================================================================
  describe('Cross-Language Equivalence Fixture', () => {
    const pair = corpus.crossLanguagePairs.find((p) => p.id === 'pair-cross-language-cancellation');

    it('exists, is classified as HIGH relevance, and spans two distinct languages', () => {
      expect(pair).toBeDefined();
      expect(pair?.expectedRelevance).toBe('HIGH');
      const { sourceProblem, targetProblem } = pair!;

      expect(sourceProblem.problemSignature.languages).toContain('typescript');
      expect(targetProblem.problemSignature.languages).toContain('go');
      expect(sourceProblem.problemSignature.languages).not.toEqual(targetProblem.problemSignature.languages);
    });

    it('shares transferable architectural concepts (cancellation, late-result rejection, cleanup)', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, targetProblem } = pair!;

      // Both belong to lifecycle failure / cancellation
      expect(sourceProblem.problemSignature.category).toBe('worker_lifecycle_failure');
      expect(targetProblem.problemSignature.category).toBe('worker_lifecycle_failure');
      expect(sourceProblem.problemSignature.domainTags).toContain('lifecycle');
      expect(targetProblem.problemSignature.domainTags).toContain('lifecycle');
      expect(sourceProblem.problemSignature.domainTags).toContain('cancellation');
      expect(targetProblem.problemSignature.domainTags).toContain('cancellation');
    });

    it('strictly separates transferable architectural steps from language-specific library calls', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, forbiddenTokensInTargetPlan } = pair!;

      // Transferable steps in source expectedAbstractApproach must NOT mention TypeScript-specific AbortSignal/AbortController
      for (const step of sourceProblem.expectedAbstractApproach) {
        expect(step.action).not.toContain('AbortSignal');
        expect(step.action).not.toContain('AbortController');
        expect(step.action).not.toContain('context.Context');
        expect(step.action).not.toContain('chan');
      }

      // Target code must not contain source symbols
      const targetCode = pair!.targetProblem.files.map((f) => f.content).join(' ');
      for (const token of forbiddenTokensInTargetPlan) {
        expect(targetCode).not.toContain(token);
      }
    });
  });

  // ========================================================================
  // 3. NEGATIVE PAIRS: LEXICAL SIMILARITY REPRESENTING DIFFERENT DEFECTS
  // ========================================================================
  describe('Negative Pairs (Lexical Similarity with Distinct Root Causes)', () => {
    const pair = corpus.negativePairs.find((p) => p.id === 'pair-negative-lexical-overlap');

    it('exists and is strictly classified as IRRELEVANT', () => {
      expect(pair).toBeDefined();
      expect(pair?.expectedRelevance).toBe('IRRELEVANT');
    });

    it('demonstrates high superficial lexical overlap between prompts/diagnostics', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, targetProblem } = pair!;

      const sharedWords = ['worker', 'timeout', 'queue', 'heartbeat'];
      const sourceCombined = `${sourceProblem.taskPrompt} ${sourceProblem.errorDiagnostics.join(' ')}`.toLowerCase();
      const targetCombined = `${targetProblem.taskPrompt} ${targetProblem.errorDiagnostics.join(' ')}`.toLowerCase();

      for (const word of sharedWords) {
        expect(sourceCombined).toContain(word);
        expect(targetCombined).toContain(word);
      }
    });

    it('verifies orthogonal underlying problem categories and failure signatures', () => {
      expect(pair).toBeDefined();
      const { sourceProblem, targetProblem } = pair!;

      // Source is concurrency race/deadlock, target is memory exhaustion / backpressure
      expect(sourceProblem.problemSignature.category).toBe('race_condition');
      expect(targetProblem.problemSignature.category).toBe('performance_regression');
      expect(sourceProblem.problemSignature.failureSignature).toBe('DEADLOCK_DETECTED');
      expect(targetProblem.problemSignature.failureSignature).toBe('OUT_OF_MEMORY');
    });
  });

  // ========================================================================
  // 4. ANTI-STRATEGY FIXTURES: HISTORICAL FAILED STRATEGY CASES
  // ========================================================================
  describe('Anti-Strategy Fixtures (Historical Failure Modes)', () => {
    it('covers all three required anti-strategy archetypes', () => {
      const antiPatterns = corpus.antiStrategyCases.map((c) => c.antiPatternName);
      expect(antiPatterns).toContain('speculative_blind_editing_before_reproduction');
      expect(antiPatterns).toContain('blind_stale_search_replace_overwrites');
      expect(antiPatterns).toContain('tight_retry_loop_without_re-reading_diagnostics');
    });

    it('validates edit before reproduction anti-strategy integrity', () => {
      const c = corpus.antiStrategyCases.find((x) => x.id === 'anti-edit-before-repro');
      expect(c).toBeDefined();
      expect(c?.warningMessage).toContain('ANTI-STRATEGY DETECTED');
      expect(c?.consequences.length).toBeGreaterThan(0);
      expect(c?.remedySuggestion).toContain('FIRST');
      // Flawed approach starts immediately with modify rather than inspect or verify
      expect(c?.flawedApproachSteps[0].phase).toBe('modify');
    });

    it('validates blind stale replacement anti-strategy integrity', () => {
      const c = corpus.antiStrategyCases.find((x) => x.id === 'anti-blind-stale-replacement');
      expect(c).toBeDefined();
      expect(c?.warningMessage).toContain('collateral breakage');
      expect(c?.remedySuggestion).toContain('Read target files immediately before editing');
    });

    it('validates retry without reread anti-strategy integrity', () => {
      const c = corpus.antiStrategyCases.find((x) => x.id === 'anti-retry-without-reread');
      expect(c).toBeDefined();
      expect(c?.warningMessage).toContain('wastes iteration budget');
      expect(c?.remedySuggestion).toContain('read and parse the compiler/test error output');
    });
  });

  // ========================================================================
  // 5. DETERMINISTIC FALSIFIABILITY & CLASSIFICATION RIGOR
  // ========================================================================
  describe('Falsifiability & Relevance Classification Standards', () => {
    it('only uses discrete HIGH, MEDIUM, IRRELEVANT relevance classes', () => {
      const validClasses = new Set(['HIGH', 'MEDIUM', 'IRRELEVANT']);
      for (const p of [...corpus.structuralPairs, ...corpus.crossLanguagePairs, ...corpus.negativePairs]) {
        expect(validClasses.has(p.expectedRelevance)).toBe(true);
      }
      for (const a of corpus.antiStrategyCases) {
        expect(validClasses.has(a.expectedRelevance)).toBe(true);
      }
    });

    it('proves solution text is never located in target repository workspace files', () => {
      // Invariant: Target repository files contain only the defective / initial state,
      // never the solution or remedy code.
      for (const p of [...corpus.structuralPairs, ...corpus.crossLanguagePairs]) {
        for (const file of p.targetProblem.files) {
          expect(file.content).not.toContain('remedySuggestion');
          expect(file.content).not.toContain('expectedAbstractApproach');
          expect(file.content).not.toContain('// Solution:');
        }
      }
    });
  });
});
