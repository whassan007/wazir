import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBroker, EncryptedFileBackend } from '@wazir/secrets';
import { formatOpenAIChatMessages, type ChatMessage } from '../src/index.js';
import { OpenAIAdapter } from '../../openai/src/index.js';
import { AnthropicAdapter } from '../../anthropic/src/index.js';
import { GoogleAdapter } from '../../google/src/index.js';
import { OllamaAdapter } from '../../ollama/src/index.js';
import { LMStudioAdapter } from '../../lmstudio/src/index.js';

async function makeBroker(): Promise<SecretBroker> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-rt-tools-'));
  return new SecretBroker(new EncryptedFileBackend(dir));
}

const MULTI_TURN_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are Wazir.' },
  { role: 'user', content: 'Read a.ts and b.ts' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
      { id: 'call_2', name: 'read', arguments: { path: 'b.ts' } },
    ],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'read', content: '1: export const a = 1;' },
  { role: 'tool', toolCallId: 'call_2', name: 'read', content: '1: export const b = 2;' },
];

describe('Multi-turn native tool_calls wire serialization across runtimes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formatOpenAIChatMessages preserves assistant.tool_calls and tool_call_id while supporting legacy ID-less fallbacks', () => {
    const formatted = formatOpenAIChatMessages({
      messages: [
        ...MULTI_TURN_MESSAGES,
        { role: 'tool', name: 'shell', content: 'legacy output without id' },
      ],
    });

    expect(formatted[0]).toEqual({ role: 'system', content: 'You are Wazir.' });
    expect(formatted[1]).toEqual({ role: 'user', content: 'Read a.ts and b.ts' });
    expect(formatted[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
        { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"path":"b.ts"}' } },
      ],
    });
    expect(formatted[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '1: export const a = 1;',
    });
    expect(formatted[4]).toEqual({
      role: 'tool',
      tool_call_id: 'call_2',
      content: '1: export const b = 2;',
    });
    expect(formatted[5]).toEqual({
      role: 'user',
      content: '[tool result: shell]\nlegacy output without id',
    });
  });

  it('OpenAIAdapter sends native tool_calls, tool_call_id, and parallel_tool_calls: true', async () => {
    const broker = await makeBroker();
    await broker.putCredential(
      'openai',
      JSON.stringify({
        provider: 'openai',
        method: 'api-key',
        credential: { kind: 'api-key', apiKey: 'sk-test-123' },
        obtainedAt: new Date().toISOString(),
      }),
    );

    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        const sse = 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const adapter = new OpenAIAdapter(broker);
    for await (const _ev of adapter.generate({
      modelId: 'gpt-4o',
      messages: MULTI_TURN_MESSAGES,
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
      parallelToolCalls: true,
    })) {
      // drain
    }

    expect(sentBody?.parallel_tool_calls).toBe(true);
    const msgs = sentBody?.messages as Array<Record<string, unknown>>;
    expect(msgs[2].tool_calls).toHaveLength(2);
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(msgs[4]).toMatchObject({ role: 'tool', tool_call_id: 'call_2' });
  });

  it('AnthropicAdapter preserves { role: "system" }, coalesces parallel tool_result blocks, advertises nativeToolCalling, and streams thinking_delta', async () => {
    const broker = await makeBroker();
    await broker.putCredential(
      'anthropic',
      JSON.stringify({
        provider: 'anthropic',
        method: 'api-key',
        credential: { kind: 'api-key', apiKey: 'sk-ant-123' },
        obtainedAt: new Date().toISOString(),
      }),
    );

    const adapter = new AnthropicAdapter(broker);
    const caps = await adapter.getCapabilities();
    expect(caps.nativeToolCalling).toBe(true);
    expect(caps.parallelToolCalling).toBe(true);

    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        const sse = [
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"checking both files"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const events: Array<{ type: string; content?: string }> = [];
    for await (const ev of adapter.generate({
      modelId: 'claude-sonnet-4-20250514',
      messages: MULTI_TURN_MESSAGES,
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
    })) {
      events.push(ev);
    }

    expect(sentBody?.system).toBe('You are Wazir.');
    const msgs = sentBody?.messages as Array<{ role: string; content: unknown }>;
    // user -> assistant (2 tool_use blocks) -> single coalesced user (2 tool_result blocks)
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'call_2', name: 'read', input: { path: 'b.ts' } },
    ]);
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '1: export const a = 1;' },
      { type: 'tool_result', tool_use_id: 'call_2', content: '1: export const b = 2;' },
    ]);
    expect(events.some((e) => e.type === 'reasoning' && e.content === 'checking both files')).toBe(true);
  });

  it('GoogleAdapter preserves { role: "system" } as systemInstruction and serializes functionCall + functionResponse parts', async () => {
    const broker = await makeBroker();
    await broker.putCredential(
      'google',
      JSON.stringify({
        provider: 'google',
        method: 'api-key',
        credential: { kind: 'api-key', apiKey: 'AIza-test' },
        obtainedAt: new Date().toISOString(),
      }),
    );

    const adapter = new GoogleAdapter(broker);
    const caps = await adapter.getCapabilities();
    expect(caps.nativeToolCalling).toBe(true);
    expect(caps.parallelToolCalling).toBe(true);

    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"All set"}]},"finishReason":"STOP"}]}\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    for await (const _ev of adapter.generate({
      modelId: 'gemini-2.5-pro',
      messages: MULTI_TURN_MESSAGES,
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
    })) {
      // drain
    }

    expect(sentBody?.systemInstruction).toEqual({ parts: [{ text: 'You are Wazir.' }] });
    const contents = sentBody?.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents).toHaveLength(3);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { name: 'read', args: { path: 'a.ts' } } },
        { functionCall: { name: 'read', args: { path: 'b.ts' } } },
      ],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'read', response: { result: '1: export const a = 1;' } } },
        { functionResponse: { name: 'read', response: { result: '1: export const b = 2;' } } },
      ],
    });
  });

  it('OllamaAdapter serializes object tool_calls and assigns deterministic toolCallId on streamed tool_call events', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        const ndjson = [
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'read', arguments: { path: 'c.ts' } } }],
            },
          }),
          JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5 }),
        ].join('\n');
        return new Response(ndjson, { status: 200 });
      }),
    );

    const adapter = new OllamaAdapter();
    const toolEvents: Array<{ toolCallId?: string; toolName?: string }> = [];
    for await (const ev of adapter.generate({
      modelId: 'qwen3-coder:latest',
      messages: MULTI_TURN_MESSAGES,
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
    })) {
      if (ev.type === 'tool_call') {
        toolEvents.push({ toolCallId: ev.toolCallId, toolName: ev.toolName });
      }
    }

    const msgs = sentBody?.messages as Array<Record<string, unknown>>;
    expect(msgs[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: { path: 'a.ts' } } },
        { id: 'call_2', type: 'function', function: { name: 'read', arguments: { path: 'b.ts' } } },
      ],
    });
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_name: 'read', tool_call_id: 'call_1' });
    expect(toolEvents).toEqual([{ toolCallId: 'ollama-call-0', toolName: 'read' }]);
  });

  it('LMStudioAdapter honors request.parallelToolCalls = true instead of forcing false', async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const adapter = new LMStudioAdapter();
    for await (const _ev of adapter.generate({
      modelId: 'qwen2.5-coder-32b',
      messages: MULTI_TURN_MESSAGES,
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
      parallelToolCalls: true,
    })) {
      // drain
    }

    expect(sentBody?.parallel_tool_calls).toBe(true);
  });
});
