import type { Task } from '../types/task.js';
import type {
  ModelCapabilityCategory,
  ExecutionPhase,
  ProgrammingLanguage,
  TaskCapabilityClassification,
} from '../types/modelIntelligence.js';

export class TaskCapabilityClassifier {
  /**
   * Deterministically classifies a task's capability requirements,
   * target execution phase, and programming language.
   */
  public classify(task: Task): TaskCapabilityClassification {
    const reasons: string[] = [];
    const anyTask = task as unknown as Record<string, unknown>;
    const text = `${task.title || ''} ${task.input || ''} ${(anyTask.description as string) || ''}`.toLowerCase();
    const metadata = (anyTask.metadata ?? {}) as Record<string, unknown>;

    // 1. Explicit metadata override
    if (metadata.capabilityCategory && typeof metadata.capabilityCategory === 'string') {
      const cat = metadata.capabilityCategory as ModelCapabilityCategory;
      reasons.push(`Explicit capability category '${cat}' specified in task metadata`);
      return {
        primaryCategory: cat,
        secondaryCategories: [],
        relevantCategories: [cat],
        phase: (metadata.phase as ExecutionPhase) || this.detectPhase(task, text),
        language: (metadata.language as ProgrammingLanguage) || this.detectLanguage(task, text),
        confidence: 1.0,
        reasons,
      };
    }

    // 2. Detect Language
    const language = (metadata.language as ProgrammingLanguage) || this.detectLanguage(task, text);
    if (language !== 'other') {
      reasons.push(`Language '${language}' detected from file extensions or task description`);
    }

    // 3. Detect Phase
    const phase = (metadata.phase as ExecutionPhase) || this.detectPhase(task, text);
    reasons.push(`Execution phase '${phase}' inferred from task semantics`);

    // 4. Primary & Secondary Category Classification
    const secondaryCategories: ModelCapabilityCategory[] = [];
    let primaryCategory: ModelCapabilityCategory = 'implementation';
    let confidence = 0.8;

    if (
      /\b(compiler error|syntax error|typecheck|tsc error|build fail|compilation error|undefined type|borrow checker)\b/i.test(text)
    ) {
      primaryCategory = 'compile_repair';
      confidence = 0.95;
      reasons.push('Task involves fixing compiler, syntax, or typechecking errors');
    } else if (
      /\b(test fail|failing test|vitest|jest|pytest|broken test|regression test|fix test)\b/i.test(text)
    ) {
      primaryCategory = 'test_repair';
      confidence = 0.95;
      reasons.push('Task targets repairing failing unit or integration tests');
    } else if (
      task.type === 'debugging' ||
      /\b(localize|root cause|stack trace|culprit|where is the bug|isolate issue)\b/i.test(text)
    ) {
      primaryCategory = 'bug_localization';
      confidence = 0.9;
      reasons.push('Task specifies debugging, root-cause localization, or symptom isolation');
    } else if (
      task.type === 'architecture' ||
      /\b(architecture|system design|subsystem|decompose|job graph|component hierarchy|topology)\b/i.test(text)
    ) {
      primaryCategory = 'architecture_reasoning';
      confidence = 0.9;
      reasons.push('Task focuses on architectural reasoning, system structure, or decomposition');
    } else if (
      task.type === 'research' ||
      /\b(navigate|find file|grep|symbol search|locate definition|explore repo|list files)\b/i.test(text)
    ) {
      primaryCategory = 'repository_navigation';
      confidence = 0.85;
      reasons.push('Task requires repository navigation, file searching, or symbol discovery');
    } else if (
      /\b(explain code|comprehend|ast|call hierarchy|interface contract|read logic)\b/i.test(text)
    ) {
      primaryCategory = 'code_comprehension';
      confidence = 0.85;
      reasons.push('Task requires deep code comprehension or semantic contract understanding');
    } else if (
      /\b(tool|mcp|execute tool|tool schema|tool chaining|subcommand|shell|pty)\b/i.test(text)
    ) {
      primaryCategory = 'tool_use';
      confidence = 0.85;
      reasons.push('Task emphasizes tool execution, parameter synthesis, or protocol interactions');
    } else if (
      /\b(verify|verification oracle|evidence check|audit proof|assert pass)\b/i.test(text)
    ) {
      primaryCategory = 'verification_reasoning';
      confidence = 0.9;
      reasons.push('Task centers on verification reasoning and evidence auditing');
    } else if (
      /\b(subagent|delegate|spawn agent|handoff|dispatch worker)\b/i.test(text)
    ) {
      primaryCategory = 'delegation';
      confidence = 0.85;
      reasons.push('Task involves subagent delegation or worker dispatch');
    } else if (
      /\b(long horizon|multi-turn|workflow|complex migration|multi-step plan)\b/i.test(text)
    ) {
      primaryCategory = 'long_horizon_execution';
      confidence = 0.8;
      reasons.push('Task requires sustained multi-turn execution over long horizons');
    } else {
      primaryCategory = 'implementation';
      reasons.push('Task entails feature implementation, code generation, or enhancement');
    }

    // Secondary categories
    if (primaryCategory !== 'tool_use' && task.requirements?.toolCalling) {
      secondaryCategories.push('tool_use');
    }
    if (primaryCategory !== 'verification_reasoning' && (task.requirements as Record<string, unknown>)?.verification) {
      secondaryCategories.push('verification_reasoning');
    }
    if ((primaryCategory as string) !== 'context_efficiency' && (task.requirements?.minimumContext ?? 0) > 30_000) {
      secondaryCategories.push('context_efficiency');
    }

    const relevantCategories = Array.from(new Set([primaryCategory, ...secondaryCategories]));
    return {
      primaryCategory,
      secondaryCategories,
      relevantCategories,
      phase,
      language,
      confidence,
      reasons,
    };
  }

