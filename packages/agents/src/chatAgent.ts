import type { AgentAdapter, AgentDescriptor, AgentRunRequest, AgentRuntime, AgentTurn } from '@wazir/core';

export const CHAT_SYSTEM_PROMPT = 'Answer the user directly and concisely. Return only the requested answer, code, or JSON. You have no tools and cannot modify files or execute commands.';

/** Explicit conversational tasks still use host scheduling, admission and accounting. */
export class ChatAgent implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    name: 'wazir-chat', version: '0.1.0', description: 'Single-generation, tool-free conversation',
    capabilities: ['generalChat'], requiredTools: [], permissions: [],
    modelRequirements: { capabilities: ['generalChat'], minimumContext: 2048 },
    taskTypes: ['chat'], strategy: 'conversational-inference',
  };
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  async *run(request: AgentRunRequest, runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    let content = '', completed = false;
    const iterator = runtime.generate({ modelId: request.modelId,
      messages: [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, { role: 'user', content: request.taskDescription }],
      temperature: 0, maxTokens: request.maxTokens ?? 1024,
    })[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancellation: ReturnType<typeof setInterval> | undefined;
    let stopped: 'CANCELLED' | 'MAX_WALL_CLOCK' | undefined;
    const stop = new Promise<never>((_, reject) => {
      const abort = (reason: typeof stopped) => { stopped = reason; runtime.cancelCurrentTurn?.(); reject(new Error(reason === 'CANCELLED' ? 'execution cancelled' : 'model response timed out')); };
      timer = setTimeout(() => abort('MAX_WALL_CLOCK'), request.maxWallClockMs ?? this.options.timeoutMs ?? 60_000);
      cancellation = setInterval(() => { if (request.isCancelled?.()) abort('CANCELLED'); }, 25);
      if (request.isCancelled?.()) abort('CANCELLED');
    });
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), stop]);
        if (next.done) break;
        const event = next.value;
        if (event.type === 'error') throw new Error(event.error ?? 'runtime generation failed');
        if (event.type === 'tool_call') throw new Error('conversational inference cannot execute tools; use a coding task');
        if (event.type === 'token') content += event.content ?? '';
        if (event.type === 'completed') { completed = true; if (!content) content = event.content ?? ''; }
      }
      if (!completed) throw new Error('model stream ended without completion');
      if (!content.trim()) throw new Error('model returned an empty response');
      yield { kind: 'done', content, terminationReason: 'COMPLETED' };
    } catch (error) {
      runtime.cancelCurrentTurn?.();
      yield { kind: 'error', error: error instanceof Error ? error.message : String(error),
        errorKind: stopped === 'CANCELLED' ? 'cancelled' : 'infrastructure', terminationReason: stopped };
    } finally {
      clearTimeout(timer); clearInterval(cancellation);
      // A broken adapter may never resolve next()/return(); do not let it hold the CLI.
      void iterator.return?.().catch(() => undefined);
    }
  }
}
