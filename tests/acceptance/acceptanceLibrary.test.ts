import { describe, it, expect } from 'vitest';
import {
  ACCEPTANCE_GATES,
  ACCEPTANCE_TESTS,
  FOUNDATIONAL_SEQUENCE,
  getGate,
  getTestsForGate,
  getTestById,
  getFoundationalTests,
  validateGatePrerequisites,
  type AcceptanceGateId,
} from './acceptanceLibrary.js';

describe('Wazir Acceptance Test Library', () => {
  it('defines all 17 progressive release gates in strict order (G0 to G16)', () => {
    expect(ACCEPTANCE_GATES).toHaveLength(17);
    const expectedIds: AcceptanceGateId[] = [
      'G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G16',
    ];
    expect(ACCEPTANCE_GATES.map((g) => g.id)).toEqual(expectedIds);

    for (let i = 0; i < ACCEPTANCE_GATES.length; i++) {
      expect(ACCEPTANCE_GATES[i].order).toBe(i);
      if (i === 0) {
        expect(ACCEPTANCE_GATES[i].prerequisiteGateId).toBeNull();
      } else {
        expect(ACCEPTANCE_GATES[i].prerequisiteGateId).toBe(ACCEPTANCE_GATES[i - 1].id);
      }
    }
  });

  it('contains all 49 unique acceptance tests', () => {
    const keys = Object.keys(ACCEPTANCE_TESTS).map(Number);
    expect(keys).toHaveLength(49);

    for (let id = 1; id <= 49; id++) {
      const test = ACCEPTANCE_TESTS[id];
      expect(test, `Test ${id} should exist`).toBeDefined();
      expect(test.id).toBe(id);
      expect(test.title.length).toBeGreaterThan(0);
      expect(test.purpose.length).toBeGreaterThan(0);
      expect(test.prompt.length).toBeGreaterThan(0);
      expect(test.expectedDag.length).toBeGreaterThan(0);
      expect(test.verificationCriteria.length).toBeGreaterThan(0);
      expect(test.associatedSuites.length).toBeGreaterThan(0);
    }
  });

  it('maps every test to a valid gate and all gate testIds exist', () => {
    for (const gate of ACCEPTANCE_GATES) {
      expect(gate.testIds.length).toBeGreaterThan(0);
      for (const testId of gate.testIds) {
        const test = getTestById(testId);
        expect(test.gateId).toBe(gate.id);
      }
    }
  });

  it('defines the canonical foundational test sequence: [20, 17, 18, 1, 9, 3, 4, 2]', () => {
    expect(FOUNDATIONAL_SEQUENCE).toEqual([20, 17, 18, 1, 9, 3, 4, 2]);

    const foundationalTests = getFoundationalTests();
    expect(foundationalTests.map((t) => t.id)).toEqual([20, 17, 18, 1, 9, 3, 4, 2]);
    for (const test of foundationalTests) {
      expect(test.tags).toContain('foundational');
    }
  });

  it('enforces strict prerequisite progression', () => {
    const passed = new Set<AcceptanceGateId>();

    // G0 has no prereqs
    expect(validateGatePrerequisites('G0', passed).allowed).toBe(true);

    // G1 blocked because G0 not passed
    const g1Check = validateGatePrerequisites('G1', passed);
    expect(g1Check.allowed).toBe(false);
    expect(g1Check.blockingGateId).toBe('G0');

    // Passing G0 unblocks G1
    passed.add('G0');
    expect(validateGatePrerequisites('G1', passed).allowed).toBe(true);

    // G4 blocked because G1, G2, G3 not yet passed
    const g4Check = validateGatePrerequisites('G4', passed);
    expect(g4Check.allowed).toBe(false);
    expect(g4Check.blockingGateId).toBe('G1');

    passed.add('G1');
    passed.add('G2');
    passed.add('G3');
    expect(validateGatePrerequisites('G4', passed).allowed).toBe(true);
  });

  it('extends strict progression through the G10-G14 hardening tier appended after G9 Golden', () => {
    const passed = new Set<AcceptanceGateId>(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);

    // G10 blocked because G9 (Golden) has not passed yet
    const g10Check = validateGatePrerequisites('G10', passed);
    expect(g10Check.allowed).toBe(false);
    expect(g10Check.blockingGateId).toBe('G9');

    passed.add('G9');
    expect(validateGatePrerequisites('G10', passed).allowed).toBe(true);

    // G14 blocked until every hardening gate in between has passed too
    const g14Check = validateGatePrerequisites('G14', passed);
    expect(g14Check.allowed).toBe(false);
    expect(g14Check.blockingGateId).toBe('G10');

    passed.add('G10');
    passed.add('G11');
    passed.add('G12');
    passed.add('G13');
    expect(validateGatePrerequisites('G14', passed).allowed).toBe(true);

    // G15 blocked until G14 (Performance) has passed too
    const g15Check = validateGatePrerequisites('G15', passed);
    expect(g15Check.allowed).toBe(false);
    expect(g15Check.blockingGateId).toBe('G14');

    passed.add('G14');
    expect(validateGatePrerequisites('G15', passed).allowed).toBe(true);
  });

  it('provides helpers to query by gate and ID', () => {
    const g0Tests = getTestsForGate('G0');
    expect(g0Tests).toHaveLength(1);
    expect(g0Tests[0].id).toBe(20);

    const test27 = getTestById(27);
    expect(test27.title).toBe('Large Paste Safety');
    expect(test27.gateId).toBe('G8');

    expect(() => getTestById(99)).toThrowError(/not found/);
  });

  it('covers the tool-depth, protocol-interop, session-hardening, terminal-depth, and performance gaps (Tests 31-44)', () => {
    const g10Tests = getTestsForGate('G10');
    expect(g10Tests.map((t) => t.title)).toEqual([
      'Subprocess Timeout Enforcement',
      'Exact-Match Edit Uniqueness Guard',
      'Windowed Read Boundaries on Large Files',
      'Search Result Truncation Signaling',
    ]);

    const g11Tests = getTestsForGate('G11');
    expect(g11Tests.map((t) => t.title)).toEqual([
      'Structured JSON Schema Enforcement',
      'MCP Dynamic Tool Discovery & Invocation (End-to-End)',
      'MCP Policy Gate Under Live Execution',
    ]);

    const g12Tests = getTestsForGate('G12');
    expect(g12Tests.map((t) => t.title)).toEqual([
      'Empty/Whitespace Completion Recovery',
      'Context Compaction Fidelity Under Repeated Rounds',
      'Fleet Worktree Merge-Conflict Safety',
    ]);

    const g13Tests = getTestsForGate('G13');
    expect(g13Tests.map((t) => t.title)).toEqual([
      'Composer History Recall via Up/Down Arrows',
      'Escape Cancellation During Active Model Streaming',
    ]);

    const g14Tests = getTestsForGate('G14');
    expect(g14Tests.map((t) => t.title)).toEqual([
      'PTY High-Throughput Streaming Latency & Zero Byte Loss',
      'Multi-Turn Latency Growth Bound',
    ]);

    expect(getTestById(44).id).toBe(44);
  });

  it('covers the verification-integrity gaps (Tests 45-48): evidence-bound completion, revision staleness, false files-changed events, and build-tool policy stalls', () => {
    const g15Tests = getTestsForGate('G15');
    expect(g15Tests.map((t) => t.title)).toEqual([
      'Evidence-Bound Completion Verification',
      'Workspace Revision Staleness Invalidation',
      'False files-changed Event Prevention on Failed Edits',
      'Workspace-Scoped Build Tool Auto-Approval',
    ]);
    expect(g15Tests.every((t) => t.priority === 'P0')).toBe(false); // test 48 is P1
    expect(g15Tests.filter((t) => t.priority === 'P0')).toHaveLength(3);

    expect(getTestById(48).id).toBe(48);
    expect(getTestById(48).gateId).toBe('G15');
  });
});
