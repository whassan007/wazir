import type { AgentTurn } from '@wazir/core';

export const CANONICAL_ACP_TOOL_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

export type CanonicalAcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface AcpToolLocation {
  path: string;
  line?: number;
  column?: number;
}

export interface AcpDiffBlock {
  path: string;
  oldText?: string;
  newText: string;
  unifiedDiff: string;
}

export interface AcpPlanEntry {
  content: string;
  status: string;
  priority?: string;
}

export interface AcpSessionHandoffMetadata {
  acpSessionId: string;
  resumeSessionId?: string;
  checkpointId?: string;
  modeId?: string;
  modelId?: string;
  canResume: boolean;
}

export type NormalizedAcpStreamEvent =
  | {
      kind: 'thought';
      acpSessionId: string;
      text: string;
    }
  | {
      kind: 'text';
      acpSessionId: string;
      text: string;
    }
  | {
      kind: 'tool_call';
      acpSessionId: string;
      toolCallId: string;
      toolKind: CanonicalAcpToolKind;
      title: string;
      status?: string;
      rawInput?: unknown;
      locations: AcpToolLocation[];
      diffs: AcpDiffBlock[];
    }
  | {
      kind: 'tool_result';
      acpSessionId: string;
      toolCallId: string;
      toolKind: CanonicalAcpToolKind;
      title: string;
      ok: boolean;
      status: string;
      output: string;
      rawOutput?: unknown;
      locations: AcpToolLocation[];
      diffs: AcpDiffBlock[];
    }
  | {
      kind: 'diff';
      acpSessionId: string;
      toolCallId?: string;
      diffs: AcpDiffBlock[];
      locations: AcpToolLocation[];
    }
  | {
      kind: 'plan';
      acpSessionId: string;
      entries: AcpPlanEntry[];
    }
  | {
      kind: 'session_handoff';
      acpSessionId: string;
      handoff: AcpSessionHandoffMetadata;
    };

export interface AcpTrackedToolCall {
  toolCallId: string;
  title: string;
  toolKind: CanonicalAcpToolKind;
  rawInput?: unknown;
  locations: AcpToolLocation[];
  diffs: AcpDiffBlock[];
}

export interface AcpMapperState {
  readonly toolCalls: ReadonlyMap<string, AcpTrackedToolCall>;
}

export interface AcpMapperOptions {
  /** When true, also emits a Wazir `thought` turn for non-empty thought chunks. */
  emitThoughtTurns?: boolean;
}

export interface AcpMappedUpdateResult {
  turns: AgentTurn[];
  events: NormalizedAcpStreamEvent[];
  /** Assistant user-facing message delta (never includes internal thoughts). */
  answerDelta: string;
  /** Internal reasoning / thought delta (kept strictly separate from `answerDelta`). */
  thoughtDelta: string;
  handoff?: AcpSessionHandoffMetadata;
  nextState: AcpMapperState;
}

export function createInitialAcpMapperState(): AcpMapperState {
  return { toolCalls: new Map() };
}

export function normalizeAcpToolKind(rawKind: unknown): CanonicalAcpToolKind {
  if (typeof rawKind !== 'string') return 'other';
  const normalized = rawKind.trim().toLowerCase();
  return CANONICAL_ACP_TOOL_KINDS.has(normalized)
    ? (normalized as CanonicalAcpToolKind)
    : 'other';
}

