/**
 * LiveSession Scenario Specifications
 *
 * The 12 canonical live session scenarios: LS01-LS36.
 * Each is a LiveSessionSpec — owned entirely by the harness.
 * The model receives only the userTurns.message strings.
 *
 * NEVER expose to the model:
 *   - hiddenOracle internals
 *   - faultSchedule contents
 *   - bugLocation / expectedPatch
 */

import type { LiveSessionSpec, LiveSessionTier } from './types/liveSession.js';

// ============================================================
// LS01 — Autonomous Bug Repair (LIVE_SMOKE)
// ============================================================

export const LS01: LiveSessionSpec = {
  id: 'LS01',
  name: 'Autonomous Bug Repair',
  tier: 'LIVE_SMOKE',
  description: 'Agent must independently locate and fix an off-by-one bug in array processing code, then verify tests pass.',
  fixtureName: 'bug-repair',
  userTurns: [
    {
      index: 0,
      message: 'The tests in this project are failing. Please investigate the code, identify the bug, fix it, and verify the tests pass.',
    },
  ],
  hiddenOracle: {
    id: 'LS01-oracle',
    hiddenExpectedPatches: {
      'src/scheduler.ts': 'i < items.length',  // model must change <= to <
    },
    bugLocation: 'src/scheduler.ts: loop condition i <= items.length should be i < items.length',
    faultScheduleDescription: 'none',
  },
  protectedFiles: ['src/scheduler.test.ts'],  // model must not modify tests
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 3,
    maxWallTimeMs: 120_000,
    maxRepairCycles: 5,
  },
  expectedControllerInvariants: [
    { id: 'LS01-I1', description: 'Must not modify protected test file', check: 'no_protected_file_modified' },
    { id: 'LS01-I2', description: 'Must physically mutate the source', check: 'physical_mutation_required' },
    { id: 'LS01-I3', description: 'Tests must pass', check: 'tests_pass' },
  ],
};

// ============================================================
// LS02 — Multi-Turn Compile Repair (LIVE_ENGINEERING)
// ============================================================

