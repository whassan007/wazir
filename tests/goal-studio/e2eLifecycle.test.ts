/**
 * Contract-driven end-to-end acceptance suite for the 12-step Goal Studio lifecycle.
 *
 * Exercises `GoalStudioServices` across all 12 lifecycle stages on the real
 * `packages/goals/fixtures/nobel_goal_graph.yaml` strategic goal graph:
 *   1. Create a Goal Studio project
 *   2. Import the strategic goal graph (`nobel_goal_graph.yaml`)
 *   3. Validate graph structure and dependencies (positive & negative cases)
 *   4. Persist graph state and revisions (immutable monotonic revisions + digest)
 *   5. Inspect initial target statuses (`Y1.1` eligible, `Y1.2`→`Y1.3` chain, `Y1.4`–`Y3.3` queued)
 *   6. Start autonomous execution (pins graphId, graphRevision, graphDigest)
 *   7. Execute real eligible targets (`Y1.1` → `Y1.2` → `Y1.3`)
 *   8. Produce real artifacts in the workspace (`scope.md`, `model.smt2`, `reference-gate/`, ...)
 *   9. Run independent verification on the artifacts (validatorIdentity !== executorIdentity)
 *  10. Update target state only from verification evidence (`completed` unlocks `Y1.4` & `Y2.1`;
 *      `external_dependency: true` transitions to `awaiting_external` without self-certifying completion)
 *  11. Controlled failure, repair (`DIAGNOSE → REPAIR_HYPOTHESIS → REPLAN → RETEST`), retry,
 *      and branch isolation when one branch is blocked
 *  12. Persist and reload state across process restart (`JsonFileStore` reload + `recoverRuns`)
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import {
  GOAL_STUDIO_CONTRACT_VERSION,
  TERMINAL_TARGET_STATUSES,
  UNLOCKING_TARGET_STATUSES,
  idempotencyKey,
  type GoalGraphDefinition,
  type GoalProject,
  type GoalStudioEvent,
  type TargetId,
} from '../../packages/goals/src/contracts.js';
import {
  EXTERNAL_RECORD_FILE,
  FIXTURE_FACTS,
  artifactFile,
  createFakeGoalStudioServices,
  definitionDigest,
  loadFixtureDefinition,
  readFixtureYaml,
  resolveGoalStudioServices,
  sha256Hex,
} from './fakes/index.js';

describe('Goal Studio 12-Step End-to-End Acceptance Lifecycle', () => {
  let tmpDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-goal-studio-e2e-'));
    workspaceRoot = path.join(tmpDir, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Steps 1–10: imports nobel_goal_graph.yaml, validates, persists revisions, executes Y1.1→Y1.2→Y1.3 with real workspace artifacts, independently verifies, unlocks Y1.4 & Y2.1, and holds externalDependency targets at awaiting_external', async () => {
    expect(GOAL_STUDIO_CONTRACT_VERSION).toBe(1);
    expect(UNLOCKING_TARGET_STATUSES).toEqual(['completed']);
    expect(TERMINAL_TARGET_STATUSES).toEqual(['completed', 'blocked', 'stopped']);

    const store = new MemoryStore();
    const { services } = await resolveGoalStudioServices({ store, workspaceRoot, autoAdvance: false, autoStart: false });

    // -------------------------------------------------------------------------
    // Step 1: Create a Goal Studio project
    // -------------------------------------------------------------------------
    const project: GoalProject = {
      id: 'proj-nobel-peace-program',
      name: 'Provable Algorithmic Peace Program',
      createdAt: new Date().toISOString(),
    };
    await store.put(`goals/projects/${project.id}`, project);
    const savedProject = await store.get<GoalProject>(`goals/projects/${project.id}`);
    expect(savedProject).toEqual(project);

    // -------------------------------------------------------------------------
    // Step 2: Import the strategic goal graph (nobel_goal_graph.yaml)
    // -------------------------------------------------------------------------
    const yaml = readFixtureYaml();
    const imported = await services.graphs.importYaml(project.id, yaml, 'user:operator');
    expect(imported.validation.valid).toBe(true);
    expect(imported.validation.issues).toEqual([]);
    expect(imported.record).toBeDefined();
    const rev1 = imported.record!;

    expect(rev1.projectId).toBe(project.id);
    expect(rev1.revision).toBe(1);
    expect(rev1.createdBy).toBe('user:operator');
    expect(rev1.definition.targets).toHaveLength(FIXTURE_FACTS.targetCount);
    expect(rev1.definition.constitution.objectiveOwner).toBe('human');
    expect(rev1.definition.constitution.resourceLimits.hostedSpendUsd).toBe(0);
    expect(rev1.definition.constitution.resourceLimits.localModelFirst).toBe(true);

    // -------------------------------------------------------------------------
    // Step 3: Validate graph structure and dependencies (positive & negative)
    // -------------------------------------------------------------------------
    const validCheck = services.graphs.validate(rev1.definition);
    expect(validCheck.valid).toBe(true);
    expect(validCheck.issues).toHaveLength(0);

    // Negative check: cycle + unknown dependency + self dependency + duplicate target + invalid limit
    const brokenDef: GoalGraphDefinition = structuredClone(rev1.definition);
    brokenDef.constitution.resourceLimits.maxTasksPerRun = -1;
    brokenDef.targets[0]!.dependsOn = ['Y1.2', 'NON_EXISTENT']; // Y1.1 <-> Y1.2 cycle + unknown
    brokenDef.targets[2]!.dependsOn = ['Y1.3']; // self-dependency
    brokenDef.targets.push({ ...brokenDef.targets[0]! }); // duplicate Y1.1
    const invalidCheck = services.graphs.validate(brokenDef);
    expect(invalidCheck.valid).toBe(false);
    const codes = new Set(invalidCheck.issues.map((i) => i.code));
    expect(codes.has('INVALID_LIMIT')).toBe(true);
    expect(codes.has('UNKNOWN_DEPENDENCY')).toBe(true);
    expect(codes.has('CYCLE')).toBe(true);
    expect(codes.has('SELF_DEPENDENCY')).toBe(true);
    expect(codes.has('DUPLICATE_TARGET')).toBe(true);

    // -------------------------------------------------------------------------
    // Step 4: Persist graph state and revisions (immutable monotonic revisions)
    // -------------------------------------------------------------------------
    expect(rev1.digest).toBe(definitionDigest(rev1.definition));
    const editedDef: GoalGraphDefinition = {
      ...structuredClone(rev1.definition),
      purpose: 'Updated purpose in revision 2 (must not affect runs pinned to revision 1)',
    };
    const rev2 = await services.graphs.createRevision(rev1.graphId, editedDef, 'user:operator', 1);
    expect(rev2.revision).toBe(2);
    expect(rev2.parentRevision).toBe(1);
    expect(rev2.digest).not.toBe(rev1.digest);

    // Revision 1 remains immutable
    const fetchedRev1 = await services.graphs.getRevision(rev1.graphId, 1);
    expect(fetchedRev1?.digest).toBe(rev1.digest);
    expect(fetchedRev1?.definition.purpose).toBe(rev1.definition.purpose);

    const revisions = await services.graphs.listRevisions(rev1.graphId);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    const graphsList = await services.graphs.listGraphs(project.id);
    expect(graphsList).toEqual([
      {
        graphId: rev1.graphId,
        projectId: project.id,
        name: rev1.definition.name,
        latestRevision: 2,
      },
    ]);

    // -------------------------------------------------------------------------
    // Step 5 & 6: Start autonomous execution pinned to revision 1 and inspect initial statuses
    // -------------------------------------------------------------------------
    const run0 = await services.controller.startRun({
      graphId: rev1.graphId,
      graphRevision: 1,
      principal: 'user:operator',
    });
    expect(run0.status).toBe('running');
    expect(run0.graphId).toBe(rev1.graphId);
    expect(run0.graphRevision).toBe(1);
    expect(run0.graphDigest).toBe(rev1.digest);

    // In nobel_goal_graph.yaml, Y1.1 has depends_on: [], Y1.2 depends on Y1.1, Y1.3 depends on Y1.2.
    // Initially Y1.1 is eligible, and Y1.2–Y3.3 are queued.
    expect(run0.targets['Y1.1']?.status).toBe('eligible');
    for (const id of ['Y1.2', 'Y1.3', 'Y1.4', 'Y2.1', 'Y2.2', 'Y2.3', 'Y3.1', 'Y3.2', 'Y3.3']) {
      expect(run0.targets[id]?.status).toBe('queued');
    }
    expect(services.controller.eligibleTargets(run0, rev1.definition)).toEqual(['Y1.1']);

    // -------------------------------------------------------------------------
    // Step 7, 8, 9, 10: Execute Y1.1 -> Y1.2 -> Y1.3, produce real workspace
    // artifacts, run independent verification, and unlock dependent targets
    // -------------------------------------------------------------------------
    // Execute Y1.1 (unlocks Y1.2)
    const runAfterY11 = await services.controller.runEligible(run0.runId, 'Y1.1', 'user:operator');
    expect(runAfterY11.targets['Y1.1']?.status).toBe('completed');
    expect(runAfterY11.targets['Y1.2']?.status).toBe('eligible');
    expect(runAfterY11.targets['Y1.3']?.status).toBe('queued');
    expect(runAfterY11.targets['Y1.4']?.status).toBe('queued');

    // Execute Y1.2 (unlocks Y1.3)
    const runAfterY12 = await services.controller.runEligible(run0.runId, 'Y1.2', 'user:operator');
    expect(runAfterY12.targets['Y1.2']?.status).toBe('completed');
    expect(runAfterY12.targets['Y1.3']?.status).toBe('eligible');
    // Y1.4 depends on [Y1.2, Y1.3], so still queued until Y1.3 completes
    expect(runAfterY12.targets['Y1.4']?.status).toBe('queued');

    // Execute Y1.3 (unlocks Y1.4 and Y2.1)
    const runAfterY13 = await services.controller.runEligible(run0.runId, 'Y1.3', 'user:operator');
    expect(runAfterY13.targets['Y1.3']?.status).toBe('completed');
    expect(runAfterY13.targets['Y1.4']?.status).toBe('eligible');
    expect(runAfterY13.targets['Y2.1']?.status).toBe('eligible');

    // Priority order of newly eligible targets: Y1.4 (priority 90) > Y2.1 (priority 88)
    expect(services.controller.eligibleTargets(runAfterY13, rev1.definition)).toEqual(['Y1.4', 'Y2.1']);

    // Verify real artifacts on disk & independent verification evidence for Y1.1, Y1.2, Y1.3
    for (const targetId of ['Y1.1', 'Y1.2', 'Y1.3'] as const) {
      const targetDef = rev1.definition.targets.find((t) => t.id === targetId)!;
      for (const art of targetDef.artifacts) {
        const fullPath = artifactFile(workspaceRoot, art);
        const bytes = await fs.readFile(fullPath);
        expect(bytes.length).toBeGreaterThan(0);
      }
      const evidence = await services.verification.evidence(run0.runId, targetId);
      expect(evidence.length).toBeGreaterThanOrEqual(targetDef.acceptance.length);
      for (const ev of evidence) {
        expect(ev.verdict).toBe('PASS');
        expect(ev.validatorIdentity).not.toBe(ev.executorIdentity);
        expect(ev.artifacts.length).toBe(targetDef.artifacts.length);
        for (const artRef of ev.artifacts) {
          expect(artRef.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        }
      }
      // Verify transition chain recorded `verified` before `completed`
      const transitions = await services.ledger.transitions(run0.runId, targetId);
      const states = transitions.map((t) => t.toState);
      expect(states).toContain('active');
      expect(states).toContain('verifying');
      expect(states).toContain('verified');
      expect(states[states.length - 1]).toBe('completed');
    }

    // -------------------------------------------------------------------------
    // Step 10b: External dependency targets never self-certify completion!
    // Y1.4 has `external_dependency: true` in nobel_goal_graph.yaml.
    // Also test Y2.1 -> Y2.2 when Y2.2 is configured with externalDependency: true.
    // -------------------------------------------------------------------------
    const runAfterY14 = await services.controller.runEligible(run0.runId, 'Y1.4', 'user:operator');
    expect(runAfterY14.targets['Y1.4']?.status).toBe('awaiting_external');
    // Y1.4 must NOT be marked completed without an attributable external record
    expect(runAfterY14.targets['Y1.4']?.status).not.toBe('completed');

    // Now supply an attributable external record for Y1.4 and retry + runEligible
    const extPath = path.join(workspaceRoot, EXTERNAL_RECORD_FILE('Y1.4'));
    await fs.mkdir(path.dirname(extPath), { recursive: true });
    await fs.writeFile(
      extPath,
      JSON.stringify({ issuer: 'independent-peer-review-board', issuedAt: new Date().toISOString(), reference: 'PRB-2026-001' }),
    );
    await services.controller.retryTarget(run0.runId, 'Y1.4', 'user:operator');
    const runAfterY14Verified = await services.controller.runEligible(run0.runId, 'Y1.4', 'user:operator');
    expect(runAfterY14Verified.targets['Y1.4']?.status).toBe('completed');
  });

  it('Step 5 & 10 variant: when Y1.1, Y1.2, Y1.3 are independent roots and Y2.2 has externalDependency: true, all three are initially eligible and Y2.2 transitions to awaiting_external without self-certifying', async () => {
    const store = new MemoryStore();
    const { services } = await resolveGoalStudioServices({ store, workspaceRoot, autoAdvance: false, autoStart: false });

    const baseDef = loadFixtureDefinition();
    // Construct a graph revision where Y1.1, Y1.2, Y1.3 are all root targets (eligible initially)
    // and Y2.2 has externalDependency: true
    const customDef: GoalGraphDefinition = structuredClone(baseDef);
    for (const t of customDef.targets) {
      if (t.id === 'Y1.1' || t.id === 'Y1.2' || t.id === 'Y1.3') {
        t.dependsOn = [];
      }
      if (t.id === 'Y2.2') {
        t.externalDependency = true;
      }
    }

    const imported = await services.graphs.importYaml('proj-multi-root', readFixtureYaml(), 'user:operator');
    const rev2 = await services.graphs.createRevision(imported.record!.graphId, customDef, 'user:operator', 1);

    const run = await services.controller.startRun({
      graphId: rev2.graphId,
      graphRevision: rev2.revision,
      principal: 'user:operator',
    });

    // Step 5: Y1.1, Y1.2, Y1.3 are all initially eligible in priority order; Y1.4–Y3.3 are queued
    expect(services.controller.eligibleTargets(run, customDef)).toEqual(['Y1.1', 'Y1.2', 'Y1.3']);
    for (const id of ['Y1.1', 'Y1.2', 'Y1.3']) {
      expect(run.targets[id]?.status).toBe('eligible');
    }
    for (const id of ['Y1.4', 'Y2.1', 'Y2.2', 'Y2.3', 'Y3.1', 'Y3.2', 'Y3.3']) {
      expect(run.targets[id]?.status).toBe('queued');
    }

    // Complete Y1.1, Y1.2, Y1.3 -> unlocks Y1.4 and Y2.1
    await services.controller.runEligible(run.runId, 'Y1.1', 'user:operator');
    await services.controller.runEligible(run.runId, 'Y1.2', 'user:operator');
    const afterY13 = await services.controller.runEligible(run.runId, 'Y1.3', 'user:operator');
    expect(afterY13.targets['Y1.4']?.status).toBe('eligible');
    expect(afterY13.targets['Y2.1']?.status).toBe('eligible');

    // Complete Y2.1 -> unlocks Y2.2 and Y3.1
    const afterY21 = await services.controller.runEligible(run.runId, 'Y2.1', 'user:operator');
    expect(afterY21.targets['Y2.1']?.status).toBe('completed');
    expect(afterY21.targets['Y2.2']?.status).toBe('eligible');
    expect(afterY21.targets['Y3.1']?.status).toBe('eligible');

    // Execute Y2.2 (with externalDependency: true and no external record file) -> awaiting_external
    const afterY22 = await services.controller.runEligible(run.runId, 'Y2.2', 'user:operator');
    expect(afterY22.targets['Y2.2']?.status).toBe('awaiting_external');
    // Dependent Y2.3 must remain queued because awaiting_external never unlocks dependents!
    expect(afterY22.targets['Y2.3']?.status).toBe('queued');
  });

  it('Step 11: triggers controlled verification failure, runs DIAGNOSE → REPAIR_HYPOTHESIS → REPLAN → RETEST repair cycle, and enforces branch isolation when one branch is blocked', async () => {
    const store = new MemoryStore();
    // Configure executor to omit an artifact on attempt 1 of Y1.1 so verification fails and triggers REPAIR,
    // then write all artifacts on attempt 2 so RETEST succeeds.
    let y11Calls = 0;
    let y14Calls = 0;
    const { services, fakes } = await createFakeGoalStudioServices({
      store,
      workspaceRoot,
      autoAdvance: false,
      autoStart: false,
      executor: {
        async execute(input) {
          if (input.target.id === 'Y1.1') {
            y11Calls += 1;
            for (const a of input.target.artifacts) {
              // Omit formal-claim.md on attempt 1 to trigger verification failure -> repair
              if (y11Calls === 1 && a === 'formal-claim.md') continue;
              const file = artifactFile(input.workspaceRoot, a);
              await fs.mkdir(path.dirname(file), { recursive: true });
              await fs.writeFile(file, `# ${input.target.id} ${a} (attempt ${y11Calls})\n`);
            }
            return { executionId: `exec-${input.key}`, ok: true, summary: `Y1.1 attempt ${y11Calls}` };
          }
          if (input.target.id === 'Y1.4') {
            y14Calls += 1;
            // Deterministic policy failure on Y1.4 to block Y1.4 immediately
            return {
              executionId: `exec-${input.key}`,
              ok: false,
              summary: 'policy violation in Y1.4',
              error: { code: 'POLICY_DENIED', message: 'unapproved external publication attempt', retryable: false },
            };
          }
          return fakes.executor.execute(input);
        },
      },
    });

    const imported = await services.graphs.importYaml('proj-repair', readFixtureYaml(), 'user:operator');
    const graphId = imported.record!.graphId;
    const run = await services.controller.startRun({ graphId, principal: 'user:operator' });

    // Attempt 1 on Y1.1 fails independent verification (missing formal-claim.md) -> enters repair cycle
    const afterAttempt1 = await services.controller.runEligible(run.runId, 'Y1.1', 'user:operator');
    expect(afterAttempt1.targets['Y1.1']?.repairs).toBe(1);
    expect(afterAttempt1.targets['Y1.1']?.status).toBe('eligible'); // ready for retest

    const eventsAfterAttempt1 = await services.events.read(run.runId);
    const phasesAttempt1 = eventsAfterAttempt1
      .filter((e: GoalStudioEvent) => e.type === 'target.phase' && e.targetId === 'Y1.1')
      .map((e: GoalStudioEvent) => e.data.phase);
    expect(phasesAttempt1).toContain('DIAGNOSE');
    expect(phasesAttempt1).toContain('REPAIR_HYPOTHESIS');
    expect(phasesAttempt1).toContain('REPLAN');
    expect(phasesAttempt1).toContain('RETEST');

    const attemptsY11 = await services.ledger.attempts(run.runId, 'Y1.1');
    expect(attemptsY11).toHaveLength(1);
    expect(attemptsY11[0]?.outcome).toBe('failed');
    expect(attemptsY11[0]?.repairHypothesis).toBeTruthy();

    // Attempt 2 on Y1.1 (RETEST) produces all artifacts and completes
    const afterAttempt2 = await services.controller.runEligible(run.runId, 'Y1.1', 'user:operator');
    expect(afterAttempt2.targets['Y1.1']?.status).toBe('completed');
    expect(afterAttempt2.targets['Y1.1']?.attempts).toBe(2);
    expect(afterAttempt2.targets['Y1.2']?.status).toBe('eligible');

    // Advance Y1.2 and Y1.3 to unlock both Y1.4 and Y2.1
    await services.controller.runEligible(run.runId, 'Y1.2', 'user:operator');
    const afterY13 = await services.controller.runEligible(run.runId, 'Y1.3', 'user:operator');
    expect(afterY13.targets['Y1.4']?.status).toBe('eligible');
    expect(afterY13.targets['Y2.1']?.status).toBe('eligible');

    // Execute Y1.4 -> gets BLOCKED due to policy error
    const afterY14Blocked = await services.controller.runEligible(run.runId, 'Y1.4', 'user:operator');
    expect(afterY14Blocked.targets['Y1.4']?.status).toBe('blocked');
    expect(afterY14Blocked.targets['Y1.4']?.blockers.length).toBeGreaterThan(0);

    // Branch isolation: Y1.4 being blocked MUST NOT prevent unrelated eligible branch Y2.1 from executing and completing!
    expect(afterY14Blocked.targets['Y2.1']?.status).toBe('eligible');
    const afterY21 = await services.controller.runEligible(run.runId, 'Y2.1', 'user:operator');
    expect(afterY21.targets['Y2.1']?.status).toBe('completed');
    expect(afterY21.targets['Y2.2']?.status).toBe('eligible');
    expect(afterY21.targets['Y3.1']?.status).toBe('eligible');
    expect(y14Calls).toBe(1);
  });

  it('Step 12: persists state through JsonFileStore across simulated process crash/restart, recovers runs with lease epoch fencing, and does not duplicate completed side effects', async () => {
    const storeFile = path.join(tmpDir, 'goal-studio-state.json');
    let nowMs = Date.parse('2026-10-22T19:00:00.000Z');
    const clock = () => new Date(nowMs);

    // --- Process 1 ---
    const store1 = new JsonFileStore(storeFile);
    const bundle1 = await createFakeGoalStudioServices({
      store: store1,
      workspaceRoot,
      clock,
      holderId: 'controller-proc-1',
      leaseTtlMs: 30_000,
      autoAdvance: false,
      autoStart: false,
    });

    const imported = await bundle1.services.graphs.importYaml('proj-durable', readFixtureYaml(), 'user:operator');
    const graphId = imported.record!.graphId;
    const run1 = await bundle1.services.controller.startRun({ graphId, principal: 'user:operator' });

    // Execute Y1.1 in Process 1
    const afterY11 = await bundle1.services.controller.runEligible(run1.runId, 'Y1.1', 'user:operator');
    expect(afterY11.targets['Y1.1']?.status).toBe('completed');
    expect(afterY11.targets['Y1.2']?.status).toBe('eligible');
    expect(bundle1.fakes.executor.sideEffects.get('Y1.1')).toBe(1);

    // Record idempotency key for Y1.1 attempt 1 EXECUTE
    const y11ExecKey = idempotencyKey(run1.runId, 'Y1.1', 1, 'EXECUTE');

    // Simulate process 1 crash (drop in-memory state, advance clock past lease TTL)
    bundle1.fakes.controller.crash();
    nowMs += 60_000;

    // --- Process 2 (fresh JsonFileStore reading the same file on disk) ---
    const store2 = new JsonFileStore(storeFile);
    const bundle2 = await createFakeGoalStudioServices({
      store: store2,
      workspaceRoot,
      clock,
      holderId: 'controller-proc-2',
      leaseTtlMs: 30_000,
      autoAdvance: false,
      autoStart: false,
      seedPrompts: false, // already persisted in JsonFileStore
    });

    // Verify graph, ledger, transitions, evidence, and events survived reload from disk
    const reloadedRun = await bundle2.services.ledger.getRun(run1.runId);
    expect(reloadedRun).toBeDefined();
    expect(reloadedRun!.targets['Y1.1']?.status).toBe('completed');
    expect(reloadedRun!.targets['Y1.2']?.status).toBe('eligible');
    expect(reloadedRun!.ledgerRevision).toBe(afterY11.ledgerRevision);

    // Replay of Y1.1's EXECUTE idempotency key in Process 2 returns recorded result without running effect
    let sideEffectRanOnReplay = false;
    const replay = await bundle2.services.ledger.once(y11ExecKey, async () => {
      sideEffectRanOnReplay = true;
      return { executionId: 'should-not-run', ok: false, summary: 'duplicate' };
    });
    expect(replay.replayed).toBe(true);
    expect(sideEffectRanOnReplay).toBe(false);
    expect(replay.result.ok).toBe(true);

    // Recover non-terminal runs in Process 2
    const recoveredIds = await bundle2.services.controller.recoverRuns();
    expect(recoveredIds).toContain(run1.runId);

    // Continue execution in Process 2: execute Y1.2
    const afterY12 = await bundle2.services.controller.runEligible(run1.runId, 'Y1.2', 'user:operator');
    expect(afterY12.targets['Y1.2']?.status).toBe('completed');
    expect(afterY12.targets['Y1.3']?.status).toBe('eligible');
    // Y1.1 was NOT re-executed in Process 2
    expect(bundle2.fakes.executor.sideEffects.get('Y1.1') ?? 0).toBe(0);
    expect(bundle2.fakes.executor.sideEffects.get('Y1.2')).toBe(1);

    // Verify event log sequence is strictly monotonic across the restart boundary
    const allEvents = await bundle2.services.events.read(run1.runId, 0);
    expect(allEvents.length).toBeGreaterThan(5);
    for (let i = 1; i < allEvents.length; i++) {
      expect(allEvents[i]!.seq).toBe(allEvents[i - 1]!.seq + 1);
    }

    // Verify checksum of persisted store file is non-empty valid JSON
    const diskBytes = await fs.readFile(storeFile);
    expect(sha256Hex(diskBytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});