export function formatUnifiedDiffBlock(
  filePath: string,
  oldText: string | undefined,
  newText: string,
): string {
  const cleanPath = filePath || 'unknown';
  const beforeLines = oldText !== undefined && oldText.length > 0 ? oldText.split('\n') : [];
  const afterLines = newText.length > 0 ? newText.split('\n') : [];
  const header = [
    `--- a/${cleanPath}`,
    `+++ b/${cleanPath}`,
    `@@ -${beforeLines.length > 0 ? 1 : 0},${beforeLines.length} +${afterLines.length > 0 ? 1 : 0},${afterLines.length} @@`,
  ];
  const body = [
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  return [...header, ...body].join('\n');
}

export function extractAcpText(content: unknown, fallbackText?: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if (obj.type === 'text' && typeof obj.text === 'string') {
      return obj.text;
    }
    if (obj.type === 'content' && obj.content) {
      return extractAcpText(obj.content);
    }
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const text = extractAcpText(item);
      if (text) parts.push(text);
    }
    if (parts.length > 0) return parts.join('');
  }
  if (typeof fallbackText === 'string') return fallbackText;
  return '';
}

export function extractAcpLocations(rawLocations: unknown): AcpToolLocation[] {
  if (!Array.isArray(rawLocations)) return [];
  const locations: AcpToolLocation[] = [];
  for (const item of rawLocations) {
    if (!item || typeof item !== 'object') continue;
    const loc = item as Record<string, unknown>;
    if (typeof loc.path !== 'string' || loc.path.trim().length === 0) continue;
    locations.push({
      path: loc.path,
      ...(typeof loc.line === 'number' && Number.isFinite(loc.line) ? { line: loc.line } : {}),
      ...(typeof loc.column === 'number' && Number.isFinite(loc.column) ? { column: loc.column } : {}),
    });
  }
  return locations;
}

export function extractAcpDiffBlocks(
  payload: Record<string, unknown>,
  fallbackLocations: readonly AcpToolLocation[] = [],
): AcpDiffBlock[] {
  const diffs: AcpDiffBlock[] = [];
  const content = payload.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      if (block.type === 'diff' && typeof block.path === 'string') {
        const oldText = typeof block.oldText === 'string' ? block.oldText : undefined;
        const newText = typeof block.newText === 'string' ? block.newText : '';
        const unifiedDiff =
          typeof block.unifiedDiff === 'string' && block.unifiedDiff.length > 0
            ? block.unifiedDiff
            : formatUnifiedDiffBlock(block.path, oldText, newText);
        diffs.push({
          path: block.path,
          ...(oldText !== undefined ? { oldText } : {}),
          newText,
          unifiedDiff,
        });
      }
    }
  }

  const directUnifiedDiff =
    typeof payload.unifiedDiff === 'string'
      ? payload.unifiedDiff
      : typeof payload.diff === 'string'
        ? payload.diff
        : payload.rawOutput &&
            typeof payload.rawOutput === 'object' &&
            typeof (payload.rawOutput as Record<string, unknown>).diff === 'string'
          ? String((payload.rawOutput as Record<string, unknown>).diff)
          : undefined;

  if (diffs.length === 0 && directUnifiedDiff && directUnifiedDiff.trim().length > 0) {
    const inferredPath =
      typeof payload.path === 'string' && payload.path.length > 0
        ? payload.path
        : fallbackLocations[0]?.path ?? '';
    diffs.push({
      path: inferredPath,
      newText: '',
      unifiedDiff: directUnifiedDiff,
    });
  }

  return diffs;
}

function extractToolUpdateOutput(
  payload: Record<string, unknown>,
  title: string,
  diffs: readonly AcpDiffBlock[],
): string {
  const contentText = Array.isArray(payload.content)
    ? payload.content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const block = item as Record<string, unknown>;
          if (block.type === 'diff') return '';
          return extractAcpText(block);
        })
        .filter((s) => s.length > 0)
        .join('\n')
    : '';
  if (contentText.trim().length > 0) return contentText;

  if (typeof payload.rawOutput === 'string' && payload.rawOutput.trim().length > 0) {
    return payload.rawOutput;
  }
  if (payload.rawOutput && typeof payload.rawOutput === 'object') {
    const rawObj = payload.rawOutput as Record<string, unknown>;
    const candidate = rawObj.output ?? rawObj.stdout ?? rawObj.content ?? rawObj.message;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  if (diffs.length > 0) {
    return diffs.map((d) => d.unifiedDiff).join('\n');
  }
  return title;
}

