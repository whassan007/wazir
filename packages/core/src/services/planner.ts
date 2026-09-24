import type { Priority, Task, TaskType, WorkspaceMode } from '../types/index.js';
import type { JobTaskInput } from './jobManager.js';
import { classifyComplexity, budgetFor } from './complexity.js';

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  taskType?: TaskType;
  capabilities?: string[];
  dependencies: string[];
  expectedEvidence?: string[];
  expectedArtifacts?: string[];
  mutationRequired?: boolean;
  workspaceMode?: WorkspaceMode;
}

export interface ExecutionPlan {
  objective: string;
  requirements?: {
    language?: string;
    capabilities?: string[];
  };
  workspaceMode?: WorkspaceMode;
  mutationRequired?: boolean;
  expectedArtifacts?: string[];
  steps: PlanStep[];
  successCriteria?: string[];
  complexity?: 'trivial' | 'small' | 'complex';
}

export interface PlannerModelCaller {
  generate(prompt: string): Promise<string>;
}

import type { StrategyLearningService } from './strategyLearningService.js';
import type { StrategyMatchResult } from '../types/strategyLearning.js';

export interface PlanOptions {
  modelCaller?: PlannerModelCaller;
  projectRoot?: string;
  availableTools?: string[];
  maxSteps?: number;
  strategyService?: StrategyLearningService;
}

export class TaskPlanner {
  /**
   * Analyzes the user request and generates a structured, dependency-ordered
   * ExecutionPlan. If a modelCaller is provided, it uses the model for dynamic
   * decomposition; otherwise, it applies deterministic semantic analysis.
   */
  async plan(input: string, options: PlanOptions = {}): Promise<ExecutionPlan & { retrievedStrategy?: StrategyMatchResult }> {
    const trimmed = input.trim();
    const complexity = classifyComplexity(trimmed);

    // Retrieve learned strategy if StrategyLearningService is provided
    let retrievedStrategy: StrategyMatchResult | undefined;
    if (options.strategyService) {
      const candidates = options.strategyService.queryStrategies({
        problemSignature: {
          category: 'general_repair',
          languages: ['typescript'],
          repositoryCharacteristics: ['monorepo', 'typed'],
        },
        taskPrompt: trimmed,
        minConfidence: 0.3,
      });
      if (candidates.length > 0) {
        retrievedStrategy = candidates[0];
      }
    }

    // Trivial tasks skip model-based decomposition (that's itself a model call
    // this task doesn't need) and the multi-step inspect/implement/compile/verify
    // DAG entirely — a single implement+verify step, instead of 4 separate
    // CodingAgent.run() invocations each with their own plan/turn/repair budget.
    if (complexity === 'trivial') {
      return { ...this.trivialPlan(trimmed), retrievedStrategy };
    }

    if (options.modelCaller) {
      try {
        const prompt = this.buildPlannerPrompt(trimmed, options);
        const raw = await options.modelCaller.generate(prompt);
        const parsed = this.parseModelPlan(raw, trimmed);
        if (parsed && parsed.steps.length > 0) {
          return { ...parsed, complexity, retrievedStrategy };
        }
      } catch {
        // Fall back to deterministic decomposition on model error
      }
    }

    return { ...this.heuristicPlan(trimmed), complexity, retrievedStrategy };
  }

