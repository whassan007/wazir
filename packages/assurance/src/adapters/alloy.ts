/**
 * Alloy adapter (FORMAL_ASSURANCE.md §2.3 item 2).
 *
 * Drives `java -jar org.alloytools.alloy.dist.jar exec -t text -c '*' -f -o <dir> <file>` and
 * judges each command from `receipt.json`. The process exit code is never a verdict on its own:
 * Alloy exits 0 whether a check finds a counterexample or not.
 *
 *  - check SAT (solution present)        → COUNTEREXAMPLE, witness = receipt instance + text trace
 *  - check UNSAT, run witness SAT        → BOUNDED_PASS (never PROVED: Alloy scopes are finite)
 *  - check UNSAT, no SAT run witness     → INCONSISTENT_ASSUMPTIONS (vacuity probe failed)
 *  - timeout                             → UNKNOWN
 *  - syntax/type error, missing receipt  → ERROR
 *  - JAR or java unavailable             → NOT_RUN
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  Obligation,
  SolverAdapter,
  ToolAvailability,
  VacuityProbeResult,
  VerificationResult,
  Verdict,
  VerifyOptions,
} from '../contracts';
import { applyVacuityProbe, mapNativeOutcomeToVerdict } from '../verdict';

export const ALLOY_PINNED_VERSION = '6.2.0';
export const DEFAULT_ALLOY_TIMEOUT_MS = 120_000;

export interface AlloyAdapterOptions {
  /** Path to `org.alloytools.alloy.dist.jar`. Defaults to `$ALLOY_JAR`, then `<cwd>/tools/alloy/...`. */
  jarPath?: string;
  /** Java executable. Defaults to `$JAVA` or `java` on PATH. */
  javaPath?: string;
  defaultTimeoutMs?: number;
  /** Keep the per-run output directory (for debugging); it is removed by default. */
  keepOutputDir?: boolean;
}

/** One command entry of Alloy 6.2 `receipt.json`. A command without `solution` was UNSAT. */
export interface AlloyReceiptCommand {
  name: string;
  type: 'run' | 'check' | string;
  source?: string;
  bitwidth?: number;
  overall?: number;
  /** -1 when not set; `expect 0` marks a run intended to be UNSAT. */
  expects?: number;
  maxseq?: number;
  /** Temporal step bound (`but N steps`); -1 for non-temporal commands. */
  maxprefix?: number;
  minprefix?: number;
  solution?: Array<{ duration?: number; instances?: unknown[] } & Record<string, unknown>>;
}

export interface AlloyReceipt {
  commands: Record<string, AlloyReceiptCommand>;
  solver?: string;
  [key: string]: unknown;
}

export interface AlloyCommandSummary {
  name: string;
  type: string;
  source?: string;
  sat: boolean;
  overall?: number;
  intBitwidth?: number;
  steps?: number;
  expects?: number;
}

export interface AlloyInterpretation {
  verdict: Verdict;
  witness?: unknown;
  vacuityProbe?: VacuityProbeResult;
  scope?: string;
  intBitwidth?: number;
  steps?: number;
  commands: AlloyCommandSummary[];
  reason?: string;
}

export interface InterpretOptions {
  /** Check command names to judge; empty/undefined or `*` → every check in the receipt. */
  checkCommands?: string[];
  /** Run commands acting as the vacuity witness; undefined → every run not marked `expect 0`. */
  witnessCommands?: string[];
  /** Text output per command name (`<name>-solution-0.txt`), attached to counterexample witnesses. */
  solutionTexts?: Record<string, string>;
}

function isSat(cmd: AlloyReceiptCommand): boolean {
  return Array.isArray(cmd.solution) && cmd.solution.length > 0;
}

function positive(n: number | undefined): number | undefined {
  return typeof n === 'number' && n >= 0 ? n : undefined;
}

function summarize(cmd: AlloyReceiptCommand): AlloyCommandSummary {
  return {
    name: cmd.name,
    type: cmd.type,
    source: cmd.source,
    sat: isSat(cmd),
    overall: positive(cmd.overall),
    intBitwidth: positive(cmd.bitwidth),
    steps: positive(cmd.maxprefix),
    expects: cmd.expects,
  };
}

function scopeOf(cmds: AlloyReceiptCommand[]): string | undefined {
  const parts = cmds.map((c) => {
    const bits = [`overall=${c.overall ?? '?'}`, `int=${c.bitwidth ?? '?'}`];
    if (positive(c.maxprefix) !== undefined) bits.push(`steps=${c.maxprefix}`);
    return `${c.name}: ${c.source ?? '?'} [${bits.join(', ')}]`;
  });
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function maxOf(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === 'number');
  return nums.length > 0 ? Math.max(...nums) : undefined;
}

