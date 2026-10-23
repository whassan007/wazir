import { createHash } from 'node:crypto';
import { PolicyEngine, type PolicyEngineOptions, type PolicyRule } from '@wazir/core';
import { sanitizeUntrustedOutput } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  type GoalConstitution,
  type GoalGovernance,
  type GoalGraphStore,
  type GoalLedgerStore,
  type GoalRunId,
  type GoalRunLedger,
  type GoalStudioDeps,
  type GoalStudioEvent,
  type GoalStudioEventType,
  type GoalTarget,
  type GovernanceDecision,
  type ModelRouteDecision,
  type ResourceLimits,
  type TargetId,
} from '../contracts.js';

export const DEFAULT_CONSTITUTION_INVARIANTS: readonly string[] = [
  'no_fabrication',
  'no_unverified_completion',
  'no_wet_lab_or_hazardous_protocols',
  'no_unapproved_external_submission',
  'no_unbounded_retry_loops',
  'preserve_reproducibility_artifacts',
] as const;

export const DEFAULT_CONSTITUTION_NEEDS_APPROVAL: readonly string[] = [
  'paid_api_usage',
  'destructive_changes',
  'protected_branch_merge',
  'external_submission',
  'production_deployment',
  'policy_mutation',
  'legal_or_diplomatic_commitment',
] as const;

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = {
  maxTasksPerRun: 12,
  maxRepairsPerTask: 3,
  maxSameActionNoProgress: 2,
  maxRunMinutes: 90,
  hostedSpendUsd: 0,
  localModelFirst: true,
  maxConcurrentWritersPerWorktree: 1,
  maxConcurrentTargets: 1,
};

export const DEFAULT_GOAL_CONSTITUTION: Readonly<GoalConstitution> = {
  objectiveOwner: 'human',
  invariants: [...DEFAULT_CONSTITUTION_INVARIANTS],
  resourceLimits: { ...DEFAULT_RESOURCE_LIMITS },
  allowedUnattended: [
    'local read-only research and analysis of authorized sources',
    'drafting documents, code and formal models in isolated workspaces',
    'running read-only analysis and tests in a configured sandbox',
    'writing evidence manifests and updating the target ledger',
  ],
  needsApproval: [...DEFAULT_CONSTITUTION_NEEDS_APPROVAL],
};

export interface GoalAuditRecord {
  /** Monotonic zero-padded sequence key (`0000000001`). */
  seq: string;
  /** Numeric sequence number starting at 1. */
  seqNumber: number;
  /** ISO-8601 timestamp when persisted. */
  recordedAt: string;
  /** Redacted GoalStudioEvent payload. */
  event: GoalStudioEvent;
  /** Previous audit record digest (or `'GENESIS'` for seq 1) for tamper-evidence. */
  prevDigest: string;
  /** SHA-256 hex digest of canonical JSON `{ seq, recordedAt, prevDigest, event }`. */
  digest: string;
}

export interface GoalAuditQuery {
  runId?: GoalRunId;
  targetId?: TargetId;
  type?: GoalStudioEventType | string;
  effect?: 'allow' | 'ask' | 'deny';
  principal?: string;
  afterSeq?: number;
  limit?: number;
}

export interface GoalPreflightInput {
  run: GoalRunLedger;
  target: GoalTarget;
  route?: ModelRouteDecision;
  principal: string;
  /** Optional explicit constitution; otherwise resolved from graphs store or default constitution. */
  constitution?: GoalConstitution;
  /** Optional specific action name (defaults to `execute:${target.executor || target.id}`). */
  action?: string;
  /** Optional explicit attempt number (defaults to `ledgerEntry.attempts + 1`). */
  attempt?: number;
  /** Optional additional metadata or proposed parameters to inspect against invariants. */
  context?: Record<string, unknown>;
}

export interface GoalPolicySummary {
  constitution: GoalConstitution;
  invariants: readonly string[];
  needsApproval: readonly string[];
  resourceLimits: ResourceLimits;
  policyRules: PolicyRule[];
  modelPrincipalsForbidden: true;
}

