import {
  ContextCompiler,
  computeUsableBudget,
  computeUtilization,
  estimateTokens,
  planOutputReserveTokens,
  type AgentRunRequest,
  type ChatMessage,
  type GroundedResult,
} from '@wazir/core';

function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content || '');
    if (m.toolCalls) {
      total += estimateTokens(JSON.stringify(m.toolCalls));
    }
  }
  return total;
}

/**
 * Partitions `messages[startIndex..]` into atomic turn groups so an `assistant`
 * message carrying `toolCalls` is NEVER split apart from its immediately
 * following `role: 'tool'` response messages.
 */
export function partitionAtomicTurnGroups(messages: readonly ChatMessage[], startIndex: number): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let i = startIndex;
  while (i < messages.length) {
    const current = messages[i];
    if (current.role === 'assistant' && current.toolCalls && current.toolCalls.length > 0) {
      const group: ChatMessage[] = [current];
      i += 1;
      while (i < messages.length && messages[i].role === 'tool') {
        group.push(messages[i]);
        i += 1;
      }
      groups.push(group);
    } else {
      groups.push([current]);
      i += 1;
    }
  }
  return groups;
}

export interface CompressionInput {
  messages: ChatMessage[];
  request: AgentRunRequest;
  effectiveContextTokens?: number;
  maxTokensPerTurn: number;
  toolSchemaTokens: number;
  compactionRatio: number;
  filesChanged: ReadonlySet<string>;
  unresolvedDiagnostics: string | null;
  webEvidence: ReadonlyMap<string, GroundedResult>;
  force?: boolean;
}

/**
 * Qwen Code 1.0 `ChatCompressionService`:
 *  - Compacts older turn groups into a structured `<state_snapshot>` XML block when
 *    context utilization reaches `compactionRatio` (default `0.70`) or on forced overflow recovery.
 *  - Slices strictly at atomic turn-group boundaries so `assistant.toolCalls` and `role: 'tool'`
 *    (`tool_call_id`) invariants are never broken for OpenAI, Anthropic, or Gemini.
 */
export class ChatCompressionService {
  maybeCompress(input: CompressionInput): string | null {
    const {
      messages,
      request,
      effectiveContextTokens,
      maxTokensPerTurn,
      toolSchemaTokens,
      compactionRatio,
      filesChanged,
      unresolvedDiagnostics,
      webEvidence,
      force = false,
    } = input;

    if (!force && (!effectiveContextTokens || effectiveContextTokens <= 0)) {
      return null;
    }

    // Keep system prompt (messages[0]) and initial user prompt (messages[1]) untouched
    const headCount = Math.min(2, messages.length);
    if (messages.length <= headCount + 2) {
      return null;
    }

    const beforeTokens = estimateMessagesTokens(messages);

    if (!force && effectiveContextTokens) {
      const outputReserve =
        request.reserve?.outputTokens ??
        planOutputReserveTokens({
          taskDescription: request.taskDescription,
          taskType: request.taskType,
          effectiveContextTokens,
        });
      const schemaReserve = request.reserve?.toolSchemaTokens ?? toolSchemaTokens;
      const safetyReserve =
        request.reserve?.safetyTokens ?? (effectiveContextTokens > 32_000 ? 5000 : Math.floor(effectiveContextTokens * 0.05));
      const usableBudget = computeUsableBudget({
        effectiveContextTokens,
        reserveOutputTokens: outputReserve,
        reserveToolSchemaTokens: schemaReserve,
        reserveSafetyTokens: safetyReserve,
      });
      const utilization = computeUtilization(beforeTokens, usableBudget);
      if (utilization < compactionRatio) {
        return null;
      }
    }

    const groups = partitionAtomicTurnGroups(messages, headCount);
    // Keep at least the 2 most recent atomic turn groups intact
    const keepTailGroups = Math.min(2, Math.max(1, groups.length - 1));
    const compressCount = groups.length - keepTailGroups;
    if (compressCount <= 0) {
      return null;
    }

    const compressedGroups = groups.slice(0, compressCount);
    const preservedTailGroups = groups.slice(compressCount);

    const inspectedPaths = new Set<string>();
    const recentActions: string[] = [];
    let latestTodoBlock = '';

    for (const grp of compressedGroups) {
      for (const msg of grp) {
        if (msg.role === 'assistant' && msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const args = (tc.arguments ?? {}) as Record<string, unknown>;
            if ((tc.name === 'read' || tc.name === 'edit' || tc.name === 'write' || tc.name === 'multi_edit') && typeof args.path === 'string') {
              inspectedPaths.add(args.path);
            } else if (tc.name === 'read_many_files' && Array.isArray(args.paths)) {
              for (const p of args.paths) if (typeof p === 'string') inspectedPaths.add(p);
            }
            recentActions.push(tc.name);
          }
        } else if (msg.role === 'tool' && msg.name === 'todo_write' && msg.content) {
          latestTodoBlock = msg.content;
        }
      }
    }

    const snapshotLines: string[] = [
      '<state_snapshot>',
      `  <overall_goal>${request.taskDescription.slice(0, 600)}</overall_goal>`,
      `  <files_inspected>${[...inspectedPaths].slice(-25).join(', ') || 'none'}</files_inspected>`,
      `  <files_modified>${[...filesChanged].join(', ') || 'none'}</files_modified>`,
      `  <compressed_actions count="${recentActions.length}">${recentActions.slice(-20).join(' -> ') || 'none'}</compressed_actions>`,
      `  <unresolved_diagnostics>${(unresolvedDiagnostics ?? 'none').slice(0, 800)}</unresolved_diagnostics>`,
    ];
    if (latestTodoBlock) {
      snapshotLines.push(`  <todo_state>\n${latestTodoBlock}\n  </todo_state>`);
    }
    for (const evidence of webEvidence.values()) {
      snapshotLines.push(`  <web_evidence>${new ContextCompiler().grounded(evidence, 500).content}</web_evidence>`);
    }
    snapshotLines.push('</state_snapshot>');
    snapshotLines.push('Earlier conversation turns were compacted into <state_snapshot> above. Continue from the current state.');

    const summaryMessage: ChatMessage = {
      role: 'user',
      content: snapshotLines.join('\n'),
    };

    const head = messages.slice(0, headCount);
    const tail = preservedTailGroups.flat();
    const candidate = [...head, summaryMessage, ...tail];
    const afterTokens = estimateMessagesTokens(candidate);

    if (!force && afterTokens >= beforeTokens) {
      return null;
    }

    messages.length = 0;
    messages.push(...candidate);
    const reduction = beforeTokens > 0 ? Math.round((1 - afterTokens / beforeTokens) * 100) : 0;
    return `context compacted: ${compressCount} turn group(s) -> <state_snapshot> (~${beforeTokens}->~${afterTokens} tokens, ${reduction}% smaller)`;
  }
}
