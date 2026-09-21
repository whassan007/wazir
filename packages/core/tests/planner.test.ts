import { describe, expect, it } from 'vitest';
import { createTaskPlanner } from '../src/index.js';

describe('TaskPlanner — Pre-Execution Task Decomposition', () => {
  it('generates a specialized DAG for C++ compile/sort requests', async () => {
    const planner = createTaskPlanner();
    const plan = await planner.plan('write a C++ program to sort an array');

    expect(plan.requirements?.language).toBe('C++');
    expect(plan.steps.length).toBe(4);

    const stepIds = plan.steps.map((s) => s.id);
    expect(stepIds).toEqual(['inspect', 'implement', 'compile', 'verify']);

    // Check dependency ordering
    const implementStep = plan.steps.find((s) => s.id === 'implement')!;
    const compileStep = plan.steps.find((s) => s.id === 'compile')!;
    const verifyStep = plan.steps.find((s) => s.id === 'verify')!;

    expect(implementStep.dependencies).toContain('inspect');
    expect(compileStep.dependencies).toContain('implement');
    expect(verifyStep.dependencies).toContain('compile');

    // Expected evidence check
    expect(implementStep.expectedEvidence?.some((e) => e.includes('file_exists:'))).toBe(true);
    expect(compileStep.expectedEvidence?.some((e) => e.includes('file_exists:'))).toBe(true);
    expect(verifyStep.expectedEvidence).toContain('exit_code_zero');
  });

  it('generates default 3-stage plan (inspect -> implement -> verify) for general tasks', async () => {
    const planner = createTaskPlanner();
    const plan = await planner.plan('add error handling to user service');

    expect(plan.steps.length).toBe(3);
    const stepIds = plan.steps.map((s) => s.id);
    expect(stepIds).toEqual(['inspect', 'implement', 'verify']);
  });

  it('converts plan into JobTaskInput array for JobManager', async () => {
    const planner = createTaskPlanner();
    const plan = await planner.plan('write a C++ program in src/main.cpp to reverse a string');
    const taskInputs = planner.planToJobTaskInputs(plan, {
      execution: { targetAgentId: 'wazir-step' },
    });

    expect(taskInputs.length).toBe(4);
    expect(taskInputs[0].task.id).toBe('inspect');
    expect(taskInputs[1].task.id).toBe('implement');
    expect(taskInputs[1].dependencies).toEqual(['inspect']);
    expect(taskInputs[1].task.execution?.targetAgentId).toBe('wazir-step');
    expect(taskInputs[1].task.expectedEvidence?.length).toBeGreaterThan(0);
  });

  it('uses model caller when provided and parses structured JSON plan', async () => {
    const planner = createTaskPlanner();
    const mockModelCaller = {
      generate: async () => JSON.stringify({
        objective: 'Custom LLM Plan',
        steps: [
          {
            id: 'setup',
            title: 'Setup files',
            description: 'Create config',
            dependencies: [],
            expectedEvidence: ['file_exists: config.json'],
          },
          {
            id: 'run',
            title: 'Run service',
            description: 'Start and test',
            dependencies: ['setup'],
            expectedEvidence: ['no_errors'],
          },
        ],
      }),
    };

    const plan = await planner.plan('do something custom', { modelCaller: mockModelCaller });
    expect(plan.objective).toBe('Custom LLM Plan');
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0].id).toBe('setup');
    expect(plan.steps[1].dependencies).toEqual(['setup']);
  });

  it('falls back to the deterministic heuristic plan when the model caller throws', async () => {
    const planner = createTaskPlanner();
    const throwingModelCaller = {
      generate: async () => {
        throw new Error('model host unreachable');
      },
    };

    const plan = await planner.plan('add error handling to user service', { modelCaller: throwingModelCaller });

    // Should silently recover into the same deterministic 3-stage plan as no-modelCaller.
    const stepIds = plan.steps.map((s) => s.id);
    expect(stepIds).toEqual(['inspect', 'implement', 'verify']);
  });

  it('falls back to the deterministic heuristic plan when the model returns an empty step list', async () => {
    const planner = createTaskPlanner();
    const emptyStepsModelCaller = {
      generate: async () => JSON.stringify({ objective: 'nothing to do here', steps: [] }),
    };

    const plan = await planner.plan('write a C++ program to sort an array', { modelCaller: emptyStepsModelCaller });

    // Empty steps must not be accepted as a valid plan — falls back to the C++ heuristic.
    expect(plan.requirements?.language).toBe('C++');
    expect(plan.steps.length).toBe(4);
  });

  it('falls back to the deterministic heuristic plan when the model response has no parseable JSON', async () => {
    const planner = createTaskPlanner();
    const garbageModelCaller = {
      generate: async () => 'Sure, I can help with that! Let me think about the steps...',
    };

    const plan = await planner.plan('add error handling to user service', { modelCaller: garbageModelCaller });

    const stepIds = plan.steps.map((s) => s.id);
    expect(stepIds).toEqual(['inspect', 'implement', 'verify']);
  });

  it('analyze() detects inspection-only intent as not requiring mutation', () => {
    const planner = createTaskPlanner();
    const analysis = planner.analyze('check whether the login flow works and explain why it fails');

    expect(analysis.mutationRequired).toBe(false);
    expect(analysis.capabilities).not.toContain('filesystem_write');
  });

  it('analyze() detects build/write intent as requiring mutation with a clean workspace for from-scratch requests', () => {
    const planner = createTaskPlanner();
    const analysis = planner.analyze('write a new program from scratch to reverse a string');

    expect(analysis.mutationRequired).toBe(true);
    expect(analysis.workspaceMode).toBe('clean');
    expect(analysis.capabilities).toContain('filesystem_write');
  });
});