  /**
   * Single-step plan for trivial tasks: implement and verify inline instead
   * of forcing a separate inspect/implement/compile/verify DAG.
   */
  private trivialPlan(task: string): ExecutionPlan {
    const analysis = this.analyze(task);
    const budget = budgetFor('trivial');

    return {
      objective: task,
      complexity: 'trivial',
      workspaceMode: analysis.workspaceMode,
      mutationRequired: true,
      expectedArtifacts: analysis.expectedArtifacts,
      requirements: {
        language: analysis.language,
        capabilities: analysis.capabilities,
      },
      steps: [
        {
          id: 'implement',
          title: 'Implement and verify',
          description:
            `Implement the following request directly: ${task}\n\n` +
            'Write the necessary file(s), then compile/run/test as appropriate to ' +
            'confirm the result works. This is a small, self-contained task: do not ' +
            'spend turns exploring the repository beyond what is strictly necessary, ' +
            `and stop once it works (budget: ${budget.maxTurns} model turns).`,
          taskType: 'coding',
          capabilities: analysis.capabilities,
          dependencies: [],
          expectedEvidence: ['no_errors'],
          expectedArtifacts: analysis.expectedArtifacts,
          mutationRequired: true,
        },
      ],
      successCriteria: ['no_errors'],
    };
  }

  /**
   * Pre-execution task analyzer. Categorizes intent (build vs inspect),
   * required evidence, expected artifacts, and workspace isolation mode.
   */
  analyze(input: string): {
    mutationRequired: boolean;
    workspaceMode: WorkspaceMode;
    expectedArtifacts: string[];
    language?: string;
    capabilities: string[];
  } {
    const lower = input.toLowerCase();
    const isBuildOrWrite = /\b(build|write|create|implement|add|code|make|generate|scaffold)\b/i.test(input);
    const isCheckOrInspect = /\b(check|inspect|verify|test|read|examine|review|explain|does\b.*work)\b/i.test(input);
    const isFix = /\b(fix|patch|repair|resolve|update)\b/i.test(input);

    const mutationRequired = isBuildOrWrite || isFix || (!isCheckOrInspect);
    const isFromScratch = /\b(from scratch|new program|new project|empty workspace)\b/i.test(input) || (isBuildOrWrite && !isFix);
    const workspaceMode: WorkspaceMode = isFromScratch ? 'clean' : 'repository';

    // Only treat this as an expected artifact when the user actually named a
    // file; otherwise the agent is free to place files wherever makes sense
    // (e.g. src/main.cpp), and guessing a bare filename here just produces a
    // verification target that can never match reality.
    const artifacts: string[] = [];
    const filenameMatch = input.match(/\b([A-Za-z0-9_-]+\.(?:cpp|cc|cxx|c|py|js|ts|go|rs|java))\b/i);
    if (filenameMatch) {
      artifacts.push(filenameMatch[1]);
    }

    let language: string | undefined;
    if (lower.includes('c++') || lower.includes('.cpp') || lower.includes('g++') || lower.includes('clang++')) language = 'C++';
    else if (lower.includes('python') || lower.includes('.py')) language = 'Python';
    else if (lower.includes('typescript') || lower.includes('.ts')) language = 'TypeScript';

    const capabilities: string[] = ['filesystem_read', 'shell'];
    if (mutationRequired) capabilities.push('filesystem_write');
    if (language === 'C++') capabilities.push('compiler');

    return {
      mutationRequired,
      workspaceMode,
      expectedArtifacts: artifacts,
      language,
      capabilities,
    };
  }