export function buildAcpSessionHandoffMetadata(params: {
  acpSessionId: string;
  resumeSessionId?: string;
  checkpointId?: string;
  modeId?: string;
  modelId?: string;
  canResume?: boolean;
}): AcpSessionHandoffMetadata {
  return {
    acpSessionId: params.acpSessionId,
    ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
    ...(params.checkpointId ? { checkpointId: params.checkpointId } : {}),
    ...(params.modeId ? { modeId: params.modeId } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    canResume: params.canResume ?? Boolean(params.acpSessionId),
  };
}

/**
 * Pure mapper translating a single ACP `session/update` notification payload into
 * structured Wazir `AgentTurn` objects and normalized ACP stream events.
 */
export function mapAcpSessionUpdate(
  sessionId: string,
  update: unknown,
  state: AcpMapperState = createInitialAcpMapperState(),
  options: AcpMapperOptions = {},
): AcpMappedUpdateResult {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return {
      turns: [],
      events: [],
      answerDelta: '',
      thoughtDelta: '',
      nextState: state,
    };
  }

  const u = update as Record<string, unknown>;
  const updateKind = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : '';
  const turns: AgentTurn[] = [];
  const events: NormalizedAcpStreamEvent[] = [];
  let answerDelta = '';
  let thoughtDelta = '';
  let handoff: AcpSessionHandoffMetadata | undefined;
  let nextState = state;

  switch (updateKind) {
    case 'agent_thought_chunk':
    case 'thought': {
      const text = extractAcpText(u.content, u.text);
      if (text.length > 0) {
        thoughtDelta = text;
        events.push({
          kind: 'thought',
          acpSessionId: sessionId,
          text,
        });
        if (options.emitThoughtTurns) {
          turns.push({
            kind: 'message',
            content: `[thought] ${text}`,
          });
        }
      }
      break;
    }

    case 'agent_message_chunk':
    case 'agent_message': {
      const text = extractAcpText(u.content, u.text);
      if (text.length > 0) {
        answerDelta = text;
        events.push({
          kind: 'text',
          acpSessionId: sessionId,
          text,
        });
      }
      break;
    }

    case 'tool_call': {
      const toolCallId = u.toolCallId !== undefined ? String(u.toolCallId) : '';
      const toolKind = normalizeAcpToolKind(u.kind);
      const title = String(u.title ?? (toolCallId || 'tool'));
      const locations = extractAcpLocations(u.locations);
      const diffs = extractAcpDiffBlocks(u, locations);

      if (toolCallId) {
        const nextMap = new Map(state.toolCalls);
        nextMap.set(toolCallId, {
          toolCallId,
          title,
          toolKind,
          rawInput: u.rawInput,
          locations,
          diffs,
        });
        nextState = { toolCalls: nextMap };
      }

      const toolInput: Record<string, unknown> = {
        title,
        ...(toolCallId ? { toolCallId } : {}),
        ...(sessionId ? { acpSessionId: sessionId } : {}),
        ...(u.rawInput !== undefined ? { input: u.rawInput } : {}),
        ...(locations.length > 0 ? { locations } : {}),
        ...(diffs.length > 0 ? { diffs } : {}),
      };

      turns.push({
        kind: 'tool_call',
        tool: toolKind,
        toolInput,
      });

      events.push({
        kind: 'tool_call',
        acpSessionId: sessionId,
        toolCallId,
        toolKind,
        title,
        ...(typeof u.status === 'string' ? { status: u.status } : {}),
        ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}),
        locations,
        diffs,
      });

      if (diffs.length > 0) {
        events.push({
          kind: 'diff',
          acpSessionId: sessionId,
          ...(toolCallId ? { toolCallId } : {}),
          diffs,
          locations,
        });
      }
      break;
    }

    case 'tool_call_update': {
      const toolCallId = u.toolCallId !== undefined ? String(u.toolCallId) : '';
      const prior = toolCallId ? state.toolCalls.get(toolCallId) : undefined;
      const title = String(u.title ?? prior?.title ?? (toolCallId || 'tool'));
      const toolKind = u.kind !== undefined ? normalizeAcpToolKind(u.kind) : (prior?.toolKind ?? 'other');
      const incomingLocations = extractAcpLocations(u.locations);
      const locations = incomingLocations.length > 0 ? incomingLocations : (prior?.locations ?? []);
      const incomingDiffs = extractAcpDiffBlocks(u, locations);
      const diffs = incomingDiffs.length > 0 ? incomingDiffs : (prior?.diffs ?? []);

      if (toolCallId) {
        const nextMap = new Map(state.toolCalls);
        nextMap.set(toolCallId, {
          toolCallId,
          title,
          toolKind,
          rawInput: u.rawInput ?? prior?.rawInput,
          locations,
          diffs,
        });
        nextState = { toolCalls: nextMap };
      }

      if (incomingDiffs.length > 0) {
        events.push({
          kind: 'diff',
          acpSessionId: sessionId,
          ...(toolCallId ? { toolCallId } : {}),
          diffs: incomingDiffs,
          locations,
        });
      }

      const status = typeof u.status === 'string' ? u.status : '';
      if (status === 'completed' || status === 'failed') {
        const ok = status === 'completed';
        const output = extractToolUpdateOutput(u, title, diffs);

        turns.push({
          kind: 'tool_result',
          tool: title,
          toolResult: {
            ok,
            output,
            durationMs: typeof u.durationMs === 'number' && Number.isFinite(u.durationMs) ? u.durationMs : 0,
            ...(toolCallId ? { toolCallId } : {}),
            ...(sessionId ? { acpSessionId: sessionId } : {}),
            toolKind,
            ...(u.rawOutput !== undefined ? { rawOutput: u.rawOutput } : {}),
            ...(locations.length > 0 ? { locations } : {}),
            ...(diffs.length > 0 ? { diffs } : {}),
          } as NonNullable<AgentTurn['toolResult']>,
        });

        events.push({
          kind: 'tool_result',
          acpSessionId: sessionId,
          toolCallId,
          toolKind,
          title,
          ok,
          status,
          output,
          ...(u.rawOutput !== undefined ? { rawOutput: u.rawOutput } : {}),
          locations,
          diffs,
        });
      }
      break;
    }

    case 'plan': {
      if (Array.isArray(u.entries)) {
        const entries: AcpPlanEntry[] = u.entries
          .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
          .map((e) => ({
            content: typeof e.content === 'string' ? e.content : '',
            status: typeof e.status === 'string' ? e.status : 'pending',
            ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
          }));
        turns.push({
          kind: 'message',
          content: `Plan:\n${entries.map((e) => `- [${e.status}] ${e.content}`).join('\n')}`,
        });
        events.push({
          kind: 'plan',
          acpSessionId: sessionId,
          entries,
        });
      }
      break;
    }

    case 'session_handoff':
    case 'session_info_update':
    case 'current_mode_update': {
      const meta =
        u._meta && typeof u._meta === 'object' && !Array.isArray(u._meta)
          ? (u._meta as Record<string, unknown>)
          : undefined;
      const pickStr = (key: string): string | undefined =>
        typeof u[key] === 'string'
          ? (u[key] as string)
          : meta && typeof meta[key] === 'string'
            ? (meta[key] as string)
            : undefined;
      handoff = buildAcpSessionHandoffMetadata({
        acpSessionId: sessionId,
        resumeSessionId: pickStr('resumeSessionId'),
        checkpointId: pickStr('checkpointId'),
        modeId: pickStr('currentModeId') ?? pickStr('modeId'),
        modelId: pickStr('modelId'),
        canResume:
          typeof u.canResume === 'boolean'
            ? u.canResume
            : meta && typeof meta.canResume === 'boolean'
              ? meta.canResume
              : true,
      });
      events.push({
        kind: 'session_handoff',
        acpSessionId: sessionId,
        handoff,
      });
      break;
    }

    default:
      break;
  }

  return {
    turns,
    events,
    answerDelta,
    thoughtDelta,
    ...(handoff ? { handoff } : {}),
    nextState,
  };
}

