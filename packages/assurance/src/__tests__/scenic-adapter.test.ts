import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveScenicPython, ScenicAdapter } from '../adapters/scenic.js';
import { Verdict, type Obligation } from '../contracts.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'scenic-adapter-')); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function obligation(source: string, metadata: Record<string, unknown> = {}): Promise<Obligation> {
  const artifactPath = join(directory, 'scenario.scenic');
  await writeFile(artifactPath, source);
  return { id: 'sample', propertyId: 'scene-constraints', specVersion: '1', specHash: 'test', tool: 'scenic', artifactPath, assumptions: [], guarantee: 'sample satisfies scenario requirements', seed: 42, metadata };
}
const scenario = 'param label = "fixture"\nego = new Object at Range(-10, 10) @ Range(-10, 10), facing Range(-3, 3)\n';

describe('Scenic Python path resolution', () => {
  beforeEach(() => {
    vi.stubEnv('WAZIR_SCENIC_PYTHON', '');
    vi.stubEnv('WAZIR_TOOLS_DIR', '');
  });

  it('prefers the Python environment override over the tools directory', () => {
    const python = join(directory, 'custom-python');
    vi.stubEnv('WAZIR_SCENIC_PYTHON', python);
    vi.stubEnv('WAZIR_TOOLS_DIR', join(directory, 'other-tools'));
    expect(resolveScenicPython()).toBe(python);
  });

  it('resolves the virtualenv under the tools directory override', () => {
    vi.stubEnv('WAZIR_TOOLS_DIR', directory);
    expect(resolveScenicPython()).toBe(join(directory, 'scenic-venv/bin/python3'));
  });

  it('walks up from a nested working directory to find repository tools', async () => {
    const python = join(directory, 'tools/scenic-venv/bin/python3');
    const nested = join(directory, 'packages/assurance');
    await mkdir(join(directory, 'tools/scenic-venv/bin'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(python, '');
    vi.spyOn(process, 'cwd').mockReturnValue(nested);
    expect(resolveScenicPython()).toBe(python);
  });

  it('keeps an explicit adapter Python path ahead of environment overrides', async () => {
    vi.stubEnv('WAZIR_SCENIC_PYTHON', join(directory, 'env-python'));
    const pythonPath = join(directory, 'explicit-python');
    expect(await new ScenicAdapter({ pythonPath }).checkAvailability()).toMatchObject({ available: false, path: pythonPath });
  });
});

const hasPinnedScenic = existsSync(resolveScenicPython());
describe.skipIf(!hasPinnedScenic)('ScenicAdapter (real headless Scenic)', () => {
  it('finds the installed Scenic version', async () => {
    expect(await new ScenicAdapter().checkAvailability()).toMatchObject({ available: true, version: expect.stringMatching(/^\d/) });
  });

  it('replays deterministic scenes, serializes positions/headings/parameters, and never proves', async () => {
    const adapter = new ScenicAdapter();
    const input = await obligation(scenario, { count: 3 });
    const first = await adapter.verify(input, 'rev');
    const second = await adapter.verify(input, 'rev');
    expect(first.stderr).toBe('');
    expect(first.verdict).toBe(Verdict.NOT_FALSIFIED);
    expect(first.generated).toBe(3);
    expect(first.attempted).toBe(first.generated! + first.rejected!);
    expect(first.vacuityProbe?.passed).toBe(true);
    expect(first.seed).toBe(42);
    expect(first.witness).toEqual(second.witness);
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.metadata?.scenes).toEqual(first.witness);
    const scenes = first.witness as { objects: { position: number[]; heading: number }[]; parameters: Record<string, unknown> }[];
    expect(scenes[0].objects[0].position).toHaveLength(3);
    expect(typeof scenes[0].objects[0].heading).toBe('number');
    expect(scenes[0].parameters.label).toBe('fixture');
    const changed = await adapter.verify({ ...input, seed: 43 }, 'rev');
    expect(changed.witness).not.toEqual(first.witness);
    expect(changed.inputHash).not.toBe(first.inputHash);
  }, 20_000);

  it('fails the vacuity probe when rejection sampling cannot produce enough scenes', async () => {
    const input = await obligation('ego = new Object at Range(0, 1) @ 0\nrequire ego.position.x > 2\n', { count: 2, maxIterations: 5 });
    const result = await new ScenicAdapter().verify(input, 'rev');
    expect(result.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(result).toMatchObject({ attempted: 10, generated: 0, rejected: 10, witness: [], vacuityProbe: { passed: false } });
  });

  it('fails the rejection-rate probe even when every requested scene is generated', async () => {
    const input = await obligation('ego = new Object at Range(0, 1) @ 0\nrequire ego.position.x > 0.9\n', { count: 5, maxIterations: 1000, maxRejectionRate: 0 });
    const result = await new ScenicAdapter().verify(input, 'rev');
    expect(result.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(result.generated).toBe(5);
    expect(result.rejected).toBeGreaterThan(0);
    expect(result.vacuityProbe?.passed).toBe(false);
  });

  it('maps Scenic parse failures to ERROR', async () => {
    const result = await new ScenicAdapter().verify(await obligation('ego = new Object at (\n'), 'rev');
    expect(result.verdict).toBe(Verdict.ERROR);
    expect(result.stderr).toMatch(/SyntaxError|ParseError/);
  });

  it('maps a missing Python executable to NOT_RUN', async () => {
    const adapter = new ScenicAdapter({ pythonPath: join(directory, 'missing-python') });
    expect((await adapter.checkAvailability()).available).toBe(false);
    expect((await adapter.verify(await obligation(scenario), 'rev')).verdict).toBe(Verdict.NOT_RUN);
  });

  it('maps a missing Scenic package to NOT_RUN', async () => {
    const pythonPath = join(directory, 'python-without-scenic');
    await writeFile(pythonPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect((await new ScenicAdapter({ pythonPath }).verify(await obligation(scenario), 'rev')).verdict).toBe(Verdict.NOT_RUN);
  });

  it('maps the execution deadline to UNKNOWN', async () => {
    const result = await new ScenicAdapter().verify(await obligation(scenario), 'rev', { timeoutMs: 1 });
    expect(result.verdict).toBe(Verdict.UNKNOWN);
  });

  it('rejects invalid budgets and thresholds', async () => {
    for (const metadata of [{ count: 0 }, { maxIterations: -1 }, { maxRejectionRate: 2 }]) {
      expect((await new ScenicAdapter().verify(await obligation(scenario, metadata), 'rev')).verdict).toBe(Verdict.ERROR);
    }
  });
});
