/**
 * VerifAI adapter (FORMAL_ASSURANCE.md §2.3 item 5).
 *
 * Wires VerifAI `specification_monitor` (and optionally `ScenicSampler`) into the common
 * `SolverAdapter` interface. Every campaign is preceded by a monitor sanity check on known
 * passing and failing traces; a monitor that misclassifies either is never trusted.
 *
 * Verdict rules:
 * - rho < 0 on any sample (primary or holdout seed) => FALSIFIED with a replayable witness.
 * - budget exhausted with rho >= 0 everywhere => NOT_FALSIFIED. Never PROVED / BOUNDED_PASS.
 * - monitor misclassifies a known trace => ERROR.
 * - python/VerifAI missing, or simulator required but `simulatorAvailable` is false => NOT_RUN.
 *
 * Simulator-backed runs are never fabricated: the artifact module must provide
 * `run_simulator(params, seed)` and the caller must opt in with `simulatorAvailable: true`.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  Verdict,
  type Obligation,
  type SolverAdapter,
  type ToolAvailability,
  type VerificationResult,
  type VerifyOptions,
} from '../contracts';

/** A trace is a sequence of states; states are opaque records the monitor understands. */
export type Trace = ReadonlyArray<Record<string, unknown>>;

/** Robustness monitor: rho >= 0 means the trace satisfies the property, rho < 0 violates it. */
export type MonitorFn = (trace: Trace) => number;

export interface KnownTraces {
  passing: Trace[];
  failing: Trace[];
}

export interface MonitorTraceOutcome {
  kind: 'passing' | 'failing';
  index: number;
  rho: number;
  ok: boolean;
}

export interface MonitorSanityResult {
  passed: boolean;
  outcomes: MonitorTraceOutcome[];
  reason?: string;
}

export interface FalsificationWitness {
  seed: number;
  sampleIndex: number;
  params: Record<string, unknown>;
  trace: Trace;
  rho: number;
  holdout: boolean;
}

export interface SeedRunSummary {
  seed: number;
  holdout: boolean;
  attempted: number;
  minRho: number | null;
  falsification?: Omit<FalsificationWitness, 'holdout'>;
}

/** Obligation.metadata keys understood by this adapter. */
export interface VerifAIObligationMetadata {
  /** Known traces for the pre-campaign monitor sanity check (required). */
  monitorTraces?: KnownTraces;
  /** Box parameter space `{name: [lo, hi]}` for the deterministic sampler. */
  space?: Record<string, [number, number]>;
  /** Use VerifAI's ScenicSampler on this .scenic file instead of the box sampler. */
  scenicFile?: string;
  /** Samples per seed (search budget). */
  samples?: number;
  /** Extra seeds re-run as a holdout re-check (§2.5). */
  holdoutSeeds?: number[];
  /** The campaign needs an external simulator (ScenicServer / simulator bridge). */
  requiresSimulator?: boolean;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
  cwd?: string,
) => Promise<ProcessResult>;

export interface VerifAIAdapterOptions {
  pythonPath?: string;
  /** Capability flag: a simulator is attached and may be driven by the campaign. Default false. */
  simulatorAvailable?: boolean;
  runProcess?: ProcessRunner;
  defaultTimeoutMs?: number;
}

export interface VerifAIVerifyOptions extends VerifyOptions {
  simulatorAvailable?: boolean;
}

/** Evaluate a monitor on known passing and failing traces; every misclassification fails the check. */
export function evaluateMonitorOnTraces(monitor: MonitorFn, traces: KnownTraces): MonitorSanityResult {
  const outcomes: MonitorTraceOutcome[] = [];
  for (const [index, trace] of traces.passing.entries()) {
    const rho = monitor(trace);
    outcomes.push({ kind: 'passing', index, rho, ok: Number.isFinite(rho) && rho >= 0 });
  }
  for (const [index, trace] of traces.failing.entries()) {
    const rho = monitor(trace);
    outcomes.push({ kind: 'failing', index, rho, ok: Number.isFinite(rho) && rho < 0 });
  }
  return judgeMonitorSanity(outcomes, traces);
}

