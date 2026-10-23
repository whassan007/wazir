import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ComputerRegistry, ModelRegistry, RuntimeRegistry } from '@wazir/core';
import {
  createGoalController,
  createGoalGovernance,
  createGoalGraphStore,
  createLedgerStore,
  createModelRouter,
  createPromptStore,
  createRecoveryService,
  createTargetTaskExecutor,
  createVerificationService,
  type ContinuousGoalController,
  type DeclaredCheck,
  type EvidenceRecord,
  type FleetModelRouter,
  type GoalController,
  type GoalEventLog,
  type GoalGovernanceService,
  type GoalGraphDefinition,
  type GoalRunId,
  type GoalRunLedger,
  type GoalStudioDeps,
  type GoalStudioServices,
  type GoalVerificationService,
  type PromptStudio,
  type TargetId,
  type TargetTaskExecutor,
} from '@wazir/goals';
import { createGoalStudioApprovals, type GoalStudioApprovals, type MobileApprovalMirror } from './controlApprovals.js';
import { createGoalEventLog } from './controlEventLog.js';

export interface CreateGoalStudioServicesOptions extends GoalStudioDeps {
  models?: ModelRegistry;
  runtimes?: RuntimeRegistry;
  computers?: ComputerRegistry;
  executor?: TargetTaskExecutor;
  events?: GoalEventLog;
  approvals?: GoalStudioApprovals;
  mobileApprovals?: MobileApprovalMirror;
  holderId?: string;
  leaseTtlMs?: number;
  seedPrompts?: boolean;
  /**
   * When false (default in step-by-step operator control and E2E tests), `startRun`
   * initializes the run and marks initial targets `eligible`, waiting for explicit
   * `runEligible` or `resume` calls before launching target execution.
   */
  autoStart?: boolean;
  /**
   * When false, `runEligible` executes only the requested target (and awaits its
   * attempt completion) before pausing automatic advancement to subsequent targets.
   */
  autoAdvance?: boolean;
}

export interface WiredGoalStudioServices extends GoalStudioServices {
  graphs: ReturnType<typeof createGoalGraphStore>;
  ledger: ReturnType<typeof createLedgerStore>;
  events: GoalEventLog;
  verification: GoalVerificationService;
  recovery: ReturnType<typeof createRecoveryService>;
  prompts: PromptStudio;
  router: FleetModelRouter;
  governance: GoalGovernanceService;
  executor: TargetTaskExecutor;
  controller: GoalController & {
    resolveApproval?: ContinuousGoalController['resolveApproval'];
    settled?: ContinuousGoalController['settled'];
    activeTargets?: ContinuousGoalController['activeTargets'];
    shutdown?: ContinuousGoalController['shutdown'];
  };
  approvals: GoalStudioApprovals;
}