  private detectLanguage(task: Task, text: string): ProgrammingLanguage {
    const anyTask = task as unknown as Record<string, unknown>;
    const files = [
      ...((task.acceptanceContract as any)?.expectedFiles ?? []),
      ...(task.expectedArtifacts ?? []),
      ...((anyTask.expectedFiles as string[]) ?? []),
    ];
    const extensions = files.map((f) => f.split('.').pop()?.toLowerCase());

    if (extensions.some((ext) => ext === 'ts' || ext === 'tsx') || /\b(typescript|\.ts)\b/i.test(text)) {
      return 'typescript';
    }
    if (extensions.some((ext) => ext === 'js' || ext === 'jsx' || ext === 'mjs') || /\b(javascript|node\.js)\b/i.test(text)) {
      return 'javascript';
    }
    if (extensions.some((ext) => ext === 'py') || /\b(python|\.py|pytest)\b/i.test(text)) {
      return 'python';
    }
    if (extensions.some((ext) => ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'h' || ext === 'hpp') || /\b(c\+\+|cpp|clang)\b/i.test(text)) {
      return 'cpp';
    }
    if (extensions.some((ext) => ext === 'rs') || /\b(rust|cargo|\.rs)\b/i.test(text)) {
      return 'rust';
    }
    if (extensions.some((ext) => ext === 'go') || /\b(golang|\.go)\b/i.test(text)) {
      return 'go';
    }
    if (extensions.some((ext) => ext === 'java') || /\b(java|maven|gradle)\b/i.test(text)) {
      return 'java';
    }
    return 'other';
  }

  private detectPhase(task: Task, text: string): ExecutionPhase {
    if (task.type === 'architecture' || /\b(plan|design|decompose|blueprint|roadmap)\b/i.test(text)) {
      return 'PLAN';
    }
    if (task.type === 'debugging' || /\b(repair|fix|patch|resolve error|compile error)\b/i.test(text)) {
      return 'REPAIR';
    }
    if (/\b(verify|test suite|oracle|evidence|assert|check)\b/i.test(text)) {
      return 'VERIFY';
    }
    if (/\b(delegate|subagent|worker|dispatch)\b/i.test(text)) {
      return 'DELEGATE';
    }
    return 'ACT';
  }
}