export interface GoalGovernanceService extends GoalGovernance {
  preflight(input: GoalPreflightInput): Promise<GovernanceDecision>;
  authorizeSpend(run: GoalRunLedger, amountUsd: number, constitution?: GoalConstitution): GovernanceDecision;
  audit(event: GoalStudioEvent): Promise<void>;
  appendAudit(event: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { seq?: number; timestamp?: string }): Promise<GoalAuditRecord>;
  queryAudit(query?: GoalAuditQuery): Promise<GoalAuditRecord[]>;
  verifyAuditChain(): Promise<{ valid: boolean; count: number; brokenAtSeq?: string; reason?: string }>;
  getPolicySummary(input?: { run?: GoalRunLedger; constitution?: GoalConstitution }): Promise<GoalPolicySummary>;
  /** Validates that a principal is a human/operator and never an executing model/agent. */
  assertHumanOrSystemPrincipal(principal: string, operation?: string): GovernanceDecision;
}

export interface CreateGoalGovernanceDeps extends GoalStudioDeps {
  graphs?: GoalGraphStore;
  ledger?: GoalLedgerStore;
  defaultConstitution?: GoalConstitution;
  policyOptions?: PolicyEngineOptions;
}

const MODEL_OR_AGENT_PRINCIPAL_RE =
  /^(?:model|agent|executor|llm|assistant|autonomous|subagent|tool|worker-model|bot)(?:[:/._-]|$)/i;

const SELF_AUTH_OR_POLICY_MUTATION_RE =
  /\b(?:self[_-]?approv\w*|self[_-]?authoriz\w*|self[_-]?certif\w*|mutate[_-]?constitution|edit[_-]?constitution|override[_-]?constitution|bypass[_-]?policy|disable[_-]?policy|raise[_-]?limit\w*|raise[_-]?budget|increase[_-]?spend|alter[_-]?permission\w*|grant[_-]?permission\w*|modify[_-]?rubric|redefine[_-]?objective|auto[_-]?merge[_-]?protected)\b/i;

const WET_LAB_OR_HAZARD_RE =
  /\b(?:wet[_-\s]?lab|pathogen\w*|bioweapon\w*|biological[_-\s]?agent\w*|chemical[_-\s]?weapon\w*|nerve[_-\s]?agent\w*|toxin[_-\s]?synthesis|viral[_-\s]?gain[_-\s]?of[_-\s]?function|gain[_-\s]?of[_-\s]?function|hazardous[_-\s]?material[_-\s]?synthesis|explosive[_-\s]?synthesis|radiological[_-\s]?dispersal|cbrn|anthrax|ricin|sarin|vx[_-\s]?gas|ebola[_-\s]?culture|live[_-\s]?virus[_-\s]?culture|biosafety[_-\s]?level[_-\s]?[34]|bsl[_-\s]?[34])\b/i;

const FABRICATION_RE =
  /\b(?:fabricat(?:e|ed|ing)\s+(?:evidence|proof|data|citation|solver|result|verdict|endorsement|adoption)|invent(?:ed|ing)?\s+(?:endorsement|citation|ratification|solver\s+output|proof)|fake[_-\s]?(?:evidence|proof|solver|verification|signature|endorsement)|spoof[_-\s]?(?:validator|verifier|evidence|signature)|suppress[_-\s]?counterexample\w*|forged?[_-\s]?(?:evidence|attestation|record))\b/i;

const UNVERIFIED_COMPLETION_RE =
  /\b(?:unverified[_-\s]?completion|mark[_-\s]?completed?[_-\s]?without[_-\s]?(?:evidence|verification|check)|skip[_-\s]?(?:independent[_-\s]?)?verif(?:y|ication)|bypass[_-\s]?acceptance[_-\s]?gate|self[_-\s]?certif(?:y|ied)[_-\s]?completion|assume[_-\s]?success)\b/i;

const DESTRUCTIVE_REPRODUCIBILITY_RE =
  /\b(?:delete[_-\s]?(?:audit|evidence|ledger|reproducibility|provenance|history)|purge[_-\s]?(?:audit|evidence|ledger|history)|wipe[_-\s]?(?:evidence|ledger|audit)|overwrite[_-\s]?history|truncate[_-\s]?(?:audit|ledger))\b/i;

