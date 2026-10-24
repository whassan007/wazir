import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Verdict, type Obligation } from '../contracts';
import {
  VerifAIAdapter,
  evaluateMonitorOnTraces,
  mapCampaignToVerdict,
  type KnownTraces,
  type MonitorFn,
  type ProcessRunner,
  type Trace,
} from '../adapters/verifai';

// Safe-distance monitor: rho = min over the trace of (gap - 2.0).
const safeGap: MonitorFn = (trace) => Math.min(...trace.map((s) => Number(s.gap) - 2.0));
const passingTrace: Trace = [{ gap: 10 }, { gap: 6 }, { gap: 3 }];
const failingTrace: Trace = [{ gap: 10 }, { gap: 4 }, { gap: 1 }];
const known: KnownTraces = { passing: [passingTrace], failing: [failingTrace] };

const MODULE = String.raw`
from verifai.monitor import specification_monitor

class SafeGap(specification_monitor):
    def __init__(self):
        super().__init__(lambda traj: min(s["gap"] - 2.0 for s in traj))

monitor = SafeGap

def simulate(params, seed):
    gap, traj = 20.0, []
    for _ in range(10):
        gap -= params["closing_speed"]
        traj.append({"gap": gap})
    return traj
`;

const BROKEN_MODULE = String.raw`
def specification(traj):
    return 1.0  # always passes: must fail the sanity check on the known failing trace

def simulate(params, seed):
    return [{"gap": 0.0}]
`;

function writeModule(src: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'verifai-adapter-'));
  const file = path.join(dir, 'obligation.py');
  writeFileSync(file, src);
  return file;
}

function obligation(artifactPath: string, metadata: Record<string, unknown> = {}, seed = 7): Obligation {
  return {
    id: 'obl-safe-gap',
    propertyId: 'SAFE_GAP',
    specVersion: '1.0',
    specHash: 'sha256:test',
    tool: 'verifai',
    artifactPath,
    assumptions: ['lead vehicle decelerates at most 3 m/s^2'],
    guarantee: 'gap >= 2m',
    seed,
    metadata: { monitorTraces: known, ...metadata },
  };
}

/** Fake runner: replays canned JSON per mode, so verdict mapping is tested without python. */
function fakeRunner(responses: { monitor?: unknown; campaign?: unknown }): ProcessRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner = (async (_cmd: string, _args: string[], input: string) => {
    const mode = (JSON.parse(input) as { mode: string }).mode;
    calls.push(mode);
    const body = mode === 'monitor' ? responses.monitor : responses.campaign;
    return { code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false };
  }) as ProcessRunner & { calls: string[] };
  runner.calls = calls;
  return runner;
}

const goodMonitor = {
  status: 'ok',
  verifaiVersion: '2.2.0',
  monitor: [
    { kind: 'passing', index: 0, rho: 1 },
    { kind: 'failing', index: 0, rho: -1 },
  ],
};

describe('evaluateMonitorOnTraces (monitor unit tests on known traces)', () => {
  it('accepts a monitor that passes the known passing trace and fails the known failing trace', () => {
    const r = evaluateMonitorOnTraces(safeGap, known);
    expect(r.passed).toBe(true);
    expect(r.outcomes.map((o) => o.rho)).toEqual([1, -1]);
  });

  it('rejects a monitor that passes a known failing trace', () => {
    const r = evaluateMonitorOnTraces(() => 1, known);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('failing[0]');
  });

  it('rejects a monitor that fails a known passing trace', () => {
    const r = evaluateMonitorOnTraces(() => -1, known);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('passing[0]');
  });

  it('rejects NaN robustness and empty trace sets', () => {
    expect(evaluateMonitorOnTraces(() => Number.NaN, known).passed).toBe(false);
    expect(evaluateMonitorOnTraces(safeGap, { passing: [passingTrace], failing: [] }).passed).toBe(false);
  });
});