/** Shared judgement for TS- and Python-evaluated monitors. */
export function judgeMonitorSanity(outcomes: MonitorTraceOutcome[], traces: KnownTraces): MonitorSanityResult {
  if (traces.passing.length === 0 || traces.failing.length === 0) {
    return { passed: false, outcomes, reason: 'monitor sanity check needs at least one known passing and one known failing trace' };
  }
  const bad = outcomes.filter((o) => !o.ok);
  if (bad.length > 0) {
    const desc = bad.map((o) => `${o.kind}[${o.index}] rho=${o.rho}`).join(', ');
    return { passed: false, outcomes, reason: `monitor misclassified known traces: ${desc}` };
  }
  return { passed: true, outcomes };
}

/** Map seed runs to a verdict. Exhaustion is NOT_FALSIFIED — never a pass verdict. */
export function mapCampaignToVerdict(runs: SeedRunSummary[]): { verdict: Verdict; witness?: FalsificationWitness } {
  const hit = runs.find((r) => r.falsification);
  if (hit?.falsification) {
    return { verdict: Verdict.FALSIFIED, witness: { ...hit.falsification, holdout: hit.holdout } };
  }
  if (runs.length === 0 || runs.some((r) => r.attempted === 0)) return { verdict: Verdict.UNKNOWN };
  return { verdict: Verdict.NOT_FALSIFIED };
}

export const defaultProcessRunner: ProcessRunner = (command, args, input, timeoutMs, cwd) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: ProcessResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

function findDefaultPython(): string {
  if (process.env.WAZIR_VERIFAI_PYTHON) return process.env.WAZIR_VERIFAI_PYTHON;
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'tools', 'verifai-venv', 'bin', 'python3');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), 'tools', 'verifai-venv', 'bin', 'python3');
    dir = parent;
  }
}

/**
 * Headless runner. Reads a JSON request on stdin, imports the artifact module, and either
 * evaluates its monitor on given traces (`mode: "monitor"`) or runs a seeded campaign.
 * Module contract: `monitor` (specification_monitor subclass/instance) or `specification(traj)`;
 * `simulate(params, seed)` for pure dynamics, or `run_simulator(params, seed)` for a real simulator.
 */
export const VERIFAI_RUNNER_PY = String.raw`
import importlib.util, inspect, json, math, random, sys
req = json.load(sys.stdin)
out = {}
try:
    import importlib.metadata as md
    from verifai.monitor import specification_monitor
    out["verifaiVersion"] = md.version("verifai")
except Exception as e:
    print(json.dumps({"status": "tool_missing", "error": repr(e)})); sys.exit(0)

spec = importlib.util.spec_from_file_location("wazir_verifai_obligation", req["module"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

if hasattr(mod, "monitor"):
    m = mod.monitor
    if inspect.isclass(m):
        m = m()
    if not isinstance(m, specification_monitor):
        raise TypeError("module.monitor must be a verifai specification_monitor")
elif hasattr(mod, "specification"):
    m = specification_monitor(mod.specification)
else:
    raise TypeError("module must define monitor or specification")

def rho_of(traj):
    r = float(m.evaluate(traj))
    if math.isnan(r):
        raise ValueError("monitor returned NaN")
    return r

if req["mode"] == "monitor":
    res = []
    for kind in ("passing", "failing"):
        for i, t in enumerate(req["traces"][kind]):
            res.append({"kind": kind, "index": i, "rho": rho_of(t)})
    out.update({"status": "ok", "monitor": res})
    print(json.dumps(out)); sys.exit(0)

if req.get("useSimulator"):
    if not hasattr(mod, "run_simulator"):
        raise TypeError("simulator run requested but module has no run_simulator(params, seed)")
    run = mod.run_simulator
else:
    if not hasattr(mod, "simulate"):
        raise TypeError("module must define simulate(params, seed)")
    run = mod.simulate

scenic_sampler = None
if req.get("scenicFile"):
    from verifai.samplers import ScenicSampler
    scenic_sampler = ScenicSampler.fromScenario(req["scenicFile"])

def sample(rng, seed):
    if scenic_sampler is not None:
        import numpy
        random.seed(rng.random()); numpy.random.seed(rng.randrange(2**32))
        s = scenic_sampler.nextSample()
        return {"scenic": repr(s)}, s
    p = {k: rng.uniform(lo, hi) for k, (lo, hi) in sorted(req["space"].items())}
    return p, p

runs = []
for seed, holdout in [(req["seed"], False)] + [(s, True) for s in req.get("holdoutSeeds", [])]:
    rng = random.Random(seed)
    summary = {"seed": seed, "holdout": holdout, "attempted": 0, "minRho": None}
    for i in range(req["samples"]):
        params, raw = sample(rng, seed)
        traj = run(raw, seed)
        r = rho_of(traj)
        summary["attempted"] += 1
        summary["minRho"] = r if summary["minRho"] is None else min(summary["minRho"], r)
        if r < 0:
            summary["falsification"] = {"seed": seed, "sampleIndex": i, "params": params, "trace": traj, "rho": r}
            break
    runs.append(summary)
out.update({"status": "ok", "runs": runs})
print(json.dumps(out, default=repr))
`;

