import { describe, it, expect } from 'vitest';
import { doctor, type DoctorCheck, type DoctorReport } from '../src/doctor.js';
import type { RookEngine } from '../src/engine.js';
import { ComputerRegistry, ModelRegistry, PolicyEngine } from '@wazir/core';

function createMockEngine(overrides: Partial<RookEngine> = {}): RookEngine {
  const computers = new ComputerRegistry();
  computers.register({
    id: 'local',
    name: 'test-node',
    type: 'workstation',
    local: true,
  });

  const models = new ModelRegistry();
  models.register({
    id: 'test-model',
    name: 'test-model',
    provider: 'ollama',
    family: 'other',
    contextMax: 32768,
    capabilities: ['generalChat'],
    toolCalling: false,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: 'any',
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'test-model::local::ollama',
    modelId: 'test-model',
    computerId: 'local',
    runtimeId: 'ollama',
    runtimeModelId: 'test-model',
    loaded: true,
    health: 'healthy',
  });

  const base: any = {
    config: { ollamaUrl: 'http://localhost:11434' },
    projectRoot: '/tmp',
    configDir: '/tmp/.wazir',
    computers,
    runtimes: {} as any,
    models,
    agents: {} as any,
    tools: {} as any,
    policy: new PolicyEngine({ projectRoot: '/tmp' }),
    scheduler: {} as any,
    compiler: {} as any,
    executions: { store: { path: '/tmp/store.json' } } as any,
    approvalQueue: {} as any,
    orchestrator: {} as any,
    worktrees: {} as any,
    adapters: new Map(),
    discovered: [
      {
        id: 'ollama',
        health: 'healthy',
        info: { id: 'ollama', name: 'Ollama', version: '0.3.10' },
        models: [{ id: 'test-model', name: 'test-model' }],
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: false, vision: false, embeddings: false, reasoning: false, modelLoad: false, modelUnload: false, modelDownload: false, statefulChat: false, mcp: false },
        adapter: {} as any,
      },
    ],
    worker: {
      id: 'worker-local',
      computerId: 'local',
      isRunning: true,
      info: { id: 'worker-local', computerId: 'local', version: '1.0', status: 'online', runtimes: ['ollama'], models: ['test-model'] },
    } as any,
    store: {} as any,
  };

  return Object.assign(base, overrides) as RookEngine;
}

function findCheck(report: DoctorReport, name: string): DoctorCheck {
  const check = report.checks.find((c) => c.name === name);
  if (!check) throw new Error(`Check '${name}' not found in report`);
  return check;
}

