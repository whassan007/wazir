import { describe, expect, it } from 'vitest';
import {
  buildStandardAcceptanceTestSuite,
  CONTROLLED_FAULT_SCENARIOS,
  MANDATORY_USER_JOURNEY_IDS,
  runControlledFaultInjectionSuite,
  runMandatoryUserJourneys,
} from '../src/index.js';

describe('WAZIR META-HARNESS — Part 7 Zero-Manual-Test Qualification (Journeys A–H & 12 Fault Injections)', () => {
  it('executes all 8 Mandatory Real-User Journeys (Journeys A through H) end-to-end with independent verification', async () => {
    const report = await runMandatoryUserJourneys();

    expect(report.journeys.map((j) => j.journeyId)).toEqual([...MANDATORY_USER_JOURNEY_IDS]);
    for (const journey of report.journeys) {
      expect(
        journey.passed,
        `Journey ${journey.journeyId} (${journey.title}) failed: ${journey.error ?? journey.summary}`,
      ).toBe(true);
      expect(journey.stepsVerified.length).toBeGreaterThan(0);
    }
    expect(report.allPassed).toBe(true);
  }, 30_000);

  it('executes all 12 Controlled Fault Injection Scenarios with zero lost tasks, zero duplicate commits, and 0% Claude leakage', async () => {
    const faultReport = await runControlledFaultInjectionSuite();

    expect(faultReport.results).toHaveLength(12);
    expect(faultReport.results.map((r) => r.scenarioId)).toEqual([...CONTROLLED_FAULT_SCENARIOS]);
    for (const res of faultReport.results) {
      expect(res.passed, `Fault scenario '${res.scenarioId}' failed: ${res.error ?? res.recoveryActionVerified}`).toBe(
        true,
      );
      expect(res.isolatedSimulation).toBe(true);
      expect(res.mutatedProductionServices).toBe(false);
      expect(res.zeroLostTasks).toBe(true);
      expect(res.zeroDuplicateCommits).toBe(true);
      expect(res.zeroClaudeMaintained).toBe(true);
    }
    expect(faultReport.allPassed).toBe(true);
  }, 30_000);

  it('synthesizes the full 15-gate standard acceptance suite from live journey and fault evidence', async () => {
    const [journeysReport, faultReport] = await Promise.all([
      runMandatoryUserJourneys(),
      runControlledFaultInjectionSuite(),
    ]);

    const gates = buildStandardAcceptanceTestSuite({
      journeysReport,
      faultReport,
    });
    expect(gates).toHaveLength(15);
    for (const gate of gates) {
      expect(gate.passed, `Acceptance gate ${gate.id} (${gate.title}) failed: ${gate.detail}`).toBe(true);
    }
  }, 30_000);
});
