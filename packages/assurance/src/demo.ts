/**
 * RED_SIGNAL_COMPLIANCE end-to-end demonstration (FORMAL_ASSURANCE.md §3).
 *
 * TOY educational model (TOY-TRAFFIC-SIGNAL-001): not a certified braking or traffic-law model, and no claim
 * about any real vehicle. Every verdict here comes from a real tool run through its adapter (Z3, Alloy, Dafny,
 * VerifAI). A missing tool yields NOT_RUN and the release gate fails; nothing is ever substituted.
 *
 *   a) The implementation worker writes the seeded-bug controller (`POLICY = "buggy"`) → `rev-1-buggy`.
 *   b) Obligations run on `rev-1-buggy`; Z3 returns COUNTEREXAMPLE (speed, distance, red=True). The witness is
 *      saved as a permanent regression obligation and a repair task is filed carrying it.
 *   c) The repair worker rewrites the controller to the guarded policy → `rev-2-repaired`, with `specs/` frozen;
 *      the spec content hash is checked before and after.
 *   d) `rev-1-buggy` evidence is invalidated; every obligation (Alloy WitnessStop + NoCrossOnRed, Z3
 *      stopping_envelope, Dafny stop_command.dfy, VerifAI monitor), every regression and a fresh holdout seed set
 *      re-run on `rev-2-repaired`.
 *   e) Negative controls: Alloy `NoCrossOnRedMutant` and Z3 `--candidate mutant` must both be COUNTEREXAMPLE.
 *   f) All runs are in the hash-chained ledger; the chain is verified and the AssuranceRecord is generated and
 *      schema-validated.
 *
 * The "agents" are scripted stand-ins for Wazir's CodingAgent so the demo is deterministic: the implementation
 * worker always plants the known bug, and the repair worker applies the guarded policy only when handed a witness.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { AlloyAdapter } from './adapters/alloy';
import { DafnyAdapter, resolveDafnyBinary } from './adapters/dafny';
import { VerifAIAdapter } from './adapters/verifai';
import { resolveZ3Python, Z3Adapter } from './adapters/z3';
import { FormalTool, Obligation, SolverAdapter, SpecManifest, ToolAvailability, Verdict } from './contracts';
import { EvidenceLedger } from './ledger';
import { AssuranceRecord, generateAssuranceRecord, SchemaValidationResult, validateAgainstEvidenceSchema } from './record';
import { parseSpecManifest } from './registry';
import {
  AssuranceRepairOrchestrator,
  GitWorkspace,
  hashSpecsTree,
  ImplementationTask,
  ImplementationWorker,
  LedgerEvidenceSink,
  ObligationPlanContext,
  ObligationRun,
  RegressionObligation,
  RegressionObligationStore,
  RegressionReplayContext,
  RepairLoopReport,
  RepairTask,
  WorkspaceVcs,
  defaultRegressionReplayer,
} from './repair';

export const RED_SIGNAL_PROPERTY = 'RED_SIGNAL_COMPLIANCE';
export const RED_SIGNAL_COMPONENT = 'intersection_behavior_planner';
export const CONTROLLER_PATH = 'src/controller/red_signal_controller.py';
export const VERIFAI_BRIDGE_PATH = '.wazir-assurance/red_signal_bridge.py';
const SPEC_REL = 'specs/red_signal';

// ---------------------------------------------------------------------------
// Tool and spec discovery
// ---------------------------------------------------------------------------

function findUp(rel: string, starts: string[] = [__dirname, process.cwd()]): string | undefined {
  for (const start of starts) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
      if (dirname(dir) === dir) break;
    }
  }
  return undefined;
}

export interface RedSignalToolPaths {
  z3Python?: string;
  alloyJar?: string;
  javaPath?: string;
  dafnyBinary?: string;
  verifaiPython?: string;
}

export function resolveRedSignalToolPaths(overrides: RedSignalToolPaths = {}): Required<Omit<RedSignalToolPaths, 'javaPath'>> & { javaPath?: string } {
  return {
    z3Python: overrides.z3Python ?? resolveZ3Python(),
    alloyJar:
      overrides.alloyJar ??
      process.env.ALLOY_JAR ??
      findUp('tools/alloy/org.alloytools.alloy.dist.jar') ??
      resolve('tools/alloy/org.alloytools.alloy.dist.jar'),
    javaPath: overrides.javaPath,
    dafnyBinary: overrides.dafnyBinary ?? resolveDafnyBinary(),
    verifaiPython:
      overrides.verifaiPython ??
      process.env.WAZIR_VERIFAI_PYTHON ??
      findUp('tools/verifai-venv/bin/python3') ??
      resolve('tools/verifai-venv/bin/python3'),
  };
}

export function findRedSignalSpecDir(): string {
  const manifest = findUp(join(SPEC_REL, 'manifest.yaml'));
  if (!manifest) throw new Error(`cannot locate ${SPEC_REL}/manifest.yaml`);
  return dirname(manifest);
}

// ---------------------------------------------------------------------------
// The implementation under repair (outside specs/)
// ---------------------------------------------------------------------------

/**
 * The controller is the only thing workers may change. `POLICY` names the decision policy, and the Z3
 * obligation checks it via `stopping_envelope.py --candidate <POLICY>`. `proceed()` is the executable
 * policy, used by the simulation campaign and by regression replays at concrete witness points. The two must
 * agree; their correspondence is listed in the record's trusted base.
 */
