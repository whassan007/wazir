import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  createGoalGovernance,
  formatApprovalScope,
  isModelOrAgentPrincipal,
  sanitizeAuditValue,
  DEFAULT_GOAL_CONSTITUTION,
  type GoalConstitution,
  type GoalRunLedger,
  type GoalTarget,
  type ModelRouteDecision,
  type GoalAuditRecord,
} from '../../src/index.js';

function makeRun(overrides: Partial<GoalRunLedger> = {}): GoalRunLedger {
  const now = new Date('2026-10-23T00:00:00.000Z');
  const deadline = new Date(now.getTime() + 90 * 60_000);
  return {
    runId: 'run-nobel-1',
    graphId: 'graph-nobel',
    graphRevision: 1,
    graphDigest: 'sha256:deadbeef',
    status: 'running',
    ledgerRevision: 1,
    targets: {
      'Y1.1': {
        targetId: 'Y1.1',
        status: 'eligible',
        attempts: 0,
        repairs: 0,
        evidenceIds: [],
        blockers: [],
        updatedAt: now.toISOString(),
      },
      'Y2.3': {
        targetId: 'Y2.3',
        status: 'eligible',
        attempts: 1,
        repairs: 0,
        evidenceIds: [],
        blockers: [],
        updatedAt: now.toISOString(),
      },
    },
    resource: {
      tasksStarted: 1,
      hostedSpendUsd: 0,
      startedAt: now.toISOString(),
      deadlineAt: deadline.toISOString(),
    },
    createdBy: 'operator:alice',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function makeTarget(overrides: Partial<GoalTarget> = {}): GoalTarget {
  return {
    id: 'Y1.1',
    stage: 'foundational_research',
    title: 'Define a bounded formal safety claim',
    dependsOn: [],
    priority: 100,
    executor: 'axiomatize',
    artifacts: ['scope.md', 'threat-model.md', 'formal-claim.md'],
    acceptance: [
      'Formal assumptions, observables, transition system, trust boundary and non-goals are explicit.',
      'At least one counterexample to an overbroad claim is documented.',
    ],
    ...overrides,
  };
}

function makeRoute(overrides: Partial<ModelRouteDecision> = {}): ModelRouteDecision {
  return {
    modelId: 'qwen2.5-coder:32b',
    runtimeId: 'ollama',
    computerId: 'local',
    hosted: false,
    estimatedCostUsd: 0,
    reasons: ['local model verified ready'],
    rejected: [],
    decidedAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('GoalGovernance — security, policy, and governance gates', () => {
  let store: MemoryStore;
  let clockNow: Date;

  beforeEach(() => {
    store = new MemoryStore();
    clockNow = new Date('2026-10-23T00:10:00.000Z');
  });

  describe('Principal boundary (models and agents are never principals)', () => {
    it.each([
      'model:qwen2.5-coder',
      'model:claude-3-7-sonnet',
      'agent:coding-agent',
      'executor:axiomatize',
      'llm:gpt-4o',
      'assistant:verifier',
      'subagent:worker-1',
      'autonomous:controller',
      '',
      '   ',
    ])('denies preflight when principal is "%s"', async (principal) => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      const decision = await gov.preflight({
        run: makeRun(),
        target: makeTarget(),
        route: makeRoute(),
        principal,
      });

      expect(decision.effect).toBe('deny');
      expect(decision.reasons.join(' ')).toMatch(/MODEL_PRINCIPAL_FORBIDDEN|PRINCIPAL_REQUIRED/);

      const audits = await gov.queryAudit({ runId: 'run-nobel-1', effect: 'deny' });
      expect(audits.length).toBe(1);
      expect(audits[0].event.type).toBe('governance.denied');
    });

    it('denies when a model attempts to self-approve, mutate constitution, raise limits, or bypass policy via action or context', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      const byAction = await gov.preflight({
        run: makeRun(),
        target: makeTarget(),
        principal: 'operator:alice',
        action: 'mutate_constitution:raise_budget',
      });
      expect(byAction.effect).toBe('deny');
      expect(byAction.reasons.join(' ')).toMatch(/CONSTITUTION_INVARIANT_VIOLATION/);

      const byContextFlag = await gov.preflight({
        run: makeRun(),
        target: makeTarget(),
        principal: 'operator:alice',
        context: { raiseSpendLimit: 100, selfApprove: true },
      });
      expect(byContextFlag.effect).toBe('deny');
      expect(byContextFlag.reasons.join(' ')).toMatch(/CONSTITUTION_INVARIANT_VIOLATION/);

      const bySpoofedContextPrincipal = await gov.preflight({
        run: makeRun(),
        target: makeTarget(),
        principal: 'operator:alice',
        context: { principal: 'executor:formal_verify' },
      });
      expect(bySpoofedContextPrincipal.effect).toBe('deny');
      expect(bySpoofedContextPrincipal.reasons.join(' ')).toMatch(/MODEL_PRINCIPAL_FORBIDDEN/);
    });

    it('allows human operator and controller principals on safe local targets', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      expect(isModelOrAgentPrincipal('user:wael')).toBe(false);
      expect(isModelOrAgentPrincipal('operator:admin')).toBe(false);
      expect(isModelOrAgentPrincipal('controller')).toBe(false);

      const decision = await gov.preflight({
        run: makeRun(),
        target: makeTarget(),
        route: makeRoute({ hosted: false, estimatedCostUsd: 0 }),
        principal: 'user:wael',
      });

      expect(decision.effect).toBe('allow');
      expect(decision.approvalScope).toBeUndefined();
    });
  });

  describe('Hard spending gate (authorizeSpend & hostedSpendUsd: 0)', () => {
    it('denies any positive hosted spend when hostedSpendUsd is 0 ($0.0001 denied; $0 local allowed)', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });
      const run = makeRun();

      // $0 is allowed
      const zeroDecision = gov.authorizeSpend(run, 0);
      expect(zeroDecision.effect).toBe('allow');

      // $0.0001 is denied when ceiling is 0 (default from nobel_goal_graph.yaml)
      const tinySpend = gov.authorizeSpend(run, 0.0001);
      expect(tinySpend.effect).toBe('deny');
      expect(tinySpend.reasons.join(' ')).toMatch(/BUDGET_DENIED|hostedSpendUsd ceiling is \$0/);

      // Preflight with a hosted route costing $0.0001 is denied
      const preflightHosted = await gov.preflight({
        run,
        target: makeTarget(),
        route: makeRoute({
          modelId: 'gpt-4o',
          runtimeId: 'openai',
          hosted: true,
          estimatedCostUsd: 0.0001,
        }),
        principal: 'operator:alice',
      });
      expect(preflightHosted.effect).toBe('deny');
      expect(preflightHosted.reasons.join(' ')).toMatch(/BUDGET_DENIED/);
    });

    it('denies negative, NaN, or infinite spend amounts', () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
      });
      const run = makeRun();

      expect(gov.authorizeSpend(run, -0.01).effect).toBe('deny');
      expect(gov.authorizeSpend(run, Number.NaN).effect).toBe('deny');
      expect(gov.authorizeSpend(run, Number.POSITIVE_INFINITY).effect).toBe('deny');
      expect(gov.authorizeSpend(run, Number.NEGATIVE_INFINITY).effect).toBe('deny');
    });

    it('allows positive hosted spend only up to an explicitly raised ceiling and denies when cumulative spend exceeds it', () => {
      const customConstitution: GoalConstitution = {
        ...DEFAULT_GOAL_CONSTITUTION,
        resourceLimits: {
          ...DEFAULT_GOAL_CONSTITUTION.resourceLimits,
          hostedSpendUsd: 5.0,
        },
      };
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        defaultConstitution: customConstitution,
      });

      const run = makeRun({
        resource: {
          tasksStarted: 2,
          hostedSpendUsd: 4.5,
          startedAt: '2026-10-23T00:00:00.000Z',
          deadlineAt: '2026-10-23T01:30:00.000Z',
        },
      });

      // $0.50 fits exactly into $4.50 + $0.50 <= $5.00
      const withinCap = gov.authorizeSpend(run, 0.5);
      expect(withinCap.effect).toBe('allow');

      // $0.5001 exceeds $5.00 ceiling
      const overCap = gov.authorizeSpend(run, 0.5001);
      expect(overCap.effect).toBe('deny');
      expect(overCap.reasons.join(' ')).toMatch(/BUDGET_EXCEEDED/);
    });
  });

  describe('Approval scoping (requiresApproval & constitution needsApproval)', () => {
    it('returns effect="ask" with deterministic approvalScope="${runId}:${targetId}:${attempt}:${action}" for target.requiresApproval', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      const run = makeRun();
      const target = makeTarget({
        id: 'Y2.3',
        stage: 'open_protocol',
        title: 'Prepare standards submission and adoption evidence',
        executor: 'standards_strategy',
        requiresApproval: true,
        externalDependency: true,
      });

      // Y2.3 in makeRun() has attempts: 1, so next attempt is 2
      const decision = await gov.preflight({
        run,
        target,
        route: makeRoute(),
        principal: 'operator:alice',
      });

      expect(decision.effect).toBe('ask');
      expect(decision.approvalScope).toBe('run-nobel-1:Y2.3:2:execute:standards_strategy');
      expect(decision.reasons.join(' ')).toMatch(/TARGET_REQUIRES_APPROVAL/);

      // Verify approvalScope cannot be reused for another target or another attempt
      const wrongTargetReuse = await gov.preflight({
        run,
        target,
        route: makeRoute(),
        principal: 'operator:alice',
        context: {
          approvedScopes: [
            'run-nobel-1:Y1.1:2:execute:standards_strategy', // wrong target
            'run-nobel-1:Y2.3:1:execute:standards_strategy', // wrong attempt
            'run-other:Y2.3:2:execute:standards_strategy', // wrong run
          ],
        },
      });
      expect(wrongTargetReuse.effect).toBe('ask');

      // Exact matching approvalScope allows execution
      const exactScopeApproved = await gov.preflight({
        run,
        target,
        route: makeRoute(),
        principal: 'operator:alice',
        context: {
          approvedScopes: ['run-nobel-1:Y2.3:2:execute:standards_strategy'],
        },
      });
      expect(exactScopeApproved.effect).toBe('allow');
    });

    it('returns effect="ask" when constitution needsApproval action is triggered (external submission, protected branch merge, deployment)', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      const run = makeRun();
      const target = makeTarget({ id: 'Y1.1', requiresApproval: false });

      const decision = await gov.preflight({
        run,
        target,
        route: makeRoute(),
        principal: 'operator:alice',
        action: 'external_submission:send_outreach_email',
      });

      expect(decision.effect).toBe('ask');
      expect(decision.approvalScope).toBe(
        formatApprovalScope('run-nobel-1', 'Y1.1', 1, 'external_submission:send_outreach_email'),
      );
      expect(decision.reasons.join(' ')).toMatch(/CONSTITUTION_NEEDS_APPROVAL/);
    });
  });

  describe('Constitution invariants & resource limits enforcement', () => {
    it.each([
      [
        'no_wet_lab_or_hazardous_protocols',
        makeTarget({
          title: 'Synthesize pathogen protocol in wet lab BSL-4 culture',
        }),
      ],
      [
        'no_fabrication',
        makeTarget({
          title: 'Fabricate solver proof and fake evidence for theorem',
        }),
      ],
      [
        'no_unverified_completion',
        makeTarget({
          title: 'Mark completed without verification and bypass acceptance gate',
        }),
      ],
      [
        'preserve_reproducibility_artifacts',
        makeTarget({
          title: 'Delete audit log and wipe evidence history',
        }),
      ],
    ])('denies target violating invariant %s', async (expectedInvariant, badTarget) => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      const decision = await gov.preflight({
        run: makeRun(),
        target: badTarget,
        route: makeRoute(),
        principal: 'operator:alice',
      });

      expect(decision.effect).toBe('deny');
      expect(decision.reasons.join(' ')).toContain(expectedInvariant);
    });

    it('enforces maxTasksPerRun, maxRunMinutes, deadlineAt, and maxRepairsPerTask (no_unbounded_retry_loops)', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      // 1. maxTasksPerRun exceeded
      const maxTasksRun = makeRun({
        resource: {
          tasksStarted: 12,
          hostedSpendUsd: 0,
          startedAt: '2026-10-23T00:00:00.000Z',
          deadlineAt: '2026-10-23T01:30:00.000Z',
        },
      });
      const tasksDecision = await gov.preflight({
        run: maxTasksRun,
        target: makeTarget(),
        principal: 'operator:alice',
      });
      expect(tasksDecision.effect).toBe('deny');
      expect(tasksDecision.reasons.join(' ')).toMatch(/maxTasksPerRun/);

      // 2. deadlineAt / maxRunMinutes exceeded
      const expiredRun = makeRun({
        resource: {
          tasksStarted: 1,
          hostedSpendUsd: 0,
          startedAt: '2026-10-22T20:00:00.000Z',
          deadlineAt: '2026-10-22T21:30:00.000Z',
        },
      });
      const expiredDecision = await gov.preflight({
        run: expiredRun,
        target: makeTarget(),
        principal: 'operator:alice',
      });
      expect(expiredDecision.effect).toBe('deny');
      expect(expiredDecision.reasons.join(' ')).toMatch(/deadlineAt|maxRunMinutes/);

      // 3. maxRepairsPerTask exceeded (no_unbounded_retry_loops)
      const exhaustedTargetRun = makeRun({
        targets: {
          'Y1.1': {
            targetId: 'Y1.1',
            status: 'repairing',
            attempts: 4,
            repairs: 4,
            evidenceIds: [],
            blockers: [],
            updatedAt: clockNow.toISOString(),
          },
        },
      });
      const retryDecision = await gov.preflight({
        run: exhaustedTargetRun,
        target: makeTarget(),
        principal: 'operator:alice',
      });
      expect(retryDecision.effect).toBe('deny');
      expect(retryDecision.reasons.join(' ')).toMatch(/no_unbounded_retry_loops/);
    });
  });

  describe('Tamper-evident audit log & secret redaction', () => {
    it('redacts secrets, bearer tokens, API keys, and terminal escapes before persisting under GOAL_STORE_KEYS.audit(seq)', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      const fakeOpenAiKey = 'sk-proj-1234567890abcdefghijklmnop';
      const fakeGhToken = 'ghp_1234567890abcdefghijklmnopqrstuvwx';
      const fakeBearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      await gov.audit({
        seq: 1,
        type: 'governance.denied',
        runId: 'run-nobel-1',
        targetId: 'Y1.1',
        timestamp: clockNow.toISOString(),
        data: {
          effect: 'deny',
          principal: 'operator:alice',
          apiKey: fakeOpenAiKey,
          nested: {
            command: `curl -H "Authorization: ${fakeBearer}" https://user:supersecretpass@example.com`,
            envLine: `OPENAI_API_KEY=${fakeOpenAiKey} GITHUB_TOKEN=${fakeGhToken}`,
            ansi: '\x1b[31mDANGER\x1b[0m',
          },
        },
      });

      const stored = await store.get<GoalAuditRecord>(GOAL_STORE_KEYS.audit('0000000001'));
      expect(stored).toBeDefined();
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toContain(fakeOpenAiKey);
      expect(serialized).not.toContain(fakeGhToken);
      expect(serialized).not.toContain('supersecretpass');
      expect(serialized).not.toContain('\x1b[');
      expect(serialized).toContain('[REDACTED]');
      expect(stored?.prevDigest).toBe('GENESIS');
      expect(stored?.digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('maintains a verifiable hash chain across audit records and detects tampering', async () => {
      const gov = createGoalGovernance({
        store,
        workspaceRoot: '/tmp/wazir-test',
        clock: () => clockNow,
      });

      await gov.audit({
        seq: 1,
        type: 'run.created',
        runId: 'run-1',
        timestamp: clockNow.toISOString(),
        data: { principal: 'operator:alice' },
      });
      await gov.audit({
        seq: 2,
        type: 'approval.requested',
        runId: 'run-1',
        targetId: 'Y2.3',
        timestamp: clockNow.toISOString(),
        data: { effect: 'ask', principal: 'operator:alice' },
      });

      const verificationBefore = await gov.verifyAuditChain();
      expect(verificationBefore).toEqual({ valid: true, count: 2 });

      // Tamper with record 1 in the underlying store
      const rec1Key = GOAL_STORE_KEYS.audit('0000000001');
      const rec1 = await store.get<GoalAuditRecord>(rec1Key);
      expect(rec1).toBeDefined();
      await store.put(rec1Key, {
        ...rec1!,
        event: {
          ...rec1!.event,
          data: { principal: 'attacker:mallory' },
        },
      });

      const verificationAfter = await gov.verifyAuditChain();
      expect(verificationAfter.valid).toBe(false);
      expect(verificationAfter.brokenAtSeq).toBe('0000000001');
    });

    it('sanitizeAuditValue strips prototype pollution keys and sensitive field names', () => {
      const cleaned = sanitizeAuditValue({
        client_secret: 'my-very-secret-value',
        normalField: 'hello',
      });
      expect(cleaned.client_secret).toBe('[REDACTED]');
      expect(cleaned.normalField).toBe('hello');
    });
  });
});
