import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  SubagentTask,
  SubagentsLedger,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from '@wazir/core';
import { WazirQwenAgent } from './wazirQwenAgent.js';

export type QwenSubagentRole = 'explore' | 'plan' | 'worker';

export const READ_ONLY_SUBAGENT_TOOLS = new Set<string>([
  'read',
  'read_many_files',
  'search',
  'glob',
  'git',
  'todo_write',
  'goToDefinition',
  'findReferences',
  'findCallers',
  'findImplementations',
  'documentSymbols',
  'workspaceSymbols',
  'code_intelligence',
  'web_search',
  'web_fetch'
]);

export function resolveSubagentRole(input: Record<string, unknown>): QwenSubagentRole {
  const role = (input.role as string ?? input.subagent_type as string ?? '').toLowerCase();
  if (role === 'plan') return 'plan';
  if (role === 'worker' || role === 'general-purpose' || role === 'coder') return 'worker';
  if (role === 'explore') return 'explore';
  if (Array.isArray(input.expectedArtifacts) && input.expectedArtifacts.length > 0) {
    return 'worker';
  }
  return 'explore';
}

export function filterToolsForSubagentRole(
  tools: AgentRuntime['tools'],
  role: QwenSubagentRole,
): AgentRuntime['tools'] {
  const filtered = tools.filter((t) => t.name !== 'dispatch_subagent' && t.name !== 'task');
  if (role === 'explore' || role === 'plan') {
    return filtered.filter((t) => READ_ONLY_SUBAGENT_TOOLS.has(t.name));
  }
  return filtered;
}

export interface QwenSubagentExecutorOptions {
  ledger?: SubagentsLedger;
  parentModelId: string;
  parentProjectRoot: string;
  parentRuntime: AgentRuntime;
  currentDepth?: number;
  maxDepth?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  isCancelled?: () => boolean;
}

