import type { Priority, Task, TaskType } from '../types/index.js';
import type { JobTaskInput } from './jobManager.js';

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  taskType?: TaskType;
  capabilities?: string[];
  dependencies: string[];
  expectedEvidence?: string[];
}

export interface ExecutionPlan {
  objective: string;
  requirements?: {
    language?: string;
    capabilities?: string[];
  };
  steps: PlanStep[];
  successCriteria?: string[];
}

export interface PlannerModelCaller {
  generate(prompt: string): Promise<string>;
}

export interface PlanOptions {
  modelCaller?: PlannerModelCaller;
  projectRoot?: string;
  availableTools?: string[];
  maxSteps?: number;
}

export class TaskPlanner {
  /**
   * Analyzes the user request and generates a structured, dependency-ordered
   * ExecutionPlan. If a modelCaller is provided, it uses the model for dynamic
   * decomposition; otherwise, it applies deterministic semantic analysis.
   */
  async plan(input: string, options: PlanOptions = {}): Promise<ExecutionPlan> {
    const trimmed = input.trim();

    if (options.modelCaller) {
      try {
        const prompt = this.buildPlannerPrompt(trimmed, options);
        const raw = await options.modelCaller.generate(prompt);
        const parsed = this.parseModelPlan(raw, trimmed);
        if (parsed && parsed.steps.length > 0) {
          return parsed;
        }
      } catch {
        // Fall back to deterministic decomposition on model error
      }
    }

    return this.heuristicPlan(trimmed);
  }

  /**
   * Converts an ExecutionPlan into an array of JobTaskInputs ready for JobManager.createJob.
   */
  planToJobTaskInputs(
    plan: ExecutionPlan,
    baseTaskProps: Partial<Task> = {},
  ): JobTaskInput[] {
    return plan.steps.map((step) => {
      return {
        task: {
          id: step.id,
          title: step.title,
          type: step.taskType ?? (baseTaskProps.type ?? 'coding'),
          input: `${step.title}\n\nObjective: ${step.description}` +
            (step.expectedEvidence && step.expectedEvidence.length > 0
              ? `\n\nRequired Acceptance Evidence:\n${step.expectedEvidence.map((e) => `- ${e}`).join('\n')}`
              : ''),
          capabilities: step.capabilities,
          expectedEvidence: step.expectedEvidence,
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
    const lower = task.toLowerCase();

    // Check for C/C++ compilation workflow
    if (lower.includes('c++') || lower.includes('.cpp') || lower.includes('clang++') || lower.includes('g++') || lower.includes('compile c')) {
      const isSort = lower.includes('sort');
      const filenameMatch = task.match(/\b([A-Za-z0-9_-]+\.(?:cpp|cc|cxx|c))\b/i);
      const filename = filenameMatch ? filenameMatch[1] : (isSort ? 'src/sort.cpp' : 'src/main.cpp');
      const binName = filename.replace(/\.(cpp|cc|cxx|c)$/i, '');

      return {
        objective: task,
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
          },
          {
            id: 'implement',
            title: `Create ${filename}`,
            description: `Implement the requested C++ logic in ${filename} based on requirements: ${task}`,
            taskType: 'coding',
            capabilities: ['filesystem_write'],
            dependencies: ['inspect'],
            expectedEvidence: [`file_exists: ${filename}`],
          },
          {
            id: 'compile',
            title: `Compile ${filename}`,
            description: `Compile ${filename} into binary '${binName}' using g++ or clang++ (e.g. g++ -std=c++17 -O2 -o ${binName} ${filename}).`,
            taskType: 'coding',
            capabilities: ['shell'],
            dependencies: ['implement'],
            expectedEvidence: [`file_exists: ${binName}`, 'no_errors'],
          },
          {
            id: 'verify',
            title: 'Verify execution and correctness',
            description: `Execute ./${binName} to verify clean exit and correct output.`,
            taskType: 'debugging',
            capabilities: ['shell'],
            dependencies: ['compile'],
            expectedEvidence: ['exit_code_zero', 'no_errors'],
          },
        ],
        successCriteria: [`file_exists: ${filename}`, `file_exists: ${binName}`, 'exit_code_zero'],
      };
    }

    // Default 3-stage plan: inspect -> implement -> verify
    return {
      objective: task,
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
