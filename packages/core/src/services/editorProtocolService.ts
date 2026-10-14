import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type {
  AgentProtocolTask,
  AgentProtocolStep,
  AgentProtocolStepOutcome,
  AgentProtocolArtifact,
  ControlledToolExecutor,
  ControlledToolResult,
  CreateTaskRequestBody,
  ExecuteStepRequestBody,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDescriptor,
  McpResourceDescriptor,
  McpPromptDescriptor,
  ProtocolPrincipal,
  ProtocolRequestContext,
  ProtocolScope,
  StepVerificationReport,
  StepVerifier,
} from '../types/editorProtocol.js';

/** Read-only view of the tool catalogue; execution goes through `executeTool` only. */
export interface ToolRegistry {
  descriptors(): any[];
}

export interface EditorProtocolServiceOptions {
  store: KeyValueStore;
  tools?: ToolRegistry;
  /** The policy-enforced execution boundary. Absent, every tool call fails closed. */
  executeTool?: ControlledToolExecutor;
  /** Runs independent checks for `verify`. Absent, verification is UNAVAILABLE, never PASS. */
  verify?: StepVerifier;
  /** Tools exposed over MCP / Agent Protocol; `tools/list` advertises only these. */
  toolSurface?: readonly string[];
  projectRoot?: string;
}

/** JSON-RPC methods a read-only (viewer) principal may call. Everything else needs `execute`. */
export const MCP_READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);

/** Scope a JSON-RPC method requires. Unknown methods get the most privileged scope. */
export function mcpMethodScope(method: string): ProtocolScope {
  return MCP_READ_ONLY_METHODS.has(method) ? 'read' : 'execute';
}

export function hasScope(principal: ProtocolPrincipal | undefined, scope: ProtocolScope): principal is ProtocolPrincipal {
  return principal !== undefined && principal.scopes.includes(scope);
}

/** JSON-RPC error code for an authenticated caller lacking the method's scope. */
export const JSONRPC_FORBIDDEN = -32003;

const VERIFICATION_STATUS_KEY = 'editor_protocol/verification/latest';
const CHECK_NAMES = new Set(['test', 'lint', 'typecheck', 'build']);

export class ProtocolError extends Error {
  constructor(readonly code: 'TASK_NOT_FOUND' | 'TASK_TERMINAL' | 'STEP_INVALID' | 'FORBIDDEN', message: string) {
    super(`${code}: ${message}`);
  }
}

function outcomeFromFailure(result: ControlledToolResult): AgentProtocolStepOutcome {
  switch (result.failureClass) {
    case 'POLICY_DENIED': return 'POLICY_DENIED';
    case 'CANCELLED': return 'CANCELLED';
    case 'TOOL_TIMEOUT': return 'TIMED_OUT';
    case 'TOOL_OUTCOME_UNKNOWN': return 'OUTCOME_UNKNOWN';
    default: return 'TOOL_FAILED';
  }
}

/** Accepts `verify: true` (run `test`), a check-name array, or `{ checks: [...] }`. */
function requestedChecks(verify: unknown): string[] | undefined {
  if (verify === undefined || verify === false || verify === null) return undefined;
  if (verify === true) return ['test'];
  const list = Array.isArray(verify) ? verify : (verify as { checks?: unknown })?.checks;
  if (!Array.isArray(list) || list.length === 0 || !list.every((c) => typeof c === 'string' && CHECK_NAMES.has(c))) {
    throw new ProtocolError('STEP_INVALID', `verify must be true or a non-empty list of ${[...CHECK_NAMES].join('|')}`);
  }
  return [...new Set(list as string[])];
}

function parseToolCall(raw: unknown): { name: string; input: Record<string, unknown> } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const call = raw as { name?: unknown; input?: unknown };
  if (typeof call !== 'object' || typeof call.name !== 'string' || !call.name) {
    throw new ProtocolError('STEP_INVALID', 'additional_input.tool must be { name: string, input?: object }');
  }
  const input = call.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('STEP_INVALID', 'additional_input.tool.input must be an object');
  }
  return { name: call.name, input: input as Record<string, unknown> };
}

export class EditorProtocolService {
  private readonly store: KeyValueStore;
  private readonly tools?: ToolRegistry;
  private readonly executeTool?: ControlledToolExecutor;
  private readonly verifier?: StepVerifier;
  private readonly toolSurface?: readonly string[];
  private readonly projectRoot: string;
  /** Serializes step execution per task so a late request cannot overwrite a terminal state. */
  private readonly taskLocks = new Map<string, Promise<unknown>>();