  /**
   * Converts an ExecutionPlan into an array of JobTaskInputs ready for JobManager.createJob.
   */
  planToJobTaskInputs(
    plan: ExecutionPlan,
    baseTaskProps: Partial<Task> = {},
  ): JobTaskInput[] {
    const budget = budgetFor(plan.complexity ?? classifyComplexity(plan.objective));
    return plan.steps.map((step) => {
      return {
        task: {
          maxTurns: baseTaskProps.maxTurns ?? budget.maxTurns,
          maxRepairCycles: baseTaskProps.maxRepairCycles ?? budget.maxRepairCycles,
          maxRetries: baseTaskProps.maxRetries ?? budget.maxRetries,
          id: step.id,
          title: step.title,
          type: step.taskType ?? (baseTaskProps.type ?? 'coding'),
          input: `${step.title}\n\nObjective: ${step.description}` +
            (step.expectedEvidence && step.expectedEvidence.length > 0
              ? `\n\nRequired Acceptance Evidence:\n${step.expectedEvidence.map((e) => `- ${e}`).join('\n')}`
              : ''),
          capabilities: step.capabilities,
          expectedEvidence: step.expectedEvidence,
          expectedArtifacts: step.expectedArtifacts ?? plan.expectedArtifacts,
          mutationRequired: step.mutationRequired ?? (step.id === 'implement' ? true : plan.mutationRequired ?? baseTaskProps.mutationRequired),
          workspaceMode: step.workspaceMode ?? plan.workspaceMode ?? baseTaskProps.workspaceMode,
          priority: baseTaskProps.priority ?? ('normal' as Priority),
          requirements: {
            capabilities: [],
            reasoning: 'low',
            vision: false,
            toolCalling: true,
            minimumContext: 4096,
            minimumMemoryGB: 4,
            minimumGPUMemoryGB: 0,
            localOnly: false,
            mutationRequired: step.mutationRequired ?? plan.mutationRequired ?? baseTaskProps.mutationRequired,
            expectedArtifacts: step.expectedArtifacts ?? plan.expectedArtifacts,
            ...(baseTaskProps.requirements ?? {}),
          },
          execution: baseTaskProps.execution,
        },
        dependencies: step.dependencies,
      };
    });
  }

  private buildPlannerPrompt(task: string, options: PlanOptions): string {
    const tools = options.availableTools?.join(', ') ?? 'read, write, edit, shell, search, glob, test, lint, build';
    return [
      'You are Wazir\'s Task Planner and Analyzer.',
      'Analyze the following request and decompose it into a clean, minimal, dependency-ordered execution plan.',
      'Allowed tools in the environment: ' + tools,
      'Respond ONLY with a JSON object matching this exact schema:',
      '{',
      '  "objective": "brief summary of user goal",',
      '  "requirements": { "language": "c++ | typescript | python | etc", "capabilities": ["filesystem_write", "shell"] },',
      '  "steps": [',
      '    {',
      '      "id": "short_unique_id",',
      '      "title": "short step title",',
      '      "description": "exact actionable instructions for this step",',
      '      "taskType": "coding",',
      '      "capabilities": ["shell"],',
      '      "dependencies": ["prior_step_id"],',
      '      "expectedEvidence": ["file_exists: path/to/file", "check_passed: test", "no_errors"]',
      '    }',
      '  ],',
      '  "successCriteria": ["file_exists: path/to/file"]',
      '}',
      '',
      `User Task: ${task}`,
    ].join('\n');
  }