export const LS02: LiveSessionSpec = {
  id: 'LS02',
  name: 'Multi-Turn Compile Repair',
  tier: 'LIVE_ENGINEERING',
  description: 'Agent fixes TypeScript type errors across 3 turns with evolving constraints. Public API must not change.',
  fixtureName: 'compile-repair',
  userTurns: [
    {
      index: 0,
      message: 'This TypeScript project has compilation errors. Please fix all type errors so the project compiles cleanly.',
    },
    {
      index: 1,
      message: 'Good. Now ensure you have not changed any function signatures in the public Registry API.',
      constraints: ['Do not change function signatures in the public API'],
    },
    {
      index: 2,
      message: 'Verify that all existing exports from the registry module still work correctly. Run the tests.',
    },
  ],
  hiddenOracle: {
    id: 'LS02-oracle',
    hiddenExpectedPatches: {
      'src/registry.ts': 'Map<string,',  // must add proper type params
    },
    bugLocation: 'src/registry.ts: multiple type errors — missing Map type params, implicit any, arithmetic on string',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['BUILD'],
  budgets: {
    maxTotalTurns: 5,
    maxWallTimeMs: 180_000,
  },
  expectedControllerInvariants: [
    { id: 'LS02-I1', description: 'Build must pass', check: 'build_passes' },
    { id: 'LS02-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
  ],
};

// ============================================================
// LS05 — Revision Invalidation (LIVE_ENGINEERING)
// ============================================================

export const LS05: LiveSessionSpec = {
  id: 'LS05',
  name: 'Revision Invalidation & Stale Edit Repair',
  tier: 'LIVE_ENGINEERING',
  description: 'Agent must detect and repair an inconsistent module (partially refactored interface/implementation mismatch) and ensure no stale evidence remains.',
  fixtureName: 'stale-edit',
  userTurns: [
    {
      index: 0,
      message: 'This project has an inconsistency: the WorkerConfig interface was updated but the Worker class implementation was not updated to match. Please fix the inconsistency so the interface and class are aligned.',
    },
    {
      index: 1,
      message: 'Ensure all verification evidence is current. Do not leave stale build or test results — re-run verification after your changes.',
    },
  ],
  hiddenOracle: {
    id: 'LS05-oracle',
    hiddenExpectedPatches: {
      'src/worker.ts': 'timeout',  // timeout must appear in the implementation
    },
    bugLocation: 'src/worker.ts: Worker class constructor does not accept timeout or retries from WorkerConfig',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['BUILD', 'TEST'],
  budgets: {
    maxTotalTurns: 4,
    maxWallTimeMs: 150_000,
  },
  expectedControllerInvariants: [
    { id: 'LS05-I1', description: 'Physical mutation required', check: 'physical_mutation_required' },
    { id: 'LS05-I2', description: 'Build must pass', check: 'build_passes' },
    { id: 'LS05-I3', description: 'No stale evidence', check: 'no_stale_evidence' },
  ],
};

// ============================================================
// LS06 — Long-Horizon Feature (LIVE_LONG_HORIZON)
// ============================================================

export const LS06: LiveSessionSpec = {
  id: 'LS06',
  name: 'Long-Horizon Feature Implementation',
  tier: 'LIVE_LONG_HORIZON',
  description: 'Agent implements multiple missing features in an EventBus across 4 turns: unsubscribe, once(), error isolation, wildcard subscriptions.',
  fixtureName: 'long-horizon-feature',
  userTurns: [
    {
      index: 0,
      message: 'This EventBus is missing critical features. Start by implementing the unsubscribe function: on() should return a cleanup function that removes the handler.',
    },
    {
      index: 1,
      message: 'Now implement once() — a subscription that fires exactly once and then automatically unsubscribes.',
      constraints: ['on() must still return an unsubscribe function'],
    },
    {
      index: 2,
      message: 'Implement error isolation: if one event handler throws, the error must be caught and the other handlers must still receive the event.',
      constraints: ['on() must still return an unsubscribe function', 'once() must still work'],
    },
    {
      index: 3,
      message: 'Finally, implement wildcard subscriptions: handlers registered with event name \'*\' receive all events along with the event name as a second argument. Run all tests.',
      constraints: ['on() returns unsubscribe', 'once() works', 'error isolation works'],
    },
  ],
  hiddenOracle: {
    id: 'LS06-oracle',
    hiddenExpectedPatches: {
      'src/core/event-bus.ts': 'once',       // once() must be implemented
    },
    protectedOracleChecks: [
      {
        id: 'LS06-OC1',
        name: 'All EventBus tests pass',
        command: 'node --experimental-vm-modules node_modules/.bin/vitest run src/core/event-bus.test.ts 2>&1 | tail -5',
        expectedExitCode: 0,
        timeoutMs: 60_000,
      },
    ],
    bugLocation: 'src/core/event-bus.ts: missing on() return value, once(), error isolation, wildcard support',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 8,
    maxWallTimeMs: 300_000,
    maxRepairCycles: 10,
  },
  expectedControllerInvariants: [
    { id: 'LS06-I1', description: 'Tests must pass', check: 'tests_pass' },
    { id: 'LS06-I2', description: 'Physical mutations required', check: 'physical_mutation_required' },
  ],
};

// ============================================================
// LS09 — Parallel Investigation (LIVE_AUTONOMY)
// ============================================================

export const LS09: LiveSessionSpec = {
  id: 'LS09',
  name: 'Parallel Investigation & Bug Repair',
  tier: 'LIVE_AUTONOMY',
  description: 'Agent is asked to investigate in parallel and use the best finding. Validates multi-candidate search behavior.',
  fixtureName: 'bug-repair',
  userTurns: [
    {
      index: 0,
      message: 'The tests are failing. Please investigate the bug using multiple parallel investigation strategies if available, then apply the best fix.',
    },
    {
      index: 1,
      message: 'Confirm which approach you selected and why. Run the tests to verify.',
    },
  ],
  hiddenOracle: {
    id: 'LS09-oracle',
    hiddenExpectedPatches: {
      'src/scheduler.ts': 'i < items.length',
    },
    bugLocation: 'src/scheduler.ts: loop condition off-by-one',
    faultScheduleDescription: 'none',
  },
  protectedFiles: ['src/scheduler.test.ts'],
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 4,
    maxWallTimeMs: 180_000,
  },
  expectedControllerInvariants: [
    { id: 'LS09-I1', description: 'Tests must pass', check: 'tests_pass' },
    { id: 'LS09-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
    { id: 'LS09-I3', description: 'No protected file modified', check: 'no_protected_file_modified' },
  ],
};

// ============================================================
// LS12 — Best-of-N Repair (LIVE_ENGINEERING)
// ============================================================

export const LS12: LiveSessionSpec = {
  id: 'LS12',
  name: 'Best-of-N Candidate Repair',
  tier: 'LIVE_ENGINEERING',
  description: 'Agent generates multiple candidate fixes and selects the best one. Validates solution-search integration.',
  fixtureName: 'compile-repair',
  userTurns: [
    {
      index: 0,
      message: 'This TypeScript project has type errors. Generate multiple candidate fixes (at least 2 different approaches if possible), evaluate each, and apply the best one.',
    },
    {
      index: 1,
      message: 'Explain which candidate solution was selected and verify the build passes.',
    },
  ],
  hiddenOracle: {
    id: 'LS12-oracle',
    hiddenExpectedPatches: {
      'src/registry.ts': 'Map<string,',
    },
    bugLocation: 'src/registry.ts: type errors throughout',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['BUILD'],
  budgets: {
    maxTotalTurns: 4,
    maxWallTimeMs: 180_000,
  },
  expectedControllerInvariants: [
    { id: 'LS12-I1', description: 'Build must pass', check: 'build_passes' },
    { id: 'LS12-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
  ],
};

// ============================================================
// LS19 — Crash Mid-Tool (LIVE_RESILIENCE)
// ============================================================

export const LS19: LiveSessionSpec = {
  id: 'LS19',
  name: 'Process Crash Mid-Tool Recovery',
  tier: 'LIVE_RESILIENCE',
  description: 'A process crash is injected mid-operation. Agent must recover and complete the repair.',
  fixtureName: 'bug-repair',
  userTurns: [
    {
      index: 0,
      message: 'The tests are failing. Fix the bug in the scheduler code and verify the tests pass.',
    },
  ],
  faultSchedule: [
    {
      id: 'LS19-F1',
      faultKind: 'process_crash',
      triggerAfterTurnIndex: 0,
      maxTimes: 1,
      seed: 1901,
    },
  ],
  hiddenOracle: {
    id: 'LS19-oracle',
    hiddenExpectedPatches: {
      'src/scheduler.ts': 'i < items.length',
    },
    bugLocation: 'src/scheduler.ts: off-by-one loop condition',
    faultScheduleDescription: 'process_crash injected after turn 0 begins',
  },
  protectedFiles: ['src/scheduler.test.ts'],
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 5,
    maxWallTimeMs: 180_000,
    maxRepairCycles: 8,
  },
  expectedControllerInvariants: [
    { id: 'LS19-I1', description: 'Tests must pass despite crash', check: 'tests_pass' },
    { id: 'LS19-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
    { id: 'LS19-I3', description: 'No protected file modified', check: 'no_protected_file_modified' },
  ],
  metadata: {
    resilience: true,
    expectedFaultRecovery: true,
  },
};

// ============================================================
// LS22 — Worker Disappearance (LIVE_RESILIENCE)
// ============================================================

export const LS22: LiveSessionSpec = {
  id: 'LS22',
  name: 'Worker Disappearance Recovery',
  tier: 'LIVE_RESILIENCE',
  description: 'A worker dies mid-session. Agent must detect cancellation and complete the job correctly.',
  fixtureName: 'worker-cancellation',
  userTurns: [
    {
      index: 0,
      message: 'Implement proper cancellation support in the JobRunner. The cancel() method exists but in-flight jobs are not being cancelled. Fix this.',
    },
    {
      index: 1,
      message: 'Ensure the cancellation tests pass. Verify that a job can be cancelled both before it starts and while it is running.',
      constraints: ['Do not change the JobRunner public API'],
    },
  ],
  faultSchedule: [
    {
      id: 'LS22-F1',
      faultKind: 'worker_death',
      triggerAfterTurnIndex: 0,
      maxTimes: 1,
      seed: 2201,
    },
  ],
  hiddenOracle: {
    id: 'LS22-oracle',
    hiddenExpectedPatches: {
      'src/job-runner.ts': 'cancelled',  // cancelled check must appear in run()
    },
    bugLocation: 'src/job-runner.ts: cancel() sets flag but run() does not check it',
    faultScheduleDescription: 'worker_death injected after turn 0',
  },
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 5,
    maxWallTimeMs: 200_000,
  },
  expectedControllerInvariants: [
    { id: 'LS22-I1', description: 'Tests must pass', check: 'tests_pass' },
    { id: 'LS22-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
  ],
  metadata: {
    resilience: true,
    expectedWorkerFailure: true,
  },
};

// ============================================================
// LS23 — Wazir Improves Wazir (LIVE_AUTONOMY)
// ============================================================

export const LS23: LiveSessionSpec = {
  id: 'LS23',
  name: 'Wazir Improves Wazir',
  tier: 'LIVE_AUTONOMY',
  description: 'Agent improves Wazir\'s own scheduler implementation with demonstrable performance gains.',
  fixtureName: 'self-improvement',
  userTurns: [
    {
      index: 0,
      message: 'The NaiveScheduler has O(n) task selection. Please implement a more efficient priority queue using a binary heap (O(log n) selection). Keep the same public interface.',
    },
    {
      index: 1,
      message: 'Now add a configurable concurrency limit to the scheduler. The constructor should accept maxConcurrent: number (default: unlimited for backward compat).',
      constraints: ['Keep the same public interface as NaiveScheduler'],
    },
    {
      index: 2,
      message: 'Run all tests and confirm the priority ordering still works correctly. Also confirm the concurrency limit works.',
      constraints: ['Keep the same public interface', 'Max concurrent must be configurable'],
    },
  ],
  hiddenOracle: {
    id: 'LS23-oracle',
    hiddenExpectedPatches: {
      'src/naive-scheduler.ts': 'heap',  // heap or similar data structure must appear
    },
    bugLocation: 'src/naive-scheduler.ts: O(n) linear scan instead of heap; no concurrency limit',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 6,
    maxWallTimeMs: 240_000,
    maxRepairCycles: 8,
  },
  expectedControllerInvariants: [
    { id: 'LS23-I1', description: 'Tests must pass', check: 'tests_pass' },
    { id: 'LS23-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
  ],
};

// ============================================================
// LS27 — Requirement Change (LIVE_ENGINEERING)
// ============================================================

export const LS27: LiveSessionSpec = {
  id: 'LS27',
  name: 'Requirement Change Mid-Session',
  tier: 'LIVE_ENGINEERING',
  description: 'Requirements evolve across 4 turns. Agent must adapt its solution to the latest authoritative requirements.',
  fixtureName: 'monorepo-feature',
  userTurns: [
    {
      index: 0,
      message: 'The ConfigService in packages/core is missing a validate() method. Implement it: it should return { valid: boolean; errors: string[] }. Validate that host is a non-empty string and port is a positive integer.',
    },
    {
      index: 1,
      message: 'CHANGE OF REQUIREMENTS: validate() must now also check that port is ≤ 65535. Update your implementation.',
      constraints: ['validate() returns { valid: boolean; errors: string[] }'],
    },
    {
      index: 2,
      message: 'Also validate that host is not "localhost" in production mode. Add an optional parameter isProduction: boolean to validate(). Default is false.',
      constraints: ['validate() returns { valid: boolean; errors: string[] }', 'port ≤ 65535 check required'],
    },
    {
      index: 3,
      message: 'Run all tests and verify that the final implementation matches all three requirements: (1) host non-empty, (2) port 1-65535, (3) no localhost in production mode.',
      constraints: ['validate(isProduction?: boolean): { valid: boolean; errors: string[] }', 'port 1-65535', 'no localhost in production'],
    },
  ],
  hiddenOracle: {
    id: 'LS27-oracle',
    hiddenExpectedPatches: {
      'packages/core/src/config.ts': 'isProduction',  // must handle production flag
    },
    bugLocation: 'packages/core/src/config.ts: validate() method missing entirely',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 6,
    maxWallTimeMs: 240_000,
  },
  expectedControllerInvariants: [
    { id: 'LS27-I1', description: 'Tests must pass', check: 'tests_pass' },
    { id: 'LS27-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
  ],
};

// ============================================================
// LS35 — Engineer Session Simulation (LIVE_LONG_HORIZON)
// ============================================================

export const LS35: LiveSessionSpec = {
  id: 'LS35',
  name: 'Full Engineer Session Simulation',
  tier: 'LIVE_LONG_HORIZON',
  description: 'Simulates a realistic multi-turn engineering session: design, implement, test, refactor, and review.',
  fixtureName: 'long-horizon-feature',
  userTurns: [
    {
      index: 0,
      message: 'Review the EventBus in src/core/event-bus.ts. Describe the current gaps and propose a complete implementation plan.',
    },
    {
      index: 1,
      message: 'Implement the plan. Start with on() returning an unsubscribe function and once().',
      constraints: ['Follow the plan from turn 0'],
    },
    {
      index: 2,
      message: 'Implement error isolation for handlers that throw.',
      constraints: ['on() returns unsubscribe', 'once() works'],
    },
    {
      index: 3,
      message: 'Implement wildcard \'*\' subscriptions and run all tests.',
      constraints: ['on() returns unsubscribe', 'once() works', 'error isolation works'],
    },
    {
      index: 4,
      message: 'Refactor for clarity: add JSDoc comments to all public methods. Verify tests still pass.',
      constraints: ['No behavioral changes', 'All tests must still pass'],
    },
  ],
  hiddenOracle: {
    id: 'LS35-oracle',
    hiddenExpectedPatches: {
      'src/core/event-bus.ts': '@param',  // JSDoc must be added
    },
    protectedOracleChecks: [
      {
        id: 'LS35-OC1',
        name: 'EventBus tests pass',
        command: 'node --experimental-vm-modules node_modules/.bin/vitest run 2>&1 | grep -E "(PASS|FAIL|Tests)" | tail -5',
        expectedExitCode: 0,
        timeoutMs: 60_000,
      },
    ],
    bugLocation: 'src/core/event-bus.ts: missing unsubscribe, once(), error isolation, wildcard',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 8,
    maxWallTimeMs: 360_000,
    maxRepairCycles: 10,
  },
  expectedControllerInvariants: [
    { id: 'LS35-I1', description: 'Tests must pass', check: 'tests_pass' },
    { id: 'LS35-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
    { id: 'LS35-I3', description: 'Provenance completeness ≥ 90%', check: 'provenance_complete' },
  ],
};

// ============================================================
// LS36 — Release Simulation (LIVE_LONG_HORIZON)
// ============================================================

export const LS36: LiveSessionSpec = {
  id: 'LS36',
  name: 'Release Simulation',
  tier: 'LIVE_LONG_HORIZON',
  description: 'Simulates a complete release cycle: implement improvements, verify, document changes, prepare for release.',
  fixtureName: 'self-improvement',
  userTurns: [
    {
      index: 0,
      message: 'Improve the NaiveScheduler with a binary heap for O(log n) priority selection. Keep the public interface.',
    },
    {
      index: 1,
      message: 'Run all tests. Verify correctness and run the concurrency test to confirm thread-safety.',
      constraints: ['Keep NaiveScheduler public interface'],
    },
    {
      index: 2,
      message: 'Add a CHANGELOG.md file documenting the improvement: describe the change from O(n) to O(log n) selection, what was changed, and why.',
      constraints: ['Tests must still pass'],
    },
    {
      index: 3,
      message: 'Bump the version in package.json from 0.0.1 to 0.1.0 to mark this as a minor improvement release. Confirm all tests pass.',
      constraints: ['CHANGELOG.md must exist', 'Tests must pass'],
    },
  ],
  hiddenOracle: {
    id: 'LS36-oracle',
    hiddenTestFiles: ['CHANGELOG.md'],  // CHANGELOG must exist
    hiddenExpectedPatches: {
      'package.json': '0.1.0',           // version must be bumped
      'CHANGELOG.md': 'O(log n)',         // must mention the improvement
    },
    bugLocation: 'src/naive-scheduler.ts: inefficient O(n) selection',
    faultScheduleDescription: 'none',
  },
  requiredVerification: ['TEST'],
  budgets: {
    maxTotalTurns: 6,
    maxWallTimeMs: 300_000,
  },
  expectedControllerInvariants: [
    { id: 'LS36-I1', description: 'Tests must pass', check: 'tests_pass' },
    { id: 'LS36-I2', description: 'Physical mutation required', check: 'physical_mutation_required' },
  ],
};

// ============================================================
// SCENARIO CATALOG
// ============================================================

export const ALL_LIVE_SCENARIOS: LiveSessionSpec[] = [
  LS01, LS02, LS05, LS06, LS09, LS12, LS19, LS22, LS23, LS27, LS35, LS36,
];

export const LIVE_SCENARIOS_BY_TIER: Record<string, LiveSessionSpec[]> = {
  LIVE_SMOKE:        [LS01],
  LIVE_ENGINEERING:  [LS02, LS05, LS12, LS27],
  LIVE_RESILIENCE:   [LS19, LS22],
  LIVE_AUTONOMY:     [LS09, LS23],
  LIVE_LONG_HORIZON: [LS06, LS35, LS36],
};

export function findScenario(id: string): LiveSessionSpec | undefined {
  return ALL_LIVE_SCENARIOS.find((s) => s.id === id);
}

export function scenariosByTier(tier: LiveSessionTier): LiveSessionSpec[] {
  return LIVE_SCENARIOS_BY_TIER[tier] ?? [];
}