  constructor(options: EditorProtocolServiceOptions) {
    this.store = options.store;
    this.tools = options.tools;
    this.executeTool = options.executeTool;
    this.verifier = options.verify;
    this.toolSurface = options.toolSurface;
    this.projectRoot = options.projectRoot ?? process.cwd();
  }

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.taskLocks.set(taskId, tail);
    try {
      return await run;
    } finally {
      if (this.taskLocks.get(taskId) === tail) this.taskLocks.delete(taskId);
    }
  }

  /** Dispatches through the injected boundary only; fails closed without it or without authority. */
  private async runTool(
    name: string,
    input: Record<string, unknown>,
    meta: { principal?: ProtocolPrincipal; executionId: string; source: 'mcp' | 'agent-protocol'; taskId?: string; stepId?: string; signal?: AbortSignal },
  ): Promise<ControlledToolResult> {
    const denied = (error: string, failureClass = 'POLICY_DENIED'): ControlledToolResult =>
      ({ ok: false, output: '', error, failureClass, durationMs: 0, callId: '' });
    if (!this.executeTool) return denied('controlled tool execution is not configured; refusing to dispatch', 'EXECUTION_UNAVAILABLE');
    if (!hasScope(meta.principal, 'execute')) return denied('caller is not authorized to execute tools');
    try {
      return await this.executeTool({ name, input, principal: meta.principal, executionId: meta.executionId,
        source: meta.source, taskId: meta.taskId, stepId: meta.stepId, signal: meta.signal });
    } catch (error) {
      return denied(error instanceof Error ? error.message : String(error), 'TOOL_EXECUTION_FAILED');
    }
  }

  // =========================================================================
  // Agent Protocol (ACP) Implementation
  // =========================================================================

  private taskKey(taskId: string): string {
    return `editor_protocol/tasks/${taskId}`;
  }

  private stepKey(taskId: string, stepId: string): string {
    return `editor_protocol/steps/${taskId}/${stepId}`;
  }

  private artifactKey(taskId: string, artifactId: string): string {
    return `editor_protocol/artifacts/${taskId}/${artifactId}`;
  }

  async createTask(body: CreateTaskRequestBody, ctx: ProtocolRequestContext = {}): Promise<AgentProtocolTask> {
    if (!hasScope(ctx.principal, 'mutate')) throw new ProtocolError('FORBIDDEN', 'operator scope required to create tasks');
    if (body?.input !== undefined && typeof body.input !== 'string') throw new ProtocolError('STEP_INVALID', 'input must be a string');
    const taskId = `ap-task-${randomUUID()}`;
    const now = new Date().toISOString();

    const task: AgentProtocolTask = {
      task_id: taskId,
      input: body.input,
      additional_input: body.additional_input,
      artifacts: [],
      steps: [],
      created_at: now,
      status: 'created',
    };

    await this.store.put(this.taskKey(taskId), task);
    return task;
  }

  async getTask(taskId: string): Promise<AgentProtocolTask | undefined> {
    return this.store.get<AgentProtocolTask>(this.taskKey(taskId));
  }

  async listTasks(): Promise<AgentProtocolTask[]> {
    const entries = await this.store.list('editor_protocol/tasks/');
    const tasks = entries.map((e) => e.value as AgentProtocolTask);
    tasks.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return tasks;
  }

  async executeStep(taskId: string, body?: ExecuteStepRequestBody, ctx: ProtocolRequestContext = {}): Promise<AgentProtocolStep> {
    if (!hasScope(ctx.principal, 'mutate')) throw new ProtocolError('FORBIDDEN', 'operator scope required to execute steps');
    return this.withTaskLock(taskId, () => this.executeStepLocked(taskId, body, ctx));
  }

  private async executeStepLocked(taskId: string, body: ExecuteStepRequestBody | undefined, ctx: ProtocolRequestContext): Promise<AgentProtocolStep> {
    const task = await this.getTask(taskId);
    if (!task) throw new ProtocolError('TASK_NOT_FOUND', taskId);
    if (task.status === 'completed' || task.status === 'failed') {
      throw new ProtocolError('TASK_TERMINAL', `${taskId} is already ${task.status}`);
    }

    const additional = (body?.additional_input ?? {}) as Record<string, unknown>;
    const toolCall = parseToolCall(additional.tool);
    const checks = requestedChecks(additional.verify);
    const isLast = additional.is_last === true;

    const stepId = `ap-step-${randomUUID()}`;
    const executionId = `ap-exec-${randomUUID()}`;
    const now = new Date().toISOString();
    const step: AgentProtocolStep = {
      task_id: taskId,
      step_id: stepId,
      name: body?.input ?? `step-${task.steps.length + 1}`,
      status: 'running',
      output: '',
      additional_output: { execution_id: executionId, accepted_at: now, executed: false, principal: ctx.principal?.id, custom: body?.additional_input },
      is_last: isLast,
      artifacts: [],
      created_at: now,
    };

    const persist = async (): Promise<void> => {
      const index = task.steps.findIndex((s) => s.step_id === stepId);
      if (index >= 0) task.steps[index] = step; else task.steps.push(step);
      await this.store.put(this.stepKey(taskId, stepId), step);
      await this.store.put(this.taskKey(taskId), task);
    };

    // Accepted + running is durable before anything is dispatched.
    task.status = 'running';
    task.additional_output = { ...task.additional_output, outcome: 'IN_PROGRESS' };
    await persist();

    try {
      return await this.runStep(task, step, persist, { toolCall, checks, isLast, executionId, input: body?.input }, ctx);
    } catch (error) {
      // Never leave an accepted step running: an unexpected fault is a failure.
      step.status = 'failed';
      step.output = `Step failed: ${error instanceof Error ? error.message : String(error)}`;
      step.additional_output = { ...step.additional_output, outcome: 'TOOL_FAILED' };
      step.completed_at = new Date().toISOString();
      task.status = 'failed';
      task.additional_output = { outcome: 'FAILED', last_step_id: stepId, failed_step_id: stepId };
      await persist();
      return step;
    }
  }

  private async runStep(
    task: AgentProtocolTask,
    step: AgentProtocolStep,
    persist: () => Promise<void>,
    plan: { toolCall?: { name: string; input: Record<string, unknown> }; checks?: string[]; isLast: boolean; executionId: string; input?: string },
    ctx: ProtocolRequestContext,
  ): Promise<AgentProtocolStep> {
    const { toolCall, checks, isLast, executionId } = plan;
    const taskId = task.task_id;
    const stepId = step.step_id;
    let outcome: AgentProtocolStepOutcome = 'RECORDED';
    let failed = false;
    const output: string[] = [];
    const out = step.additional_output!;

    if (toolCall) {
      const result = await this.runTool(toolCall.name, toolCall.input, {
        principal: ctx.principal, executionId, source: 'agent-protocol', taskId, stepId, signal: ctx.signal,
      });
      out.executed = result.callId !== '' && result.policy?.decision === 'allow';
      out.tool = {
        name: toolCall.name,
        ok: result.ok,
        call_id: result.callId || undefined,
        failure_class: result.failureClass,
        error: result.error,
        duration_ms: result.durationMs,
        policy: result.policy,
        workspace_before_hash: result.workspaceBeforeHash,
        workspace_after_hash: result.workspaceAfterHash,
        file_mutations: result.fileMutations,
      };
      if (result.ok) {
        outcome = 'TOOL_SUCCEEDED';
        output.push(result.output || `Tool ${toolCall.name} executed`);
      } else {
        failed = true;
        outcome = result.failureClass === 'EXECUTION_UNAVAILABLE' ? 'EXECUTION_UNAVAILABLE' : outcomeFromFailure(result);
        output.push(`Tool ${toolCall.name} failed (${result.failureClass ?? 'error'}): ${result.error ?? 'no error detail'}`);
      }
    }

    if (checks && !failed) {
      const report = await this.runVerification(checks, ctx, executionId, taskId, stepId);
      out.verification = report;
      await this.store.put(VERIFICATION_STATUS_KEY, report);
      if (report.status === 'PASS') {
        outcome = 'VERIFIED';
      } else {
        failed = true;
        outcome = report.status === 'UNAVAILABLE' ? 'VERIFICATION_UNAVAILABLE' : 'VERIFICATION_FAILED';
      }
      output.push(`Verification ${report.status} (${report.checks.length} executed check(s))${report.reasons.length ? `: ${report.reasons.join('; ')}` : ''}`);
    }

    if (!toolCall && !checks) output.push(`Recorded step for task ${taskId}: ${plan.input ?? 'step'} (no execution requested)`);

    step.status = failed ? 'failed' : 'completed';
    step.output = output.join('\n');
    out.outcome = outcome;
    step.completed_at = new Date().toISOString();

    if (failed) {
      task.status = 'failed';
      task.additional_output = { outcome: 'FAILED', last_step_id: stepId, failed_step_id: stepId };
    } else if (isLast) {
      task.status = 'completed';
      task.additional_output = { outcome: outcome === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED', last_step_id: stepId };
    } else {
      task.status = 'running';
      task.additional_output = { outcome: 'IN_PROGRESS', last_step_id: stepId };
    }
    await persist();
    return step;
  }

  private async runVerification(
    checks: string[], ctx: ProtocolRequestContext, executionId: string, taskId: string, stepId: string,
  ): Promise<StepVerificationReport> {
    const startedAt = new Date().toISOString();
    const base = { executionId, taskId, stepId, checks: [], startedAt };
    if (!this.verifier) {
      return { ...base, status: 'UNAVAILABLE', completedAt: new Date().toISOString(), reasons: ['no verification engine is configured'] };
    }
    if (!hasScope(ctx.principal, 'execute')) {
      return { ...base, status: 'UNAVAILABLE', completedAt: new Date().toISOString(), reasons: ['caller is not authorized to execute verification checks'] };
    }
    try {
      const report = await this.verifier({ checks, principal: ctx.principal, executionId, taskId, stepId, signal: ctx.signal });
      // PASS only with executed, all-passing checks bound to this execution.
      const bound = report.executionId === executionId && report.taskId === taskId && report.stepId === stepId;
      const allPass = report.checks.length > 0 && report.checks.every((c) => c.status === 'PASS');
      if (report.status === 'PASS' && (!bound || !allPass)) {
        return { ...report, status: 'ERROR', reasons: [...report.reasons, 'verifier reported PASS without bound, all-passing executed checks'] };
      }
      return report;
    } catch (error) {
      return { ...base, status: 'ERROR', completedAt: new Date().toISOString(), reasons: [`verification threw: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  async listSteps(taskId: string): Promise<AgentProtocolStep[]> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new ProtocolError('TASK_NOT_FOUND', taskId);
    }
    return task.steps;
  }

  async getStep(taskId: string, stepId: string): Promise<AgentProtocolStep | undefined> {
    return this.store.get<AgentProtocolStep>(this.stepKey(taskId, stepId));
  }

  async listArtifacts(taskId: string): Promise<AgentProtocolArtifact[]> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new ProtocolError('TASK_NOT_FOUND', taskId);
    }
    return task.artifacts;
  }

  async createArtifact(
    taskId: string,
    artifactData: Partial<AgentProtocolArtifact> & { file_name: string },
    ctx: ProtocolRequestContext = {},
  ): Promise<AgentProtocolArtifact> {
    if (!hasScope(ctx.principal, 'mutate')) throw new ProtocolError('FORBIDDEN', 'operator scope required to create artifacts');
    if (typeof artifactData?.file_name !== 'string' || !artifactData.file_name) throw new ProtocolError('STEP_INVALID', 'file_name is required');
    return this.withTaskLock(taskId, async () => {
    const task = await this.getTask(taskId);
    if (!task) throw new ProtocolError('TASK_NOT_FOUND', taskId);

    const artifactId = `ap-art-${randomUUID()}`;
    const now = new Date().toISOString();

    const artifact: AgentProtocolArtifact = {
      artifact_id: artifactId,
      agent_task_id: taskId,
      file_name: artifactData.file_name,
      relative_path: artifactData.relative_path,
      content: artifactData.content,
      created_at: now,
      modified_at: now,
    };

    task.artifacts.push(artifact);

    await this.store.put(this.artifactKey(taskId, artifactId), artifact);
    await this.store.put(this.taskKey(taskId), task);

    return artifact;
    });
  }

  async getArtifact(taskId: string, artifactId: string): Promise<AgentProtocolArtifact | undefined> {
    return this.store.get<AgentProtocolArtifact>(this.artifactKey(taskId, artifactId));
  }

  // =========================================================================
  // Model Context Protocol (MCP) Server Implementation
  // =========================================================================

  /** Latest recorded verification evidence; never `verified: true` without executed, passing checks. */
  async verificationStatus(): Promise<Record<string, unknown>> {
    const engineAvailable = Boolean(this.verifier);
    const latest = await this.store.get<StepVerificationReport>(VERIFICATION_STATUS_KEY);
    if (!latest) {
      return { verified: false, status: engineAvailable ? 'UNKNOWN' : 'UNAVAILABLE', engineAvailable, reasons: ['no verification has been executed'] };
    }
    const verified = latest.status === 'PASS' && latest.checks.length > 0 && latest.checks.every((c) => c.status === 'PASS');
    return { verified, status: verified ? 'PASS' : latest.status === 'PASS' ? 'ERROR' : latest.status, engineAvailable, evidence: latest };
  }

  async handleJsonRpc(request: JsonRpcRequest, ctx: ProtocolRequestContext = {}): Promise<JsonRpcResponse | null> {
    if (Array.isArray(request)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batch requests are not supported' } };
    }
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      const rawId = (request as { id?: unknown } | undefined)?.id;
      return {
        jsonrpc: '2.0',
        id: typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      };
    }

    const id = request.id ?? null;

    // Each method is classified on its own; unknown methods need the highest scope
    // and are only reported as "not found" to a caller who holds it.
    const scope = mcpMethodScope(request.method);
    if (!hasScope(ctx.principal, scope)) {
      return { jsonrpc: '2.0', id, error: { code: JSONRPC_FORBIDDEN, message: `Forbidden: '${request.method}' requires ${scope} scope` } };
    }

    try {
      switch (request.method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
                prompts: { listChanged: true },
              },
              serverInfo: {
                name: 'wazir-control-plane',
                version: '0.1.0',
              },
            },
          };
        }

        case 'notifications/initialized': {
          // Client acknowledgement; return null if no id was provided (notification)
          if (request.id === undefined) return null;
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'tools/list': {
          const surface = this.toolSurface;
          const descriptors = (this.tools ? this.tools.descriptors() : []).filter((d) => !surface || surface.includes(d.name));
          const mcpTools: McpToolDescriptor[] = descriptors.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: (d as any).parameters ?? (d as any).schema ?? { type: 'object', properties: {} },
          }));

          return {
            jsonrpc: '2.0',
            id,
            result: { tools: mcpTools },
          };
        }

        case 'tools/call': {
          const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (!params?.name) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: tool name is required' },
            };
          }

          const args = params.arguments ?? {};
          if (typeof args !== 'object' || Array.isArray(args)) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: arguments must be an object' } };
          }
          const toolResult = await this.runTool(params.name, args, {
            principal: ctx.principal, executionId: `mcp-${randomUUID()}`, source: 'mcp', signal: ctx.signal,
          });
          const text = toolResult.ok
            ? toolResult.output || 'OK'
            : `${toolResult.failureClass ?? 'FAILED'}: ${toolResult.error ?? 'tool failed'}`;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }],
              isError: !toolResult.ok,
              _meta: { callId: toolResult.callId || undefined, failureClass: toolResult.failureClass, policy: toolResult.policy },
            },
          };
        }

        case 'resources/list': {
          const resources: McpResourceDescriptor[] = [
            {
              uri: 'wazir://workspace/status',
              name: 'Workspace Status',
              description: 'Current workspace status and path',
              mimeType: 'application/json',
            },
            {
              uri: 'wazir://verification/status',
              name: 'Verification Status',
              description: 'Status of verification oracles and suite',
              mimeType: 'application/json',
            },
          ];

          return {
            jsonrpc: '2.0',
            id,
            result: { resources },
          };
        }

        case 'resources/read': {
          const params = request.params as { uri?: string } | undefined;
          if (!params?.uri) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: uri is required' },
            };
          }

          let content = '{}';
          if (params.uri === 'wazir://workspace/status') {
            content = JSON.stringify({ projectRoot: this.projectRoot, status: 'ready' });
          } else if (params.uri === 'wazir://verification/status') {
            content = JSON.stringify(await this.verificationStatus());
          }

          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: params.uri,
                  mimeType: 'application/json',
                  text: content,
                },
              ],
            },
          };
        }

        case 'prompts/list': {
          const prompts: McpPromptDescriptor[] = [
            {
              name: 'wazir-code-repair',
              description: 'Instructs Wazir to diagnose defect and formulate deterministic verified repair.',
              arguments: [
                { name: 'defect_description', description: 'Description of the bug or defect', required: true },
              ],
            },
            {
              name: 'wazir-feature-implementation',
              description: 'Instructs Wazir to implement a new feature with tests and full verification.',
              arguments: [
                { name: 'feature_spec', description: 'Specification of the feature', required: true },
              ],
            },
          ];

          return {
            jsonrpc: '2.0',
            id,
            result: { prompts },
          };
        }

        case 'prompts/get': {
          const params = request.params as { name?: string; arguments?: Record<string, string> } | undefined;
          if (!params?.name) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: prompt name is required' },
            };
          }

          const description = `Wazir Prompt: ${params.name}`;
          const promptText = `Execute task with Wazir Control Plane: ${params.arguments?.defect_description ?? params.arguments?.feature_spec ?? params.name}`;

          return {
            jsonrpc: '2.0',
            id,
            result: {
              description,
              messages: [
                {
                  role: 'user',
                  content: {
                    type: 'text',
                    text: promptText,
                  },
                },
              ],
            },
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }
}
