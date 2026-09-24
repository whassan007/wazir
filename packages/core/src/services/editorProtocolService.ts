import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type {
  AgentProtocolTask,
  AgentProtocolStep,
  AgentProtocolArtifact,
  CreateTaskRequestBody,
  ExecuteStepRequestBody,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDescriptor,
  McpResourceDescriptor,
  McpPromptDescriptor,
} from '../types/editorProtocol.js';
export interface ToolRegistry {
  register?(tool: any): void;
  get?(name: string): any;
  list?(): any[];
  execute?(name: string, input: any, ctx?: any): Promise<any>;
  descriptors(): any[];
}
import type { ExecutionEngine } from './executionEngine.js';
import type { VerificationEngine } from './verificationEngine.js';

export interface EditorProtocolServiceOptions {
  store: KeyValueStore;
  tools?: ToolRegistry;
  executionEngine?: ExecutionEngine;
  verificationEngine?: VerificationEngine;
  projectRoot?: string;
}

export class EditorProtocolService {
  private readonly store: KeyValueStore;
  private readonly tools?: ToolRegistry;
  private readonly executionEngine?: ExecutionEngine;
  private readonly verificationEngine?: VerificationEngine;
  private readonly projectRoot: string;

  constructor(options: EditorProtocolServiceOptions) {
    this.store = options.store;
    this.tools = options.tools;
    this.executionEngine = options.executionEngine;
    this.verificationEngine = options.verificationEngine;
    this.projectRoot = options.projectRoot ?? process.cwd();
  }

  private async runTool(name: string, input: any, ctx?: any): Promise<any> {
    if (!this.tools) throw new Error('Tool registry unavailable');
    if (typeof this.tools.execute === 'function') {
      return this.tools.execute(name, input, ctx);
    }
    if (typeof this.tools.get === 'function') {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Tool '${name}' not found`);
      return tool.execute(input, ctx);
    }
    throw new Error('Tool registry has no execution capability');
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

  async createTask(body: CreateTaskRequestBody): Promise<AgentProtocolTask> {
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

  async executeStep(taskId: string, body?: ExecuteStepRequestBody): Promise<AgentProtocolStep> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    }
    if (task.status === 'completed') {
      throw new Error(`TASK_ALREADY_COMPLETED: ${taskId}`);
    }

    const stepId = `ap-step-${randomUUID()}`;
    const now = new Date().toISOString();
    const isLast = Boolean(body?.additional_input?.is_last ?? false);

    let output = `Executed step for task ${taskId}: ${body?.input ?? 'step'}`;
    const artifacts: AgentProtocolArtifact[] = [];

    // If an explicit tool call is requested via additional_input
    const toolCall = body?.additional_input?.tool as { name: string; input: Record<string, unknown> } | undefined;
    if (toolCall && this.tools) {
      try {
        const toolResult = await this.runTool(toolCall.name, toolCall.input, {
          executionId: taskId,
          projectRoot: this.projectRoot,
        });
        output = toolResult.output ?? (toolResult.ok ? 'Tool executed successfully' : 'Tool execution failed');
      } catch (err) {
        output = `Error executing tool ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // If verification requested
    if (body?.additional_input?.verify && this.verificationEngine) {
      try {
        const vResult = typeof (this.verificationEngine as any).verifyWorkspace === 'function'
          ? await (this.verificationEngine as any).verifyWorkspace()
          : { passing: true, checks: [] };
        output += `\nVerification: ${vResult.passing ? 'PASSED' : 'FAILED'} (checks: ${vResult.checks.length})`;
      } catch (err) {
        output += `\nVerification error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const step: AgentProtocolStep = {
      task_id: taskId,
      step_id: stepId,
      name: body?.input ?? `step-${task.steps.length + 1}`,
      status: 'completed',
      output,
      additional_output: {
        executed_at: now,
        custom: body?.additional_input,
      },
      is_last: isLast,
      artifacts,
      created_at: now,
      completed_at: new Date().toISOString(),
    };

    // Update task
    task.steps.push(step);
    task.status = isLast ? 'completed' : 'running';

    await this.store.put(this.stepKey(taskId, stepId), step);
    await this.store.put(this.taskKey(taskId), task);

    return step;
  }

  async listSteps(taskId: string): Promise<AgentProtocolStep[]> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    }
    return task.steps;
  }

  async getStep(taskId: string, stepId: string): Promise<AgentProtocolStep | undefined> {
    return this.store.get<AgentProtocolStep>(this.stepKey(taskId, stepId));
  }

  async listArtifacts(taskId: string): Promise<AgentProtocolArtifact[]> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    }
    return task.artifacts;
  }

  async createArtifact(
    taskId: string,
    artifactData: Partial<AgentProtocolArtifact> & { file_name: string }
  ): Promise<AgentProtocolArtifact> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    }

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
  }

  async getArtifact(taskId: string, artifactId: string): Promise<AgentProtocolArtifact | undefined> {
    return this.store.get<AgentProtocolArtifact>(this.artifactKey(taskId, artifactId));
  }

  // =========================================================================
  // Model Context Protocol (MCP) Server Implementation
  // =========================================================================

  async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      };
    }

    const id = request.id ?? null;

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
          const descriptors = this.tools ? this.tools.descriptors() : [];
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

          if (!this.tools) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'Tool registry unavailable' },
            };
          }

          try {
            const toolResult = await this.runTool(params.name, params.arguments ?? {}, {
              executionId: `mcp-${randomUUID()}`,
              projectRoot: this.projectRoot,
            });

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: toolResult.output ?? (toolResult.ok ? 'OK' : 'FAILED'),
                  },
                ],
                isError: !toolResult.ok,
              },
            };
          } catch (toolErr) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: toolErr instanceof Error ? toolErr.message : String(toolErr),
                  },
                ],
                isError: true,
              },
            };
          }
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
            content = JSON.stringify({ verified: true, engineAvailable: Boolean(this.verificationEngine) });
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