export function controllerSource(policy: 'buggy' | 'guarded' | 'mutant'): string {
  const body = {
    buggy: [
      '    # SEEDED BUG: low speed is treated as license to proceed on red.',
      '    return (not red) or speed < 4',
    ],
    guarded: [
      '    # Proceed only when not red, or when a stop is infeasible (dilemma zone).',
      '    return (not red) or distance < stopping_distance(speed) + MARGIN',
    ],
    mutant: [
      '    # Mutant: dilemma-zone threshold doubled (one guard relaxed).',
      '    return (not red) or distance < 2 * stopping_distance(speed) + MARGIN',
    ],
  }[policy];
  return [
    '"""Red-signal approach controller (TOY demo implementation; generated by the implementation worker)."""',
    `POLICY = "${policy}"`,
    '',
    'T_REACT = 1',
    'DECEL = 4',
    'MARGIN = 2',
    '',
    '',
    'def stopping_distance(speed):',
    '    return speed * T_REACT + speed * speed / (2 * DECEL)',
    '',
    '',
    'def proceed(red, speed, distance):',
    '    """True: keep going. False: brake."""',
    ...body,
    '',
  ].join('\n');
}

export function readControllerPolicy(snapshotDir: string): string | undefined {
  const path = join(snapshotDir, CONTROLLER_PATH);
  if (!existsSync(path)) return undefined;
  return /^POLICY\s*=\s*["']([A-Za-z_]+)["']/m.exec(readFileSync(path, 'utf8'))?.[1];
}

/**
 * Trusted harness bridge for the VerifAI campaign. Written by the orchestrator into each revision snapshot (never
 * by a worker): toy longitudinal dynamics driven by the controller's `proceed()`, judged by the spec's own
 * `red_signal_monitor.evaluate`. A trace in which the obligation never arises is vacuously satisfied (rho=1000).
 */
export const VERIFAI_BRIDGE_SOURCE = String.raw`
import importlib.util, os, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(_ROOT, "specs", "red_signal"))
import red_signal_monitor as _spec

_cs = importlib.util.spec_from_file_location("wazir_red_signal_controller", os.path.join(_ROOT, "src", "controller", "red_signal_controller.py"))
_controller = importlib.util.module_from_spec(_cs)
_cs.loader.exec_module(_controller)

STOP_LINE = 100.0
DT = 0.25
STEPS = 200
VACUOUS_RHO = 1000.0

def simulate(params, seed):
    v = float(params["v0"])
    pos = STOP_LINE - float(params["d0"])
    onset = float(params["red_onset_s"])
    traj = []
    for k in range(STEPS):
        t = k * DT
        red = t >= onset
        traj.append({"t": round(t, 3), "position_m": round(pos, 4), "speed_m_per_s": round(v, 4), "signal": "red" if red else "green"})
        if pos > STOP_LINE + 10:
            break
        go = bool(_controller.proceed(red, v, STOP_LINE - pos))
        v_prev = v
        if not go:
            v = max(0.0, v - _spec.DECEL * DT)
        pos += v_prev * DT
    return traj

def specification(simulation):
    traj = getattr(simulation, "trajectory", simulation)
    r = _spec.evaluate(traj, STOP_LINE)["robustness"]
    return VACUOUS_RHO if r is None else float(r)
`;

type TraceState = { t: number; position_m: number; speed_m_per_s: number; signal: string };

/** Known traces for the monitor sanity check: approach at 10 m/s, red at t=2 s; one stops, one runs the light. */
export function knownMonitorTraces(): { passing: TraceState[][]; failing: TraceState[][] } {
  const make = (brake: boolean) => {
    const out: TraceState[] = [];
    let pos = 0;
    let v = 10;
    for (let k = 0; k < 60; k++) {
      const t = k * 0.25;
      const red = t >= 2;
      out.push({ t, position_m: Math.round(pos * 1e4) / 1e4, speed_m_per_s: v, signal: red ? 'red' : 'green' });
      if (pos > 110) break;
      const prev = v;
      if (brake && red) v = Math.max(0, v - 1);
      pos += prev * 0.25;
    }
    return out;
  };
  return { passing: [make(true)], failing: [make(false)] };
}

// ---------------------------------------------------------------------------
// Obligation planning (spec artifacts → obligations, per revision)
// ---------------------------------------------------------------------------

export interface RedSignalPlanOptions {
  verifaiSeed?: number;
  verifaiSamples?: number;
}

function baseObligation(spec: SpecManifest, tool: FormalTool, id: string, artifactPath: string): Obligation {
  return {
    id: `${spec.id}/${tool}/${id}`,
    propertyId: spec.id,
    specVersion: spec.version,
    specHash: spec.content_hash,
    tool,
    artifactPath,
    assumptions: [...spec.assumptions],
    guarantee: spec.guarantee,
  };
}

export function planRedSignalObligations(spec: SpecManifest, ctx: ObligationPlanContext, options: RedSignalPlanOptions = {}): Obligation[] {
  const alloyArtifact = spec.artifacts.find((a) => a.tool === 'alloy');
  const out: Obligation[] = [];
  if (alloyArtifact) {
    out.push({
      ...baseObligation(spec, 'alloy', 'NoCrossOnRed', `${SPEC_REL}/${alloyArtifact.file}`),
      command: 'NoCrossOnRed',
      scope: alloyArtifact.scope,
      metadata: { witnessCommands: ['WitnessStop'] },
    });
  }
  const z3Artifact = spec.artifacts.find((a) => a.tool === 'z3');
  if (z3Artifact) {
    // An undeclared policy is passed through verbatim; the spec script rejects it, which is an ERROR, not a pass.
    const policy = readControllerPolicy(ctx.snapshotDir) ?? '<undeclared>';
    out.push({
      ...baseObligation(spec, 'z3', 'stopping_envelope', `${SPEC_REL}/${z3Artifact.file}`),
      metadata: { args: ['--candidate', policy, '--json'], controllerPolicy: policy },
    });
  }
  const dafnyArtifact = spec.artifacts.find((a) => a.tool === 'dafny');
  if (dafnyArtifact) out.push(baseObligation(spec, 'dafny', 'stop_command', `${SPEC_REL}/${dafnyArtifact.file}`));
  if (spec.monitors?.some((m) => m.tool === 'verifai')) {
    mkdirSync(join(ctx.snapshotDir, dirname(VERIFAI_BRIDGE_PATH)), { recursive: true });
    writeFileSync(join(ctx.snapshotDir, VERIFAI_BRIDGE_PATH), VERIFAI_BRIDGE_SOURCE);
    out.push({
      ...baseObligation(spec, 'verifai', 'red_signal_monitor', VERIFAI_BRIDGE_PATH),
      seed: options.verifaiSeed ?? 7,
      scope: 'v0 in [3,20] m/s; d0 in [40,120] m; red onset in [0,3] s; dt=0.25 s; toy dynamics',
      metadata: {
        monitorTraces: knownMonitorTraces(),
        space: { v0: [3, 20], d0: [40, 120], red_onset_s: [0, 3] },
        samples: options.verifaiSamples ?? 40,
        holdoutSeeds: [],
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Z3 regression replay: the controller's concrete decision at the stored witness point
// ---------------------------------------------------------------------------

function smtReal(value: unknown): string {
  const s = String(value).trim();
  const m = /^(-?)(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(s);
  if (!m) throw new Error(`unsupported Z3 model value: ${s}`);
  const [, neg, num, den] = m;
  const n = num.includes('.') ? num : `${num}.0`;
  const body = den ? `(/ ${n} ${den.includes('.') ? den : `${den}.0`})` : n;
  return neg ? `(- ${body})` : body;
}

function smtBool(value: unknown): string {
  const s = String(value).trim().toLowerCase();
  if (s !== 'true' && s !== 'false') throw new Error(`unsupported Z3 Bool value: ${String(value)}`);
  return s;
}

const OBSERVE_PY = String.raw`
import importlib.util, json, sys
from fractions import Fraction
sys.dont_write_bytecode = True
req = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location("wazir_controller_under_test", req["path"])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
v = Fraction(req["speed"]); d = Fraction(req["distance"])
print(json.dumps({"proceed": bool(mod.proceed(req["red"], v, d)), "policy": getattr(mod, "POLICY", None)}))
`;

/**
 * Pin the stored Z3 model (speed, distance, red), execute the controller's real `proceed()` at that point, and
 * ask Z3 whether `A ∧ pins ∧ (red ∧ feasible) ∧ proceed=observed ∧ proceed` is satisfiable. SAT means the
 * counterexample recurs (COUNTEREXAMPLE); UNSAT means it is fixed. The vacuity probe confirms the pinned point
 * really lies inside `A ∧ precondition`.
 */
export function makeZ3PointRegressionReplayer(python: string) {
  return (regression: RegressionObligation, ctx: RegressionReplayContext): Obligation => {
    const w = (regression.witness ?? {}) as Record<string, unknown>;
    const controller = join(ctx.snapshotDir, CONTROLLER_PATH);
    const red = smtBool(w.red);
    const r = spawnSync(python, ['-I', '-B', '-c', OBSERVE_PY], {
      input: JSON.stringify({ path: controller, speed: String(w.speed_m_per_s), distance: String(w.distance_to_stopline_m), red: red === 'true' }),
      timeout: 10_000,
    });
    if (r.error || r.status !== 0) {
      throw new Error(`cannot execute controller at regression point: ${r.error?.message ?? r.stderr?.toString().trim()}`);
    }
    const observed = (JSON.parse(r.stdout.toString().trim()) as { proceed: boolean }).proceed;
    const v = 'speed_m_per_s';
    const d = 'distance_to_stopline_m';
    const origin = regression.originObligation;
    return {
      ...origin,
      id: `regression:${regression.id.slice(0, 16)}`,
      artifactPath: `regression/${regression.id}.smt2`,
      assumptions: [
        `(>= ${v} 0.0)`, `(<= ${v} 30.0)`, `(>= ${d} 0.0)`, `(<= ${d} 200.0)`,
        `(= ${v} ${smtReal(w.speed_m_per_s)})`, `(= ${d} ${smtReal(w.distance_to_stopline_m)})`, `(= red ${red})`,
      ],
      guarantee: '(not proceed)',
      metadata: {
        smtLib: `(declare-const ${v} Real)\n(declare-const ${d} Real)\n(declare-const red Bool)\n(declare-const proceed Bool)\n`,
        precondition: `(and red (>= ${d} (+ (* ${v} 1.0) (/ (* ${v} ${v}) 8.0) 2.0)))`,
        implementation: `(= proceed ${observed ? 'true' : 'false'})`,
        regressionReplay: { regressionId: regression.id, originObligation: origin },
        observedProceed: observed,
        specAssumptions: origin.assumptions,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Scripted workers
// ---------------------------------------------------------------------------

/** Writes the seeded-bug controller for the implementation task; applies the guarded policy when repairing. */
export class ScriptedRedSignalWorker implements ImplementationWorker {
  readonly tasks: Array<ImplementationTask | RepairTask> = [];

  async run(task: ImplementationTask | RepairTask, workspace: WorkspaceVcs): Promise<{ label: string }> {
    this.tasks.push(task);
    const ws = workspace as GitWorkspace;
    const path = join(ws.dir, CONTROLLER_PATH);
    mkdirSync(dirname(path), { recursive: true });
    if (task.kind === 'implementation') {
      writeFileSync(path, controllerSource('buggy'));
      ws.commitAll('implementation: red-signal controller (seeded bug)', 'rev-1-buggy');
      return { label: 'rev-1-buggy' };
    }
    if (!task.witnesses.some((w) => w.propertyId === RED_SIGNAL_PROPERTY)) {
      throw new Error('repair task carries no RED_SIGNAL_COMPLIANCE witness');
    }
    writeFileSync(path, controllerSource('guarded'));
    const label = `rev-${task.attempt + 1}-repaired`;
    ws.commitAll(`repair ${task.attempt}: guard red-signal proceed decision\n\n${task.prompt}`, label);
    return { label };
  }
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

export interface RedSignalDemoOptions {
  /** Parent for the temporary workspace and state; defaults to the OS temp dir. */
  workDir?: string;
  /** Keep the workspace and state on disk (paths are in the result). */
  keep?: boolean;
  toolPaths?: RedSignalToolPaths;
  /** Override individual adapters (e.g. to simulate an absent tool). */
  adapters?: Partial<Record<FormalTool, SolverAdapter>>;
  worker?: ImplementationWorker;
  maxRepairAttempts?: number;
  verifaiSamples?: number;
  holdoutSeedsPerCheck?: number;
  timeoutMs?: number;
  /** Also run the GAM Appendix B governance case through the same ledger and record format. */
  includeGamAppendixB?: boolean;
  log?: (line: string) => void;
}

export interface NegativeControlResult {
  run: ObligationRun;
  expected: Verdict.COUNTEREXAMPLE;
  ok: boolean;
}

export interface RedSignalDemoResult {
  workspaceDir: string;
  stateDir: string;
  ledgerPath: string;
  tools: Record<string, ToolAvailability>;
  spec: SpecManifest;
  loop: RepairLoopReport;
  /** First Z3 counterexample (on rev-1-buggy), when Z3 ran. */
  initialZ3Counterexample?: ObligationRun;
  /** obligation id → verdict, on the final revision (spec + regression + holdout runs). */
  finalVerdicts: Record<string, Verdict>;
  negativeControls: NegativeControlResult[];
  gamAppendixB?: GamAppendixBDemoResult;
  specsHashBefore: string;
  specsHashAfter: string;
  specsUnchanged: boolean;
  ledgerEntries: number;
  ledgerVerified: boolean;
  record: AssuranceRecord;
  recordValidation: SchemaValidationResult;
  /** All §3 expectations held. False whenever a tool was missing, a check failed, or a control did not fail. */
  passed: boolean;
  failures: string[];
}

/** Raw `solver_result` printed by stopping_envelope.py (`sat` / `unsat` / `unknown`). */
export function z3SolverAnswer(run?: ObligationRun): string | undefined {
  const line = run?.result.stdout?.trim().split('\n').pop();
  if (!line) return undefined;
  try {
    return (JSON.parse(line) as { solver_result?: string }).solver_result;
  } catch {
    return undefined;
  }
}

export async function runRedSignalDemo(options: RedSignalDemoOptions = {}): Promise<RedSignalDemoResult> {
  const log = options.log ?? (() => undefined);
  const parent = options.workDir ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const workspaceDir = mkdtempSync(join(parent, 'wazir-red-signal-ws-'));
  const stateDir = mkdtempSync(join(parent, 'wazir-red-signal-state-'));
  const ledgerPath = join(stateDir, 'ledger.json');
  try {
    // ---- workspace: approved spec committed first ----
    const specSource = findRedSignalSpecDir();
    const spec = parseSpecManifest(readFileSync(join(specSource, 'manifest.yaml'), 'utf8'));
    const workspace = GitWorkspace.init(workspaceDir);
    cpSync(specSource, join(workspaceDir, SPEC_REL), {
      recursive: true,
      filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
    });
    workspace.commitAll(`spec: ${spec.id} v${spec.version} (${spec.status})`, 'rev-0-spec');
    const specsHashBefore = hashSpecsTree(join(workspaceDir, 'specs'));

    // ---- adapters ----
    const paths = resolveRedSignalToolPaths(options.toolPaths);
    const adapters: Partial<Record<FormalTool, SolverAdapter>> = {
      z3: new Z3Adapter({ pythonPath: paths.z3Python }),
      alloy: new AlloyAdapter({ jarPath: paths.alloyJar, javaPath: paths.javaPath }),
      dafny: new DafnyAdapter(paths.dafnyBinary),
      verifai: new VerifAIAdapter({ pythonPath: paths.verifaiPython }),
      ...options.adapters,
    };
    const tools: Record<string, ToolAvailability> = {};
    for (const [tool, adapter] of Object.entries(adapters)) {
      tools[tool] = await adapter!.checkAvailability().catch(() => ({ available: false, version: 'unknown' }));
      log(`tool ${tool}: ${tools[tool].available ? tools[tool].version : 'MISSING'}`);
    }

    // ---- state outside the worktree ----
    const store = new RegressionObligationStore(join(stateDir, 'assurance'), { forbiddenRoots: [workspaceDir] });
    const ledger = new EvidenceLedger({ filePath: ledgerPath });
    const sink = new LedgerEvidenceSink(ledger);
    const worker = options.worker ?? new ScriptedRedSignalWorker();

    const orchestrator = new AssuranceRepairOrchestrator({
      runId: `red-signal-demo`,
      component: RED_SIGNAL_COMPONENT,
      workspace,
      worker,
      adapters,
      planObligations: (ctx) => planRedSignalObligations(spec, ctx, { verifaiSamples: options.verifaiSamples }),
      regressionStore: store,
      maxRepairAttempts: options.maxRepairAttempts,
      holdout: { seedsPerCheck: options.holdoutSeedsPerCheck ?? 3 },
      regressionReplayers: { z3: makeZ3PointRegressionReplayer(paths.z3Python), verifai: defaultRegressionReplayer },
      evidence: sink,
      timeoutMs: options.timeoutMs,
      onEvent: (e) => {
        if (e.type === 'revision') log(`revision ${e.revision.label} ${e.revision.commit.slice(0, 10)}`);
        if (e.type === 'obligation') log(`  [${e.run.kind}] ${e.run.obligation.id}: ${e.run.result.verdict}`);
        if (e.type === 'regression_saved') log(`  regression saved ${e.witness.regressionId.slice(0, 12)}: ${e.witness.witness.summary}`);
        if (e.type === 'repair_task') log(`  repair task ${e.task.id} (${e.task.witnesses.length} witness(es))`);
        if (e.type === 'spec_check') log(`  specs/ ${e.unchanged ? 'unchanged' : 'MODIFIED'} at ${e.revision.label}: ${e.specsHash}`);
      },
    });

    const loop = await orchestrator.run({
      kind: 'implementation',
      id: 'red-signal-demo:implementation',
      component: RED_SIGNAL_COMPONENT,
      prompt: `Implement the red-signal approach controller at ${CONTROLLER_PATH} satisfying ${spec.id} (specs/red_signal, read-only).`,
    });
    log(`loop outcome: ${loop.outcome}${loop.reason ? ` (${loop.reason})` : ''}`);

    const specsHashAfter = hashSpecsTree(join(workspaceDir, 'specs'));
    const final = loop.iterations.at(-1);
    const finalVerdicts: Record<string, Verdict> = {};
    for (const run of [...(final?.runs ?? []), ...(final?.holdoutRuns ?? [])]) finalVerdicts[run.obligation.id] = run.result.verdict;
    const initialZ3Counterexample = loop.iterations[0]?.runs.find(
      (r) => r.obligation.tool === 'z3' && r.kind === 'spec' && r.result.verdict === Verdict.COUNTEREXAMPLE,
    );

    // ---- e) negative controls on the final revision ----
    const negativeControls: NegativeControlResult[] = [];
    if (loop.outcome !== 'spec_tampered') {
      const snapshot = workspace.snapshot(loop.finalRevision.commit);
      try {
        const planned = planRedSignalObligations(spec, { revision: loop.finalRevision, snapshotDir: snapshot });
        const controls: Obligation[] = [];
        const alloy = planned.find((o) => o.tool === 'alloy');
        if (alloy) controls.push({ ...alloy, id: `${spec.id}/alloy/NoCrossOnRedMutant`, command: 'NoCrossOnRedMutant', metadata: { ...alloy.metadata, expectedVerdict: Verdict.COUNTEREXAMPLE } });
        const z3 = planned.find((o) => o.tool === 'z3');
        if (z3) controls.push({ ...z3, id: `${spec.id}/z3/stopping_envelope:mutant`, metadata: { args: ['--candidate', 'mutant', '--json'], expectedVerdict: Verdict.COUNTEREXAMPLE } });
        for (const o of controls) {
          const adapter = adapters[o.tool]!;
          const result = await adapter.verify(o, loop.finalRevision.label, { workspaceDir: snapshot, timeoutMs: options.timeoutMs });
          const run: ObligationRun = { kind: 'negative_control', obligation: o, result, revision: loop.finalRevision };
          sink.record(run);
          negativeControls.push({ run, expected: Verdict.COUNTEREXAMPLE, ok: result.verdict === Verdict.COUNTEREXAMPLE });
          log(`  [negative_control] ${o.id}: ${result.verdict}`);
        }
      } finally {
        rmSync(snapshot, { recursive: true, force: true });
      }
    }

    // ---- f) ledger + record ----
    let gamAppendixB: GamAppendixBDemoResult | undefined;
    if (options.includeGamAppendixB) {
      gamAppendixB = await runGamAppendixBGovernanceCase({
        adapter: adapters.gam,
      });
    }
    let ledgerVerified = false;
    try {
      ledger.verifyLedger(ledger.checkpoint);
      new EvidenceLedger({ filePath: ledgerPath }).verifyLedger(); // re-read from disk and re-verify the chain
      ledgerVerified = true;
    } catch (error) {
      log(`ledger verification failed: ${String(error)}`);
    }
    const entries = ledger.entries;
    const record = generateAssuranceRecord({
      component: RED_SIGNAL_COMPONENT,
      version: '0.1.0-demo',
      sourceCommit: loop.finalRevision.commit,
      // Negative controls are deliberately failing mutants: ledgered, but not release evidence for the candidate.
      ledgerEntries: entries.filter((e) => e.metadata?.negativeControl !== true),
      specs: [spec],
      regressionObligations: store.count({ propertyId: spec.id, specHash: spec.content_hash }),
      counterexamplesFound: loop.witnesses.length,
      runtimeMonitors: 'NOT_DEPLOYED',
      trustedBase: [
        'controller POLICY declaration ↔ proceed() correspondence (checked only at regression witness points and by simulation)',
        'VerifAI toy longitudinal dynamics bridge (.wazir-assurance/red_signal_bridge.py)',
      ],
      coverageLimits: [
        'TOY model (TOY-TRAFFIC-SIGNAL-001): not a certified braking or traffic-law model',
        `${spec.id}:implementation_contract is the model-level Dafny kernel; the Python controller is not compiled from Dafny (no refinement link)`,
        `${spec.id}:negative_controls=${negativeControls.map((c) => `${c.run.obligation.id}:${c.run.result.verdict}`).join(',') || 'not run'}`,
      ],
      nonClaims: ['legal_interpretation'],
    });
    const controlsOk = negativeControls.length === 2 && negativeControls.every((c) => c.ok);
    if (!controlsOk && record.release_gate.status === 'PASS') {
      record.release_gate = { status: 'FAIL', reason: 'negative control did not produce COUNTEREXAMPLE: checks are not discriminating' };
    }
    const recordValidation = validateAgainstEvidenceSchema(record);

    // ---- expectations ----
    const failures: string[] = [];
    const expect = (cond: boolean, msg: string) => {
      if (!cond) failures.push(msg);
    };
    for (const [tool, a] of Object.entries(tools)) expect(a.available, `${tool} unavailable: its obligations are NOT_RUN`);
    expect(loop.revisions[0]?.label === 'rev-1-buggy', 'first revision is not rev-1-buggy');
    expect(initialZ3Counterexample !== undefined, 'no Z3 COUNTEREXAMPLE on rev-1-buggy');
    expect(loop.iterations[0]?.repairTask !== undefined, 'no repair task filed with the witness');
    expect(loop.outcome === 'passed', `repair loop outcome ${loop.outcome}${loop.reason ? `: ${loop.reason}` : ''}`);
    expect(loop.finalRevision.label === 'rev-2-repaired', `final revision ${loop.finalRevision.label}, expected rev-2-repaired`);
    expect(specsHashBefore === specsHashAfter && specsHashBefore === loop.specsHash, 'specs/ content hash changed');
    // Z3: the solver must answer `unsat` on A ∧ impl ∧ ¬P. Z3Adapter reports BOUNDED_PASS rather than PROVED
    // whenever the script declares a `scope` (stopping_envelope.py always does), so both are accepted here and
    // the raw solver answer is checked separately.
    const want: Array<[FormalTool, Verdict[]]> = [
      ['alloy', [Verdict.BOUNDED_PASS]],
      ['z3', [Verdict.PROVED, Verdict.BOUNDED_PASS]],
      ['dafny', [Verdict.PROVED]],
      ['verifai', [Verdict.NOT_FALSIFIED]],
    ];
    for (const [tool, verdicts] of want) {
      const runs = final?.runs.filter((r) => r.kind === 'spec' && r.obligation.tool === tool) ?? [];
      expect(runs.length > 0 && runs.every((r) => verdicts.includes(r.result.verdict)), `${tool} on final revision: ${runs.map((r) => r.result.verdict).join(',') || 'missing'} (expected ${verdicts.join('|')})`);
    }
    const finalZ3 = final?.runs.find((r) => r.kind === 'spec' && r.obligation.tool === 'z3');
    expect(z3SolverAnswer(finalZ3) === 'unsat', `Z3 solver answer on final revision: ${z3SolverAnswer(finalZ3) ?? 'none'} (expected unsat)`);
    const regressionRuns = final?.runs.filter((r) => r.kind === 'regression') ?? [];
    expect(regressionRuns.length >= 1 && regressionRuns.every((r) => [Verdict.PROVED, Verdict.BOUNDED_PASS, Verdict.NOT_FALSIFIED].includes(r.result.verdict)), 'regression obligations did not all pass on the final revision');
    expect((final?.holdoutRuns.length ?? 0) > 0 && final!.holdoutRuns.every((r) => r.result.verdict === Verdict.NOT_FALSIFIED), 'holdout check missing or not NOT_FALSIFIED');
    expect(controlsOk, `negative controls: ${negativeControls.map((c) => `${c.run.obligation.id}=${c.run.result.verdict}`).join(', ') || 'not run'}`);
    expect(ledgerVerified, 'ledger chain verification failed');
    expect(recordValidation.valid, `record schema validation: ${recordValidation.errors.join('; ')}`);
    expect(record.release_gate.status === 'PASS', `release gate ${record.release_gate.status}: ${record.release_gate.reason ?? ''}`);
    if (gamAppendixB) {
      expect(gamAppendixB.passed, `GAM Appendix B case failed: ${gamAppendixB.failures.join('; ')}`);
    }

    return {
      workspaceDir,
      stateDir,
      ledgerPath,
      tools,
      spec,
      loop,
      initialZ3Counterexample,
      finalVerdicts,
      negativeControls,
      gamAppendixB,
      specsHashBefore,
      specsHashAfter,
      specsUnchanged: specsHashBefore === specsHashAfter,
      ledgerEntries: entries.length,
      ledgerVerified,
      record,
      recordValidation,
      passed: failures.length === 0,
      failures,
    };
  } finally {
    if (!options.keep) {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// GAM Appendix B governance case (as-built COUNTEREXAMPLE vs remediated BOUNDED_PASS)
// ---------------------------------------------------------------------------

import { GalModel, GamAdapter } from './adapters/gam';
import { computeSpecHash } from './registry';

export const APPENDIX_B_PROPERTY = 'AGENT_CONTAINMENT_POLICY';
export const APPENDIX_B_COMPONENT = 'eval_harness_containment';

export const APPENDIX_B_LAW: GalModel = {
  model_type: 'Law_Model',
  context: 'Appendix B containment policy (July 2026 agent intrusion)',
  entities: [
    { id: 'EvalHarness', type: 'Process' },
    { id: 'PublicInternet', type: 'Process' },
    { id: 'K8sClusterA', type: 'Process' },
    { id: 'K8sClusterB', type: 'Process' },
    { id: 'CISubnet', type: 'Process' },
    { id: 'SourceControl', type: 'Process' },
    { id: 'PublicNetworkEgress', type: 'Activity' },
    { id: 'ReadInstanceMetadata', type: 'Activity' },
    { id: 'CreatePrivilegedPod', type: 'Activity' },
    { id: 'ReadClusterSecrets', type: 'Activity' },
    { id: 'SafetyClassification', type: 'Activity' },
    { id: 'EvalAgentIdentity', type: 'Role' },
    { id: 'WorkerSA', type: 'Role' },
  ],
  relations: [
    { type: 'Separate', source: 'EvalHarness', target: 'PublicInternet' },
    { type: 'Separate', source: 'K8sClusterA', target: 'K8sClusterB' },
    { type: 'Separate', source: 'CISubnet', target: 'SourceControl' },
  ],
  policies: [
    { type: 'CanAssignTo', modality: 'Deny', source: 'PublicNetworkEgress', target: 'EvalAgentIdentity' },
    { type: 'CanAssignTo', modality: 'Deny', source: 'ReadInstanceMetadata', target: 'WorkerSA' },
    { type: 'CanAssignTo', modality: 'Deny', source: 'CreatePrivilegedPod', target: 'WorkerSA' },
    { type: 'CanAssignTo', modality: 'Deny', source: 'ReadClusterSecrets', target: 'WorkerSA' },
  ],
  ontologyRequirements: [
    { id: 'B2', process: 'EvalHarness', activity: 'SafetyClassification', rationale: 'safety classification step in harness' },
  ],
};

const APPENDIX_B_ENTITIES: GalModel['entities'] = [
  ...['EvalHarness', 'PackageProxy', 'PublicInternet', 'K8sClusterA', 'K8sClusterB', 'CISubnet', 'SourceControl', 'MeshNetwork'].map(
    (id) => ({ id, type: 'Process' }),
  ),
  ...['PublicNetworkEgress', 'ReadInstanceMetadata', 'CreatePrivilegedPod', 'RunEval', 'SafetyClassification'].map((id) => ({
    id,
    type: 'Activity',
  })),
  ...[
    'EvalAgentIdentity',
    'WorkerSA',
    'CSIDriverRole',
    'NodeRole',
    'ConnectorIdentity',
    'ClusterAdminA',
    'ClusterAdminB',
    'CIAutomationTag',
  ].map((id) => ({ id, type: 'Role' })),
  ...['EvalAgent', 'WorkerPod', 'ConnectorSvc', 'CIRunner'].map((id) => ({ id, type: 'User' })),
];

const APPENDIX_B_PRINCIPALS = [
  { type: 'Acts', source: 'EvalAgentIdentity', target: 'EvalAgent' },
  { type: 'Assumes', source: 'EvalAgent', target: 'EvalHarness' },
  { type: 'Acts', source: 'WorkerSA', target: 'WorkerPod' },
  { type: 'Acts', source: 'ConnectorIdentity', target: 'ConnectorSvc' },
  { type: 'Acts', source: 'CIAutomationTag', target: 'CIRunner' },
];

export const APPENDIX_B_AS_BUILT: GalModel = {
  model_type: 'Enterprise_Model',
  entities: APPENDIX_B_ENTITIES,
  relations: [
    ...APPENDIX_B_PRINCIPALS,
    { type: 'ComposedOf', source: 'EvalHarness', target: 'PackageProxy' },
    { type: 'ComposedOf', source: 'PackageProxy', target: 'PublicInternet' },
    { type: 'Contains', source: 'PublicInternet', target: 'PublicNetworkEgress' },
    { type: 'Contains', source: 'EvalHarness', target: 'RunEval' },
    { type: 'Includes', source: 'WorkerSA', target: 'CSIDriverRole' },
    { type: 'Includes', source: 'CSIDriverRole', target: 'NodeRole' },
    { type: 'AssignedTo', source: 'NodeRole', target: 'ReadInstanceMetadata' },
    { type: 'AssignedTo', source: 'CSIDriverRole', target: 'CreatePrivilegedPod' },
    { type: 'Includes', source: 'ConnectorIdentity', target: 'ClusterAdminA' },
    { type: 'Includes', source: 'ConnectorIdentity', target: 'ClusterAdminB' },
    { type: 'Reaches', source: 'ClusterAdminA', target: 'K8sClusterA' },
    { type: 'Reaches', source: 'ClusterAdminB', target: 'K8sClusterB' },
    { type: 'Reaches', source: 'CIAutomationTag', target: 'MeshNetwork' },
    { type: 'ComposedOf', source: 'MeshNetwork', target: 'CISubnet' },
    { type: 'ComposedOf', source: 'MeshNetwork', target: 'SourceControl' },
  ],
  policies: [],
};

export const APPENDIX_B_REMEDIATED: GalModel = {
  model_type: 'Enterprise_Model',
  entities: APPENDIX_B_ENTITIES,
  relations: [
    ...APPENDIX_B_PRINCIPALS,
    { type: 'ComposedOf', source: 'EvalHarness', target: 'PackageProxy' },
    { type: 'Contains', source: 'PublicInternet', target: 'PublicNetworkEgress' },
    { type: 'Contains', source: 'EvalHarness', target: 'RunEval' },
    { type: 'Contains', source: 'EvalHarness', target: 'SafetyClassification' },
    { type: 'Includes', source: 'CSIDriverRole', target: 'NodeRole' },
    { type: 'AssignedTo', source: 'NodeRole', target: 'ReadInstanceMetadata' },
    { type: 'AssignedTo', source: 'CSIDriverRole', target: 'CreatePrivilegedPod' },
    { type: 'Includes', source: 'ConnectorIdentity', target: 'ClusterAdminA' },
    { type: 'Reaches', source: 'ClusterAdminA', target: 'K8sClusterA' },
    { type: 'Reaches', source: 'ClusterAdminB', target: 'K8sClusterB' },
    { type: 'Reaches', source: 'CIAutomationTag', target: 'CISubnet' },
    { type: 'ComposedOf', source: 'MeshNetwork', target: 'CISubnet' },
    { type: 'ComposedOf', source: 'MeshNetwork', target: 'SourceControl' },
  ],
  policies: [],
};

export interface GamAppendixBDemoResult {
  spec: SpecManifest;
  asBuiltRun: ObligationRun;
  remediatedRun: ObligationRun;
  ledgerEntries: number;
  ledgerVerified: boolean;
  record: AssuranceRecord;
  recordValidation: SchemaValidationResult;
  passed: boolean;
  failures: string[];
}

/**
 * Run the GAM Appendix B governance case (as-built COUNTEREXAMPLE vs remediated BOUNDED_PASS)
 * through the same hash-chained EvidenceLedger and AssuranceRecord format.
 */
export async function runGamAppendixBGovernanceCase(
  options: { ledger?: EvidenceLedger; adapter?: SolverAdapter } = {},
): Promise<GamAppendixBDemoResult> {
  const baseSpec: Omit<SpecManifest, 'content_hash'> = {
    id: APPENDIX_B_PROPERTY,
    version: '1.0',
    status: 'approved',
    source: {
      normative_ref: 'APPENDIX-B-CONTAINMENT-001 (Governance policy model; not a host enforcement check)',
      jurisdiction: 'configured',
      interpretation_date: '2026-10-23',
    },
    assumptions: ['gal_closure_semantics', 'rbac_export_matches_deployed_config'],
    guarantee: 'Con(Phi_L U Phi_E) and ontology duties satisfied',
    artifacts: [{ tool: 'gam', file: 'specs/containment/appendix_b.gal.json', scope: 'finite GAL closure' }],
    reviewers: ['wael'],
  };
  const spec: SpecManifest = { ...baseSpec, content_hash: computeSpecHash(baseSpec) };
  const adapter = options.adapter ?? new GamAdapter();
  const ledger = options.ledger ?? new EvidenceLedger();
  const sink = new LedgerEvidenceSink(ledger);

  const asBuiltRev = { label: 'rev-1-as-built', commit: '1111111111111111111111111111111111111111' };
  const remediatedRev = { label: 'rev-2-remediated', commit: '2222222222222222222222222222222222222222' };

  const makeObligation = (id: string, enterprise: GalModel): Obligation => ({
    id: `${spec.id}/gam/${id}`,
    propertyId: spec.id,
    specVersion: spec.version,
    specHash: spec.content_hash,
    tool: 'gam',
    artifactPath: 'specs/containment/appendix_b.gal.json',
    scope: 'finite GAL closure',
    assumptions: [...spec.assumptions],
    guarantee: spec.guarantee,
    metadata: { galJson: { law: APPENDIX_B_LAW, enterprise } },
  });

  sink.beginRevision(asBuiltRev);
  const asBuiltObl = makeObligation('as_built', APPENDIX_B_AS_BUILT);
  const asBuiltRes = await adapter.verify(asBuiltObl, asBuiltRev.label);
  const asBuiltRun: ObligationRun = { kind: 'spec', obligation: asBuiltObl, result: asBuiltRes, revision: asBuiltRev };
  sink.record(asBuiltRun);

  sink.beginRevision(remediatedRev);
  const remediatedObl = makeObligation('remediated', APPENDIX_B_REMEDIATED);
  const remediatedRes = await adapter.verify(remediatedObl, remediatedRev.label);
  const remediatedRun: ObligationRun = { kind: 'spec', obligation: remediatedObl, result: remediatedRes, revision: remediatedRev };
  sink.record(remediatedRun);

  const ledgerVerified = ledger.verifyLedger(ledger.checkpoint);
  const record = generateAssuranceRecord({
    component: APPENDIX_B_COMPONENT,
    version: '0.1.0-appendix-b',
    sourceCommit: remediatedRev.commit,
    ledgerEntries: ledger.entries,
    specs: [spec],
    regressionObligations: 1,
    counterexamplesFound: 1,
    runtimeMonitors: 'NOT_DEPLOYED',
    trustedBase: ['gam_consistency_and_ontology_checker'],
    coverageLimits: ['Governance graph model only; does not inspect live kernel or cloud IAM runtime state'],
    nonClaims: ['live_infrastructure_isolation'],
  });
  const recordValidation = validateAgainstEvidenceSchema(record);

  const failures: string[] = [];
  if (asBuiltRes.verdict !== Verdict.COUNTEREXAMPLE) {
    failures.push(`as-built verdict ${asBuiltRes.verdict}, expected COUNTEREXAMPLE`);
  }
  if (remediatedRes.verdict !== Verdict.BOUNDED_PASS) {
    failures.push(`remediated verdict ${remediatedRes.verdict}, expected BOUNDED_PASS`);
  }
  if (!ledgerVerified) failures.push('ledger verification failed');
  if (!recordValidation.valid) failures.push(`record schema validation failed: ${recordValidation.errors.join('; ')}`);
  if (record.release_gate.status !== 'PASS') {
    failures.push(`release gate ${record.release_gate.status}: ${record.release_gate.reason ?? ''}`);
  }

  return {
    spec,
    asBuiltRun,
    remediatedRun,
    ledgerEntries: ledger.entries.length,
    ledgerVerified,
    record,
    recordValidation,
    passed: failures.length === 0,
    failures,
  };
}

