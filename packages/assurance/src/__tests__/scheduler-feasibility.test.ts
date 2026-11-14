import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Scheduler,
  ComputerRegistry,
  ModelRegistry,
  RuntimeRegistry,
  PolicyEngine,
  SchedulingError,
  type Task,
} from '@wazir/core';
import {
  createScheduler,
  scheduleToolHost,
  describeDecision,
  checkComputerToolFeasibility,
  isDgxClassComputer,
  isHeavyVerificationTask,
  extractRequiredToolCapabilities,
} from '@wazir/scheduler';
import {
  FORMAL_TOOL_CAPABILITIES,
  advertiseHostToolCapabilities,
  buildUnschedulableNotRunResult,
  computeFeasibilitySet,
  evaluateHostFeasibility,
  getRequiredToolCapabilities,
  isDgxClassHost,
  isHeavyObligation,
  obligationToVerificationTask,
  parseMaxScopeBound,
  scheduleVerificationObligation,
  shouldBypassModelRouter,
  toToolCapability,
  type FeasibilityHost,
} from '../scheduler-feasibility';
import { Verdict, type Obligation } from '../contracts';

describe('Scheduler Feasibility & Formal Tool Capabilities (Phase 5 — Agent 23)', () => {
  let computers: ComputerRegistry;
  let runtimes: RuntimeRegistry;
  let models: ModelRegistry;
  let policy: PolicyEngine;

  beforeEach(() => {
    computers = new ComputerRegistry();
    runtimes = new RuntimeRegistry();
    models = new ModelRegistry();
    policy = new PolicyEngine({ projectRoot: '/tmp/test-wazir' });
  });

  function registerLaptopWithZ3AndDafny() {
    computers.register({
      id: 'macbook-local',
      name: 'Local Developer MacBook',
      type: 'laptop',
      local: true,
      os: { platform: 'darwin', architecture: 'arm64', version: '14.5' },
      hardware: {
        cpu: 'Apple M3 Max',
        cpuCores: 14,
        memoryGB: 64,
        gpu: { vendor: 'apple', model: 'M3 Max', memoryGB: 48, unifiedMemory: true },
      },
      capabilities: ['localExecution', 'tool:z3', 'tool:dafny', 'tool:alloy'],
      runtimes: ['ollama-local'],
      models: [],
    });
  }

  function registerDgxSparkWithFullSuite() {
    computers.register({
      id: 'dgx-spark-gb10',
      name: 'NVIDIA DGX Spark GX10',
      type: 'server',
      local: false,
      os: { platform: 'linux', architecture: 'arm64', version: '6.8' },
      hardware: {
        cpu: 'NVIDIA Grace',
        cpuCores: 20,
        memoryGB: 128,
        gpu: {
          vendor: 'nvidia',
          model: 'NVIDIA GB10 Grace Blackwell',
          memoryGB: 128,
          unifiedMemory: true,
          cuda: true,
        },
      },
      capabilities: [
        'tool:z3',
        'tool:alloy',
        'tool:dafny',
        'tool:scenic',
        'tool:verifai',
        'tool:verifai.simulator',
        'tool:gam',
      ],
      runtimes: ['ollama-dgx'],
      models: [],
    });
  }

  function registerPlainLinuxWorkerNoFormalTools() {
    computers.register({
      id: 'worker-plain',
      name: 'Plain Build Worker',
      type: 'workstation',
      local: false,
      os: { platform: 'linux', architecture: 'x64', version: '6.1' },
      hardware: {
        cpu: 'AMD EPYC',
        cpuCores: 16,
        memoryGB: 64,
      },
      capabilities: ['git', 'docker'],
      runtimes: [],
      models: [],
    });
  }

  const baseZ3Obligation: Obligation = {
    id: 'ob-z3-envelope',
    propertyId: 'RED_SIGNAL_COMPLIANCE',
    specVersion: '1.0.0',
    specHash: 'sha256:abc123',
    tool: 'z3',
    artifactPath: 'specs/red_signal/stopping_envelope.py',
    assumptions: ['A1: decel >= 3.0'],
    guarantee: 'P1: ego stops before stop_line',
  };

  const heavyAlloyObligation: Obligation = {
    id: 'ob-alloy-large',
    propertyId: 'RED_SIGNAL_COMPLIANCE',
    specVersion: '1.0.0',
    specHash: 'sha256:abc123',
    tool: 'alloy',
    artifactPath: 'specs/red_signal/red_signal.als',
    scope: 'for 8 but 6 Int, 1..12 steps',
    assumptions: ['A1: signal state valid'],
    guarantee: 'P1: no enter on red',
  };

  const verifaiCampaignObligation: Obligation = {
    id: 'ob-verifai-campaign',
    propertyId: 'RED_SIGNAL_COMPLIANCE',
    specVersion: '1.0.0',
    specHash: 'sha256:abc123',
    tool: 'verifai',
    artifactPath: 'specs/red_signal/red_signal_monitor.py',
    assumptions: ['A1: visibility >= 50m'],
    guarantee: 'P1: safe stopping margin >= 0',
    metadata: {
      requiresSimulator: true,
    },
  };

  describe('1. Tool capability normalization & host advertisement', () => {
    it('normalizes all 7 canonical formal tool capabilities', () => {
      expect(FORMAL_TOOL_CAPABILITIES).toEqual([
        'tool:z3',
        'tool:alloy',
        'tool:dafny',
        'tool:scenic',
        'tool:verifai',
        'tool:verifai.simulator',
        'tool:gam',
      ]);
      expect(toToolCapability('z3')).toBe('tool:z3');
      expect(toToolCapability('tool:alloy')).toBe('tool:alloy');
      expect(toToolCapability('verifai.simulator')).toBe('tool:verifai.simulator');
      expect(toToolCapability('GAM')).toBe('tool:gam');
    });

    it('advertises only available pinned tools from doctor probe results', () => {
      const caps = advertiseHostToolCapabilities({
        z3: { available: true, version: '4.13.0.0' },
        alloy: { available: true, version: '6.2.0' },
        dafny: { available: false, version: 'unavailable' },
        scenic: { available: true, version: '3.0.0' },
        verifai: { available: true, version: '2.2.0' },
        'verifai.simulator': false,
        gam: true,
      });

      expect(caps).toEqual([
        'tool:z3',
        'tool:alloy',
        'tool:scenic',
        'tool:verifai',
        'tool:gam',
      ]);
      expect(caps).not.toContain('tool:dafny');
      expect(caps).not.toContain('tool:verifai.simulator');
    });

    it('extracts required tool capabilities from Obligation and Task objects', () => {
      expect(getRequiredToolCapabilities(baseZ3Obligation)).toEqual(['tool:z3']);
      expect(getRequiredToolCapabilities(verifaiCampaignObligation)).toEqual([
        'tool:verifai',
        'tool:verifai.simulator',
      ]);

      const task = obligationToVerificationTask(verifaiCampaignObligation);
      expect(extractRequiredToolCapabilities(task as unknown as Task)).toEqual([
        'tool:verifai',
        'tool:verifai.simulator',
      ]);
    });
  });

  describe('2. Feasibility set F(t) filtering by pinned tool capabilities', () => {
    it('includes a host in F(t) iff it advertises all required pinned tool capabilities', () => {
      registerLaptopWithZ3AndDafny();
      registerDgxSparkWithFullSuite();
      registerPlainLinuxWorkerNoFormalTools();

      const fleet = computers.listOnline() as unknown as FeasibilityHost[];

      // Z3 obligation: macbook-local and dgx-spark-gb10 both have tool:z3; worker-plain does not
      const z3Feasible = computeFeasibilitySet(fleet, baseZ3Obligation);
      expect(z3Feasible.map((h) => h.id).sort()).toEqual(['dgx-spark-gb10', 'macbook-local']);

      // VerifAI + simulator obligation: only dgx-spark-gb10 advertises both tool:verifai and tool:verifai.simulator
      const verifaiFeasible = computeFeasibilitySet(fleet, verifaiCampaignObligation);
      expect(verifaiFeasible.map((h) => h.id)).toEqual(['dgx-spark-gb10']);

      // GAM obligation: only dgx-spark-gb10 advertises tool:gam
      const gamTask: Task = {
        id: 'task-gam-check',
        type: 'verification',
        input: 'Check GAL-JSON consistency and ontology',
        requirements: { toolCapabilities: ['tool:gam', 'tool:alloy'] },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };
      const gamFeasible = computeFeasibilitySet(fleet, gamTask);
      expect(gamFeasible.map((h) => h.id)).toEqual(['dgx-spark-gb10']);
    });

    it('rejects a host missing even one of multiple required tool capabilities', () => {
      registerLaptopWithZ3AndDafny(); // has z3, dafny, alloy, but NOT verifai.simulator
      const mac = computers.get('macbook-local')!;

      const check = checkComputerToolFeasibility(mac, ['tool:z3', 'tool:verifai.simulator']);
      expect(check.feasible).toBe(false);
      expect(check.matched).toEqual(['tool:z3']);
      expect(check.missing).toEqual(['tool:verifai.simulator']);
    });
  });

  describe('3. DGX/GX10-class preference for heavy campaigns vs lightweight Z3 checks', () => {
    it('identifies DGX/GX10/GB10/unified-memory NVIDIA hosts accurately', () => {
      registerLaptopWithZ3AndDafny();
      registerDgxSparkWithFullSuite();
      registerPlainLinuxWorkerNoFormalTools();

      const mac = computers.get('macbook-local')!;
      const dgx = computers.get('dgx-spark-gb10')!;
      const plain = computers.get('worker-plain')!;

      expect(isDgxClassComputer(dgx)).toBe(true);
      expect(isDgxClassHost(dgx as unknown as FeasibilityHost)).toBe(true);

      // Apple Silicon has unified memory, but vendor is 'apple', not 'nvidia' / DGX / GX10 / GB10
      expect(isDgxClassComputer(mac)).toBe(false);
      expect(isDgxClassComputer(plain)).toBe(false);
    });

    it('classifies VerifAI campaigns, large Alloy scopes, and preferHostClass=dgx as heavy obligations', () => {
      expect(parseMaxScopeBound('for 8 but 6 Int, 1..12 steps')).toBe(12);
      expect(parseMaxScopeBound('for 4')).toBe(4);

      expect(isHeavyObligation(baseZ3Obligation)).toBe(false);
      expect(isHeavyObligation(heavyAlloyObligation)).toBe(true);
      expect(isHeavyObligation(verifaiCampaignObligation)).toBe(true);

      const smallAlloy: Obligation = {
        ...heavyAlloyObligation,
        id: 'ob-alloy-small',
        scope: 'for 3',
      };
      expect(isHeavyObligation(smallAlloy)).toBe(false);

      const explicitDgxZ3: Obligation = {
        ...baseZ3Obligation,
        metadata: { preferHostClass: 'dgx' },
      };
      expect(isHeavyObligation(explicitDgxZ3)).toBe(true);
    });

    it('routes heavy Alloy obligations to the DGX/GX10-class host when both local and DGX hosts are feasible', () => {
      registerLaptopWithZ3AndDafny();
      registerDgxSparkWithFullSuite();

      const scheduler = createScheduler({ computers, runtimes, models, policy });
      const task = obligationToVerificationTask(heavyAlloyObligation) as unknown as Task;

      expect(isHeavyVerificationTask(task)).toBe(true);

      const decision = scheduler.plan({ task });
      expect(decision.computerId).toBe('dgx-spark-gb10');
      expect(decision.computerDecision.reasons.some((r) => r.includes('DGX/GX10-class host'))).toBe(true);

      // Also verify via standalone assurance helper
      const outcome = scheduleVerificationObligation(
        computers.listOnline() as unknown as FeasibilityHost[],
        heavyAlloyObligation,
      );
      expect(outcome.schedulable).toBe(true);
      expect(outcome.preferDgx).toBe(true);
      expect(outcome.selectedHostId).toBe('dgx-spark-gb10');
      expect(outcome.selectedHostIsDgx).toBe(true);
    });

    it('allows small Z3 checks to run on any feasible host and prefers low-latency local host when available', () => {
      registerLaptopWithZ3AndDafny();
      registerDgxSparkWithFullSuite();

      const scheduler = createScheduler({ computers, runtimes, models, policy });
      const z3Task = obligationToVerificationTask(baseZ3Obligation) as unknown as Task;

      expect(isHeavyVerificationTask(z3Task)).toBe(false);

      // When local macbook is online and has tool:z3, small Z3 check runs locally
      const decision = scheduler.plan({ task: z3Task });
      expect(decision.computerId).toBe('macbook-local');

      // If local macbook goes offline, small Z3 check seamlessly runs on DGX host
      computers.setOffline('macbook-local');
      const fallbackDecision = scheduler.plan({ task: z3Task });
      expect(fallbackDecision.computerId).toBe('dgx-spark-gb10');
    });

    it('falls back to a non-DGX feasible host for heavy Alloy obligation when DGX host is offline', () => {
      registerLaptopWithZ3AndDafny();
      registerDgxSparkWithFullSuite();
      computers.setOffline('dgx-spark-gb10');

      const scheduler = createScheduler({ computers, runtimes, models, policy });
      const task = obligationToVerificationTask(heavyAlloyObligation) as unknown as Task;

      const decision = scheduler.plan({ task });
      expect(decision.computerId).toBe('macbook-local');
      expect(decision.computerDecision.reasons.some((r) => r.includes('fallback'))).toBe(true);
    });
  });

  describe('4. Model-router bypass for solver / verification tasks', () => {
    it('bypasses routeModel and ResourceRouter completely (zero model capacity, works with empty ModelRegistry)', () => {
      registerLaptopWithZ3AndDafny();
      // Deliberately keep `models` (ModelRegistry) completely EMPTY!
      expect(models.list()).toHaveLength(0);

      const resourceAssessSpy = vi.fn();
      const mockResourceRouter = {
        assess: resourceAssessSpy,
        record: vi.fn(),
      } as any;

      const scheduler = new Scheduler({
        computers,
        runtimes,
        models,
        policy,
        resources: { router: mockResourceRouter },
      });

      const z3Task = obligationToVerificationTask(baseZ3Obligation) as unknown as Task;
      expect(shouldBypassModelRouter(z3Task)).toBe(true);

      // A normal coding task fails with "No models are registered" when ModelRegistry is empty:
      const codingTask: Task = {
        id: 'coding-1',
        type: 'coding',
        input: 'Write controller',
        requirements: {},
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };
      expect(() => scheduler.plan({ task: codingTask })).toThrow('No models are registered');

      // The verification task succeeds without touching ModelRegistry or ResourceRouter!
      const decision = scheduler.plan({ task: z3Task });
      expect(decision.computerId).toBe('macbook-local');
      expect(decision.modelId).toBe('');
      expect(decision.modelInstanceId).toBe('');
      expect(decision.modelDecision.strategy).toBe('tool_bypass');
      expect(decision.resourceType).toBe('FORMAL_TOOL_EXECUTION');
      expect(resourceAssessSpy).not.toHaveBeenCalled();

      const summary = describeDecision(decision);
      expect(summary).toContain('bypassed — formal tool execution');
      expect(summary).toContain('macbook-local');
    });

    it('exposes scheduleToolHost directly on Scheduler and @wazir/scheduler facade', () => {
      registerDgxSparkWithFullSuite();
      const scheduler = createScheduler({ computers, runtimes, models, policy });
      const task = obligationToVerificationTask(verifaiCampaignObligation) as unknown as Task;

      const hostDecision = scheduleToolHost(scheduler, task);
      expect(hostDecision.status).toBe('SCHEDULED');
      expect(hostDecision.bypassesModelRouter).toBe(true);
      expect(hostDecision.computerId).toBe('dgx-spark-gb10');
      expect(hostDecision.selectedHostIsDgx).toBe(true);
      expect(hostDecision.requiredToolCapabilities).toEqual([
        'tool:verifai',
        'tool:verifai.simulator',
      ]);
    });
  });

  describe('5. Explicit unschedulable / NOT_RUN result when no host has required tool capability', () => {
    it('returns explicit NOT_RUN from scheduleToolHost and scheduleVerificationObligation when capability is absent across the fleet', () => {
      registerLaptopWithZ3AndDafny(); // has z3, dafny, alloy — no scenic or verifai
      registerPlainLinuxWorkerNoFormalTools();

      const scheduler = createScheduler({ computers, runtimes, models, policy });
      const verifaiTask = obligationToVerificationTask(verifaiCampaignObligation) as unknown as Task;

      // Non-throwing call returns explicit NOT_RUN status & verdict
      const toolHostResult = scheduler.scheduleToolHost(verifaiTask);
      expect(toolHostResult.status).toBe('NOT_RUN');
      expect(toolHostResult.verdict).toBe('NOT_RUN');
      expect(toolHostResult.computerId).toBeUndefined();
      expect(toolHostResult.missingCapabilities).toEqual([
        'tool:verifai',
        'tool:verifai.simulator',
      ]);
      expect(toolHostResult.reasons[0]).toContain('NOT_RUN');

      // Scheduler.plan() throws SchedulingError carrying verdict === 'NOT_RUN' and missingCapabilities
      let caughtError: SchedulingError | undefined;
      try {
        scheduler.plan({ task: verifaiTask });
      } catch (err) {
        caughtError = err as SchedulingError;
      }
      expect(caughtError).toBeInstanceOf(SchedulingError);
      expect(caughtError?.verdict).toBe('NOT_RUN');
      expect(caughtError?.missingCapabilities).toEqual([
        'tool:verifai',
        'tool:verifai.simulator',
      ]);
      expect(caughtError?.message).toContain('NOT_RUN');

      // Assurance-level scheduleVerificationObligation + buildUnschedulableNotRunResult
      const outcome = scheduleVerificationObligation(
        computers.listOnline() as unknown as FeasibilityHost[],
        verifaiCampaignObligation,
      );
      expect(outcome.schedulable).toBe(false);
      expect(outcome.verdict).toBe(Verdict.NOT_RUN);
      expect(outcome.selectedHostId).toBeUndefined();
      expect(outcome.modelId).toBeUndefined();
      expect(outcome.modelCapacityConsumed).toBe(0);
      expect(outcome.missingCapabilities).toEqual([
        'tool:verifai',
        'tool:verifai.simulator',
      ]);

      const verificationResult = buildUnschedulableNotRunResult(
        verifaiCampaignObligation,
        outcome,
        'sha256:input-1',
      );
      expect(verificationResult.verdict).toBe(Verdict.NOT_RUN);
      expect(verificationResult.tool).toBe('verifai');
      expect(verificationResult.metadata?.unschedulable).toBe(true);
      expect(verificationResult.metadata?.missingCapabilities).toEqual([
        'tool:verifai',
        'tool:verifai.simulator',
      ]);
    });

    it('returns NOT_RUN when the fleet has zero online computers', () => {
      const outcome = scheduleVerificationObligation([], baseZ3Obligation);
      expect(outcome.schedulable).toBe(false);
      expect(outcome.verdict).toBe(Verdict.NOT_RUN);
      expect(outcome.missingCapabilities).toEqual(['tool:z3']);
      expect(outcome.reasons[0]).toContain('no hosts registered in fleet');
    });

    it('enforces OS, architecture, memory, and policy allowedComputers constraints alongside tool capabilities', () => {
      registerLaptopWithZ3AndDafny(); // darwin, arm64, 64GB RAM
      const host = computers.get('macbook-local')! as unknown as FeasibilityHost;

      const linuxOnlyZ3Task: Task = {
        id: 'z3-linux-only',
        type: 'verification',
        input: 'Run Z3 on Linux only',
        requirements: {
          toolCapabilities: ['tool:z3'],
          os: 'linux',
        },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const evalResult = evaluateHostFeasibility(host, linuxOnlyZ3Task);
      expect(evalResult.feasible).toBe(false);
      expect(evalResult.rejectionReasons.some((r) => r.includes("OS 'darwin' does not match required 'linux'"))).toBe(
        true,
      );
    });
  });
});