  private parseModelPlan(raw: string, fallbackObjective: string): ExecutionPlan | null {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;

      const steps: PlanStep[] = parsed.steps.map((s: any, idx: number) => ({
        id: String(s.id ?? `step-${idx + 1}`),
        title: String(s.title ?? `Step ${idx + 1}`),
        description: String(s.description ?? s.title ?? ''),
        taskType: (s.taskType as TaskType) ?? 'coding',
        capabilities: Array.isArray(s.capabilities) ? s.capabilities.map(String) : [],
        dependencies: Array.isArray(s.dependencies) ? s.dependencies.map(String) : [],
        expectedEvidence: Array.isArray(s.expectedEvidence) ? s.expectedEvidence.map(String) : [],
      }));

      return {
        objective: String(parsed.objective ?? fallbackObjective),
        requirements: parsed.requirements,
        steps,
        successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria.map(String) : undefined,
      };
    } catch {
      return null;
    }
  }

  private heuristicPlan(task: string): ExecutionPlan {
    const analysis = this.analyze(task);
    const lower = task.toLowerCase();

    // Check for C/C++ compilation workflow
    if (lower.includes('c++') || lower.includes('.cpp') || lower.includes('clang++') || lower.includes('g++') || lower.includes('compile c')) {
      const isSort = lower.includes('sort');
      const filenameMatch = task.match(/\b([A-Za-z0-9_-]+\.(?:cpp|cc|cxx|c))\b/i);
      // filename/binName below are only used for step titles/descriptions
      // (what to *call* the file the agent creates), not as a hard
      // verification target — the agent may legitimately nest it under src/
      // or a project subdirectory. Only pin a hard expectedArtifacts entry
      // when the user named a file explicitly.
      const filename = filenameMatch ? filenameMatch[1] : (isSort ? 'src/sort.cpp' : 'src/main.cpp');
      const binName = filename.replace(/\.(cpp|cc|cxx|c)$/i, '');
      const expectedArtifacts = filenameMatch ? [filenameMatch[1]] : [];

      return {
        objective: task,
        workspaceMode: analysis.workspaceMode,
        mutationRequired: true,
        expectedArtifacts,
        requirements: {
          language: 'C++',
          capabilities: ['filesystem_read', 'filesystem_write', 'shell'],
        },
        steps: [
          {
            id: 'inspect',
            title: 'Inspect workspace',
            description: 'Inspect existing files and workspace configuration using glob/read tools.',
            taskType: 'code_analysis',
            capabilities: ['filesystem_read'],
            dependencies: [],
            expectedEvidence: ['no_errors'],
            mutationRequired: false,
          },
          {
            id: 'implement',
            title: `Create ${filename}`,
            description: `Implement the requested C++ logic in ${filename} based on requirements: ${task}`,
            taskType: 'coding',
            capabilities: ['filesystem_write'],
            dependencies: ['inspect'],
            expectedEvidence: [`file_exists: ${filename}`],
            expectedArtifacts,
            mutationRequired: true,
          },
          {
            id: 'compile',
            title: `Compile ${filename}`,
            description: `Compile ${filename} into binary '${binName}' using g++ or clang++ (e.g. g++ -std=c++17 -O2 -o ${binName} ${filename}).`,
            taskType: 'coding',
            capabilities: ['shell'],
            dependencies: ['implement'],
            expectedEvidence: [`file_exists: ${binName}`, 'no_errors'],
            mutationRequired: true,
          },
          {
            id: 'verify',
            title: 'Verify execution and correctness',
            description: `Execute ./${binName} to verify clean exit and correct output.`,
            taskType: 'debugging',
            capabilities: ['shell'],
            dependencies: ['compile'],
            expectedEvidence: ['exit_code_zero', 'no_errors'],
            mutationRequired: false,
          },
        ],
        successCriteria: ['exit_code_zero'],
      };
    }

    // Default 3-stage plan: inspect -> implement -> verify
    return {
      objective: task,
      workspaceMode: analysis.workspaceMode,
      mutationRequired: analysis.mutationRequired,
      expectedArtifacts: analysis.expectedArtifacts,
      requirements: {
        capabilities: ['filesystem_read', 'filesystem_write', 'shell'],
      },
      steps: [
        {
          id: 'inspect',
          title: 'Inspect workspace and requirements',
          description: `Analyze project files and context needed for: ${task}`,
          taskType: 'code_analysis',
          capabilities: ['filesystem_read'],
          dependencies: [],
          expectedEvidence: ['no_errors'],
        },
        {
          id: 'implement',
          title: 'Implement requested changes',
          description: `Perform the required file edits or creations to accomplish: ${task}`,
          taskType: 'coding',
          capabilities: ['filesystem_write', 'shell'],
          dependencies: ['inspect'],
          expectedEvidence: ['no_errors'],
        },
        {
          id: 'verify',
          title: 'Verify implementation and checks',
          description: 'Run tests, linters, or check tools to confirm the changes work properly.',
          taskType: 'evaluation',
          capabilities: ['shell'],
          dependencies: ['implement'],
          expectedEvidence: ['no_errors'],
        },
      ],
      successCriteria: ['no_errors'],
    };
  }
}

export function createTaskPlanner(): TaskPlanner {
  return new TaskPlanner();
}
