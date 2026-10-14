import { randomUUID } from 'node:crypto';
import {
  PolicyEngine,
  hasScope,
  type ControlledToolExecutor,
  type ControlledToolResult,
  type PolicyActionRequest,
  type PolicyDecision,
  type StepVerificationCheck,
  type StepVerifier,
} from '@wazir/core';
import { executeTool, type ToolRegistry } from '@wazir/tools';
import { appendAuditEvent } from '@wazir/shared';

/**
 * Tools reachable from the network protocol surfaces (MCP, Agent Protocol).
 * Excluded: tools that need the agent harness (`dispatch_subagent`), hold
 * long-lived processes (`terminal_*`), or re-dispatch other tools outside this
 * boundary (`code_mode`).
 */
export const PROTOCOL_TOOL_SURFACE: readonly string[] = [
  'read', 'write', 'edit', 'search', 'glob', 'shell', 'git', 'test', 'lint', 'typecheck', 'build',
];

export interface ControlledExecutionOptions {
  tools: ToolRegistry;
  projectRoot: string;
  toolSurface?: readonly string[];
  /** Human approval for policy `ask` decisions. Absent, `ask` is denied (never silently allowed). */
  approve?: (request: PolicyActionRequest, decision: PolicyDecision) => Promise<boolean | 'unavailable'>;
  /** Network for tool processes; the OS sandbox enforces it. Defaults to off. */
  networkAllowed?: boolean;
  auditPath?: string;
  policy?: PolicyEngine;
}

export interface ControlledExecution {
  executeTool: ControlledToolExecutor;
  verify: StepVerifier;
  policy: PolicyEngine;
  toolSurface: readonly string[];
}

/**
 * The API's single policy-enforced tool boundary — the same sequence `wa run`
 * applies to coding agents: principal authorization, tool surface, schema,
 * PolicyEngine (with approval), then `executeTool` for controller-only,
 * oracle protection, workspace observation, timeout and cancellation, followed
 * by an audit record. Every protocol tool call and verification check uses it.
 */