export function createQwenSubagentExecutor(
  options: QwenSubagentExecutorOptions,
): (input: Record<string, unknown>, ctx?: ToolExecutionContext) => Promise<ToolResult> {
  return async (input: Record<string, unknown>, ctx?: ToolExecutionContext) => {
    const startedAt = Date.now();
    const depth = options.currentDepth ?? 0;
    const maxDepth = options.maxDepth ?? 1;
    if (depth >= maxDepth) {
      return {
        ok: false,
        output: '',
        error: `Maximum subagent nesting depth (${maxDepth}) exceeded; subagents cannot spawn nested subagents.`,
        failureClass: 'POLICY_DENIED',
        durationMs: Date.now() - startedAt
      };
    }

    const description = String(input.description ?? input.prompt ?? '').trim();
    if (!description) {
      return {
        ok: false,
        output: '',
        error: 'Subagent description is required',
        failureClass: 'TOOL_VALIDATION_FAILED',
        durationMs: Date.now() - startedAt
      };
    }

    const role = resolveSubagentRole(input);
    const title =
      typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : description.slice(0, 80);
    const subagentId = 'sub-' + randomUUID().slice(0, 8);
    const expectedArtifacts = Array.isArray(input.expectedArtifacts)
      ? input.expectedArtifacts.map(String)
      : undefined;

    const allowedTools = filterToolsForSubagentRole(options.parentRuntime.tools, role);
    const allowedNames = new Set(allowedTools.map((t) => t.name));

    const events: SubagentTask['events'] = [
      { at: startedAt, kind: 'status', text: `Started ${role} subagent` }
    ];

    if (options.ledger) {
      options.ledger.upsert({
        id: subagentId,
        kind: role === 'explore' ? 'search' : 'harness',
        title,
        status: 'running',
        createdAt: startedAt,
        updatedAt: startedAt,
        backend: options.parentModelId,
        source: role,
        request: description,
        activity: `Running ${role} subagent`,
        output: '',
        events
      });
    }

    const childRuntime: AgentRuntime = {
      ...options.parentRuntime,
      tools: allowedTools,
      executeTool: async (toolName, toolInput) => {
        if (!allowedNames.has(toolName)) {
          return {
            ok: false,
            output: '',
            error: `Tool '${toolName}' is not permitted for '${role}' subagent role`,
            failureClass: 'POLICY_DENIED',
            durationMs: 0
          };
        }

        events.push({ at: Date.now(), kind: 'tool', text: `${toolName}` });
        options.ledger?.upsert({
          id: subagentId,
          kind: role === 'explore' ? 'search' : 'harness',
          title,
          status: 'running',
          createdAt: startedAt,
          updatedAt: Date.now(),
          backend: options.parentModelId,
          source: role,
          request: description,
          activity: `Executing ${toolName}`,
          events: [...events]
        });

        return await options.parentRuntime.executeTool(toolName, toolInput);
      }
    };

    const childAgent = new WazirQwenAgent({
      maxTurns: options.maxTurns ?? 12,
      maxToolCalls: options.maxToolCalls ?? 24,
      maxRepairCycles: role === 'worker' ? 2 : 0,
      systemPromptExtra:
        role === 'explore'
          ? 'You are a read-only exploration subagent. Inspect the codebase concisely and return factual findings.'
          : role === 'plan'
          ? 'You are a read-only planning subagent. Analyze relevant files and return a clear implementation plan without modifying files.'
          : 'You are a focused worker subagent. Complete only the delegated subtask.'
    });

    let doneSummary = '';
    let doneTurn = false;
    let errorMessage = '';
    let lastMessage = '';
    let turnsCount = 0;
    let toolCallsCount = 0;
    const filesChanged = new Set<string>();

    try {
      for await (const turn of childAgent.run(
        {
          modelId: options.parentModelId,
          taskDescription: description,
          taskType: role === 'worker' ? 'coding' : 'code_analysis',
          projectRoot: ctx?.projectRoot ?? options.parentProjectRoot,
          subagentDepth: depth + 1,
          mutationRequired:
            role === 'worker' && Boolean(expectedArtifacts && expectedArtifacts.length > 0),
          expectedArtifacts,
          isCancelled: options.isCancelled
        },
        childRuntime
      )) {
        if (turn.kind === 'done') {
          doneTurn = true;
          doneSummary = turn.content ?? '';
        } else if (turn.kind === 'error') {
          errorMessage = turn.error ?? 'Subagent failed';
        } else if (turn.kind === 'message') {
          if (turn.content) lastMessage = turn.content;
        } else if (turn.kind === 'tool_call' || turn.kind === 'tool_result') {
          if (turn.kind === 'tool_call') {
            toolCallsCount += 1;
          }
          if (turn.toolResult?.fileMutations) {
            for (const mutation of turn.toolResult.fileMutations) {
              if (mutation.changed || mutation.succeeded) {
                filesChanged.add(mutation.path);
              }
            }
          }
        }
        turnsCount += 1;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const status = options.isCancelled?.()
      ? 'cancelled'
      : errorMessage || !doneTurn
      ? 'failed'
      : 'completed';

    const bodySummary = doneSummary || lastMessage || 'Task completed successfully.';
    const formattedCondensedSummary = `[Subagent ${subagentId} (${role}) ${status}] Summary: ${
      status === 'completed' ? bodySummary : `Failed with error: ${errorMessage || 'Subagent exited without completion'}`
    } Files changed: ${Array.from(filesChanged).join(', ') || 'None'}`;

    if (options.ledger) {
      options.ledger.upsert({
        id: subagentId,
        kind: role === 'explore' ? 'search' : 'harness',
        title,
        status,
        createdAt: startedAt,
        updatedAt: Date.now(),
        backend: options.parentModelId,
        source: role,
        request: description,
        activity: formattedCondensedSummary,
        output: formattedCondensedSummary,
        events
      });
    }

    return {
      ok: status === 'completed',
      output: formattedCondensedSummary,
      error: status === 'completed' ? undefined : errorMessage,
      durationMs: Date.now() - startedAt,
      metadata: {
        subagentId,
        role,
        turns: turnsCount,
        toolCalls: toolCallsCount,
        filesChanged: [...filesChanged]
      }
    };
  };
}

export function createQwenSubagentTool(
  options: QwenSubagentExecutorOptions,
): Tool {
  return {
    descriptor: {
      name: 'dispatch_subagent',
      description: 'Spawn a bounded subagent (explore, plan, or worker) for an isolated subtask and return its condensed summary.',
      permissions: ['subagent'],
      riskLevel: 'medium',
      environment: 'local',
      provenance: { source: 'subagent' },
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          role: { type: 'string', enum: ['explore', 'plan', 'worker'] },
          title: { type: 'string' },
          expectedArtifacts: { type: 'array', items: { type: 'string' } }
        },
        required: ['description']
      }
    },
    execute: createQwenSubagentExecutor(options)
  };
}
