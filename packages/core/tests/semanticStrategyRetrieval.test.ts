import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyLearningService } from '../src/services/strategyLearningService.js';
import { ModelIntelligenceService } from '../src/services/modelIntelligenceService.js';
import { MemoryStore } from '@wazir/shared';
import { DETERMINISTIC_SEMANTIC_CORPUS } from '../src/fixtures/deterministicSemanticCorpus.js';
import type { ExecutionRecord } from '../src/types/execution.js';
import type { StrategyQuery, EngineeringStrategy, RelevantStrategy } from '../src/types/strategyLearning.js';

describe('StrategyLearningService: Hybrid Semantic + Structural Retrieval & Clustering', () => {
  let strategyService: StrategyLearningService;
  let store: MemoryStore;
  let modelIntelligenceService: ModelIntelligenceService;

  beforeEach(() => {
    store = new MemoryStore();
    modelIntelligenceService = new ModelIntelligenceService({ store });
    strategyService = new StrategyLearningService({
      store,
      modelIntelligenceService,
      minEvidenceThreshold: 2,
    });
  });

  describe('Multi-Signal Scoring & Diagnostic Breakdown', () => {
    it('computes transparent multi-signal score breakdown without collapsing into raw semantic similarity', async () => {
      const source = DETERMINISTIC_SEMANTIC_CORPUS.structuralPairs[0].sourceProblem;

      const record: ExecutionRecord = {
        execution: {
          id: 'exec-sig-breakdown-1',
          taskId: source.id,
          runtimeId: 'local',
          modelId: 'qwen-2.5-coder',
          status: 'completed',
          workspaceRoot: source.workspaceRoot,
          createdAt: new Date(),
          startedAt: new Date(Date.now() - 3000),
          completedAt: new Date(),
        },
        task: {
          id: source.id,
          prompt: source.taskPrompt,
          type: 'coding',
          expectedAbstractApproach: source.expectedAbstractApproach,
          problemSignature: source.problemSignature,
        } as any,
        toolCalls: [
          { id: 'c1', tool: 'search_code', input: { pattern: 'lease' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 50, at: new Date() },
          { id: 'c2', tool: 'edit_file', input: { file: 'src/lease.ts' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 120, at: new Date() },
          { id: 'c3', tool: 'run_tests', input: { command: 'npm test' }, ok: true, policyEffect: 'allow', policyRule: 'default', durationMs: 1000, at: new Date() },
        ],
        filesChanged: ['src/lease.ts'],
        errors: [],
        events: [],
        checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1000 }],
        evaluation: {
          success: true,
          reasons: ['Lease race condition resolved with atomic versioning'],
          filesChanged: ['src/lease.ts'],
          checks: [{ name: 'test', command: 'npm test', ok: true, output: 'passed', durationMs: 1000 }],
          evidence: [
            { id: 'ev-sig-1', type: 'TEST', exitCode: 0, status: 'PASS', revision: 1 },
            { id: 'ev-sig-2', type: 'ACCEPTANCE', exitCode: 0, status: 'PASS', revision: 1 },
          ],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
        usage: { input: 1500, output: 300, total: 1800 },
      };

      await strategyService.extractStrategy(record, {
        overrideCategory: source.problemSignature.category,
        repositoryCharacteristics: source.problemSignature.repositoryCharacteristics,
      });

      const query: StrategyQuery = {
        problemDescription: 'Lease token expires mid-flight causing worker heartbeat race',
        taskCategory: source.problemSignature.category,
        observedFailures: source.errorDiagnostics,
        architectureProperties: source.problemSignature.repositoryCharacteristics,
        language: 'typescript',
      };

      const results = strategyService.queryStrategies(query);
      expect(results.length).toBeGreaterThan(0);

      const top = results[0];
      expect(top.scoreBreakdown).toBeDefined();
      const b = top.scoreBreakdown!;

      // All sub-signals must be individually quantified in [0, 1] range
      expect(b.semantic).toBeGreaterThan(0.5);
      expect(b.structural).toBeGreaterThanOrEqual(0);
      expect(b.architecture).toBeGreaterThanOrEqual(0.5);
      expect(b.failureTraits).toBeGreaterThanOrEqual(0.5);
      expect(b.languageCompatibility).toBe(1.0);
      expect(b.evidenceQuality).toBeGreaterThanOrEqual(0.7);
      expect(b.confidence).toBeGreaterThan(0);

      // Verify applicability reflects multi-signal combination
      expect(top.applicability).toBeGreaterThan(0.7);
      expect(top.relevanceClass).toBe('HIGH');
    });
  });

  describe('Clustering Semantically Equivalent Engineering Experiences', () => {
    it('groups lease expiration, orphan subprocess, and worker disconnect into REMOTE WORK OWNERSHIP / CANCELLATION', async () => {
      // 1. Ingest multiple distinct experiences related to remote work ownership & cancellation
      const strategiesToIngest: Array<{ id: string; name: string; domain: string; category: any; approach: string[] }> = [
        {
          id: 'strat-lease-exp',
          name: 'Worker lease expiration handling',
          domain: 'remote_work_coordination',
          category: 'distributed_consensus',
          approach: ['Check lease timeout', 'Renew lease via atomic CAS', 'Trigger orderly shutdown if expired'],
        },
        {
          id: 'strat-orphan-subproc',
          name: 'Orphan subprocess termination on worker death',
          domain: 'remote_work_coordination',
          category: 'lifecycle_management',
          approach: ['Track child PID in session table', 'Register process exit handler', 'Send SIGTERM then SIGKILL to process group'],
        },
        {
          id: 'strat-worker-disc',
          name: 'Worker disconnect late-result rejection',
          domain: 'remote_work_coordination',
          category: 'distributed_consensus',
          approach: ['Validate worker token on completion', 'Drop late result if lease re-assigned', 'Log stale completion warning'],
        },
        {
          id: 'strat-cancel-prop',
          name: 'Cancellation signal propagation across worker cluster',
          domain: 'remote_work_coordination',
          category: 'lifecycle_management',
          approach: ['Broadcast AbortSignal to all leased workers', 'Wait for task teardown acknowledgment', 'Reclaim allocated memory'],
        },
      ];

      for (const s of strategiesToIngest) {
        const dummyStrategy: EngineeringStrategy = {
          id: s.id,
          problemSignature: {
            category: s.category,
            languages: ['typescript'],
            repositoryCharacteristics: ['distributed', 'concurrency'],
            failureSignature: s.name,
            failureEvidenceTags: ['timeout', 'cancellation', 'worker_disconnect'],
            domainTags: [s.domain, 'worker_lifecycle'],
          },
          taskCategories: [s.category],
          languages: ['typescript'],
          repositoryCharacteristics: ['distributed', 'concurrency'],
          failureSignature: s.name,
          approach: s.approach.map((a, i) => ({ phase: (i === 0 ? 'inspect' : i === 1 ? 'modify' : 'verify') as any, action: a, intent: a })),
          usefulTools: ['search_code', 'edit_file'],
          usefulAgents: ['coding_agent'],
          usefulModels: [{ capabilityCategory: 'concurrency', preferredProfileScore: 0.9, description: 'Concurrency specialist' }],
          verificationPattern: {
            recommendedCheckTypes: ['test'],
            minimumEvidenceThreshold: 2,
            keyMetricsToMonitor: ['leak_count'],
            flakinessMitigation: ['isolated_ports'],
          },
          executions: 3,
          successRate: 1.0,
          repairDistribution: [1],
          tokenDistribution: [1200],
          durationDistribution: [2000],
          distributions: {
            repairCycles: { p50: 1, p90: 1, p99: 1, min: 1, max: 1 },
            tokens: { p50: 1200, p90: 1200, p99: 1200, min: 1200, max: 1200 },
            durationMs: { p50: 2000, p90: 2000, p99: 2000, min: 2000, max: 2000 },
          },
          evidenceRefs: ['ev-1', 'ev-2'],
          confidence: 0.88,
          version: 2,
          knownFailureModes: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        (strategyService as any).strategies.set(dummyStrategy.id, dummyStrategy);
      }

      // Also ingest an orthogonal defect: Deadlock via mutex inverted lock acquisition
      const deadlockStrategy: EngineeringStrategy = {
        id: 'strat-deadlock-ordering',
        problemSignature: {
          category: 'concurrency_race',
          languages: ['typescript'],
          repositoryCharacteristics: ['database', 'orm'],
          failureSignature: 'Database table row lock deadlock',
          failureEvidenceTags: ['deadlock', 'lock_ordering', 'sql_deadlock'],
          domainTags: ['database_storage'],
        },
        taskCategories: ['concurrency_race'],
        languages: ['typescript'],
        repositoryCharacteristics: ['database', 'orm'],
        failureSignature: 'Database table row lock deadlock',
        approach: [
          { phase: 'inspect', action: 'Inspect lock acquisition order in transaction', intent: 'Find inverted mutex' },
          { phase: 'modify', action: 'Sort entity IDs monotonically prior to lock acquisition', intent: 'Enforce lock hierarchy' },
          { phase: 'verify', action: 'Run concurrent stress test', intent: 'Verify 0 deadlocks' },
        ],
        usefulTools: ['search_code', 'edit_file'],
        usefulAgents: ['coding_agent'],
        usefulModels: [],
        verificationPattern: {
          recommendedCheckTypes: ['test'],
          minimumEvidenceThreshold: 2,
          keyMetricsToMonitor: ['deadlock_count'],
          flakinessMitigation: [],
        },
        executions: 2,
        successRate: 1.0,
        repairDistribution: [1],
        tokenDistribution: [1000],
        durationDistribution: [1500],
        distributions: {
          repairCycles: { p50: 1, p90: 1, p99: 1, min: 1, max: 1 },
          tokens: { p50: 1000, p90: 1000, p99: 1000, min: 1000, max: 1000 },
          durationMs: { p50: 1500, p90: 1500, p99: 1500, min: 1500, max: 1500 },
        },
        evidenceRefs: ['ev-dl-1', 'ev-dl-2'],
        confidence: 0.85,
        version: 1,
        knownFailureModes: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      (strategyService as any).strategies.set(deadlockStrategy.id, deadlockStrategy);

      // Perform clustering
      const clusters = strategyService.clusterStrategies();
      expect(clusters.length).toBeGreaterThan(1);

      // Find the remote work cluster
      const remoteWorkCluster = clusters.find(
        (c) => c.label.includes('REMOTE WORK OWNERSHIP') || c.label.includes('DISTRIBUTED') || c.label.includes('COORDINATION')
      );
      expect(remoteWorkCluster).toBeDefined();

      // Assert strategies in remote work cluster contains the 4 related strategies
      expect(remoteWorkCluster?.strategies).toContain('strat-lease-exp');
      expect(remoteWorkCluster?.strategies).toContain('strat-orphan-subproc');
      expect(remoteWorkCluster?.strategies).toContain('strat-worker-disc');
      expect(remoteWorkCluster?.strategies).toContain('strat-cancel-prop');

      // The orthogonal deadlock strategy must NOT be in the remote work cluster
      expect(remoteWorkCluster?.strategies).not.toContain('strat-deadlock-ordering');
    });
  });

  describe('Context Injection & Token Budget Compaction', () => {
    it('formats compact relevant strategy within strict ContextCompiler token budget (<= 300 tokens)', () => {
      const canonicalStrategy: EngineeringStrategy = {
        id: 'strat-canonical-001',
        problemSignature: {
          category: 'distributed_consensus',
          languages: ['typescript'],
          repositoryCharacteristics: ['monorepo', 'distributed'],
          failureSignature: 'Worker heartbeat timeout under high gc load',
          failureEvidenceTags: ['timeout', 'lease_expiration'],
          domainTags: ['remote_work_coordination'],
        },
        taskCategories: ['distributed_consensus'],
        languages: ['typescript'],
        repositoryCharacteristics: ['monorepo', 'distributed'],
        failureSignature: 'Worker heartbeat timeout under high gc load',
        approach: [
          { phase: 'find', action: 'Locate lease expiration ticker and heartbeat interval', intent: 'Identify drift' },
          { phase: 'modify', action: 'Decouple heartbeat ping from main thread loop via separate worker thread', intent: 'Prevent GC delay' },
          { phase: 'test', action: 'Simulate 5s GC pause and verify lease is maintained', intent: 'Validate fix' },
        ],
        usefulTools: ['search_code', 'edit_file'],
        usefulAgents: ['coding_agent'],
        usefulModels: [],
        verificationPattern: {
          recommendedCheckTypes: ['test'],
          minimumEvidenceThreshold: 2,
          keyMetricsToMonitor: ['lease_loss_count'],
          flakinessMitigation: [],
        },
        executions: 4,
        successRate: 1.0,
        repairDistribution: [1],
        tokenDistribution: [1100],
        durationDistribution: [1800],
        distributions: {
          repairCycles: { p50: 1, p90: 1, p99: 1, min: 1, max: 1 },
          tokens: { p50: 1100, p90: 1100, p99: 1100, min: 1100, max: 1100 },
          durationMs: { p50: 1800, p90: 1800, p99: 1800, min: 1800, max: 1800 },
        },
        evidenceRefs: ['ev-01', 'ev-02'],
        confidence: 0.92,
        version: 3,
        knownFailureModes: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const relevant: RelevantStrategy = {
        strategyId: canonicalStrategy.id,
        normalizedStrategy: canonicalStrategy,
        applicability: 0.88,
        semanticSimilarity: 0.85,
        structuralSimilarity: 0.80,
        evidenceQuality: 0.95,
        verifiedUses: canonicalStrategy.executions,
        verifiedFailures: 0,
        antiStrategyWarnings: [
          {
            problemSignature: canonicalStrategy.problemSignature,
            antiPatternName: 'speculative_blind_editing_before_reproduction',
            description: 'speculative editing',
            observedFailureCount: 2,
            failureRate: 0.8,
            warningMessage: 'ANTI-STRATEGY DETECTED: Speculative blind editing without reproduction test.',
            remedySuggestion: 'Implement reproducible integration test FIRST before editing production files.',
          },
        ],
        strategy: canonicalStrategy,
        matchScore: 0.88,
        confidence: 0.92,
        historicalEvidenceCount: canonicalStrategy.executions,
        warnings: [],
        relevanceExplanation: 'Test match',
        clusterLabel: 'REMOTE WORK OWNERSHIP / CANCELLATION',
      };

      const formatted = strategyService.formatStrategyForContext(relevant);

      // Verify compact formatted content
      expect(formatted).toContain('STRATEGY GUIDANCE');
      expect(formatted).toContain('strat-canonical-001');
      expect(formatted).toContain('Recommended Abstract Approach:');
      expect(formatted).toContain('AVOID:');
      expect(formatted).toContain('REMEDY:');
      expect(formatted).toContain('Past experience cannot prove current correctness');

      // Estimate tokens (~4 characters per token heuristic)
      const tokenEstimate = Math.ceil(formatted.length / 4);
      expect(tokenEstimate).toBeLessThanOrEqual(300);
      expect(formatted.length).toBeLessThan(1200);
    });
  });

  describe('Epistemic Principle: PAST EXPERIENCE != CURRENT EVIDENCE', () => {
    it('maintains that past strategy guidance does not establish current correctness or completion', () => {
      const canonicalStrategy: EngineeringStrategy = {
        id: 'strat-past-exp-01',
        problemSignature: {
          category: 'distributed_consensus',
          languages: ['typescript'],
          repositoryCharacteristics: ['monorepo'],
          failureSignature: 'Lease token expiration',
          failureEvidenceTags: ['timeout'],
          domainTags: ['remote_work'],
        },
        taskCategories: ['distributed_consensus'],
        languages: ['typescript'],
        repositoryCharacteristics: ['monorepo'],
        failureSignature: 'Lease token expiration',
        approach: [{ phase: 'modify', action: 'Fix lease timeout', intent: 'Fix' }],
        usefulTools: ['edit_file'],
        usefulAgents: [],
        usefulModels: [],
        verificationPattern: {
          recommendedCheckTypes: ['test'],
          minimumEvidenceThreshold: 2,
          keyMetricsToMonitor: [],
          flakinessMitigation: [],
        },
        executions: 10,
        successRate: 1.0,
        repairDistribution: [1],
        tokenDistribution: [1000],
        durationDistribution: [1000],
        distributions: {
          repairCycles: { p50: 1, p90: 1, p99: 1, min: 1, max: 1 },
          tokens: { p50: 1000, p90: 1000, p99: 1000, min: 1000, max: 1000 },
          durationMs: { p50: 1000, p90: 1000, p99: 1000, min: 1000, max: 1000 },
        },
        evidenceRefs: ['ev-01', 'ev-02'],
        confidence: 0.99,
        version: 5,
        knownFailureModes: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (strategyService as any).strategies.set(canonicalStrategy.id, canonicalStrategy);

      const query: StrategyQuery = {
        problemDescription: 'Lease token expires',
        taskCategory: 'distributed_consensus',
        observedFailures: ['timeout'],
        architectureProperties: ['monorepo'],
        language: 'typescript',
      };

      const results = strategyService.queryStrategies(query);
      expect(results.length).toBeGreaterThan(0);
      const relevant = results[0];

      // Strategy retrieval produces guidance, but confidence must remain bounded (< 1.0)
      expect(relevant.confidence).toBeLessThan(1.0);

      // Invariant: Unverified execution record is never marked as verified strategy
      const unverifiedRecord: ExecutionRecord = {
        execution: {
          id: 'exec-unverified',
          taskId: 'task-1',
          runtimeId: 'local',
          modelId: 'qwen',
          status: 'completed',
          createdAt: new Date(),
          startedAt: new Date(),
          completedAt: new Date(),
        },
        task: { id: 'task-1', prompt: 'test', type: 'coding' } as any,
        toolCalls: [],
        filesChanged: [],
        errors: [],
        events: [],
        checks: [],
        // evaluation is missing physical evidence
        evaluation: {
          success: true,
          reasons: ['Model claimed task completed without test pass'],
          filesChanged: [],
          checks: [],
          evidence: [],
          evaluatedAt: new Date(),
        },
        policyDecisions: [],
      };

      // Model narrative without verification evidence is rejected
      expect((strategyService as any).isExecutionVerified(unverifiedRecord)).toBe(false);
    });
  });
});
