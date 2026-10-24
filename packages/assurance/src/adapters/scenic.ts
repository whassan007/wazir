import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Verdict, type Obligation, type SolverAdapter, type ToolAvailability, type VerificationResult, type VerifyOptions } from '../contracts.js';

export interface ScenicAdapterOptions {
  pythonPath?: string;
  seed?: number;
  count?: number;
  maxIterations?: number;
  maxRejectionRate?: number;
}

const PYTHON = '/Users/wael/Code/Wazir/tools/scenic-venv/bin/python3';
const MARKER = '__SCENIC_RESULT__';
const BRIDGE = String.raw`
import sys, json, random, importlib.metadata
import numpy as np
import scenic
from scenic.core.distributions import RejectionException
path, seed, count, cap = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
random.seed(seed)
np.random.seed(seed)
def serialize(value):
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, dict):
        return {str(k): serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [serialize(v) for v in value]
    if isinstance(value, np.generic):
        return value.item()
    if hasattr(value, 'x') and hasattr(value, 'y'):
        return [float(value.x), float(value.y), float(getattr(value, 'z', 0))]
    return str(value)
scenario = scenic.scenarioFromFile(path)
attempted = 0
scenes = []
for _ in range(count):
    try:
        scene, iterations = scenario.generate(maxIterations=cap, verbosity=0)
        attempted += iterations
        scenes.append({'objects': [{'position': serialize(obj.position), 'heading': float(obj.heading)} for obj in scene.objects], 'parameters': serialize(scene.params)})
    except RejectionException:
        attempted += cap
print('${MARKER}' + json.dumps({'attempted': attempted, 'generated': len(scenes), 'rejected': attempted - len(scenes), 'scenes': scenes}, allow_nan=False))
`;

function run(python: string, args: string[], timeout: number, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    execFile(python, args, { timeout, cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, MPLBACKEND: 'Agg', PYTHONHASHSEED: '0' } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else accept({ stdout, stderr });
    });
  });
}

/** Headless generation only: successful sampling is never a proof. */
export class ScenicAdapter implements SolverAdapter {
  readonly tool = 'scenic' as const;
  constructor(private readonly config: ScenicAdapterOptions = {}) {}

  async checkAvailability(): Promise<ToolAvailability> {
    const path = this.config.pythonPath ?? PYTHON;
    try {
      const { stdout } = await run(path, ['-c', 'import scenic, importlib.metadata; print(importlib.metadata.version("scenic"))'], 10_000);
      return { available: true, version: stdout.trim(), path };
    } catch {
      return { available: false, version: 'unavailable', path };
    }
  }

  async verify(obligation: Obligation, workspaceRev: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    const start = Date.now();
    const metadata = obligation.metadata ?? {};
    const seed = obligation.seed ?? this.config.seed ?? 0;
    const count = metadata.count ?? this.config.count ?? 1;
    const maxIterations = metadata.maxIterations ?? this.config.maxIterations ?? 2000;
    const maxRejectionRate = metadata.maxRejectionRate ?? this.config.maxRejectionRate ?? 0.95;
    const result: VerificationResult = {
      tool: this.tool, toolVersion: 'unavailable', verdict: Verdict.ERROR,
      assumptions: [...obligation.assumptions], scope: obligation.scope,
      elapsedMs: 0, inputHash: '', seed,
      metadata: { workspaceRev, count, maxIterations, maxRejectionRate },
    };
    const finish = () => ({ ...result, elapsedMs: Date.now() - start });
    const availability = await this.checkAvailability();
    result.toolVersion = availability.version;
    if (!availability.available) { result.verdict = Verdict.NOT_RUN; return finish(); }
    try {
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff ||
          typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 ||
          typeof maxIterations !== 'number' || !Number.isSafeInteger(maxIterations) || maxIterations < 1 ||
          typeof maxRejectionRate !== 'number' || !Number.isFinite(maxRejectionRate) || maxRejectionRate < 0 || maxRejectionRate > 1) {
        throw new Error('Invalid Scenic seed, count, maxIterations, or maxRejectionRate');
      }
      const path = resolve(options.workspaceDir ?? process.cwd(), obligation.artifactPath);
      const source = await readFile(path);
      result.inputHash = createHash('sha256').update(source).update(JSON.stringify({ seed, count, maxIterations, maxRejectionRate, workspaceRev })).digest('hex');
      const output = await run(availability.path!, ['-c', BRIDGE, path, String(seed), String(count), String(maxIterations)], options.timeoutMs ?? obligation.timeoutMs ?? 60_000, options.workspaceDir);
      result.stdout = output.stdout;
      result.stderr = output.stderr;
      const line = output.stdout.split('\n').reverse().find((item) => item.startsWith(MARKER));
      if (!line) throw new Error('Scenic bridge returned no sampling result');
      const sampled = JSON.parse(line.slice(MARKER.length)) as { attempted: number; generated: number; rejected: number; scenes: unknown[] };
      result.attempted = sampled.attempted;
      result.generated = sampled.generated;
      result.rejected = sampled.rejected;
      result.witness = sampled.scenes;
      const rejectionRate = sampled.attempted ? sampled.rejected / sampled.attempted : 1;
      const passed = sampled.generated === count && rejectionRate <= maxRejectionRate;
      result.metadata = { ...result.metadata, scenes: sampled.scenes, rejectionRate };
      result.vacuityProbe = { passed, reason: passed ? 'Sampling completed within rejection threshold' : 'Insufficient scenes or excessive rejection rate', details: { attempted: sampled.attempted, generated: sampled.generated, rejected: sampled.rejected, rejectionRate, maxRejectionRate } };
      result.verdict = passed ? Verdict.NOT_FALSIFIED : Verdict.INCONSISTENT_ASSUMPTIONS;
    } catch (error) {
      const failure = error as Error & { killed?: boolean; code?: string; stdout?: string; stderr?: string };
      result.verdict = failure.killed ? Verdict.UNKNOWN : Verdict.ERROR;
      result.stdout = failure.stdout;
      result.stderr = failure.stderr ?? failure.message;
    }
    return finish();
  }
}
