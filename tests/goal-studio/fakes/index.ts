/**
 * Contract-compliant reference fakes for GoalStudioServices, plus a harness
 * helper (`resolveGoalStudioServices`) that automatically uses the real
 * `createGoalStudioServices` from `apps/api/src/goalStudio/services.js` (or
 * individual real module factories from `@wazir/goals`) when present after
 * integration, falling back to these reference fakes on isolated branches.
 */
import type { GoalStudioDeps, GoalStudioServices, TargetId, TargetTaskExecutor } from '../../../packages/goals/src/contracts.js';
import { FakeGoalController, referenceEligibleTargets, type FakeControllerOptions } from './controller.js';
import { GLOBAL_EVENT_STREAM, MemoryGoalEventLog } from './eventLog.js';
import {
  FIXTURE_FACTS,
  FIXTURE_PATH,
  REPO_ROOT,
  canonicalJson,
  definitionDigest,
  definitionFromRaw,
  fixtureRevisionRecord,
  loadFixtureDefinition,
  parseGraphYaml,
  readFixtureYaml,
  referenceValidate,
  syntheticDefinition,
} from './graphDefinition.js';
import { MemoryGoalGraphStore } from './graphStore.js';
import { MemoryGoalLedgerStore } from './ledgerStore.js';
import {
  FakeGoalGovernance,
  FakeModelRouter,
  FakeRecoveryService,
  approvalScope,
  failureSignature,
  gateError,
  type FakeModel,
  type LimitsResolver,
} from './policyServices.js';
import { MemoryPromptStore } from './promptStore.js';
import { clone, datesToIso, fail, getIso, listIso, mutexFor, pad, sha256Hex, systemClock, type Clock } from './util.js';
import { EXTERNAL_RECORD_FILE, FAKE_VALIDATOR_IDENTITY, FakeTargetTaskExecutor, FakeVerificationService, artifactFile } from './verification.js';
import { YamlLiteError, parseYamlLite } from './yamlLite.js';

export {
  EXTERNAL_RECORD_FILE,
  FAKE_VALIDATOR_IDENTITY,
  FIXTURE_FACTS,
  FIXTURE_PATH,
  FakeGoalController,
  FakeGoalGovernance,
  FakeModelRouter,
  FakeRecoveryService,
  FakeTargetTaskExecutor,
  FakeVerificationService,
  GLOBAL_EVENT_STREAM,
  MemoryGoalEventLog,
  MemoryGoalGraphStore,
  MemoryGoalLedgerStore,
  MemoryPromptStore,
  REPO_ROOT,
  YamlLiteError,
  approvalScope,
  artifactFile,
  canonicalJson,
  clone,
  datesToIso,
  definitionDigest,
  definitionFromRaw,
  fail,
  failureSignature,
  fixtureRevisionRecord,
  gateError,
  getIso,
  listIso,
  loadFixtureDefinition,
  mutexFor,
  pad,
  parseGraphYaml,
  parseYamlLite,
  readFixtureYaml,
  referenceEligibleTargets,
  referenceValidate,
  sha256Hex,
  syntheticDefinition,
  systemClock,
  type Clock,
  type FakeControllerOptions,
  type FakeModel,
  type LimitsResolver,
};

export const DEFAULT_FAKE_MODELS: readonly FakeModel[] = [
  {
    modelId: 'local-qwen2.5-coder:32b',
    runtimeId: 'ollama-local',
    computerId: 'dgx-node-01',
    hosted: false,
    capabilities: ['text-generation', 'formal-verification', 'code-generation'],
    costUsd: 0,
    ready: true,
  },
  {
    modelId: 'local-deepseek-r1:14b',
    runtimeId: 'ollama-local',
    computerId: 'mac-studio-01',
    hosted: false,
    capabilities: ['text-generation'],
    costUsd: 0,
    ready: true,
  },
  {
    modelId: 'hosted-claude-sonnet-4',
    runtimeId: 'anthropic',
    hosted: true,
    capabilities: ['text-generation', 'formal-verification', 'code-generation'],
    costUsd: 0.25,
    ready: true,
  },
  {
    modelId: 'unready-local-llama',
    runtimeId: 'ollama-local',
    hosted: false,
    capabilities: ['text-generation'],
    costUsd: 0,
    ready: false,
  },
];

export interface CreateFakeServicesOptions extends GoalStudioDeps {
  models?: FakeModel[];
  executor?: TargetTaskExecutor;
  failFirst?: Record<TargetId, number>;
  omitArtifact?: Record<TargetId, string>;
  autoAdvance?: boolean;
  autoStart?: boolean;
  holderId?: string;
  leaseTtlMs?: number;
  seedPrompts?: boolean;
}

export interface FakeGoalStudioBundle {
  services: GoalStudioServices;
  fakes: {
    graphs: MemoryGoalGraphStore;
    ledger: MemoryGoalLedgerStore;
    events: MemoryGoalEventLog;
    controller: FakeGoalController;
    verification: FakeVerificationService;
    recovery: FakeRecoveryService;
    prompts: MemoryPromptStore;
    router: FakeModelRouter;
    governance: FakeGoalGovernance;
    executor: FakeTargetTaskExecutor;
  };
  mode: 'fakes' | 'real';
}

