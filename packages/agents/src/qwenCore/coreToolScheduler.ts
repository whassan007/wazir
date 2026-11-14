import {
  ObservationCompactor,
  CODE_INTELLIGENCE_TOOLS,
  type AgentRuntime,
  type AgentTurn,
  type ChatMessage,
  type GroundedResult,
  type TerminationReason,
  type ToolResult,
} from '@wazir/core';
import { validateToolActionSemantics } from '../protocolAdapters.js';
import { normalizeQwenToolAlias, normalizeQwenToolInput } from './xmlToolFallback.js';
import type { QwenToolCallRequest } from './turn.js';

const PARALLEL_READ_ONLY_TOOLS = new Set<string>([
  'read',
  'read_many_files',
  'search',
  'glob',
  'todo_write',
  'web_search',
  'web_fetch',
  'recall_facts',
  ...CODE_INTELLIGENCE_TOOLS,
]);

const MAX_PARALLEL_CONCURRENCY = 6;

export interface ExecutedToolOutcome {
  callId: string;
  rawName: string;
  canonicalName: string;
  input: Record<string, unknown>;
  executed: boolean;
  result: ToolResult;
}

export interface ScheduledBatchOutcome {
  assistantToolCalls: NonNullable<ChatMessage['toolCalls']>;
  toolMessages: ChatMessage[];
  turnsToYield: AgentTurn[];
  outcomes: ExecutedToolOutcome[];
  executedCount: number;
  filesMutated: string[];
  checksPassed: string[];
  checksFailed: string[];
  fatalStop?: {
    terminationReason: TerminationReason;
    errorKind: 'protocol' | 'policy' | 'other';
    error: string;
    escalatable: boolean;
    raw?: string;
  };
}

const REQUIRED_TOOL_FIELDS: Record<string, string[]> = {
  read: ['path'],
  write: ['path', 'content'],
  edit: ['path', 'oldString', 'newString'],
  shell: ['command'],
  glob: ['pattern'],
};

function validateExtendedToolSemantics(
  tool: string,
  input: Record<string, unknown>,
): { ok: true; reason?: undefined } | { ok: false; reason: string } {
  if ('__malformedJson' in input) {
    return { ok: false, reason: `'${tool}' arguments were not valid JSON` };
  }
  const reqFields = REQUIRED_TOOL_FIELDS[tool];
  if (reqFields) {
    const missing = reqFields.filter((f) => input[f] === undefined || input[f] === null);
    if (missing.length > 0) {
      return { ok: false, reason: `missing ${missing.join(', ')}` };
    }
  }
  if (tool === 'multi_edit') {
    if (typeof input.path !== 'string' || !input.path.trim()) {
      return { ok: false, reason: `'multi_edit' requires a non-empty string 'path'` };
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { ok: false, reason: `'multi_edit' requires a non-empty 'edits' array` };
    }
    return { ok: true };
  }
  if (tool === 'read_many_files') {
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      return { ok: false, reason: `'read_many_files' requires a non-empty 'paths' array` };
    }
    return { ok: true };
  }
  if (tool === 'todo_write') {
    if (!Array.isArray(input.todos)) {
      return { ok: false, reason: `'todo_write' requires a 'todos' array` };
    }
    return { ok: true };
  }
  const base = validateToolActionSemantics(tool, input);
  return base.ok ? { ok: true } : { ok: false, reason: base.reason ?? `invalid '${tool}' arguments` };
}

function isParallelSafeTool(toolName: string, runtimeTools: AgentRuntime['tools']): boolean {
  const found = runtimeTools.find((t) => t.name === toolName);
  const descriptor = found?.descriptor as
    | { sideEffectClass?: string; concurrencySafety?: string }
    | undefined;
  if (descriptor?.concurrencySafety === 'parallel' || descriptor?.sideEffectClass === 'READ_ONLY') {
    return true;
  }
  if (descriptor?.concurrencySafety === 'exclusive') {
    return false;
  }
  return PARALLEL_READ_ONLY_TOOLS.has(toolName);
}