describe('mapCampaignToVerdict', () => {
  it('maps exhaustion with rho >= 0 to NOT_FALSIFIED, never a passing verdict', () => {
    const { verdict } = mapCampaignToVerdict([{ seed: 1, holdout: false, attempted: 50, minRho: 0.3 }]);
    expect(verdict).toBe(Verdict.NOT_FALSIFIED);
    expect([Verdict.PROVED, Verdict.BOUNDED_PASS]).not.toContain(verdict);
  });

  it('maps a holdout-seed violation to FALSIFIED with holdout flagged', () => {
    const fals = { seed: 9, sampleIndex: 3, params: { x: 1 }, trace: [{ gap: 0 }], rho: -2 };
    const { verdict, witness } = mapCampaignToVerdict([
      { seed: 1, holdout: false, attempted: 50, minRho: 0.3 },
      { seed: 9, holdout: true, attempted: 4, minRho: -2, falsification: fals },
    ]);
    expect(verdict).toBe(Verdict.FALSIFIED);
    expect(witness).toMatchObject({ seed: 9, holdout: true, sampleIndex: 3 });
  });

  it('maps an empty or zero-sample campaign to UNKNOWN', () => {
    expect(mapCampaignToVerdict([]).verdict).toBe(Verdict.UNKNOWN);
    expect(mapCampaignToVerdict([{ seed: 1, holdout: false, attempted: 0, minRho: null }]).verdict).toBe(Verdict.UNKNOWN);
  });
});

describe('VerifAIAdapter (fake runner)', () => {
  const artifact = writeModule(MODULE);

  it('has tool = verifai', () => {
    expect(new VerifAIAdapter().tool).toBe('verifai');
  });

  it('returns NOT_RUN without invoking python when a simulator is required but the capability flag is off', async () => {
    const runner = fakeRunner({});
    const adapter = new VerifAIAdapter({ runProcess: runner });
    const r = await adapter.verify(obligation(artifact, { requiresSimulator: true, space: { v: [0, 1] } }), 'rev');
    expect(r.verdict).toBe(Verdict.NOT_RUN);
    expect(runner.calls).toEqual([]);
    expect(r.attempted).toBeUndefined();
  });

  it('returns NOT_RUN when python cannot be spawned', async () => {
    const runner: ProcessRunner = async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' });
    const r = await new VerifAIAdapter({ runProcess: runner }).verify(obligation(artifact, { space: { v: [0, 1] } }), 'rev');
    expect(r.verdict).toBe(Verdict.NOT_RUN);
  });

  it('returns NOT_RUN when verifai is not importable', async () => {
    const runner = fakeRunner({ monitor: { status: 'tool_missing', error: 'ModuleNotFoundError' } });
    const r = await new VerifAIAdapter({ runProcess: runner }).verify(obligation(artifact, { space: { v: [0, 1] } }), 'rev');
    expect(r.verdict).toBe(Verdict.NOT_RUN);
  });

  it('returns ERROR and skips the campaign when the monitor fails the sanity check', async () => {
    const runner = fakeRunner({
      monitor: { ...goodMonitor, monitor: [{ kind: 'passing', index: 0, rho: 1 }, { kind: 'failing', index: 0, rho: 0.5 }] },
    });
    const r = await new VerifAIAdapter({ runProcess: runner }).verify(obligation(artifact, { space: { v: [0, 1] } }), 'rev');
    expect(r.verdict).toBe(Verdict.ERROR);
    expect(runner.calls).toEqual(['monitor']);
  });

  it('returns ERROR when no known traces are supplied', async () => {
    const runner = fakeRunner({});
    const obl = obligation(artifact, { space: { v: [0, 1] } });
    obl.metadata = { space: { v: [0, 1] } };
    const r = await new VerifAIAdapter({ runProcess: runner }).verify(obl, 'rev');
    expect(r.verdict).toBe(Verdict.ERROR);
    expect(runner.calls).toEqual([]);
  });

  it('maps a timeout to UNKNOWN', async () => {
    const runner: ProcessRunner = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
    const r = await new VerifAIAdapter({ runProcess: runner }).verify(obligation(artifact, { space: { v: [0, 1] } }), 'rev');
    expect(r.verdict).toBe(Verdict.UNKNOWN);
  });

  it('runs the monitor check before the campaign and maps exhaustion to NOT_FALSIFIED', async () => {
    const runner = fakeRunner({
      monitor: goodMonitor,
      campaign: { status: 'ok', runs: [{ seed: 7, holdout: false, attempted: 20, minRho: 0.1 }] },
    });
    const r = await new VerifAIAdapter({ runProcess: runner }).verify(obligation(artifact, { space: { v: [0, 1] } }), 'rev');
    expect(runner.calls).toEqual(['monitor', 'campaign']);
    expect(r.verdict).toBe(Verdict.NOT_FALSIFIED);
    expect(r.toolVersion).toBe('2.2.0');
    expect(r.attempted).toBe(20);
  });
});