export class VerifAIAdapter implements SolverAdapter {
  readonly tool = 'verifai' as const;
  private readonly pythonPath: string;
  private readonly simulatorAvailable: boolean;
  private readonly runProcess: ProcessRunner;
  private readonly defaultTimeoutMs: number;

  constructor(options: VerifAIAdapterOptions = {}) {
    this.pythonPath = options.pythonPath ?? findDefaultPython();
    this.simulatorAvailable = options.simulatorAvailable ?? false;
    this.runProcess = options.runProcess ?? defaultProcessRunner;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  async checkAvailability(): Promise<ToolAvailability> {
    const r = await this.runProcess(
      this.pythonPath,
      ['-c', 'import importlib.metadata as m, verifai.monitor; print(m.version("verifai"))'],
      '',
      30_000,
    );
    if (r.spawnError || r.code !== 0) return { available: false, version: 'unknown', path: this.pythonPath };
    return { available: true, version: r.stdout.trim(), path: this.pythonPath };
  }

  async verify(obligation: Obligation, _workspaceRev: string, options: VerifAIVerifyOptions = {}): Promise<VerificationResult> {
    const started = Date.now();
    const meta = (obligation.metadata ?? {}) as VerifAIObligationMetadata;
    const seed = obligation.seed ?? 0;
    const holdoutSeeds = meta.holdoutSeeds ?? [];
    const simulatorAvailable = options.simulatorAvailable ?? this.simulatorAvailable;
    const cwd = options.workspaceDir;
    const timeoutMs = options.timeoutMs ?? obligation.timeoutMs ?? this.defaultTimeoutMs;
    const modulePath = cwd ? path.resolve(cwd, obligation.artifactPath) : path.resolve(obligation.artifactPath);

    let toolVersion = 'unknown';
    const result = (verdict: Verdict, extra: Partial<VerificationResult> = {}): VerificationResult => ({
      verdict,
      tool: this.tool,
      toolVersion,
      scope: obligation.scope,
      assumptions: obligation.assumptions,
      elapsedMs: Date.now() - started,
      inputHash,
      seed,
      ...extra,
      metadata: { holdoutSeeds, simulatorAvailable, ...extra.metadata },
    });

    let inputHash = hashInput(obligation, undefined);
    if (meta.requiresSimulator && !simulatorAvailable) {
      return result(Verdict.NOT_RUN, { metadata: { reason: 'simulator required but simulatorAvailable capability is false' } });
    }
    if (!existsSync(modulePath)) {
      return result(Verdict.ERROR, { metadata: { reason: `artifact not found: ${modulePath}` } });
    }
    inputHash = hashInput(obligation, readFileSync(modulePath));

    const traces = meta.monitorTraces;
    if (!traces) {
      return result(Verdict.ERROR, { metadata: { reason: 'monitorTraces missing: monitor must be sanity-checked before any campaign' } });
    }

    // 1. Monitor sanity check on known passing / failing traces.
    const mon = await this.invoke({ mode: 'monitor', module: modulePath, traces }, timeoutMs, cwd);
    if (mon.kind !== 'ok') return result(mon.verdict, mon.extra);
    toolVersion = String(mon.payload.verifaiVersion ?? 'unknown');
    const outcomes = ((mon.payload.monitor ?? []) as Array<{ kind: 'passing' | 'failing'; index: number; rho: number }>).map(
      (o) => ({ ...o, ok: o.kind === 'passing' ? o.rho >= 0 : o.rho < 0 }),
    );
    const sanity = judgeMonitorSanity(outcomes, traces);
    if (!sanity.passed) {
      return result(Verdict.ERROR, { metadata: { reason: sanity.reason, monitorSanity: sanity } });
    }

    // 2. Falsification campaign.
    if (!meta.space && !meta.scenicFile) {
      return result(Verdict.ERROR, { metadata: { reason: 'no sample space: set metadata.space or metadata.scenicFile', monitorSanity: sanity } });
    }
    const samples = meta.samples ?? 100;
    const campaign = await this.invoke(
      {
        mode: 'campaign',
        module: modulePath,
        seed,
        holdoutSeeds,
        samples,
        space: meta.space ?? {},
        scenicFile: meta.scenicFile ? (cwd ? path.resolve(cwd, meta.scenicFile) : path.resolve(meta.scenicFile)) : undefined,
        useSimulator: Boolean(meta.requiresSimulator),
      },
      timeoutMs,
      cwd,
    );
    if (campaign.kind !== 'ok') return result(campaign.verdict, { ...campaign.extra, metadata: { ...campaign.extra.metadata, monitorSanity: sanity } });
    const runs = (campaign.payload.runs ?? []) as SeedRunSummary[];
    const { verdict, witness } = mapCampaignToVerdict(runs);
    const attempted = runs.reduce((n, r) => n + r.attempted, 0);
    return result(verdict, {
      witness,
      seed: witness?.seed ?? seed,
      attempted,
      generated: attempted,
      rejected: 0,
      stdout: campaign.stdout,
      stderr: campaign.stderr,
      metadata: { samplesPerSeed: samples, runs, monitorSanity: sanity, ...(verdict === Verdict.NOT_FALSIFIED ? { note: 'search budget exhausted; not a proof' } : {}) },
    });
  }

  private async invoke(
    request: Record<string, unknown>,
    timeoutMs: number,
    cwd?: string,
  ): Promise<
    | { kind: 'ok'; payload: Record<string, unknown>; stdout: string; stderr: string }
    | { kind: 'fail'; verdict: Verdict; extra: Partial<VerificationResult> & { metadata: Record<string, unknown> } }
  > {
    const r = await this.runProcess(this.pythonPath, ['-c', VERIFAI_RUNNER_PY], JSON.stringify(request), timeoutMs, cwd);
    const io = { stdout: r.stdout, stderr: r.stderr };
    if (r.spawnError) return { kind: 'fail', verdict: Verdict.NOT_RUN, extra: { ...io, metadata: { reason: `python unavailable: ${r.spawnError}` } } };
    if (r.timedOut) return { kind: 'fail', verdict: Verdict.UNKNOWN, extra: { ...io, metadata: { reason: `timeout after ${timeoutMs}ms; campaign incomplete` } } };
    let payload: Record<string, unknown>;
    try {
      const lastLine = r.stdout.trim().split('\n').pop() ?? '';
      payload = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      return { kind: 'fail', verdict: Verdict.ERROR, extra: { ...io, metadata: { reason: `runner failed (exit ${r.code})` } } };
    }
    if (payload.status === 'tool_missing') {
      return { kind: 'fail', verdict: Verdict.NOT_RUN, extra: { ...io, metadata: { reason: `verifai not importable: ${String(payload.error)}` } } };
    }
    if (r.code !== 0 || payload.status !== 'ok') {
      return { kind: 'fail', verdict: Verdict.ERROR, extra: { ...io, metadata: { reason: `runner failed (exit ${r.code})` } } };
    }
    return { kind: 'ok', payload, ...io };
  }
}

function hashInput(obligation: Obligation, artifact: Buffer | undefined): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({ ...obligation, metadata: obligation.metadata ?? null }));
  if (artifact) h.update(artifact);
  return `sha256:${h.digest('hex')}`;
}