/**
 * Stateful session collector built atop the pure `mapAcpSessionUpdate` function.
 * Keeps `answer` and `thought` streams strictly isolated while preserving diffs,
 * locations, normalized stream events, and `acpSessionId` handoff metadata.
 */
export class AcpSessionEventCollector {
  private state: AcpMapperState = createInitialAcpMapperState();
  private answerText = '';
  private thoughtText = '';
  private readonly streamEvents: NormalizedAcpStreamEvent[] = [];
  private readonly diffBlocks: AcpDiffBlock[] = [];
  private latestHandoff?: AcpSessionHandoffMetadata;

  constructor(private readonly options: AcpMapperOptions = {}) {}

  ingest(sessionId: string, update: unknown): AcpMappedUpdateResult {
    const mapped = mapAcpSessionUpdate(sessionId, update, this.state, this.options);
    this.state = mapped.nextState;
    if (mapped.answerDelta) this.answerText += mapped.answerDelta;
    if (mapped.thoughtDelta) this.thoughtText += mapped.thoughtDelta;
    for (const ev of mapped.events) {
      this.streamEvents.push(ev);
      if (ev.kind === 'diff') {
        this.diffBlocks.push(...ev.diffs);
      }
    }
    if (mapped.handoff) {
      const merged: AcpSessionHandoffMetadata = {
        acpSessionId: mapped.handoff.acpSessionId || this.latestHandoff?.acpSessionId || sessionId,
        ...(mapped.handoff.resumeSessionId ?? this.latestHandoff?.resumeSessionId
          ? { resumeSessionId: mapped.handoff.resumeSessionId ?? this.latestHandoff?.resumeSessionId }
          : {}),
        ...(mapped.handoff.checkpointId ?? this.latestHandoff?.checkpointId
          ? { checkpointId: mapped.handoff.checkpointId ?? this.latestHandoff?.checkpointId }
          : {}),
        ...(mapped.handoff.modeId ?? this.latestHandoff?.modeId
          ? { modeId: mapped.handoff.modeId ?? this.latestHandoff?.modeId }
          : {}),
        ...(mapped.handoff.modelId ?? this.latestHandoff?.modelId
          ? { modelId: mapped.handoff.modelId ?? this.latestHandoff?.modelId }
          : {}),
        canResume: mapped.handoff.canResume,
      };
      this.latestHandoff = merged;
    }
    return mapped;
  }

  recordSessionHandoff(params: {
    acpSessionId: string;
    resumeSessionId?: string;
    checkpointId?: string;
    modeId?: string;
    modelId?: string;
    canResume?: boolean;
  }): AcpSessionHandoffMetadata {
    const handoff = buildAcpSessionHandoffMetadata(params);
    this.latestHandoff = handoff;
    this.streamEvents.push({
      kind: 'session_handoff',
      acpSessionId: params.acpSessionId,
      handoff,
    });
    return handoff;
  }

  getAnswer(): string {
    return this.answerText;
  }

  getThoughts(): string {
    return this.thoughtText;
  }

  getEvents(): readonly NormalizedAcpStreamEvent[] {
    return this.streamEvents;
  }

  getDiffs(): readonly AcpDiffBlock[] {
    return this.diffBlocks;
  }

  getHandoff(): AcpSessionHandoffMetadata | undefined {
    return this.latestHandoff;
  }
}