// Search upward from this file for the repo's tools/verifai-venv (worktrees live below the repo root).
function findVenvPython(): string | undefined {
  if (process.env.WAZIR_VERIFAI_PYTHON && existsSync(process.env.WAZIR_VERIFAI_PYTHON)) return process.env.WAZIR_VERIFAI_PYTHON;
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'tools', 'verifai-venv', 'bin', 'python3');
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}
const REPO_PYTHON = findVenvPython();

describe.skipIf(!REPO_PYTHON)('VerifAIAdapter (real VerifAI, no simulator)', () => {
  const adapter = new VerifAIAdapter({ pythonPath: REPO_PYTHON });
  const artifact = writeModule(MODULE);

  it('reports availability and version', async () => {
    const a = await adapter.checkAvailability();
    expect(a.available).toBe(true);
    expect(a.version).toMatch(/\d+\.\d+/);
  });

  it('FALSIFIED with a replayable seed, parameter sample and trace', async () => {
    const obl = obligation(artifact, { space: { closing_speed: [0.5, 3.0] }, samples: 50 }, 42);
    const r = await adapter.verify(obl, 'rev');
    expect(r.verdict).toBe(Verdict.FALSIFIED);
    const w = r.witness as { seed: number; params: { closing_speed: number }; trace: Trace; rho: number; holdout: boolean };
    expect(w.seed).toBe(42);
    expect(w.rho).toBeLessThan(0);
    expect(w.trace.length).toBe(10);
    // Replay: same seed reproduces the same witness.
    const again = await adapter.verify(obl, 'rev');
    expect(again.witness).toEqual(r.witness);
  }, 60_000);

  it('NOT_FALSIFIED (never PROVED/BOUNDED_PASS) when every sample is safe, across holdout seeds', async () => {
    const obl = obligation(artifact, { space: { closing_speed: [0.1, 1.5] }, samples: 20, holdoutSeeds: [101, 202] }, 1);
    const r = await adapter.verify(obl, 'rev');
    expect(r.verdict).toBe(Verdict.NOT_FALSIFIED);
    expect(r.attempted).toBe(60);
    expect((r.metadata?.runs as Array<{ seed: number }>).map((x) => x.seed)).toEqual([1, 101, 202]);
  }, 60_000);

  it('ERROR when the real monitor misclassifies a known failing trace', async () => {
    const r = await adapter.verify(obligation(writeModule(BROKEN_MODULE), { space: { closing_speed: [0, 1] } }), 'rev');
    expect(r.verdict).toBe(Verdict.ERROR);
    expect(String(r.metadata?.reason)).toContain('misclassified');
  }, 60_000);

  it('NOT_RUN for a simulator-required obligation without the capability flag', async () => {
    const r = await adapter.verify(obligation(artifact, { requiresSimulator: true, space: { closing_speed: [0, 1] } }), 'rev');
    expect(r.verdict).toBe(Verdict.NOT_RUN);
  });
});