/** Pure receipt → verdict mapping (also used for fixture tests). */
export function interpretAlloyReceipt(receipt: AlloyReceipt, opts: InterpretOptions = {}): AlloyInterpretation {
  const all = Object.values(receipt?.commands ?? {});
  const commands = all.map(summarize);
  const wanted = (opts.checkCommands ?? []).filter((c) => c && c !== '*');

  const checks = all.filter((c) => c.type === 'check');
  const targeted = wanted.length > 0 ? checks.filter((c) => wanted.includes(c.name)) : checks;
  const missing = wanted.filter((w) => !checks.some((c) => c.name === w));
  if (missing.length > 0) {
    return { verdict: Verdict.ERROR, commands, reason: `check command(s) not found in receipt: ${missing.join(', ')}` };
  }
  if (targeted.length === 0) {
    return { verdict: Verdict.ERROR, commands, reason: 'model has no check commands to judge' };
  }

  const scope = scopeOf(targeted);
  const intBitwidth = maxOf(targeted.map((c) => positive(c.bitwidth)));
  const steps = maxOf(targeted.map((c) => positive(c.maxprefix)));

  const failing = targeted.filter(isSat);
  if (failing.length > 0) {
    const witness = failing.map((c) => ({
      command: c.name,
      source: c.source,
      instance: c.solution?.[0]?.instances?.[0],
      trace: opts.solutionTexts?.[c.name],
    }));
    return {
      verdict: mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'counterexample' }),
      witness: witness.length === 1 ? witness[0] : witness,
      scope,
      intBitwidth,
      steps,
      commands,
      reason: `counterexample found for: ${failing.map((c) => c.name).join(', ')}`,
    };
  }

  const runs = all.filter((c) => c.type === 'run');
  const witnessRuns = opts.witnessCommands
    ? runs.filter((r) => opts.witnessCommands!.includes(r.name))
    : runs.filter((r) => r.expects !== 0);
  const missingWitness = (opts.witnessCommands ?? []).filter((w) => !runs.some((r) => r.name === w));
  const unsatWitness = witnessRuns.filter((r) => !isSat(r));

  let probe: VacuityProbeResult;
  if (missingWitness.length > 0) {
    probe = { passed: false, reason: `designated witness run(s) not found: ${missingWitness.join(', ')}` };
  } else if (witnessRuns.length === 0) {
    probe = { passed: false, reason: 'no run witness command in model; cannot rule out vacuous facts' };
  } else if (opts.witnessCommands && unsatWitness.length > 0) {
    probe = { passed: false, reason: `designated witness run(s) UNSAT: ${unsatWitness.map((r) => r.name).join(', ')}` };
  } else if (unsatWitness.length === witnessRuns.length) {
    probe = { passed: false, reason: `all run witnesses UNSAT: ${unsatWitness.map((r) => r.name).join(', ')}` };
  } else {
    probe = { passed: true, reason: `run witness SAT: ${witnessRuns.filter(isSat).map((r) => r.name).join(', ')}` };
  }
  probe.details = {
    witnesses: witnessRuns.map((r) => ({ name: r.name, source: r.source, sat: isSat(r) })),
  };

  const verdict = applyVacuityProbe(mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'no_counterexample' }), probe);
  return {
    verdict,
    vacuityProbe: probe,
    scope,
    intBitwidth,
    steps,
    commands,
    reason: verdict === Verdict.BOUNDED_PASS ? 'no counterexample within scope' : probe.reason,
  };
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<ProcResult, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ...r, stdout, stderr, timedOut });
    };
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, spawnError: err }));
    child.on('close', (code) => finish({ code }));
  });
}

