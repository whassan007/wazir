// wazir harness: the tool loop runs on Wazir's own OpenAI-compatible runtime adapter
// (@wazir/runtimes-lmstudio), so this suite exercises Wazir's streaming, tool-call parsing,
// retry and cancellation code against the shared LiteLLM endpoint.
import { pathToFileURL } from "node:url";
import { trace, type Span } from "@opentelemetry/api";
import { MAX_TURNS } from "./scenario.js";
import { IMPLS, SYSTEM_PROMPT, TOOLS } from "./tools.js";

export const HARNESS = "wazir";
// Built Wazir checkout. install.sh fills this in; qa/run.py passes harnesses only an
// allow-listed environment, so an env var alone would not reach this process.
const WAZIR_ROOT = process.env.WAZIR_ROOT ?? "__WAZIR_ROOT__";
const tracer = trace.getTracer(HARNESS);

type Adapter = { generate(req: any): AsyncIterable<any>; cancel(requestId: string): Promise<void> | void };
let adapterPromise: Promise<Adapter> | undefined;
const adapter = () =>
  (adapterPromise ??= import(pathToFileURL(`${WAZIR_ROOT}/packages/runtimes/lmstudio/dist/src/index.js`).href).then(
    (m) => new m.LMStudioAdapter(process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:4000/v1", { apiKey: process.env.OPENAI_API_KEY }),
  ));

// Wazir's own schema validator: an invalid tool call goes back to the model as a tool error
// (like Wazir's coding agent does) instead of reaching the tool implementation.
type Validator = ((input: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
let validatorsPromise: Promise<Record<string, Validator>> | undefined;
const validators = () =>
  (validatorsPromise ??= import(pathToFileURL(`${WAZIR_ROOT}/packages/core/dist/src/services/toolValidation.js`).href).then(
    (m) => Object.fromEntries(TOOLS.map((t) => [t.function.name, m.compileToolSchema(t.function.parameters) as Validator])),
  ));

const traced = <T>(name: string, attrs: Record<string, string | null>, fn: () => Promise<T> | T): Promise<T> =>
  tracer.startActiveSpan(name, async (span: Span) => {
    for (const [k, v] of Object.entries(attrs)) if (v != null) span.setAttribute(k, v);
    try {
      return await fn();
    } finally {
      span.end();
    }
  });

let seq = 0;

export async function run(prompt: string, sessionId: string | null, user: string | null, signal: AbortSignal) {
  const model = process.env.MODEL ?? "mock";
  const ids = { "session.id": sessionId, "user.id": user };
  const rt = await adapter();
  const messages: any[] = [{ role: "user", content: prompt }];
  const tools = TOOLS.map((t) => t.function);
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  let inTok = 0, outTok = 0, output = "", stopReason = "max_turns";

  await traced(`invoke_agent ${HARNESS}`, ids, async () => {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const requestId = `wazir-${process.pid}-${++seq}`;
      const onAbort = () => void rt.cancel(requestId);
      signal.addEventListener("abort", onAbort, { once: true });
      const calls: { id?: string; name: string; args: Record<string, unknown> }[] = [];
      let text = "";
      let finish: string | undefined;
      try {
        await traced(`chat ${model}`, { ...ids, "gen_ai.request.model": model }, async () => {
          for await (const ev of rt.generate({ modelId: model, systemPrompt: SYSTEM_PROMPT, messages, tools, requestId })) {
            if (ev.type === "token") text += ev.content ?? "";
            else if (ev.type === "tool_call") calls.push({ id: ev.toolCallId, name: ev.toolName, args: (ev.toolInput ?? {}) as Record<string, unknown> });
            else if (ev.type === "completed") {
              inTok += ev.usage?.inputTokens ?? 0;
              outTok += ev.usage?.outputTokens ?? 0;
              finish = ev.finishReason;
            } else if (ev.type === "error") throw new Error(ev.error ?? "runtime error");
          }
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) return;
      if (finish === "content_filter") {
        stopReason = "content_filter";
        return;
      }
      if (calls.length === 0) {
        output = text;
        stopReason = "end_turn";
        return;
      }
      messages.push({ role: "assistant", content: text, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })) });
      for (const c of calls) {
        toolCalls.push({ name: c.name, args: c.args });
        const validate = (await validators())[c.name];
        const result = await traced(`execute_tool ${c.name}`, { ...ids, "gen_ai.tool.name": c.name }, () => {
          if (!IMPLS[c.name] || !validate) return `error: unknown tool ${c.name}`;
          if (typeof c.args !== "object" || c.args === null || Array.isArray(c.args) || !validate(c.args)) {
            const why = (validate.errors ?? []).map((e) => `${e.instancePath || "arguments"} ${e.message}`).join("; ") || "arguments must be a JSON object";
            return `error: invalid arguments for ${c.name}: ${why}`;
          }
          try {
            return IMPLS[c.name](c.args);
          } catch (err) {
            return `error: ${c.name} failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
        messages.push({ role: "tool", content: String(result), toolCallId: c.id, name: c.name });
      }
    }
  });
  return { output: output.trim(), tool_calls: toolCalls, usage: { input_tokens: inTok, output_tokens: outTok },
           stop_reason: stopReason };
}
