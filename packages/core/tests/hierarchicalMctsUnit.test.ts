import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HierarchicalMctsService,
  computeStrategyDiversity,
  computeNodeStateHash,
  computeControllerReward,
  selectBestUCTChild,
} from '../src/services/hierarchicalMctsService.js';
import type {
  SearchNode,
  HierarchicalSearchConfig,
  ExecutionRecord,
  CandidateEvaluation,
  CheckRunRecord,
} from '../src/types/index.js';

describe('Hierarchical MCTS Unit Tests', () => {
  describe('Strategy Diversity & State Hashing', () => {
    it('computes strategy diversity properly between identical, similar, and orthogonal strategies', () => {
      const s1 = 'Event-driven pub/sub architecture using Redis streams for decoupled worker tasks';
      const s2 = 'Event-driven pub/sub architecture using Redis streams for decoupled worker tasks';
      expect(computeStrategyDiversity(s1, s2)).toBe(0);

      const s3 = 'Layered monolithic modular architecture with direct synchronous service calls and in-memory queue';
      const div = computeStrategyDiversity(s1, s3);
      expect(div).toBeGreaterThan(0.6);
    });

    it('computes deterministic node state hashes for transposition detection', () => {
      const hash1 = computeNodeStateHash({
        filesSnapshot: { 'src/app.ts': 'console.log(1);', 'src/db.ts': 'export const db = 1;' },
        mutations: ['mut-1', 'mut-2'],
        strategy: 'approach_a',
      });

      const hash2 = computeNodeStateHash({
        filesSnapshot: { 'src/db.ts': 'export const db = 1;', 'src/app.ts': 'console.log(1);' },
        mutations: ['mut-2', 'mut-1'],
        strategy: 'approach_a',
      });

      expect(hash1).toBe(hash2);

      const hash3 = computeNodeStateHash({
        filesSnapshot: { 'src/app.ts': 'console.log(2);' },
        strategy: 'approach_b',
      });

      expect(hash1).not.toBe(hash3);
    });
  });

  describe('Controller Evidence Reward Invariants', () => {
    it('derives reward strictly from controller evidence and never model confidence', () => {
      const checks: CheckRunRecord[] = [
        { name: 'build', command: 'tsc', ok: true, durationMs: 50 },
        { name: 'test', command: 'npm test', ok: true, durationMs: 100 },
        { name: 'lint', command: 'eslint', ok: true, durationMs: 20 },
      ];

      const reward = computeControllerReward({
        checks,
        errors: [],
        usage: { input: 2000, output: 500, total: 2500 },
        wallTimeMs: 150,
        repairCycles: 0,
      });

      expect(reward.correctness).toBe(true);
      expect(reward.verificationPassed).toBe(true);
      expect(reward.acceptanceProgress).toBe(1.0);
      expect(reward.protectedViolations).toHaveLength(0);
      expect(reward.scalarReward).toBeGreaterThan(0.8);
      expect(reward.rawMetrics.protectedViolationsCount).toBe(0);
    });

    it('assigns zero reward when a protected oracle is violated', () => {
      const checks: CheckRunRecord[] = [
        { name: 'build', command: 'tsc', ok: true, durationMs: 50 },
        { name: 'protected_audit_oracle', command: 'audit.sh', ok: false, durationMs: 100, protected: true } as any,
      ];

      const reward = computeControllerReward({
        checks,
        errors: ['Security oracle failed'],
        usage: { input: 1000, output: 200 },
      });

      expect(reward.protectedViolations.length).toBeGreaterThan(0);
      expect(reward.scalarReward).toBe(0.0);
    });

    it('assigns zero reward for catastrophic unrecoverable build failure', () => {
      const reward = computeControllerReward({
        checks: [{ name: 'build', command: 'tsc', ok: false, durationMs: 50 }],
        errors: ['UNRECOVERABLE_BUILD: missing core toolchain headers'],
      });

      expect(reward.correctness).toBe(false);
      expect(reward.scalarReward).toBe(0.0);
    });
  });

  describe('UCT Selection & Tree Navigation', () => {
    it('prioritizes unvisited children with infinite exploration score before visited children', () => {
      const parent: SearchNode = {
        id: 'parent',
        depth: 0,
        level: 'architecture',
        checkpointId: 'chk-0',
        strategy: 'root',
        mutations: [],
        workspaceRevision: 0,
        stateHash: 'h0',
        visits: 10,
        value: 5.0,
        meanValue: 0.5,
        children: ['c1', 'c2'],
        terminal: false,
        createdAt: new Date(),
      };

      const c1: SearchNode = {
        ...parent,
        id: 'c1',
        depth: 1,
        parentId: 'parent',
        visits: 5,
        value: 4.0,
        meanValue: 0.8,
        children: [],
      };

      const c2: SearchNode = {
        ...parent,
        id: 'c2',
        depth: 1,
        parentId: 'parent',
        visits: 0,
        value: 0,
        meanValue: 0,
        children: [],
      };

      const selected = selectBestUCTChild(parent, [c1, c2]);
      expect(selected?.id).toBe('c2');
    });

    it('balances exploitation and exploration according to UCT formula when all children visited', () => {
      const parent: SearchNode = {
        id: 'parent',
        depth: 0,
        level: 'architecture',
        checkpointId: 'chk-0',
        strategy: 'root',
        mutations: [],
        workspaceRevision: 0,
        stateHash: 'h0',
        visits: 100,
        value: 60.0,
        meanValue: 0.6,
        children: ['c1', 'c2'],
        terminal: false,
        createdAt: new Date(),
      };

      // c1: high visits, decent score
      const c1: SearchNode = {
        ...parent,
        id: 'c1',
        depth: 1,
        parentId: 'parent',
        visits: 90,
        value: 63.0,
        meanValue: 0.7,
        children: [],
      };

      // c2: low visits (high exploration term), slightly lower mean value
      const c2: SearchNode = {
        ...parent,
        id: 'c2',
        depth: 1,
        parentId: 'parent',
        visits: 10,
        value: 6.5,
        meanValue: 0.65,
        children: [],
      };

      // UCT(c1) = 0.7 + 1.414 * sqrt(ln(100) / 90) = 0.7 + 1.414 * 0.226 = 1.020
      // UCT(c2) = 0.65 + 1.414 * sqrt(ln(100) / 10) = 0.65 + 1.414 * 0.678 = 1.609 -> c2 should be selected!
      const selected = selectBestUCTChild(parent, [c1, c2]);
      expect(selected?.id).toBe('c2');
    });

    it('ignores pruned children during UCT selection', () => {
      const parent: SearchNode = {
        id: 'parent',
        depth: 0,
        level: 'architecture',
        checkpointId: 'chk-0',
        strategy: 'root',
        mutations: [],
        workspaceRevision: 0,
        stateHash: 'h0',
        visits: 5,
        value: 2.0,
        meanValue: 0.4,
        children: ['c1', 'c2'],
        terminal: false,
        createdAt: new Date(),
      };

      const c1: SearchNode = {
        ...parent,
        id: 'c1',
        depth: 1,
        parentId: 'parent',
        visits: 0,
        pruned: true,
        pruneReason: 'Violated protected oracle',
        children: [],
      };

      const c2: SearchNode = {
        ...parent,
        id: 'c2',
        depth: 1,
        parentId: 'parent',
        visits: 1,
        value: 0.6,
        meanValue: 0.6,
        pruned: false,
        children: [],
      };

      const selected = selectBestUCTChild(parent, [c1, c2]);
      expect(selected?.id).toBe('c2');
    });
  });
});