export function createControlledExecution(options: ControlledExecutionOptions): ControlledExecution {
  const toolSurface = options.toolSurface ?? PROTOCOL_TOOL_SURFACE;
  const policy = options.policy ?? new PolicyEngine({
    projectRoot: options.projectRoot,
    networkAllowed: options.networkAllowed ?? false,
    approveCallback: options.approve,
  });

  const audit = (event: Parameters<typeof appendAuditEvent>[0]): Promise<void> =>
    appendAuditEvent(event, { auditPath: options.auditPath }).then(() => undefined, () => undefined);

  const executeControlled: ControlledToolExecutor = async (request) => {
    const callId = `call-${randomUUID()}`;
    const deny = async (error: string, failureClass: string, decision?: PolicyDecision): Promise<ControlledToolResult> => {
      await audit({
        type: 'tool_call', tool: request.name, decision: 'deny', rule: decision?.rule ?? failureClass,
        reasons: decision?.reasons ?? [error], executionId: request.executionId, taskId: request.taskId,
        agentId: `${request.source}:${request.principal?.id ?? 'anonymous'}`, details: { callId, dispatched: false },
      });
      return { ok: false, output: '', error, failureClass, durationMs: 0, callId,
        policy: decision ? { decision: decision.decision, rule: decision.rule, reasons: decision.reasons } : undefined };
    };

    if (!hasScope(request.principal, 'execute')) return deny('caller is not authorized to execute tools', 'POLICY_DENIED');
    if (!toolSurface.includes(request.name)) return deny(`tool '${request.name}' is outside the protocol tool surface`, 'POLICY_DENIED');
    const tool = options.tools.get(request.name);
    if (!tool) return deny(`unknown tool '${request.name}'`, 'TOOL_VALIDATION_FAILED');
    const invalid = options.tools.validate(request.name, request.input, 'input');
    if (invalid) return deny(`TOOL_VALIDATION_FAILED: ${invalid}`, 'TOOL_VALIDATION_FAILED');
    if (request.signal?.aborted) return deny('cancelled before tool dispatch', 'CANCELLED');

    const decision = await policy.authorize({ tool: request.name, input: request.input, executionId: request.executionId, projectRoot: options.projectRoot });
    if (decision.decision !== 'allow') {
      return deny(`policy ${decision.decision} (${decision.rule}): ${decision.reasons.join('; ')}`, 'POLICY_DENIED', decision);
    }

    const result = await executeTool(options.tools, request.name, request.input, {
      callId,
      projectRoot: options.projectRoot,
      executionId: request.executionId,
      requester: request.principal.id,
      agentId: `${request.source}:${request.principal.id}`,
      allowedTools: toolSurface,
      verifyWorkspace: true,
      allowVerificationChanges: false,
      networkAllowed: options.networkAllowed ?? false,
      signal: request.signal,
      // Durable intent record before dispatch: if it cannot be written, the tool does not run.
      checkpoint: async () => {
        await appendAuditEvent({
          type: 'policy_decision', tool: request.name, decision: 'allow', rule: decision.rule, reasons: decision.reasons,
          executionId: request.executionId, taskId: request.taskId, agentId: `${request.source}:${request.principal.id}`,
          details: { callId, phase: 'pre-dispatch' },
        }, { auditPath: options.auditPath });
      },
    });
    const metadata = (result.metadata ?? {}) as Record<string, unknown>;
    await audit({
      type: 'tool_call', tool: request.name, decision: 'allow', rule: decision.rule, reasons: decision.reasons,
      executionId: request.executionId, taskId: request.taskId, agentId: `${request.source}:${request.principal.id}`,
      details: { callId, dispatched: true, ok: result.ok, failureClass: result.failureClass, durationMs: result.durationMs,
        workspaceAfterHash: metadata.workspaceAfterHash },
    });
    return {
      ok: result.ok,
      output: result.output,
      error: result.error,
      failureClass: result.ok ? undefined : (result.failureClass ?? 'TOOL_EXECUTION_FAILED'),
      durationMs: result.durationMs,
      callId,
      policy: { decision: decision.decision, rule: decision.rule, reasons: decision.reasons },
      workspaceBeforeHash: typeof metadata.workspaceBeforeHash === 'string' ? metadata.workspaceBeforeHash : undefined,
      workspaceAfterHash: typeof metadata.workspaceAfterHash === 'string' ? metadata.workspaceAfterHash : undefined,
      fileMutations: result.fileMutations,
    };
  };

  // Verification runs the project's own checks through the same boundary; a
  // check passes only when it was dispatched and the tool reported success.
  const verify: StepVerifier = async (request) => {
    const startedAt = new Date().toISOString();
    const checks: StepVerificationCheck[] = [];
    for (const name of request.checks) {
      const checkStarted = new Date().toISOString();
      const result = await executeControlled({
        name, input: {}, principal: request.principal, executionId: request.executionId,
        source: 'verification', taskId: request.taskId, stepId: request.stepId, signal: request.signal,
      });
      const dispatched = result.policy?.decision === 'allow';
      checks.push({
        name,
        // Not dispatched (policy, schema, cancellation) is an ERROR, never a FAIL or PASS.
        status: !dispatched ? 'ERROR' : result.ok ? 'PASS' : 'FAIL',
        callId: result.callId,
        failureClass: result.failureClass,
        error: result.error,
        output: result.output.slice(-4_000),
        durationMs: result.durationMs,
        startedAt: checkStarted,
        completedAt: new Date().toISOString(),
        workspaceAfterHash: result.workspaceAfterHash,
      });
    }
    const passed = checks.length > 0 && checks.every(c => c.status === 'PASS');
    const errored = checks.some(c => c.status === 'ERROR');
    return {
      status: passed ? 'PASS' : errored ? 'ERROR' : 'FAIL',
      executionId: request.executionId,
      taskId: request.taskId,
      stepId: request.stepId,
      checks,
      workspaceRevision: checks.at(-1)?.workspaceAfterHash,
      startedAt,
      completedAt: new Date().toISOString(),
      reasons: checks.filter(c => c.status !== 'PASS').map(c => `${c.name}: ${c.error ?? c.status}`),
    };
  };

  return { executeTool: executeControlled, verify, policy, toolSurface };
}