const NEEDS_APPROVAL_ACTION_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  {
    category: 'external_submission',
    pattern: /\b(?:external[_-\s]?submission|submit[_-\s]?to[_-\s]?(?:journal|standards|venue|regulator|third[_-\s]?party)|publish[_-\s]?external\w*|send[_-\s]?(?:email|outreach|message)|public[_-\s]?(?:release|announcement|commitment)|standards[_-\s]?submission)\b/i,
  },
  {
    category: 'protected_branch_merge',
    pattern: /\b(?:merge[_-\s]?to[_-\s]?protected|protected[_-\s]?branch|push[_-\s]?(?:main|master|production|release)|release[_-\s]?branch)\b/i,
  },
  {
    category: 'production_deployment',
    pattern: /\b(?:deploy[_-\s]?prod\w*|production[_-\s]?deploy\w*)\b/i,
  },
  {
    category: 'destructive_changes',
    pattern: /\b(?:irreversible|destructive[_-\s]?change\w*|force[_-\s]?push|drop[_-\s]?database)\b/i,
  },
  {
    category: 'legal_or_diplomatic_commitment',
    pattern: /\b(?:legal[_-\s]?commitment|diplomatic[_-\s]?commitment|binding[_-\s]?agreement|sign[_-\s]?treaty|ratif(?:y|ication)[_-\s]?claim)\b/i,
  },
  {
    category: 'paid_api_usage',
    pattern: /\b(?:paid[_-\s]?api[_-\s]?override|exceed[_-\s]?spend[_-\s]?cap|raise[_-\s]?hosted[_-\s]?spend)\b/i,
  },
];

const SENSITIVE_KEY_RE =
  /(?:^|[_-])(?:secret|password|passwd|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|refresh[_-]?token|bearer|credential|connection[_-]?string|database[_-]?url)(?:$|[_-])/i;

export function sanitizeAuditValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeUntrustedOutput(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item)) as unknown as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (SENSITIVE_KEY_RE.test(k) && typeof v === 'string' && v.length > 0) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeAuditValue(v);
      }
    }
    return out as T;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function computeAuditDigest(seq: string, recordedAt: string, prevDigest: string, event: GoalStudioEvent): string {
  return createHash('sha256')
    .update(canonicalJson({ seq, recordedAt, prevDigest, event }))
    .digest('hex');
}

export function isModelOrAgentPrincipal(principal: string): boolean {
  const normalized = (principal ?? '').trim();
  if (!normalized) return true;
  return MODEL_OR_AGENT_PRINCIPAL_RE.test(normalized);
}

export function formatApprovalScope(
  runId: GoalRunId,
  targetId: TargetId,
  attempt: number,
  action: string,
): string {
  const cleanAction = (action || 'execute').trim().replace(/\s+/g, '_');
  return `${runId}:${targetId}:${attempt}:${cleanAction}`;
}

function mergeConstitution(base: GoalConstitution, override?: Partial<GoalConstitution>): GoalConstitution {
  if (!override) return base;
  return {
    objectiveOwner: 'human',
    invariants: Array.from(new Set([...base.invariants, ...(override.invariants ?? [])])),
    resourceLimits: {
      ...base.resourceLimits,
      ...(override.resourceLimits ?? {}),
    },
    allowedUnattended: override.allowedUnattended ?? base.allowedUnattended,
    needsApproval: Array.from(new Set([...base.needsApproval, ...(override.needsApproval ?? [])])),
  };
}