function sha256(data: string | Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function splitCommands(command?: string): string[] {
  return (command ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export class AlloyAdapter implements SolverAdapter {
  readonly tool = 'alloy' as const;
  readonly jarPath: string;
  readonly javaPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly keepOutputDir: boolean;

  constructor(options: AlloyAdapterOptions = {}) {
    this.jarPath =
      options.jarPath ?? process.env.ALLOY_JAR ?? resolve(process.cwd(), 'tools/alloy/org.alloytools.alloy.dist.jar');
    this.javaPath = options.javaPath ?? process.env.JAVA ?? 'java';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_ALLOY_TIMEOUT_MS;
    this.keepOutputDir = options.keepOutputDir ?? false;
  }

  async checkAvailability(): Promise<ToolAvailability> {
    if (!existsSync(this.jarPath)) return { available: false, version: 'unknown', path: this.jarPath };
    const r = await runProcess(this.javaPath, ['-jar', this.jarPath, 'version'], 30_000);
    const version = r.stdout.trim().split(/\s+/)[0];
    if (r.spawnError || r.timedOut || r.code !== 0 || !version) {
      return { available: false, version: 'unknown', path: this.jarPath };
    }
    return { available: true, version, path: this.jarPath };
  }

  async verify(obligation: Obligation, workspaceRev: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    const started = Date.now();
    const alsPath = isAbsolute(obligation.artifactPath)
      ? obligation.artifactPath
      : resolve(options.workspaceDir ?? process.cwd(), obligation.artifactPath);
    const timeoutMs = options.timeoutMs ?? obligation.timeoutMs ?? this.defaultTimeoutMs;

    const source = existsSync(alsPath) ? readFileSync(alsPath) : undefined;
    const inputHash = sha256(
      JSON.stringify({
        tool: 'alloy',
        model: source ? sha256(source) : null,
        command: obligation.command ?? '*',
        scope: obligation.scope ?? null,
        workspaceRev,
      }),
    );
    const base = {
      tool: this.tool,
      toolVersion: ALLOY_PINNED_VERSION,
      assumptions: obligation.assumptions,
      inputHash,
      seed: obligation.seed,
    };
    const elapsed = () => Date.now() - started;

    if (!existsSync(this.jarPath)) {
      return { ...base, verdict: Verdict.NOT_RUN, elapsedMs: elapsed(), metadata: { reason: `Alloy JAR not found: ${this.jarPath}` } };
    }
    if (!source) {
      return { ...base, verdict: Verdict.ERROR, elapsedMs: elapsed(), metadata: { reason: `model not found: ${alsPath}` } };
    }

    const outDir = mkdtempSync(join(tmpdir(), 'wazir-alloy-'));
    try {
      const args = ['-jar', this.jarPath, 'exec', '-t', 'text', '-c', '*', '-f', '-o', outDir, alsPath];
      const proc = await runProcess(this.javaPath, args, timeoutMs);
      const io = { stdout: proc.stdout, stderr: proc.stderr };

      if (proc.spawnError) {
        const reason =
          proc.spawnError.code === 'ENOENT' ? `java not found: ${this.javaPath}` : `failed to start java: ${proc.spawnError.message}`;
        return { ...base, ...io, verdict: Verdict.NOT_RUN, elapsedMs: elapsed(), metadata: { reason } };
      }
      if (proc.timedOut) {
        return {
          ...base,
          ...io,
          verdict: mapNativeOutcomeToVerdict({ tool: 'alloy', outcome: 'timeout' }),
          elapsedMs: elapsed(),
          metadata: { reason: `Alloy timed out after ${timeoutMs}ms`, timeoutMs },
        };
      }

      const receiptPath = join(outDir, 'receipt.json');
      if (proc.code !== 0 || !existsSync(receiptPath)) {
        const firstError = /(Syntax error|Type error|Error)[^\n]*/.exec(proc.stderr + proc.stdout)?.[0];
        return {
          ...base,
          ...io,
          verdict: Verdict.ERROR,
          elapsedMs: elapsed(),
          metadata: { reason: firstError ?? `Alloy exited ${proc.code} without receipt.json`, exitCode: proc.code },
        };
      }

      let receipt: AlloyReceipt;
      try {
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      } catch (err) {
        return { ...base, ...io, verdict: Verdict.ERROR, elapsedMs: elapsed(), metadata: { reason: `unparseable receipt.json: ${String(err)}` } };
      }

      const solutionTexts: Record<string, string> = {};
      for (const f of readdirSync(outDir)) {
        const m = /^(.*)-solution-0\.txt$/.exec(f);
        if (m) solutionTexts[m[1]] = readFileSync(join(outDir, f), 'utf8');
      }
      const witnessCommands = obligation.metadata?.witnessCommands;
      const interp = interpretAlloyReceipt(receipt, {
        checkCommands: splitCommands(obligation.command),
        witnessCommands: Array.isArray(witnessCommands) ? (witnessCommands as string[]) : undefined,
        solutionTexts,
      });

      return {
        ...base,
        ...io,
        verdict: interp.verdict,
        witness: interp.witness,
        scope: obligation.scope ?? interp.scope,
        vacuityProbe: interp.vacuityProbe,
        elapsedMs: elapsed(),
        metadata: {
          reason: interp.reason,
          scope: interp.scope,
          intBitwidth: interp.intBitwidth,
          steps: interp.steps,
          commands: interp.commands,
          solver: receipt.solver,
          exitCode: proc.code,
          ...(this.keepOutputDir ? { outputDir: outDir } : {}),
        },
      };
    } finally {
      if (!this.keepOutputDir) rmSync(outDir, { recursive: true, force: true });
    }
  }
}