/**
 * Qwen Code 1.0 `CoreToolScheduler` adapted to Wazir's `AgentRuntime.executeTool` pipeline:
 *  - Normalizes habitual Qwen/Claude/Gemini aliases to canonical Wazir tool names
 *  - Enforces 3-strike unknown-tool guard (`MODEL_PROTOCOL_BUDGET_EXHAUSTED`) and 2-strike identical validation guard (`IDENTICAL_VALIDATION_FAILURE`)
 *  - Executes contiguous read-only tool batches concurrently (`Promise.all`, bounded to 6) and mutating/shell/check calls sequentially
 *  - Preserves strict 1:1 `assistant.toolCalls[i]` <-> `role: 'tool'` (`toolCallId`) pairing in transcript
 */
export class CoreToolScheduler {
  private incompatibleStrikes = 0;
  private consecutiveValidationFailures = 0;
  private lastValidationKey = '';
  public actionAttempts = 0;
  public validActions = 0;
  public validationErrors = 0;
  public malformedActions = 0;

  private readonly compactor = new ObservationCompactor({ maxChars: 12_000 });

  resetModelCounters(): void {
    this.incompatibleStrikes = 0;
    this.consecutiveValidationFailures = 0;
    this.lastValidationKey = '';
  }

  async scheduleBatch(params: {
    calls: QwenToolCallRequest[];
    runtime: AgentRuntime;
    availableToolNames: ReadonlySet<string>;
    remainingToolBudget: number;
    webEvidence: Map<string, GroundedResult>;
    isCancelled?: () => boolean;
  }): Promise<ScheduledBatchOutcome> {
    const { calls, runtime, availableToolNames, webEvidence, isCancelled } = params;
    let remainingBudget = params.remainingToolBudget;

    const assistantToolCalls: NonNullable<ChatMessage['toolCalls']> = [];
    const toolMessagesByIndex = new Array<ChatMessage>(calls.length);
    const turnsToYield: AgentTurn[] = [];
    const outcomes: ExecutedToolOutcome[] = [];
    const filesMutated: string[] = [];
    const checksPassed: string[] = [];
    const checksFailed: string[] = [];
    let executedCount = 0;
    let fatalStop: ScheduledBatchOutcome['fatalStop'];

    interface PreparedCall {
      idx: number;
      id: string;
      rawName: string;
      canonicalName: string;
      input: Record<string, unknown>;
      raw?: string;
      parallelSafe: boolean;
      preRejectedError?: string;
    }

    const prepared: PreparedCall[] = [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      this.actionAttempts += 1;
      const canonicalName = normalizeQwenToolAlias(call.name, availableToolNames);
      const normalizedInput = normalizeQwenToolInput(canonicalName, call.input);

      assistantToolCalls.push({
        id: call.id,
        name: canonicalName,
        arguments: normalizedInput,
      });

      const effectiveRaw = call.raw || JSON.stringify({ name: canonicalName, input: normalizedInput });

      if (!availableToolNames.has(canonicalName)) {
        this.incompatibleStrikes += 1;
        this.validationErrors += 1;
        const availList = [...availableToolNames].join(', ') || 'none';
        const errMsg = `Tool '${call.name}' is not available in this session. Available tools: ${availList}`;
        prepared.push({
          idx: i,
          id: call.id,
          rawName: call.name,
          canonicalName,
          input: normalizedInput,
          raw: effectiveRaw,
          parallelSafe: false,
          preRejectedError: errMsg,
        });
        if (this.incompatibleStrikes >= 3 && !fatalStop) {
          fatalStop = {
            terminationReason: 'MODEL_PROTOCOL_BUDGET_EXHAUSTED',
            errorKind: 'protocol',
            error: `Three incompatible actions rejected (${errMsg}); select a smoke-tested model/runtime.`,
            escalatable: true,
            raw: effectiveRaw,
          };
        }
        continue;
      }

      const sem = validateExtendedToolSemantics(canonicalName, normalizedInput);
      if (!sem.ok) {
        if ('__malformedJson' in normalizedInput) {
          this.malformedActions += 1;
        } else {
          this.validationErrors += 1;
        }
        const vKey = `${canonicalName}:${sem.reason}`;
        if (vKey === this.lastValidationKey) {
          this.consecutiveValidationFailures += 1;
        } else {
          this.lastValidationKey = vKey;
          this.consecutiveValidationFailures = 1;
        }
        prepared.push({
          idx: i,
          id: call.id,
          rawName: call.name,
          canonicalName,
          input: normalizedInput,
          raw: effectiveRaw,
          parallelSafe: false,
          preRejectedError: `ACTION_VALIDATION_FAILED: '${canonicalName}' ${sem.reason}`,
        });
        if (this.consecutiveValidationFailures >= 2 && !fatalStop) {
          fatalStop = {
            terminationReason: 'IDENTICAL_VALIDATION_FAILURE',
            errorKind: 'protocol',
            error: `Repeated identical validation failure on '${canonicalName}': ${sem.reason}`,
            escalatable: true,
            raw: effectiveRaw,
          };
        } else {
          turnsToYield.push({
            kind: 'message',
            content: `ACTION_VALIDATION_FAILED: '${canonicalName}' ${sem.reason}`,
            tool: canonicalName,
            raw: effectiveRaw,
          });
        }
        continue;
      }

      // Valid call resets consecutive protocol/validation strike streaks
      this.incompatibleStrikes = 0;
      this.consecutiveValidationFailures = 0;
      this.lastValidationKey = '';
      this.validActions += 1;

      prepared.push({
        idx: i,
        id: call.id,
        rawName: call.name,
        canonicalName,
        input: normalizedInput,
        raw: effectiveRaw,
        parallelSafe: isParallelSafeTool(canonicalName, runtime.tools),
      });
    }

    // If a pre-dispatch 3-strike protocol or 2-strike validation guard already tripped,
    // record synthetic error responses without executing any side-effecting tool in the batch.
    if (fatalStop) {
      for (const p of prepared) {
        const errText = p.preRejectedError ?? 'Skipped due to protocol validation halt in batch.';
        const failRes: ToolResult = {
          ok: false,
          output: '',
          error: errText,
          failureClass: 'TOOL_VALIDATION_FAILED',
          durationMs: 0,
        };
        toolMessagesByIndex[p.idx] = {
          role: 'tool',
          toolCallId: p.id,
          name: p.canonicalName,
          content: `ERROR: ${errText}`,
        };
        outcomes.push({
          callId: p.id,
          rawName: p.rawName,
          canonicalName: p.canonicalName,
          input: p.input,
          executed: false,
          result: failRes,
        });
      }
      return {
        assistantToolCalls,
        toolMessages: toolMessagesByIndex,
        turnsToYield,
        outcomes,
        executedCount: 0,
        filesMutated,
        checksPassed,
        checksFailed,
        fatalStop,
      };
    }

    const recordCompleted = (p: PreparedCall, result: ToolResult, executed: boolean) => {
      if (executed) {
        turnsToYield.push({
          kind: 'tool_call',
          tool: p.canonicalName,
          toolInput: p.input,
          toolResult: result,
          raw: p.raw,
        });
      }

      if (result.ok && (p.canonicalName === 'web_fetch' || p.canonicalName === 'web_search') && result.metadata?.webEvidence) {
        const evidence = result.metadata.webEvidence as GroundedResult;
        webEvidence.set(evidence.kind === 'web_document' ? evidence.citation.citationId : evidence.query, evidence);
        while (webEvidence.size > 4) {
          const oldest = webEvidence.keys().next().value;
          if (oldest !== undefined) webEvidence.delete(oldest);
        }
      }

      if (result.fileMutations) {
        for (const m of result.fileMutations) {
          if (m.changed && m.path) {
            filesMutated.push(m.path);
          }
        }
      } else if (result.ok && (p.canonicalName === 'write' || p.canonicalName === 'edit' || p.canonicalName === 'multi_edit') && typeof p.input.path === 'string') {
        // Fallback for mock runtimes in unit tests that return `{ ok: true }` without `fileMutations`
        filesMutated.push(p.input.path);
      }

      if (['build', 'test', 'lint', 'typecheck'].includes(p.canonicalName)) {
        if (result.ok) checksPassed.push(p.canonicalName);
        else checksFailed.push(p.canonicalName);
      }

      const compacted = this.compactor.compact(p.canonicalName, p.input, {
        durationMs: result.durationMs ?? 0,
        ok: result.ok,
        output: result.output ?? '',
        error: result.error,
        metadata: result.metadata,
      });
      const content = result.ok || compacted.compacted ? compacted.text : `ERROR: ${compacted.text}`;
      toolMessagesByIndex[p.idx] = {
        role: 'tool',
        toolCallId: p.id,
        name: p.canonicalName,
        content,
      };
      outcomes.push({
        callId: p.id,
        rawName: p.rawName,
        canonicalName: p.canonicalName,
        input: p.input,
        executed,
        result,
      });
    };

    // Execute in contiguous stages: parallel read-only runs vs sequential exclusive runs
    let cursor = 0;
    while (cursor < prepared.length) {
      const current = prepared[cursor];

      if (isCancelled?.()) {
        recordCompleted(
          current,
          { ok: false, output: '', error: 'Cancelled before dispatch', failureClass: 'CANCELLED', durationMs: 0 },
          false,
        );
        cursor += 1;
        continue;
      }

      if (current.preRejectedError) {
        recordCompleted(
          current,
          { ok: false, output: '', error: current.preRejectedError, failureClass: 'TOOL_VALIDATION_FAILED', durationMs: 0 },
          false,
        );
        cursor += 1;
        continue;
      }

      if (remainingBudget <= 0) {
        if (!fatalStop) {
          fatalStop = {
            terminationReason: 'MAX_TOOL_CALLS',
            errorKind: 'other',
            error: 'MAX_TOOL_CALLS: tool-call budget exhausted',
            escalatable: false,
          };
        }
        recordCompleted(
          current,
          { ok: false, output: '', error: 'Skipped: tool-call budget exhausted', durationMs: 0 },
          false,
        );
        cursor += 1;
        continue;
      }

      if (current.parallelSafe) {
        const parallelGroup: PreparedCall[] = [];
        while (
          cursor < prepared.length &&
          prepared[cursor].parallelSafe &&
          !prepared[cursor].preRejectedError &&
          parallelGroup.length < MAX_PARALLEL_CONCURRENCY &&
          parallelGroup.length < remainingBudget
        ) {
          parallelGroup.push(prepared[cursor]);
          cursor += 1;
        }

        remainingBudget -= parallelGroup.length;
        executedCount += parallelGroup.length;

        const results = await Promise.all(
          parallelGroup.map(async (item) => {
            try {
              return await runtime.executeTool(item.canonicalName, item.input);
            } catch (err) {
              return {
                ok: false,
                output: '',
                error: err instanceof Error ? err.message : String(err),
                durationMs: 0,
              } satisfies ToolResult;
            }
          }),
        );

        for (let k = 0; k < parallelGroup.length; k++) {
          recordCompleted(parallelGroup[k], results[k], true);
        }
        continue;
      }

      // Exclusive / mutating / shell / check tool: run strictly sequentially
      remainingBudget -= 1;
      executedCount += 1;
      let result: ToolResult;
      try {
        result = await runtime.executeTool(current.canonicalName, current.input);
      } catch (err) {
        result = {
          ok: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        };
      }
      recordCompleted(current, result, true);
      cursor += 1;
    }

    return {
      assistantToolCalls,
      toolMessages: toolMessagesByIndex,
      turnsToYield,
      outcomes,
      executedCount,
      filesMutated,
      checksPassed,
      checksFailed,
      fatalStop,
    };
  }
}
