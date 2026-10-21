import type { FleetMemoryService, Tool, ToolExecutionContext, ToolResult } from '@wazir/core';

const REMEMBER_FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200, description: 'Short label for this fact' },
    body: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description: 'The fact itself, written so a different agent with no other context can use it',
    },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Optional short tags for later filtering' },
  },
};

const RECALL_FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Optional keywords to narrow which facts come back' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
};

/**
 * `remember_fact` / `recall_facts`: durable, fleet-shared memory for this project.
 * Unlike per-conversation context, a fact written here is visible to any agent that
 * later works in the same project root — on this machine or, with a shared
 * KeyValueStore (PostgresStore), any other machine in the fleet. See
 * FleetMemoryService for the storage/retrieval semantics.
 */
export function createFleetMemoryTools(service: FleetMemoryService): Tool[] {
  const rememberFact: Tool = {
    descriptor: {
      name: 'remember_fact',
      description:
        'Record a durable fact about this project for future agents — on this machine or any other ' +
        'in the fleet — to recall. Use for things worth knowing next time: a flaky test and its ' +
        'workaround, a non-obvious repo convention, a gotcha that cost time to discover. Do not use ' +
        'for anything secret, credential-like, or specific to this one conversation.',
      inputSchema: REMEMBER_FACT_SCHEMA,
      permissions: [],
      riskLevel: 'low',
      environment: 'local',
      sideEffectClass: 'IDEMPOTENT_WRITE',
      concurrencySafety: 'parallel',
      provenance: { source: 'system' },
    },
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const started = Date.now();
      try {
        const fact = await service.remember({
          projectRoot: ctx.projectRoot,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
          executionId: ctx.executionId,
        });
        return {
          ok: true,
          output: `Remembered fact ${fact.id}: ${fact.title}`,
          structuredOutput: fact,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        return {
          ok: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        };
      }
    },
  };

  const recallFacts: Tool = {
    descriptor: {
      name: 'recall_facts',
      description:
        'Look up durable facts previously recorded for this project (see remember_fact) — from this ' +
        'conversation, an earlier session, or a different machine in the fleet. Returns the most ' +
        'relevant facts, most recent first when no query is given.',
      inputSchema: RECALL_FACTS_SCHEMA,
      permissions: [],
      riskLevel: 'low',
      environment: 'local',
      sideEffectClass: 'READ_ONLY',
      concurrencySafety: 'parallel',
      provenance: { source: 'system' },
    },
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
      const started = Date.now();
      const facts = await service.recall(ctx.projectRoot, {
        query: typeof input.query === 'string' ? input.query : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
      const output = facts.length === 0
        ? 'No fleet memory facts recorded for this project yet.'
        : facts.map((f) => `[${f.id}] ${f.title}\n${f.body}`).join('\n\n');
      return { ok: true, output, structuredOutput: facts, durationMs: Date.now() - started };
    },
  };

  return [rememberFact, recallFacts];
}
