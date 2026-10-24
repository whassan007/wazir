import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from '@wazir/workers';
import { EvaluationService, BenchmarkService } from '@wazir/evaluation';
import { VerificationEngine, SolutionSearchService, ModelIntelligenceService } from '@wazir/core';
import { createEngine, resolveEngineProfile, type EngineProfile } from '../src/engine.js';

const construction = vi.hoisted(() => ({ evaluation: vi.fn(), intelligence: vi.fn() }));
vi.mock('@wazir/evaluation', async (original) => {
  const actual = await original<typeof import('@wazir/evaluation')>();
  return { ...actual, EvaluationService: class extends actual.EvaluationService {
    constructor() { super(); construction.evaluation(); }
  } };
});
vi.mock('@wazir/core', async (original) => {
  const actual = await original<typeof import('@wazir/core')>();
  return { ...actual, ModelIntelligenceService: class extends actual.ModelIntelligenceService {
    constructor(...args: ConstructorParameters<typeof actual.ModelIntelligenceService>) {
      super(...args); construction.intelligence();
    }
  } };
});

describe('engine initialization profiles', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'wazir-engine-profile-'));
    vi.stubEnv('WAZIR_HOME', home);
    vi.stubEnv('WAZIR_IN_MEMORY', '1');
    vi.stubEnv('WAZIR_DATABASE_URL', '');
    vi.stubEnv('WAZIR_API_URL', '');
    vi.stubEnv('WAZIR_SECRETS_BACKEND', 'encrypted-file');
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each<EngineProfile>(['minimal', 'interactive', 'full'])('honors explicit %s', (profile) => {
    expect(resolveEngineProfile({ profile, fastStartup: true, readOnlyLifecycle: true })).toBe(profile);
  });
  it('infers minimal only for fast read-only startup', () => {
    expect(resolveEngineProfile({ fastStartup: true, readOnlyLifecycle: true })).toBe('minimal');
    for (const options of [{}, { fastStartup: true }, { readOnlyLifecycle: true }]) {
      expect(resolveEngineProfile(options)).toBe('full');
    }
  });

  it.each(['minimal', undefined] as const)('starts minimal (%s) without discovery and exposes cached working services', async (profile) => {
    const start = vi.spyOn(Worker.prototype, 'start');
    const hardware = vi.spyOn(Worker.prototype, 'hardwareReport', 'get');
    const before = performance.now();
    const engine = await createEngine({ profile, quiet: true, fastStartup: true, readOnlyLifecycle: true, projectRoot: home });
    // Generous CI ceiling; absence of probes is the deterministic performance assertion.
    expect(performance.now() - before).toBeLessThan(100);
    expect(start).not.toHaveBeenCalled();
    expect(hardware).not.toHaveBeenCalled();
    expect(engine.computers.get(engine.worker.computerId)?.hardware.cpuCores).toBe(os.cpus().length);
    expect(construction.evaluation).not.toHaveBeenCalled();
    expect(construction.intelligence).not.toHaveBeenCalled();
    for (const key of ['evaluation', 'benchmark', 'verification', 'solutionSearch', 'optimizer', 'modelIntelligence', 'compaction', 'revision', 'layoutPlanner', 'offloadStore'] as const) {
      expect(Object.getOwnPropertyDescriptor(engine, key)?.get).toBeTypeOf('function');
      expect(engine[key]).toBeDefined();
      expect(engine[key]).toBe(engine[key]);
    }
    expect(engine.evaluation).toBeInstanceOf(EvaluationService);
    expect(engine.benchmark).toBeInstanceOf(BenchmarkService);
    expect(engine.verification).toBeInstanceOf(VerificationEngine);
    expect(engine.solutionSearch).toBeInstanceOf(SolutionSearchService);
    expect(engine.modelIntelligence).toBeInstanceOf(ModelIntelligenceService);
    expect(engine.benchmark!.listTasks()).toEqual(expect.any(Array));
    expect(construction.evaluation).toHaveBeenCalledTimes(1);
    expect(construction.intelligence).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'interactive', 'full'] as const)('preserves discovery and lazy services for %s', async (profile) => {
    const start = vi.spyOn(Worker.prototype, 'start').mockImplementation(async function () { return this.info; });
    vi.spyOn(Worker.prototype, 'hardwareReport', 'get').mockReturnValue({
      os: { platform: process.platform, architecture: process.arch, version: process.version },
      hardware: { cpu: 'test', cpuCores: 4, memoryGB: 8 },
    });
    const engine = await createEngine({ profile, quiet: true, fastStartup: true, projectRoot: home });
    expect(start).toHaveBeenCalledOnce();
    expect(construction.evaluation).not.toHaveBeenCalled();
    expect(construction.intelligence).not.toHaveBeenCalled();
    expect(engine.evaluation).toBe(engine.evaluation);
    expect(engine.modelIntelligence).toBe(engine.modelIntelligence);
    expect(engine.computers.get(engine.worker.computerId)).toBeDefined();
  });

  it('allows explicit discovery opt-in and opt-out', async () => {
    const start = vi.spyOn(Worker.prototype, 'start').mockImplementation(async function () { return this.info; });
    vi.spyOn(Worker.prototype, 'hardwareReport', 'get').mockReturnValue({
      os: { platform: process.platform, architecture: process.arch, version: process.version },
      hardware: { cpu: 'test', cpuCores: 4, memoryGB: 8 },
    });
    await createEngine({ profile: 'full', skipRuntimeDiscovery: true, quiet: true, fastStartup: true, projectRoot: home });
    expect(start).not.toHaveBeenCalled();
    await createEngine({ profile: 'minimal', skipRuntimeDiscovery: false, quiet: true, fastStartup: true, projectRoot: home });
    expect(start).toHaveBeenCalledOnce();
  });
});