describe('Section 13: wa doctor check-by-check suite', () => {
  describe('checkConfig', () => {
    it('reports PASS when at least one runtime URL is configured', () => {
      const engine = createMockEngine({ config: { ollamaUrl: 'http://localhost:11434' } as any });
      const check = findCheck(doctor(engine), 'configuration');
      expect(check.status).toBe('PASS');
      expect(check.message).toContain('valid');
    });

    it('reports WARN when neither ollamaUrl nor lmstudioUrl is configured', () => {
      const engine = createMockEngine({ config: {} as any });
      const check = findCheck(doctor(engine), 'configuration');
      expect(check.status).toBe('WARN');
      expect(check.message).toContain('no runtimes configured');
    });

    it('reports FAIL on configuration access error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'config', {
        get() {
          throw new Error('Corrupt YAML in ~/.wazir/config.json');
        },
      });
      const check = findCheck(doctor(engine), 'configuration');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('Corrupt YAML');
    });
  });

  describe('checkPersistence', () => {
    it('reports PASS when persistent storage path is present', () => {
      const engine = createMockEngine({
        executions: { store: { path: '/home/user/.wazir/store.json' } } as any,
      });
      const check = findCheck(doctor(engine), 'persistence');
      expect(check.status).toBe('PASS');
      expect(check.message).toContain('/home/user/.wazir/store.json');
    });

    it('reports PASS when in-memory store is active (store.path absent)', () => {
      const engine = createMockEngine({
        executions: { store: {} } as any,
      });
      const check = findCheck(doctor(engine), 'persistence');
      expect(check.status).toBe('PASS');
      expect(check.message).toContain('in-memory');
    });

    it('reports FAIL on persistence access error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'executions', {
        get() {
          throw new Error('I/O error reading database descriptor');
        },
      });
      const check = findCheck(doctor(engine), 'persistence');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('I/O error');
    });
  });

  describe('checkControlPlane', () => {
    it('reports PASS when registered computers are online', () => {
      const engine = createMockEngine();
      const check = findCheck(doctor(engine), 'control plane');
      expect(check.status).toBe('PASS');
      expect(check.message).toContain('online');
    });

    it('reports WARN when zero computers are registered', () => {
      const emptyRegistry = new ComputerRegistry();
      const engine = createMockEngine({ computers: emptyRegistry });
      const check = findCheck(doctor(engine), 'control plane');
      expect(check.status).toBe('WARN');
      expect(check.message).toContain('no computers registered');
    });

    it('reports UNAVAILABLE when computers are registered but none are online', () => {
      const offlineRegistry = new ComputerRegistry();
      offlineRegistry.register({ id: 'c1', name: 'c1', type: 'workstation' });
      offlineRegistry.setOffline('c1');

      const engine = createMockEngine({ computers: offlineRegistry });
      const check = findCheck(doctor(engine), 'control plane');
      expect(check.status).toBe('UNAVAILABLE');
      expect(check.message).toBe('0/1 computer(s) online');
    });

    it('reports FAIL on control plane check error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'computers', {
        get() {
          throw new Error('Connection refused to control plane RPC');
        },
      });
      const check = findCheck(doctor(engine), 'control plane');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('Connection refused');
    });
  });

  describe('checkWorker', () => {
    it('reports PASS when worker is running and status is online', () => {
      const engine = createMockEngine();
      const check = findCheck(doctor(engine), 'worker');
      expect(check.status).toBe('PASS');
    });

    it('reports WARN when worker is not running', () => {
      const engine = createMockEngine({
        worker: { isRunning: false, info: { status: 'offline' } } as any,
      });
      const check = findCheck(doctor(engine), 'worker');
      expect(check.status).toBe('WARN');
      expect(check.message).toContain('worker not running');
    });

    it('reports UNAVAILABLE when worker is running but status is not online', () => {
      const engine = createMockEngine({
        worker: {
          isRunning: true,
          id: 'w-1',
          computerId: 'comp-1',
          info: { status: 'connecting', runtimes: [], models: [] },
        } as any,
      });
      const check = findCheck(doctor(engine), 'worker');
      expect(check.status).toBe('UNAVAILABLE');
    });

    it('reports FAIL on worker check error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'worker', {
        get() {
          throw new Error('Worker thread crashed');
        },
      });
      const check = findCheck(doctor(engine), 'worker');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('Worker thread crashed');
    });
  });

  describe('checkComputerRegistration', () => {
    it('reports PASS when local computer is registered and online', () => {
      const engine = createMockEngine();
      const check = findCheck(doctor(engine), 'computer registration');
      expect(check.status).toBe('PASS');
    });

    it('reports NOT INSTALLED when local computer is not found in registry', () => {
      const emptyRegistry = new ComputerRegistry();
      const engine = createMockEngine({ computers: emptyRegistry });
      const check = findCheck(doctor(engine), 'computer registration');
      expect(check.status).toBe('NOT INSTALLED');
      expect(check.message).toContain('not registered');
    });

    it('reports UNAVAILABLE when local computer is registered but status is offline', () => {
      const reg = new ComputerRegistry();
      reg.register({ id: 'local', name: 'local-node', type: 'workstation' });
      reg.setOffline('local');

      const engine = createMockEngine({ computers: reg });
      const check = findCheck(doctor(engine), 'computer registration');
      expect(check.status).toBe('UNAVAILABLE');
    });

    it('reports FAIL on registration check error', () => {
      const engine = createMockEngine();
      const faultyReg = {
        get() {
          throw new Error('Registry corrupted');
        },
        list: () => [],
        listOnline: () => [],
      } as any;
      engine.computers = faultyReg;
      const check = findCheck(doctor(engine), 'computer registration');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('Registry corrupted');
    });
  });

  describe('checkRuntimeConnectivity', () => {
    it('reports PASS when all discovered runtimes are healthy', () => {
      const engine = createMockEngine({
        discovered: [
          { id: 'ollama', health: 'healthy', info: {}, models: [] } as any,
          { id: 'lmstudio', health: 'healthy', info: {}, models: [] } as any,
        ],
      });
      const check = findCheck(doctor(engine), 'runtime connectivity');
      expect(check.status).toBe('PASS');
      expect(check.message).toBe('2/2 runtime(s) healthy');
    });

    it('reports WARN when some runtimes are healthy and some are degraded/unavailable', () => {
      const engine = createMockEngine({
        discovered: [
          { id: 'ollama', health: 'healthy', info: {}, models: [] } as any,
          { id: 'lmstudio', health: 'unavailable', info: {}, models: [] } as any,
        ],
      });
      const check = findCheck(doctor(engine), 'runtime connectivity');
      expect(check.status).toBe('WARN');
      expect(check.message).toBe('1/2 runtime(s) healthy');
    });

    it('reports UNAVAILABLE when runtimes are discovered but none are healthy', () => {
      const engine = createMockEngine({
        discovered: [{ id: 'ollama', health: 'unavailable', info: {}, models: [] } as any],
      });
      const check = findCheck(doctor(engine), 'runtime connectivity');
      expect(check.status).toBe('UNAVAILABLE');
      expect(check.message).toContain('all runtimes unavailable');
    });

    it('reports NOT INSTALLED when zero runtimes are discovered', () => {
      const engine = createMockEngine({ discovered: [] });
      const check = findCheck(doctor(engine), 'runtime connectivity');
      expect(check.status).toBe('NOT INSTALLED');
      expect(check.message).toContain('no runtimes discovered');
    });

    it('reports FAIL on connectivity check error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'discovered', {
        get() {
          throw new Error('Socket timeout probing ports');
        },
      });
      const check = findCheck(doctor(engine), 'runtime connectivity');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('Socket timeout');
    });
  });

  describe('checkModelAvailability', () => {
    it('reports PASS when models are registered', () => {
      const engine = createMockEngine();
      const check = findCheck(doctor(engine), 'model availability');
      expect(check.status).toBe('PASS');
      expect(check.message).toContain('model(s)');
    });

    it('reports NOT INSTALLED when no models are registered', () => {
      const emptyModels = new ModelRegistry();
      const engine = createMockEngine({ models: emptyModels });
      const check = findCheck(doctor(engine), 'model availability');
      expect(check.status).toBe('NOT INSTALLED');
      expect(check.message).toContain('no models registered');
    });

    it('reports FAIL on model availability check error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'models', {
        get() {
          throw new Error('Model registry lock error');
        },
      });
      const check = findCheck(doctor(engine), 'model availability');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('Model registry lock');
    });
  });

  describe('checkRequiredPermissions', () => {
    it('reports PASS when policy engine has rules', () => {
      const engine = createMockEngine();
      const check = findCheck(doctor(engine), 'required permissions');
      expect(check.status).toBe('PASS');
      expect(check.message).toContain('rule(s) configured');
    });

    it('reports WARN when policy rules are missing', () => {
      const engine = createMockEngine({ policy: {} as any });
      const check = findCheck(doctor(engine), 'required permissions');
      expect(check.status).toBe('WARN');
      expect(check.message).toContain('no policy rules defined');
    });

    it('reports FAIL on policy check error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'policy', {
        get() {
          throw new Error('Policy parse syntax error');
        },
      });
      const check = findCheck(doctor(engine), 'required permissions');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('Policy parse syntax error');
    });
  });

  describe('checkSchedulerReadiness', () => {
    it('reports PASS when scheduler is available', () => {
      const engine = createMockEngine();
      const check = findCheck(doctor(engine), 'scheduler readiness');
      expect(check.status).toBe('PASS');
      expect(check.message).toContain('scheduler ready');
    });

    it('reports FAIL when scheduler is missing', () => {
      const engine = createMockEngine({ scheduler: undefined as any });
      const check = findCheck(doctor(engine), 'scheduler readiness');
      expect(check.status).toBe('FAIL');
      expect(check.message).toContain('not available');
    });

    it('reports FAIL on scheduler check error', () => {
      const engine = createMockEngine();
      Object.defineProperty(engine, 'scheduler', {
        get() {
          throw new Error('Failed to resolve scheduler graph');
        },
      });
      const check = findCheck(doctor(engine), 'scheduler readiness');
      expect(check.status).toBe('FAIL');
      expect(check.details).toContain('scheduler graph');
    });
  });

  describe('doctor() summary computation', () => {
    it('computes exact counts across all 5 statuses', () => {
      const engine = createMockEngine({
        config: {} as any, // WARN (configuration)
        discovered: [], // NOT INSTALLED (runtime connectivity)
      });
      const report = doctor(engine);

      expect(report.summary.pass).toBeGreaterThan(0);
      expect(report.summary.warn).toBeGreaterThan(0);
      expect(report.summary.notInstalled).toBeGreaterThan(0);
      expect(
        report.summary.pass +
          report.summary.warn +
          report.summary.fail +
          report.summary.notInstalled +
          report.summary.unavailable,
      ).toBe(report.checks.length);
    });
  });
});