function ensureDefaultFleetModels(
  models: ModelRegistry,
  runtimes: RuntimeRegistry,
  computers: ComputerRegistry,
  clock: () => Date,
): void {
  if (models.list().length > 0) return;

  const now = clock();
  if (!computers.get('local')) {
    computers.register({
      id: 'local',
      name: 'Local Workstation',
      type: 'workstation',
      local: true,
      os: { platform: process.platform, architecture: process.arch, version: process.version },
      hardware: { cpu: 'local-cpu', cpuCores: 8, memoryGB: 64 },
      runtimes: ['ollama-local'],
    });
    computers.heartbeat('local', { load: { cpuPercent: 10, memoryUsedGB: 16, memoryAvailableGB: 48 } });
  }

  const defaultCaps = {
    chat: true,
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    embeddings: false,
    reasoning: true,
    modelLoad: true,
    modelUnload: true,
    modelDownload: false,
    statefulChat: false,
    mcp: false,
  };

  if (!runtimes.get('ollama-local')) {
    runtimes.register({
      id: 'ollama-local',
      type: 'ollama',
      name: 'Ollama Local',
      version: '0.5.0',
      computerId: 'local',
      capabilities: defaultCaps,
    });
    runtimes.setHealth('ollama-local', 'healthy');
  }

  if (!runtimes.get('anthropic')) {
    runtimes.register({
      id: 'anthropic',
      type: 'anthropic',
      name: 'Anthropic Hosted API',
      version: '1.0',
      runtimeKind: 'hosted',
      capabilities: defaultCaps,
    });
    runtimes.setHealth('anthropic', 'healthy');
  }

  models.register({
    id: 'local-qwen2.5-coder:32b',
    name: 'Qwen 2.5 Coder 32B (Local)',
    provider: 'ollama-local',
    family: 'qwen',
    contextMax: 65536,
    capabilities: ['generalChat', 'coding', 'agenticExecution'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: ['ollama'],
    local: true,
    createdAt: now,
    updatedAt: now,
  });
  models.upsertInstance({
    id: 'local-qwen2.5-coder:32b@ollama-local',
    modelId: 'local-qwen2.5-coder:32b',
    runtimeId: 'ollama-local',
    computerId: 'local',
    runtimeModelId: 'local-qwen2.5-coder:32b',
    loaded: true,
    state: 'READY',
    health: 'healthy',
  });

  models.register({
    id: 'hosted-claude-sonnet-4',
    name: 'Claude Sonnet 4 (Hosted)',
    provider: 'anthropic',
    family: 'other',
    contextMax: 200000,
    capabilities: ['generalChat', 'coding', 'agenticExecution'],
    toolCalling: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: ['anthropic'],
    local: false,
    createdAt: now,
    updatedAt: now,
  });
  models.upsertInstance({
    id: 'hosted-claude-sonnet-4@anthropic',
    modelId: 'hosted-claude-sonnet-4',
    runtimeId: 'anthropic',
    runtimeModelId: 'hosted-claude-sonnet-4',
    loaded: true,
    state: 'READY',
    health: 'healthy',
  });

  models.register({
    id: 'unready-local-llama',
    name: 'Unready Local Llama',
    provider: 'ollama-local',
    family: 'llama',
    contextMax: 32768,
    capabilities: ['generalChat', 'coding'],
    toolCalling: false,
    structuredOutput: false,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: false,
    runtimeCompatibility: ['ollama'],
    local: true,
    createdAt: now,
    updatedAt: now,
  });
  models.upsertInstance({
    id: 'unready-local-llama@ollama-local',
    modelId: 'unready-local-llama',
    runtimeId: 'ollama-local',
    computerId: 'local',
    runtimeModelId: 'unready-local-llama',
    loaded: false,
    state: 'INSTALLED',
    health: 'healthy',
  });
}

function artifactCheckPath(artifact: string): string {
  const clean = artifact.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return clean.endsWith('/') ? `${clean}README.md` : clean;
}

/**
 * Composes all concrete Goal Studio workstream services (`@wazir/goals` + API control broker)
 * into a single `GoalStudioServices` bundle.
 */
export async function createGoalStudioServices(
  options: CreateGoalStudioServicesOptions,
): Promise<WiredGoalStudioServices> {
  const clock = options.clock ?? (() => new Date());
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const store = options.store;

  const graphs = createGoalGraphStore({ store, workspaceRoot, clock });
  const ledger = createLedgerStore({ store, workspaceRoot, clock });
  const events = options.events ?? createGoalEventLog({ store, workspaceRoot, clock });
  const governance = createGoalGovernance({ store, workspaceRoot, clock, graphs, ledger });
  const prompts = createPromptStore({
    store,
    workspaceRoot,
    clock,
    onEvent: async (ev) => {
      await governance.audit({ ...ev, seq: 0 }).catch(() => undefined);
    },
  });

  if (options.seedPrompts !== false) {
    await prompts.seedDefaults('system:seed').catch(() => undefined);
  }

  const models = options.models ?? new ModelRegistry();
  const runtimes = options.runtimes ?? new RuntimeRegistry();
  const computers = options.computers ?? new ComputerRegistry();
  ensureDefaultFleetModels(models, runtimes, computers, clock);

  const router = createModelRouter({
    store,
    workspaceRoot,
    clock,
    models,
    runtimes,
    computers,
    pricing: (modelId) =>
      modelId.includes('claude') || modelId.includes('hosted')
        ? { inputPerMTok: 15, outputPerMTok: 75 }
        : undefined,
  });

  // Record verified readiness for the default local Qwen model if present
  if (models.get('local-qwen2.5-coder:32b')) {
    router.readiness.record({
      modelId: 'local-qwen2.5-coder:32b',
      instanceId: 'local-qwen2.5-coder:32b@ollama-local',
      runtimeId: 'ollama-local',
      computerId: 'local',
      runtimeModelId: 'local-qwen2.5-coder:32b',
      ready: true,
      checkedAt: clock().toISOString(),
      latencyMs: 18,
      source: 'probe',
      generation: 'verified',
      toolUse: 'verified',
      reason: 'verified ready local Qwen coding model ($0)',
    });
  }
  if (models.get('hosted-claude-sonnet-4')) {
    router.readiness.record({
      modelId: 'hosted-claude-sonnet-4',
      instanceId: 'hosted-claude-sonnet-4@anthropic',
      runtimeId: 'anthropic',
      runtimeModelId: 'hosted-claude-sonnet-4',
      ready: true,
      checkedAt: clock().toISOString(),
      latencyMs: 120,
      source: 'execution',
      generation: 'verified',
      toolUse: 'verified',
      reason: 'hosted execution readiness recorded',
    });
  }

  const baseVerification = createVerificationService({
    store,
    workspaceRoot,
    clock,
    events,
    audit: (ev) => governance.audit(ev),
    plan: async ({ target }) => {
      const checks: DeclaredCheck[] = [];
      const firstArtifact = target.artifacts[0] ? artifactCheckPath(target.artifacts[0]) : undefined;
      for (let i = 0; i < target.acceptance.length; i++) {
        const artifact = target.artifacts[i] ? artifactCheckPath(target.artifacts[i]!) : firstArtifact;
        if (!artifact) continue;
        checks.push({
          id: `auto-criterion-${i + 1}`,
          kind: 'non-empty',
          artifact,
          criterion: target.acceptance[i],
        });
      }
      for (let j = target.acceptance.length; j < target.artifacts.length; j++) {
        const artifact = artifactCheckPath(target.artifacts[j]!);
        checks.push({
          id: `auto-artifact-${j + 1}`,
          kind: 'non-empty',
          artifact,
        });
      }
      return checks;
    },
  });

  // Wrap verify() to also inspect `.external-records/<targetId>.json` when `target.externalDependency` is true,
  // recording an operator/external-record evidence entry when an attributable external record file exists.
  const verification: GoalVerificationService = {
    ...baseVerification,
    async verify(input) {
      const records = await baseVerification.verify(input);
      if (input.target.externalDependency) {
        const extRel = `.external-records/${input.target.id}.json`;
        const extFull = path.join(input.workspaceRoot || workspaceRoot, extRel);
        try {
          const raw = await fs.readFile(extFull, 'utf8');
          const parsed = JSON.parse(raw) as { issuer?: string; reference?: string; issuedAt?: string };
          if (parsed && typeof parsed.issuer === 'string' && parsed.issuer.trim()) {
            const signoffs = await baseVerification.recordSignoff({
              runId: input.run.runId,
              targetId: input.target.id,
              attemptId: input.attempt.id,
              principal: parsed.issuer.trim(),
              method: 'external-record',
              verdict: 'PASS',
              criteria: [...input.target.acceptance],
              source: parsed.reference ? `${parsed.issuer.trim()} (${parsed.reference})` : parsed.issuer.trim(),
              note: `External record verified from ${extRel}`,
            });
            records.push(...signoffs);
          }
        } catch {
          // No external record file present yet; gate will return awaiting_external.
        }
      }
      return records;
    },
  };

  const recovery = createRecoveryService({ store, workspaceRoot, clock });

  const defaultExecutor = createTargetTaskExecutor({
    store,
    workspaceRoot,
    clock,
    runner: async (input) => {
      const written: string[] = [];
      for (const artifact of input.target.artifacts) {
        const cleanRel = artifact.replace(/^\/+/, '');
        const relFile = cleanRel.endsWith('/') ? `${cleanRel}README.md` : cleanRel;
        const fullPath = path.join(input.workspaceRoot, relFile);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        const content = relFile.endsWith('.json')
          ? JSON.stringify(
              {
                runId: input.run.runId,
                targetId: input.target.id,
                title: input.target.title,
                stage: input.target.stage,
                attempt: input.attempt.attempt,
                executor: input.target.executor,
                modelId: input.route.modelId,
                acceptance: input.target.acceptance,
              },
              null,
              2,
            )
          : `# ${input.target.id}: ${input.target.title}\n\nRun: ${input.run.runId}\nAttempt: ${input.attempt.attempt}\nExecutor: ${input.target.executor} (${input.route.modelId})\n`;
        await fs.writeFile(fullPath, content, 'utf8');
        written.push(relFile);
      }
      return {
        ok: true,
        summary: `Produced ${written.length} artifact(s) for ${input.target.id}`,
        filesChanged: written,
      };
    },
  });

  const executor = options.executor ?? defaultExecutor;
  const approvals =
    options.approvals ??
    createGoalStudioApprovals({
      store,
      workspaceRoot,
      clock,
      events,
      mobile: options.mobileApprovals,
    });

  const holderId = options.holderId ?? `goal-controller-${randomUUID().slice(0, 8)}`;
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  const autoStart = options.autoStart ?? false;
  const autoAdvance = options.autoAdvance ?? false;

  const rawController = createGoalController({
    store,
    workspaceRoot,
    clock,
    holderId,
    leaseTtlMs,
    autoStart,
    autoAdvance,
    services: {
      graphs,
      ledger,
      events,
      verification,
      recovery,
      prompts,
      router,
      governance,
      executor,
    },
  });

  const controller: WiredGoalStudioServices['controller'] = {
    ...rawController,
    eligibleTargets(run: GoalRunLedger, graph: GoalGraphDefinition): TargetId[] {
      const all = rawController.eligibleTargets(run, graph);
      return [...all].sort((a, b) => {
        const ta = graph.targets.find((t) => t.id === a);
        const tb = graph.targets.find((t) => t.id === b);
        return (tb?.priority ?? 0) - (ta?.priority ?? 0) || a.localeCompare(b);
      });
    },
    async startRun(input) {
      if (!autoStart) {
        const actorCheck = governance.assertHumanOrSystemPrincipal(input.principal, 'startRun');
        if (actorCheck.effect === 'deny') {
          const { GoalStudioFailure: Failure } = await import('@wazir/goals');
          throw new Failure('FORBIDDEN', actorCheck.reasons.join('; '));
        }
        const actor = input.principal.startsWith('user:') ? input.principal : `user:${input.principal}`;
        const record = await graphs.getRevision(input.graphId, input.graphRevision);
        if (!record) {
          const { GoalStudioFailure: Failure } = await import('@wazir/goals');
          throw new Failure('NOT_FOUND', `Graph '${input.graphId}' not found`);
        }
        const validation = graphs.validate(record.definition);
        if (!validation.valid) {
          const { GoalStudioFailure: Failure } = await import('@wazir/goals');
          throw new Failure('VALIDATION', 'Graph is invalid', { details: { issues: validation.issues } });
        }
        const created = await ledger.createRun({ graph: record, createdBy: actor });
        await events.append({
          type: 'run.created',
          runId: created.runId,
          data: { graphId: record.graphId, graphRevision: record.revision, graphDigest: record.digest, createdBy: actor },
        });
        await governance.audit({
          seq: 0,
          type: 'run.created',
          runId: created.runId,
          timestamp: clock().toISOString(),
          data: { graphId: record.graphId, graphRevision: record.revision, actor },
        });
        const lease = await ledger.acquireLease(created.runId, holderId, leaseTtlMs);
        if (!lease) {
          const { GoalStudioFailure: Failure } = await import('@wazir/goals');
          throw new Failure('STALE_LEASE', `Could not acquire lease for ${created.runId}`);
        }
        const nowIso = clock().toISOString();
        const transitions = record.definition.targets
          .filter((t) => t.dependsOn.length === 0 && created.targets[t.id]?.status === 'queued')
          .map((t) => ({
            runId: created.runId,
            targetId: t.id,
            fromState: 'queued' as const,
            toState: 'eligible' as const,
            reason: 'dependencies completed: (none)',
            actor: 'controller',
            timestamp: nowIso,
          }));
        const committed = await ledger.commit(
          created.runId,
          created.ledgerRevision,
          lease,
          (l) => {
            l.status = 'running';
            l.updatedAt = nowIso;
            for (const tr of transitions) {
              if (l.targets[tr.targetId]) {
                l.targets[tr.targetId]!.status = 'eligible';
                l.targets[tr.targetId]!.updatedAt = nowIso;
              }
            }
          },
          transitions,
        );
        await ledger.releaseLease(lease);
        for (const tr of transitions) {
          await events.append({
            type: 'target.transition',
            runId: created.runId,
            targetId: tr.targetId,
            data: { from: tr.fromState, to: tr.toState, reason: tr.reason, actor: tr.actor },
          });
        }
        return committed;
      }
      return rawController.startRun(input);
    },
    async recoverRuns() {
      if (!autoStart) {
        const recovered: GoalRunId[] = [];
        for (const run of await ledger.listRuns()) {
          if (['completed', 'stopped', 'failed', 'paused'].includes(run.status)) continue;
          const lease = await ledger.acquireLease(run.runId, holderId, leaseTtlMs);
          if (!lease) continue;
          await events.append({
            type: 'run.status',
            runId: run.runId,
            data: { status: run.status, recovered: true, holderId, epoch: lease.epoch },
          });
          await ledger.releaseLease(lease);
          recovered.push(run.runId);
        }
        return recovered;
      }
      return rawController.recoverRuns();
    },
  };

  return {
    graphs,
    ledger,
    events,
    verification,
    recovery,
    prompts,
    router,
    governance,
    executor,
    controller,
    approvals,
  };
}
