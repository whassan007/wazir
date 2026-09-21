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
  it('defines all 10 progressive release gates in strict order (G0 to G9)', () => {
    expect(ACCEPTANCE_GATES).toHaveLength(10);
    const expectedIds: AcceptanceGateId[] = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'];
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

  it('contains all 30 unique acceptance tests', () => {
    const keys = Object.keys(ACCEPTANCE_TESTS).map(Number);
    expect(keys).toHaveLength(30);

    for (let id = 1; id <= 30; id++) {
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

  it('provides helpers to query by gate and ID', () => {
    const g0Tests = getTestsForGate('G0');
    expect(g0Tests).toHaveLength(1);
    expect(g0Tests[0].id).toBe(20);

    const test27 = getTestById(27);
    expect(test27.title).toBe('Large Paste Safety');
    expect(test27.gateId).toBe('G8');

    expect(() => getTestById(99)).toThrowError(/not found/);
  });
});
