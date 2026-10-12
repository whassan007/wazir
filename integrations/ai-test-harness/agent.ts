// Compatibility transport only. The agent loop is Wazir's production CodingAgent.
// Shared upstream tools remain simulated as required by compat/CONTRACT.md.
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { MAX_TURNS } from './scenario.js';
import { IMPLS, SYSTEM_PROMPT, TOOLS } from './tools.js';

export const HARNESS = 'wazir';
const WAZIR_ROOT = process.env.WAZIR_ROOT ?? '__WAZIR_ROOT__';
const tracer = trace.getTracer(HARNESS);
const load = (module: string) => import(pathToFileURL(`${WAZIR_ROOT}/packages/${module}/dist/src/index.js`).href);
const modules = Promise.all([load('agents'), load('runtimes/lmstudio'), load('core')]);

export async function run(prompt: string, sessionId: string | null, user: string | null, signal: AbortSignal): Promise<{
  output: string; tool_calls: { name: string; args: Record<string, unknown> }[];
  usage: { input_tokens: number; output_tokens: number }; stop_reason: string; error?: string | null;
}> {
  const [agents, runtimes, core] = await modules;
  const model = process.env.MODEL ?? 'mock';
  const executionId = randomUUID();
  const rt = new runtimes.LMStudioAdapter(process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:4000/v1', {
    apiKey: process.env.OPENAI_API_KEY,
  });
  const validators = Object.fromEntries(TOOLS.map(t => [t.function.name, core.compileToolSchema(t.function.parameters)]));
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let inputTokens = 0, outputTokens = 0, requestId: string | undefined;
  let output = '', stopReason = 'error', error: string | null = null;
  const attrs = { 'session.id': sessionId ?? '', 'user.id': user ?? '', 'execution.id': executionId };
  const traced = <T>(name: string, fn: () => Promise<T>): Promise<T> => tracer.startActiveSpan(name, async (span: Span) => {
    span.setAttributes(attrs);
    try { return await fn(); }
    catch (err) { span.setStatus({ code: SpanStatusCode.ERROR }); throw err; }
    finally { span.end(); }
  });
  const cancel = () => { if (requestId) void rt.cancel(requestId); };
  signal.addEventListener('abort', cancel);
  try {
    await traced(`invoke_agent ${HARNESS}`, async () => {
      const runtime = {
        tools: TOOLS.map(t => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })),
        runtimeCapabilities: { nativeToolCalling: true },
        cancelCurrentTurn: cancel,
        async *generate(req: any) {
          signal.throwIfAborted();
          requestId = `${executionId}:${randomUUID()}`;
          const span = tracer.startSpan(`chat ${model}`, { attributes: { ...attrs, 'gen_ai.request.model': model, 'request.id': requestId } });
          try {
            for await (const event of rt.generate({ ...req, requestId })) {
              if (event.type === 'completed') {
                inputTokens += event.usage?.inputTokens ?? 0;
                outputTokens += event.usage?.outputTokens ?? 0;
                if (event.finishReason === 'content_filter') throw new Error('UPSTREAM_CONTENT_FILTER');
              }
              yield event;
            }
          } finally { span.end(); requestId = undefined; }
        },
        async executeTool(name: string, args: Record<string, unknown>) {
          signal.throwIfAborted();
          // Verification tools absent from this upstream simulated fixture are not configured.
          if (!Object.hasOwn(IMPLS, name)) return { ok: false, output: '', error: `Tool not found: ${name}`, durationMs: 0 };
          const start = Date.now();
          const validate = validators[name];
          if (!validate || !validate(args)) return { ok: false, output: '', error: 'Invalid tool arguments', durationMs: Date.now() - start };
          calls.push({ name, args });
          return traced(`execute_tool ${name}`, async () => {
            try { return { ok: true, output: String(await IMPLS[name](args)), durationMs: Date.now() - start }; }
            catch (err) { return { ok: false, output: '', error: String(err), durationMs: Date.now() - start }; }
          });
        },
      };
      const agent = agents.createCodingAgent({ maxTurns: MAX_TURNS, systemPromptExtra: SYSTEM_PROMPT });
      for await (const turn of agent.run({
        modelId: model, taskDescription: prompt, taskType: 'code_analysis', projectRoot: '/workspace',
        maxTurns: MAX_TURNS, mutationRequired: false, isCancelled: () => signal.aborted,
      }, runtime)) {
        if (turn.kind === 'done') { output = turn.content ?? ''; stopReason = 'end_turn'; }
        if (turn.kind === 'error') {
          error = turn.error ?? 'Agent failed';
          stopReason = ['MAX_TURNS', 'MAX_MODEL_CALLS'].includes(turn.terminationReason) ? 'max_turns' : 'error';
          if (stopReason === 'max_turns') error = null;
        }
      }
    });
  } catch (err) {
    error = String(err);
    if (error.includes('UPSTREAM_CONTENT_FILTER')) { stopReason = 'content_filter'; error = null; }
    else stopReason = signal.aborted ? (signal.reason === 'timeout' ? 'timeout' : 'cancelled') : 'error';
  } finally { signal.removeEventListener('abort', cancel); }
  return { output: stopReason === 'end_turn' ? output.trim() : '', tool_calls: calls,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stop_reason: stopReason, error };
}
