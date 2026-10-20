import { describe, it, expect } from 'vitest';
import {
  ContextCompiler,
  estimateTokens,
  tokensForPart,
  type ContextPart,
  type ContextAvailability,
  Scheduler,
  SchedulingError,
  ModelRegistry,
  ComputerRegistry,
  RuntimeRegistry,
  AgentRegistry,
  type Task,
} from '@wazir/core';

describe('Section 6: Context Budgeting (model_cycle.md)', () => {
  const compiler = new ContextCompiler({ trimFraction: 0.5 });

  describe('Compaction Sequence: Drop before Trim, Priority Order', () => {
    it('compacts in exact order: retrieved -> mcp -> memory -> conversation -> repository', () => {
      // Create parts across all 5 compactible kinds with known token sizes
      const parts: ContextPart[] = [
        { label: 'System Instructions', kind: 'system', priority: 'critical', content: 'You are an agent.' }, // ~5 tokens
        { label: 'Task Specification', kind: 'task', priority: 'critical', content: 'Do this coding task.' }, // ~5 tokens
        { label: 'Retrieved Docs', kind: 'retrieved', priority: 'optional', content: 'A'.repeat(400) }, // 100 tokens
        { label: 'MCP Tools Spec', kind: 'mcp', priority: 'optional', content: 'B'.repeat(400) }, // 100 tokens
        { label: 'Long-term Memory', kind: 'memory', priority: 'optional', content: 'C'.repeat(400) }, // 100 tokens
        { label: 'Prior Conversation', kind: 'conversation', priority: 'optional', content: 'D'.repeat(400) }, // 100 tokens
        { label: 'Repo Tree', kind: 'repository', priority: 'optional', content: 'E'.repeat(400) }, // 100 tokens
      ];

      // Total input = ~510 tokens. Output reserve = 100 tokens. Total required = ~610 tokens.
      // Set availability to 350 tokens:
      // Must drop 'retrieved' (saves 100 -> ~510), then drop 'mcp' (saves 100 -> ~410), then drop 'memory' (saves 100 -> ~310 <= 350)
      const availability: ContextAvailability = {
        tokens: 350,
        source: 'model-context-max',
      };

      const decision = compiler.compile(parts, availability, 100);

      expect(decision.fits).toBe(true);
      expect(decision.compactions.length).toBeGreaterThanOrEqual(3);

      // Verify the dropped order
      const droppedLabels = decision.compactions.filter((c) => c.action === 'dropped').map((c) => c.part);
      expect(droppedLabels[0]).toBe('Retrieved Docs');
      expect(droppedLabels[1]).toBe('MCP Tools Spec');
      expect(droppedLabels[2]).toBe('Long-term Memory');
    });

    it('drops optional/important parts before trimming remaining parts', () => {
      const parts: ContextPart[] = [
        { label: 'Critical Task', kind: 'task', priority: 'critical', content: 'Task'.repeat(10) }, // 10 tokens
        { label: 'Optional Docs', kind: 'retrieved', priority: 'optional', content: 'X'.repeat(200) }, // 50 tokens
        { label: 'Repo Files 1', kind: 'repository', priority: 'important', content: 'Y'.repeat(400) }, // 100 tokens
        { label: 'Repo Files 2', kind: 'repository', priority: 'important', content: 'Z'.repeat(400) }, // 100 tokens
      ];

      // Total required = 10 + 50 + 100 + 100 + 50 (reserve) = 310 tokens.
      // Set availability to 130 tokens.
      // Phase 1 drops Optional Docs (retrieved, -50 -> 260) and Repo Files 1 (repository, -100 -> 160).
      // COMPACT_PRIORITY loop finishes. Still required 160 > 130.
      // Phase 2 trims Repo Files 2 by 50% (-50 -> 110 <= 130).
      const availability: ContextAvailability = {
        tokens: 130,
        source: 'model-context-max',
      };

      const decision = compiler.compile(parts, availability, 50);

      expect(decision.fits).toBe(true);
      expect(decision.compactions.some((c) => c.part === 'Optional Docs' && c.action === 'dropped')).toBe(true);
      expect(decision.compactions.some((c) => c.part === 'Repo Files 1' && c.action === 'dropped')).toBe(true);
      expect(decision.compactions.some((c) => c.part === 'Repo Files 2' && c.action === 'trimmed')).toBe(true);
    });
  });

  describe('Critical Parts Preservation', () => {
    it('never drops or trims priority: critical parts, returning fits: false when budget exceeded', () => {
      const parts: ContextPart[] = [
        { label: 'Core System Instructions', kind: 'system', priority: 'critical', content: 'S'.repeat(400) }, // 100 tokens
        { label: 'Core User Task', kind: 'task', priority: 'critical', content: 'T'.repeat(400) }, // 100 tokens
        { label: 'Optional Extras', kind: 'retrieved', priority: 'optional', content: 'E'.repeat(400) }, // 100 tokens
      ];

      // Critical input = 200 tokens. Output reserve = 50 tokens. Total critical required = 250 tokens.
      // Available = 150 tokens.
      // Optional Extras is dropped (saves 100 -> required 250 > 150).
      // Critical parts must NOT be trimmed, compiler must fail cleanly with fits: false.
      const availability: ContextAvailability = {
        tokens: 150,
        source: 'model-context-max',
      };

      const decision = compiler.compile(parts, availability, 50);

      expect(decision.fits).toBe(false);
      // Final parts still contain both critical parts intact
      const remainingLabels = decision.finalParts.map((p) => p.label);
      expect(remainingLabels).toContain('Core System Instructions');
      expect(remainingLabels).toContain('Core User Task');
      expect(remainingLabels).not.toContain('Optional Extras');

      // Check reasons pin exact wording
      expect(decision.reasons.some((r) => r.includes('select a model with a larger context window'))).toBe(true);
    });
  });

  describe('Overflow Case: Context Ceiling Halts Execution Before Runtime Call', () => {
    it('Scheduler rejects task with SchedulingError before any generate() call when context exceeds limits', () => {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();
      const agents = new AgentRegistry();

      computers.register({
        id: 'local-box',
        name: 'Local',
        local: true,
        health: 'healthy',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      runtimes.register({
        id: 'rt-1',
        type: 'ollama',
        name: 'Ollama',
        computerId: 'local-box',
        version: '0.3',
        capabilities: { chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false, embeddings: false, reasoning: false, modelLoad: true, modelUnload: true, modelDownload: false, statefulChat: false, mcp: false },
      });
      models.register({
        id: 'model-max-8k',
        name: 'Model 8K',
        provider: 'ollama',
        contextMax: 8192,
        capabilities: ['generalChat'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      models.upsertInstance({
        id: 'model-max-8k::local-box::rt-1',
        modelId: 'model-max-8k',
        computerId: 'local-box',
        runtimeId: 'rt-1',
        runtimeModelId: 'model-max-8k',
        loaded: false,
        health: 'healthy',
      });
      agents.register(
        {
          descriptor: {
            name: 'coder',
            version: '1.0',
            description: 'Coder',
            capabilities: ['generalChat'],
            requiredTools: [],
            modelRequirements: {},
            permissions: [],
            taskTypes: ['coding'],
            strategy: 'test',
          },
          async *run() {
            yield { kind: 'done', content: 'done' };
          },
        },
        'native',
      );

      const scheduler = new Scheduler({ computers, runtimes, models, agents });

      // Request 12,000 tokens of context, exceeding 8,192
      const task: Task = {
        id: 'task-overflow',
        type: 'coding',
        input: 'Massive code analysis',
        requirements: { minimumContext: 12000 },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      try {
        scheduler.plan({ task });
        expect.unreachable('Should have thrown SchedulingError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SchedulingError);
        expect(err.message).toContain('No model satisfies the task requirements');
        expect(err.modelReasons.some((r: string) => r.includes('context 8192 < required 12000'))).toBe(true);
      }
    });
  });

  describe('ContextDecision Consistency', () => {
    it('produces internally consistent budget, requiredTokens, and compaction savings', () => {
      const parts: ContextPart[] = [
        { label: 'System', kind: 'system', priority: 'critical', content: 'Sys' },
        { label: 'Conversation 1', kind: 'conversation', priority: 'optional', content: 'Hello '.repeat(50) },
      ];

      const initialBudget = compiler.budget(parts, 100);
      expect(initialBudget.requiredTokens).toBe(initialBudget.inputTokens + 100);

      const decision = compiler.compile(parts, { tokens: 1000, source: 'model' }, 100);
      expect(decision.fits).toBe(true);
      expect(decision.finalInputTokens).toBe(initialBudget.inputTokens);
      expect(decision.finalRequiredTokens).toBe(initialBudget.requiredTokens);
      expect(decision.compactions).toHaveLength(0);
    });
  });
});
