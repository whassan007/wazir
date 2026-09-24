import type {
  ContextCandidate,
  ContextProvider,
  ContextRequest,
} from '../types/context.js';
import { estimateTokens } from './contextCompiler.js';
import { ScopedInstructionResolver } from './instructionResolver.js';

/**
 * System and core instructions provider (Tier 1: PINNED).
 */
export class SystemContextProvider implements ContextProvider {
  readonly id = 'system';

  async provide(request: ContextRequest): Promise<ContextCandidate[]> {
    const candidates: ContextCandidate[] = [];
    const coreSystem = "You are Wazir's native coding agent, executing inside a sandboxed project.\n" +
      "You act in phases: plan, inspect, implement, test, debug, repair, verify, complete.\n" +
      "Each turn you MUST output exactly one JSON object and nothing else.";

    candidates.push({
      id: 'sys-core',
      source: this.id,
      kind: 'system',
      category: 'PINNED',
      label: 'Core System Instructions',
      content: coreSystem,
      priority: 100,
      estimatedTokens: estimateTokens(coreSystem),
      reasonIncluded: 'Core system instructions are mandatory and pinned',
    });

    return candidates;
  }
}

/**
 * Task and acceptance criteria provider (Tier 1: PINNED).
 */
export class TaskContextProvider implements ContextProvider {
  readonly id = 'task';

  async provide(request: ContextRequest): Promise<ContextCandidate[]> {
    const candidates: ContextCandidate[] = [];

    candidates.push({
      id: 'task-description',
      source: this.id,
      kind: 'task',
      category: 'PINNED',
      label: 'Task Objective',
      content: `User Task: ${request.taskDescription}`,
      priority: 95,
      estimatedTokens: estimateTokens(request.taskDescription) + 5,
      reasonIncluded: 'Current user task objective is mandatory and pinned',
    });

    if (request.acceptanceCriteria && request.acceptanceCriteria.length > 0) {
      const criteriaText = `Acceptance Criteria:\n` + request.acceptanceCriteria.map((c) => `- ${c}`).join('\n');
      candidates.push({
        id: 'task-criteria',
        source: this.id,
        kind: 'task',
        category: 'PINNED',
        label: 'Acceptance Criteria',
        content: criteriaText,
        priority: 92,
        estimatedTokens: estimateTokens(criteriaText),
        reasonIncluded: 'Explicit acceptance criteria are pinned',
      });
    }

    return candidates;
  }
}

/**
 * Instruction context provider with localized scope routing (Tier 3: RELEVANT / PINNED).
 */
export class InstructionContextProvider implements ContextProvider {
  readonly id = 'instructions';
  private readonly resolver: ScopedInstructionResolver;

  constructor(resolver: ScopedInstructionResolver = new ScopedInstructionResolver()) {
    this.resolver = resolver;
  }

  async provide(request: ContextRequest): Promise<ContextCandidate[]> {
    const candidates: ContextCandidate[] = [];
    const resolved = await this.resolver.resolve({
      projectRoot: request.projectRoot,
      workingDirectory: request.workingDirectory,
      activeFiles: request.activeFiles,
      task: request.taskDescription,
      agentRole: request.agentRole,
      phase: request.phase,
    });

    for (let i = 0; i < resolved.length; i++) {
      const item = resolved[i];
      const isRoot = item.scope === 'root';
      candidates.push({
        id: `instr-${item.path}`,
        source: this.id,
        kind: 'system',
        category: isRoot ? 'PINNED' : 'RELEVANT',
        label: `Project Instructions: ${item.path}`,
        content: item.content,
        priority: item.priority,
        estimatedTokens: item.tokenCount,
        scope: item.scope,
        sourceUri: item.path,
        reasonIncluded: item.reasonIncluded,
      });
    }

    return candidates;
  }
}

/**
 * Current execution state provider (Tier 2: ACTIVE).
 */
export class ExecutionStateContextProvider implements ContextProvider {
  readonly id = 'execution_state';

  async provide(request: ContextRequest): Promise<ContextCandidate[]> {
    const candidates: ContextCandidate[] = [];

    if (request.activeErrors && request.activeErrors.length > 0) {
      const errText = `Active Diagnostics and Errors:\n` + request.activeErrors.join('\n\n');
      candidates.push({
        id: 'exec-active-errors',
        source: this.id,
        kind: 'task',
        category: 'ACTIVE',
        label: 'Active Diagnostics',
        content: errText,
        priority: 88,
        estimatedTokens: estimateTokens(errText),
        reasonIncluded: 'Current unresolved error requires repair',
      });
    }

    if (request.activeDiff) {
      candidates.push({
        id: 'exec-active-diff',
        source: this.id,
        kind: 'repository',
        category: 'ACTIVE',
        label: 'Current Workspace Diff',
        content: request.activeDiff,
        priority: 85,
        estimatedTokens: estimateTokens(request.activeDiff),
        reasonIncluded: 'Current code mutations in progress',
      });
    }

    return candidates;
  }
}

/**
 * Historical conversation turns provider (Tier 4 & 5: Tail + Compressible).
 */
export class HistoryContextProvider implements ContextProvider {
  readonly id = 'history';

  async provide(request: ContextRequest): Promise<ContextCandidate[]> {
    const candidates: ContextCandidate[] = [];
    const history = request.recentHistory ?? [];

    for (let i = 0; i < history.length; i++) {
      const part = history[i];
      candidates.push({
        id: part.id ?? `turn-${i + 1}`,
        source: this.id,
        kind: part.kind,
        category: part.category ?? 'COMPRESSIBLE',
        label: part.label,
        content: part.content,
        priority: typeof part.priority === 'number' ? part.priority : 50,
        tokens: part.tokens,
        estimatedTokens: part.tokens ?? estimateTokens(part.content),
        contentHash: part.evidenceHash,
        sourceUri: part.sourceUri,
        scope: part.scope,
        reasonIncluded: part.reasonIncluded,
        metadata: part.metadata,
      });
    }

    return candidates;
  }
}