export async function createFakeGoalStudioServices(opts: CreateFakeServicesOptions): Promise<FakeGoalStudioBundle> {
  const clock = opts.clock ?? systemClock;
  const graphs = new MemoryGoalGraphStore(opts.store, { clock });
  const ledger = new MemoryGoalLedgerStore(opts.store, { clock });
  const events = new MemoryGoalEventLog(opts.store, { clock });
  const prompts = new MemoryPromptStore(opts.store, { clock });
  if (opts.seedPrompts !== false) {
    await prompts.seedFromGraphYaml(readFixtureYaml());
  }

  // Keep synchronous lookup of pinned graph limits for governance & recovery,
  // tracking any custom revisions stored in `graphs`.
  const defaultDef = loadFixtureDefinition();
  const pinnedLimits = new Map<string, ReturnType<LimitsResolver>>();
  const origImport = graphs.importYaml.bind(graphs);
  graphs.importYaml = async (projectId, yaml, actor) => {
    const res = await origImport(projectId, yaml, actor);
    if (res.record) {
      pinnedLimits.set(`${res.record.graphId}@${res.record.revision}`, res.record.definition.constitution.resourceLimits);
    }
    return res;
  };
  const origCreateRev = graphs.createRevision.bind(graphs);
  graphs.createRevision = async (graphId, definition, actor, parentRevision) => {
    const rec = await origCreateRev(graphId, definition, actor, parentRevision);
    pinnedLimits.set(`${rec.graphId}@${rec.revision}`, rec.definition.constitution.resourceLimits);
    return rec;
  };
  const limitsFor: LimitsResolver = (run) => pinnedLimits.get(`${run.graphId}@${run.graphRevision}`) ?? defaultDef.constitution.resourceLimits;

  const router = new FakeModelRouter(opts.models ? [...opts.models] : [...DEFAULT_FAKE_MODELS], { clock });
  const governance = new FakeGoalGovernance(opts.store, limitsFor);
  const recovery = new FakeRecoveryService(limitsFor);
  const verification = new FakeVerificationService(opts.store, { clock });
  const fakeExecutor = new FakeTargetTaskExecutor({ failFirst: opts.failFirst, omitArtifact: opts.omitArtifact });
  const executor = opts.executor ?? fakeExecutor;

  const baseServices: Omit<GoalStudioServices, 'controller'> = {
    graphs,
    ledger,
    events,
    verification,
    recovery,
    prompts,
    router,
    governance,
    executor,
  };

  const controller = new FakeGoalController({
    services: baseServices,
    workspaceRoot: opts.workspaceRoot,
    holderId: opts.holderId,
    leaseTtlMs: opts.leaseTtlMs,
    clock,
    autoAdvance: opts.autoAdvance ?? false,
    autoStart: opts.autoStart ?? false,
  });

  const services: GoalStudioServices = { ...baseServices, controller };
  return {
    services,
    fakes: {
      graphs,
      ledger,
      events,
      controller,
      verification,
      recovery,
      prompts,
      router,
      governance,
      executor: fakeExecutor,
    },
    mode: 'fakes',
  };
}

/**
 * Attempts to dynamically import the coordinator-wired `createGoalStudioServices`
 * from `apps/api/src/goalStudio/services.js` unless `WAZIR_GOAL_STUDIO_FORCE_FAKES=1`.
 * When `createGoalStudioServices` is not yet wired (or leaves any service slot undefined),
 * falls back cleanly to the contract-compliant reference fakes.
 */
export async function resolveGoalStudioServices(opts: CreateFakeServicesOptions): Promise<FakeGoalStudioBundle> {
  const fakeBundle = await createFakeGoalStudioServices(opts);
  if (process.env.WAZIR_GOAL_STUDIO_FORCE_FAKES === '1') {
    return fakeBundle;
  }
  try {
    const modPath = '../../../apps/api/src/goalStudio/services.js';
    const mod = (await import(/* @vite-ignore */ modPath)) as {
      createGoalStudioServices?: (deps: GoalStudioDeps & Record<string, unknown>) => Promise<Partial<GoalStudioServices>> | Partial<GoalStudioServices>;
    };
    if (typeof mod.createGoalStudioServices === 'function') {
      const real = await mod.createGoalStudioServices({
        store: opts.store,
        clock: opts.clock,
        workspaceRoot: opts.workspaceRoot,
        executor: opts.executor ?? fakeBundle.fakes.executor,
      });
      if (real && real.graphs && real.ledger && real.events && real.controller && real.verification && real.recovery && real.prompts && real.router && real.governance) {
        return {
          services: {
            graphs: real.graphs,
            ledger: real.ledger,
            events: real.events,
            controller: real.controller,
            verification: real.verification,
            recovery: real.recovery,
            prompts: real.prompts,
            router: real.router,
            governance: real.governance,
            executor: real.executor ?? opts.executor ?? fakeBundle.fakes.executor,
          },
          fakes: fakeBundle.fakes,
          mode: 'real',
        };
      }
    }
  } catch {
    // Coordinator has not yet added apps/api/src/goalStudio/services.ts on this branch.
  }
  return fakeBundle;
}