export function createGoalGovernance(deps: CreateGoalGovernanceDeps): GoalGovernanceService {
  const clock = deps.clock ?? (() => new Date());
  const policyEngine = new PolicyEngine(
    deps.policyOptions ?? {
      projectRoot: deps.workspaceRoot,
      networkAllowed: false,
      allowHostedProvidersDefault: false,
    },
  );
  const baseConstitution: GoalConstitution = mergeConstitution(
    DEFAULT_GOAL_CONSTITUTION,
    deps.defaultConstitution,
  );

  // Per-instance serialization chain so concurrent audit() calls preserve monotonic seq and hash chain.
  let auditChain: Promise<unknown> = Promise.resolve();

  async function resolveConstitution(
    run?: GoalRunLedger,
    explicit?: GoalConstitution,
  ): Promise<GoalConstitution> {
    if (explicit) {
      return mergeConstitution(baseConstitution, explicit);
    }
    if (run && deps.graphs) {
      try {
        const rev = await deps.graphs.getRevision(run.graphId, run.graphRevision);
        if (rev?.definition?.constitution) {
          return mergeConstitution(baseConstitution, rev.definition.constitution);
        }
      } catch {
        // Fall back to stored graph revision in store if graphs service failed
      }
    }
    if (run) {
      try {
        const key = GOAL_STORE_KEYS.graphRevision(run.graphId, run.graphRevision);
        const stored = await deps.store.get<{ definition?: { constitution?: GoalConstitution } }>(key);
        if (stored?.definition?.constitution) {
          return mergeConstitution(baseConstitution, stored.definition.constitution);
        }
      } catch {
        // Ignore store lookup error and fall back to baseConstitution
      }
    }
    return baseConstitution;
  }

  function inferRunHostedCeiling(run: GoalRunLedger, constitution?: GoalConstitution): number {
    const r = run.resource as Record<string, unknown> | undefined;
    if (r && typeof r.hostedSpendCeilingUsd === 'number' && Number.isFinite(r.hostedSpendCeilingUsd)) {
      return r.hostedSpendCeilingUsd;
    }
    const runAny = run as unknown as Record<string, unknown>;
    const runConst = runAny.constitution as GoalConstitution | undefined;
    if (runConst?.resourceLimits && typeof runConst.resourceLimits.hostedSpendUsd === 'number') {
      return runConst.resourceLimits.hostedSpendUsd;
    }
    if (constitution && typeof constitution.resourceLimits?.hostedSpendUsd === 'number') {
      return constitution.resourceLimits.hostedSpendUsd;
    }
    return baseConstitution.resourceLimits.hostedSpendUsd;
  }

  function assertHumanOrSystemPrincipal(principal: string, operation = 'preflight'): GovernanceDecision {
    const trimmed = (principal ?? '').trim();
    if (!trimmed) {
      return {
        effect: 'deny',
        reasons: [`PRINCIPAL_REQUIRED: missing principal for '${operation}'`],
      };
    }
    if (isModelOrAgentPrincipal(trimmed)) {
      return {
        effect: 'deny',
        reasons: [
          `MODEL_PRINCIPAL_FORBIDDEN: principal '${trimmed}' is a model/agent/executor identity and cannot authorize '${operation}', approve actions, raise limits, or mutate policy/constitution`,
        ],
      };
    }
    if (SELF_AUTH_OR_POLICY_MUTATION_RE.test(operation)) {
      return {
        effect: 'deny',
        reasons: [
          `CONSTITUTION_INVARIANT_VIOLATION: operation '${operation}' attempts forbidden self-authorization or autonomous constitution/policy mutation`,
        ],
      };
    }
    return {
      effect: 'allow',
      reasons: [`principal '${trimmed}' authorized for '${operation}'`],
    };
  }

  function authorizeSpend(
    run: GoalRunLedger,
    amountUsd: number,
    constitution?: GoalConstitution,
  ): GovernanceDecision {
    if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 0) {
      return {
        effect: 'deny',
        reasons: [
          `INVALID_SPEND_AMOUNT: amountUsd (${String(amountUsd)}) must be a finite non-negative number`,
        ],
      };
    }

    if (amountUsd === 0) {
      return {
        effect: 'allow',
        reasons: ['zero-cost ($0) local or free inference is allowed within spend gate'],
      };
    }

    const ceiling = inferRunHostedCeiling(run, constitution);
    const currentSpend =
      typeof run?.resource?.hostedSpendUsd === 'number' && Number.isFinite(run.resource.hostedSpendUsd)
        ? run.resource.hostedSpendUsd
        : 0;

    if (!Number.isFinite(ceiling) || ceiling <= 0) {
      return {
        effect: 'deny',
        reasons: [
          `BUDGET_DENIED: hostedSpendUsd ceiling is $0.0000 (no paid hosted inference permitted); requested $${amountUsd.toFixed(4)}`,
        ],
      };
    }

    const projected = Number((currentSpend + amountUsd).toFixed(8));
    if (projected > ceiling) {
      return {
        effect: 'deny',
        reasons: [
          `BUDGET_EXCEEDED: projected hosted spend $${projected.toFixed(4)} ($${currentSpend.toFixed(4)} + $${amountUsd.toFixed(4)}) exceeds ceiling $${ceiling.toFixed(4)}`,
        ],
      };
    }

    return {
      effect: 'allow',
      reasons: [
        `hosted spend $${amountUsd.toFixed(4)} within ceiling ($${projected.toFixed(4)} / $${ceiling.toFixed(4)})`,
      ],
    };
  }

  async function appendAuditInternal(
    rawEvent: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { seq?: number; timestamp?: string },
  ): Promise<GoalAuditRecord> {
    const existing = await deps.store.list('goals/audit/');
    const sorted = existing
      .map((entry) => entry.value as GoalAuditRecord | undefined)
      .filter((rec): rec is GoalAuditRecord => Boolean(rec && typeof rec.seqNumber === 'number'))
      .sort((a, b) => a.seqNumber - b.seqNumber);

    const last = sorted[sorted.length - 1];
    const seqNumber = (last?.seqNumber ?? 0) + 1;
    const seqKey = String(seqNumber).padStart(10, '0');
    const recordedAt = clock().toISOString();
    const prevDigest = last?.digest ?? 'GENESIS';

    const sanitizedEvent: GoalStudioEvent = sanitizeAuditValue({
      seq: typeof rawEvent.seq === 'number' && Number.isFinite(rawEvent.seq) ? rawEvent.seq : seqNumber,
      type: rawEvent.type,
      ...(rawEvent.runId !== undefined ? { runId: rawEvent.runId } : {}),
      ...(rawEvent.targetId !== undefined ? { targetId: rawEvent.targetId } : {}),
      ...(rawEvent.attemptId !== undefined ? { attemptId: rawEvent.attemptId } : {}),
      ...(rawEvent.executionId !== undefined ? { executionId: rawEvent.executionId } : {}),
      timestamp: rawEvent.timestamp ?? recordedAt,
      data: sanitizeAuditValue(rawEvent.data ?? {}),
    });

    const digest = computeAuditDigest(seqKey, recordedAt, prevDigest, sanitizedEvent);
    const record: GoalAuditRecord = {
      seq: seqKey,
      seqNumber,
      recordedAt,
      event: sanitizedEvent,
      prevDigest,
      digest,
    };

    await deps.store.put(GOAL_STORE_KEYS.audit(seqKey), record);
    return record;
  }

  function enqueueAudit(
    event: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { seq?: number; timestamp?: string },
  ): Promise<GoalAuditRecord> {
    const next = auditChain.then(
      () => appendAuditInternal(event),
      () => appendAuditInternal(event),
    );
    auditChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function audit(event: GoalStudioEvent): Promise<void> {
    await enqueueAudit(event);
  }

  async function preflight(input: GoalPreflightInput): Promise<GovernanceDecision> {
    const { run, target, route, principal } = input;
    const constitution = await resolveConstitution(run, input.constitution);
    const limits = constitution.resourceLimits;
    const ledgerEntry = run.targets?.[target.id];
    const attemptNumber =
      typeof input.attempt === 'number' && Number.isFinite(input.attempt) && input.attempt >= 1
        ? Math.floor(input.attempt)
        : (ledgerEntry?.attempts ?? 0) + 1;
    const action = (input.action ?? `execute:${target.executor || target.id}`).trim();

    const denyReasons: string[] = [];
    const askReasons: string[] = [];
    const allowReasons: string[] = [];

    // 1. Principal check: model/agent/executor identities can never self-authorize or act as control-plane principals.
    const principalCheck = assertHumanOrSystemPrincipal(principal, action);
    if (principalCheck.effect === 'deny') {
      denyReasons.push(...principalCheck.reasons);
    }

    // Also inspect context for any spoofed principal, model self-approval, or constitution mutation attempt.
    const ctxPrincipal = typeof input.context?.principal === 'string' ? input.context.principal : undefined;
    if (ctxPrincipal && isModelOrAgentPrincipal(ctxPrincipal)) {
      denyReasons.push(
        `MODEL_PRINCIPAL_FORBIDDEN: context principal '${ctxPrincipal}' is a model/agent identity`,
      );
    }
    if (
      input.context?.mutateConstitution === true ||
      input.context?.bypassPolicy === true ||
      input.context?.selfApprove === true ||
      input.context?.raiseSpendLimit !== undefined
    ) {
      denyReasons.push(
        'CONSTITUTION_INVARIANT_VIOLATION: autonomous mutation of constitution, policy, approval gates, or spend limits is forbidden',
      );
    }

    // 2. Inspect target title, stage, executor, acceptance, artifacts, action, and context against constitution invariants.
    const corpus = [
      target.id,
      target.stage,
      target.title,
      target.executor,
      ...(target.artifacts ?? []),
      ...(target.acceptance ?? []),
      action,
      input.context ? JSON.stringify(input.context) : '',
    ].join(' ');

    if (SELF_AUTH_OR_POLICY_MUTATION_RE.test(corpus)) {
      denyReasons.push(
        'CONSTITUTION_INVARIANT_VIOLATION (objective_owner=human): target or action attempts self-authorization or policy/constitution mutation',
      );
    }

    if (WET_LAB_OR_HAZARD_RE.test(corpus)) {
      denyReasons.push(
        'CONSTITUTION_INVARIANT_VIOLATION (no_wet_lab_or_hazardous_protocols): wet-lab, biological, chemical, or hazardous protocol execution is strictly forbidden',
      );
    }

    if (FABRICATION_RE.test(corpus)) {
      denyReasons.push(
        'CONSTITUTION_INVARIANT_VIOLATION (no_fabrication): fabricating evidence, proofs, citations, solver outputs, or endorsements is strictly forbidden',
      );
    }

    if (UNVERIFIED_COMPLETION_RE.test(corpus)) {
      denyReasons.push(
        'CONSTITUTION_INVARIANT_VIOLATION (no_unverified_completion): marking targets complete without independent verification is strictly forbidden',
      );
    }

    if (DESTRUCTIVE_REPRODUCIBILITY_RE.test(corpus)) {
      denyReasons.push(
        'CONSTITUTION_INVARIANT_VIOLATION (preserve_reproducibility_artifacts): deleting or overwriting audit, ledger, or reproducibility artifacts is strictly forbidden',
      );
    }

    // 3. Enforce bounded retry/repair loops (`no_unbounded_retry_loops`) and resource limits (`maxTasksPerRun`, `maxRunMinutes`, `maxRepairsPerTask`).
    if (ledgerEntry) {
      if (
        typeof limits.maxRepairsPerTask === 'number' &&
        limits.maxRepairsPerTask >= 0 &&
        ledgerEntry.repairs > limits.maxRepairsPerTask
      ) {
        denyReasons.push(
          `CONSTITUTION_INVARIANT_VIOLATION (no_unbounded_retry_loops): target '${target.id}' repairs (${ledgerEntry.repairs}) exceeded maxRepairsPerTask (${limits.maxRepairsPerTask})`,
        );
      }
      const maxAttempts = (limits.maxRepairsPerTask ?? 3) + 1;
      if (ledgerEntry.attempts >= maxAttempts && ledgerEntry.repairs >= (limits.maxRepairsPerTask ?? 3)) {
        denyReasons.push(
          `CONSTITUTION_INVARIANT_VIOLATION (no_unbounded_retry_loops): target '${target.id}' exhausted attempt/repair cap (${ledgerEntry.attempts} attempts, ${ledgerEntry.repairs} repairs)`,
        );
      }
    }

    if (
      typeof limits.maxTasksPerRun === 'number' &&
      limits.maxTasksPerRun > 0 &&
      run.resource.tasksStarted >= limits.maxTasksPerRun
    ) {
      denyReasons.push(
        `RESOURCE_LIMIT_EXCEEDED (maxTasksPerRun): run '${run.runId}' has started ${run.resource.tasksStarted} tasks (limit ${limits.maxTasksPerRun})`,
      );
    }

    const nowMs = clock().getTime();
    const startedMs = Date.parse(run.resource.startedAt);
    const deadlineMs = Date.parse(run.resource.deadlineAt);
    if (Number.isFinite(deadlineMs) && nowMs > deadlineMs) {
      denyReasons.push(
        `RESOURCE_LIMIT_EXCEEDED (deadlineAt): run '${run.runId}' passed deadline ${run.resource.deadlineAt}`,
      );
    } else if (
      Number.isFinite(startedMs) &&
      typeof limits.maxRunMinutes === 'number' &&
      limits.maxRunMinutes > 0 &&
      nowMs - startedMs > limits.maxRunMinutes * 60_000
    ) {
      denyReasons.push(
        `RESOURCE_LIMIT_EXCEEDED (maxRunMinutes): run '${run.runId}' elapsed time exceeded ${limits.maxRunMinutes} minutes`,
      );
    }

    // 4. Hosted spend check if route is provided
    if (route) {
      if (route.hosted || route.estimatedCostUsd > 0) {
        const spendDecision = authorizeSpend(run, route.estimatedCostUsd, constitution);
        if (spendDecision.effect === 'deny') {
          denyReasons.push(...spendDecision.reasons);
        } else {
          allowReasons.push(...spendDecision.reasons);
        }
      } else {
        const spendDecision = authorizeSpend(run, 0, constitution);
        if (spendDecision.effect === 'deny') {
          denyReasons.push(...spendDecision.reasons);
        } else {
          allowReasons.push(...spendDecision.reasons);
        }
      }
    } else if (run.resource.hostedSpendUsd > limits.hostedSpendUsd) {
      denyReasons.push(
        `BUDGET_EXCEEDED: run '${run.runId}' cumulative hostedSpendUsd ($${run.resource.hostedSpendUsd.toFixed(4)}) exceeds ceiling ($${limits.hostedSpendUsd.toFixed(4)})`,
      );
    }

    // If any hard deny invariant or resource limit tripped, deny immediately and record audit event.
    if (denyReasons.length > 0) {
      const decision: GovernanceDecision = {
        effect: 'deny',
        reasons: denyReasons,
      };
      await enqueueAudit({
        type: 'governance.denied',
        runId: run.runId,
        targetId: target.id,
        data: {
          effect: 'deny',
          principal,
          action,
          attempt: attemptNumber,
          reasons: denyReasons,
        },
      });
      return decision;
    }

    // 5. Approval checks (`target.requiresApproval` and constitution `needsApproval` / `no_unapproved_external_submission`)
    const approvedScopes = Array.isArray(input.context?.approvedScopes)
      ? (input.context?.approvedScopes as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const approvalScope = formatApprovalScope(run.runId, target.id, attemptNumber, action);
    const alreadyApprovedForScope = approvedScopes.includes(approvalScope);

    if (target.requiresApproval && !alreadyApprovedForScope) {
      askReasons.push(
        `TARGET_REQUIRES_APPROVAL: target '${target.id}' (${target.title}) requires explicit human approval for scope '${approvalScope}'`,
      );
    }

    for (const rule of NEEDS_APPROVAL_ACTION_PATTERNS) {
      if (rule.pattern.test(corpus) && !alreadyApprovedForScope) {
        askReasons.push(
          `CONSTITUTION_NEEDS_APPROVAL (${rule.category}): action '${action}' on target '${target.id}' requires explicit human approval for scope '${approvalScope}'`,
        );
      }
    }

    // Also match literal strings listed in `constitution.needsApproval` if action or context explicitly names them
    for (const item of constitution.needsApproval) {
      const normalizedItem = item.trim().toLowerCase();
      if (
        normalizedItem &&
        (action.toLowerCase().includes(normalizedItem) ||
          (typeof input.context?.category === 'string' &&
            input.context.category.toLowerCase() === normalizedItem)) &&
        !alreadyApprovedForScope
      ) {
        askReasons.push(
          `CONSTITUTION_NEEDS_APPROVAL (${item}): requires explicit human approval for scope '${approvalScope}'`,
        );
      }
    }

    if (askReasons.length > 0) {
      const uniqueAskReasons = Array.from(new Set(askReasons));
      const decision: GovernanceDecision = {
        effect: 'ask',
        reasons: uniqueAskReasons,
        approvalScope,
      };
      await enqueueAudit({
        type: 'approval.requested',
        runId: run.runId,
        targetId: target.id,
        data: {
          effect: 'ask',
          principal,
          action,
          attempt: attemptNumber,
          approvalScope,
          reasons: uniqueAskReasons,
        },
      });
      return decision;
    }

    allowReasons.unshift(
      `preflight passed for target '${target.id}' under principal '${principal}' (attempt ${attemptNumber})`,
    );
    return {
      effect: 'allow',
      reasons: allowReasons,
    };
  }

  async function queryAudit(query: GoalAuditQuery = {}): Promise<GoalAuditRecord[]> {
    await auditChain;
    const entries = await deps.store.list('goals/audit/');
    const records = entries
      .map((entry) => entry.value as GoalAuditRecord | undefined)
      .filter((rec): rec is GoalAuditRecord => Boolean(rec && rec.event && typeof rec.seqNumber === 'number'))
      .sort((a, b) => a.seqNumber - b.seqNumber);

    const filtered = records.filter((rec) => {
      if (query.afterSeq !== undefined && rec.seqNumber <= query.afterSeq) return false;
      if (query.runId && rec.event.runId !== query.runId) return false;
      if (query.targetId && rec.event.targetId !== query.targetId) return false;
      if (query.type && rec.event.type !== query.type) return false;
      if (query.effect && rec.event.data?.effect !== query.effect) return false;
      if (query.principal && rec.event.data?.principal !== query.principal) return false;
      return true;
    });

    if (query.limit !== undefined && query.limit > 0 && filtered.length > query.limit) {
      return filtered.slice(filtered.length - query.limit);
    }
    return filtered;
  }

  async function verifyAuditChain(): Promise<{
    valid: boolean;
    count: number;
    brokenAtSeq?: string;
    reason?: string;
  }> {
    await auditChain;
    const entries = await deps.store.list('goals/audit/');
    const records = entries
      .map((entry) => entry.value as GoalAuditRecord | undefined)
      .filter((rec): rec is GoalAuditRecord => Boolean(rec && rec.event && typeof rec.seqNumber === 'number'))
      .sort((a, b) => a.seqNumber - b.seqNumber);

    let expectedPrev = 'GENESIS';
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.seqNumber !== i + 1) {
        return {
          valid: false,
          count: records.length,
          brokenAtSeq: rec.seq,
          reason: `expected sequence number ${i + 1} but found ${rec.seqNumber}`,
        };
      }
      if (rec.prevDigest !== expectedPrev) {
        return {
          valid: false,
          count: records.length,
          brokenAtSeq: rec.seq,
          reason: `prevDigest mismatch at seq ${rec.seq}`,
        };
      }
      const recomputed = computeAuditDigest(rec.seq, rec.recordedAt, rec.prevDigest, rec.event);
      if (recomputed !== rec.digest) {
        return {
          valid: false,
          count: records.length,
          brokenAtSeq: rec.seq,
          reason: `digest mismatch at seq ${rec.seq}`,
        };
      }
      expectedPrev = rec.digest;
    }

    return { valid: true, count: records.length };
  }

  async function getPolicySummary(input?: {
    run?: GoalRunLedger;
    constitution?: GoalConstitution;
  }): Promise<GoalPolicySummary> {
    const constitution = await resolveConstitution(input?.run, input?.constitution);
    return {
      constitution,
      invariants: DEFAULT_CONSTITUTION_INVARIANTS,
      needsApproval: constitution.needsApproval,
      resourceLimits: constitution.resourceLimits,
      policyRules: [...policyEngine.rules],
      modelPrincipalsForbidden: true,
    };
  }

  return {
    preflight,
    authorizeSpend,
    audit,
    appendAudit: enqueueAudit,
    queryAudit,
    verifyAuditChain,
    getPolicySummary,
    assertHumanOrSystemPrincipal,
  };
}

export { GoalStudioFailure };
