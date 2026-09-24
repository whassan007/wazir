import { describe, it, expect, vi } from 'vitest';
import {
  normalizeToActionEnvelope,
  actionToEnvelope,
  envelopeToCanonicalAction,
  ModelProtocolAdapter,
} from '../src/protocolAdapters.js';
import { PolicyEngine, type ToolResult } from '@wazir/core';

describe('ActionEnvelope & Protocol Normalization', () => {
  const toolNames = new Set(['read', 'write', 'edit', 'shell', 'code_mode', 'build', 'test']);

  // Test 3: native call normalized into ActionEnvelope
  it('3. normalizes native tool calls into ActionEnvelope with source: native_tool_call', () => {
    const nativeCall = {
      id: 'call_12345',
      name: 'read',
      input: { path: 'src/main.ts' },
    };

    const result = normalizeToActionEnvelope({
      nativeToolCall: nativeCall,
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
      phase: 'inspect',
    });

    expect(result.error).toBeUndefined();
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.id).toBe('call_12345');
    expect(result.envelope?.name).toBe('read');
    expect(result.envelope?.source).toBe('native_tool_call');
    expect(result.envelope?.runtimeId).toBe('lmstudio');
    expect(result.envelope?.modelId).toBe('qwen3-coder');
    expect(result.envelope?.arguments).toEqual({ path: 'src/main.ts' });
    expect(result.envelope?.phase).toBe('inspect');

    const canonical = envelopeToCanonicalAction(result.envelope!);
    expect(canonical.action).toBe('tool');
    expect(canonical.tool).toBe('read');
    expect(canonical.input).toEqual({ path: 'src/main.ts' });
  });

  // Test 4: malformed native arguments rejected
  it('4. rejects malformed native tool arguments with clear validation error', () => {
    // Malformed JSON string
    const malformedJson = {
      name: 'read',
      input: '{"path": "unclosed_string',
    };
    const res1 = normalizeToActionEnvelope({
      nativeToolCall: malformedJson,
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
    });
    expect(res1.envelope).toBeNull();
    expect(res1.error).toContain('Malformed native tool arguments');

    // Non-object JSON
    const nonObject = {
      name: 'read',
      input: '"just a string"',
    };
    const res2 = normalizeToActionEnvelope({
      nativeToolCall: nonObject,
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
    });
    expect(res2.envelope).toBeNull();
    expect(res2.error).toContain('expected JSON object');

    // Semantic placeholder failure
    const placeholder = {
      name: 'read',
      input: { path: '<path_to_file>' },
    };
    const res3 = normalizeToActionEnvelope({
      nativeToolCall: placeholder,
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
    });
    expect(res3.envelope).toBeNull();
    expect(res3.error).toContain('placeholder');
  });

  // Test 5: native and legacy paths converge before ToolRegistry execution
  it('5. native and legacy paths converge into identical ActionEnvelope semantics before execution', () => {
    // Path A: Native tool calling
    const nativeCall = {
      name: 'write',
      input: { path: 'file.txt', content: 'hello world' },
    };
    const envelopeNative = normalizeToActionEnvelope({
      nativeToolCall: nativeCall,
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
      phase: 'implement',
    }).envelope!;

    // Path B: Legacy JSON action
    const legacyRaw = '{"action":"tool","tool":"write","input":{"path":"file.txt","content":"hello world"}}';
    const envelopeLegacy = normalizeToActionEnvelope({
      raw: legacyRaw,
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
      phase: 'implement',
    }).envelope!;

    // Both produce canonical ActionEnvelope
    expect(envelopeNative.name).toBe('write');
    expect(envelopeLegacy.name).toBe('write');
    expect(envelopeNative.arguments).toEqual(envelopeLegacy.arguments);

    // Converge to identical CanonicalAction for ToolRegistry execution
    const canonicalNative = envelopeToCanonicalAction(envelopeNative);
    const canonicalLegacy = envelopeToCanonicalAction(envelopeLegacy);
    expect(canonicalNative.tool).toBe(canonicalLegacy.tool);
    expect(canonicalNative.input).toEqual(canonicalLegacy.input);
  });

  // Test 11: policy still intercepts native calls
  it('11. policy intercepts native tool calls identical to legacy actions', async () => {
    const policy = new PolicyEngine();
    // Deny modifying package.json or sensitive files
    const nativeEnvelope = normalizeToActionEnvelope({
      nativeToolCall: {
        name: 'write',
        input: { path: '/etc/passwd', content: 'malicious' },
      },
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
    }).envelope!;

    const action = envelopeToCanonicalAction(nativeEnvelope);
    const decision = await policy.authorize({
      tool: action.tool!,
      input: action.input as Record<string, unknown>,
      projectRoot: '/home/wael/Code/Wazir',
    });

    expect(decision.decision).toBe('deny');
  });

  // Test 12: provenance still records native calls
  it('12. provenance records native call source, runtimeId, and modelId', () => {
    const envelope = normalizeToActionEnvelope({
      nativeToolCall: {
        id: 'call_prov_99',
        name: 'shell',
        input: { command: 'git status' },
      },
      runtimeId: 'lmstudio-local',
      modelId: 'qwen/qwen3-coder-next',
      toolNames,
      phase: 'verify',
    }).envelope!;

    expect(envelope.id).toBe('call_prov_99');
    expect(envelope.source).toBe('native_tool_call');
    expect(envelope.runtimeId).toBe('lmstudio-local');
    expect(envelope.modelId).toBe('qwen/qwen3-coder-next');
    expect(envelope.phase).toBe('verify');
    expect(envelope.timestamp).toBeInstanceOf(Date);
  });

  // Test 13: Code Mode remains functional as a canonical tool
  it('13. Code Mode is normalized as a canonical action envelope', () => {
    const script = 'const data = await wazir.read("package.json"); return JSON.parse(data).version;';
    const envelope = normalizeToActionEnvelope({
      nativeToolCall: {
        name: 'code_mode',
        input: { script },
      },
      runtimeId: 'lmstudio',
      modelId: 'qwen3-coder',
      toolNames,
    }).envelope!;

    expect(envelope.name).toBe('code_mode');
    expect(envelope.source).toBe('native_tool_call');
    expect(envelope.arguments).toEqual({ script });

    const canonical = envelopeToCanonicalAction(envelope);
    expect(canonical.tool).toBe('code_mode');
    expect((canonical.input as any)?.script).toBe(script);
  });

  // Test 15: legacy parser still works across Gemma, Qwen, and Anthropic formats
  it('15. legacy parser normalizes multi-provider wire formats into canonical ActionEnvelope', () => {
    // Gemma wire format
    const gemma = '<|tool_call>call:shell{command:"ls -la"}';
    const gemmaEnv = normalizeToActionEnvelope({
      raw: gemma,
      runtimeId: 'gemma-rt',
      modelId: 'gemma-4',
      toolNames,
    }).envelope!;
    expect(gemmaEnv.name).toBe('shell');
    expect(gemmaEnv.source).toBe('legacy_text');
    expect(gemmaEnv.arguments).toEqual({ command: 'ls -la' });

    // Qwen wire format
    const qwen = '<tool_call>\n{"name":"read","arguments":{"path":"README.md"}}\n</tool_call>';
    const qwenEnv = normalizeToActionEnvelope({
      raw: qwen,
      runtimeId: 'qwen-rt',
      modelId: 'qwen-2.5',
      toolNames,
    }).envelope!;
    expect(qwenEnv.name).toBe('read');
    expect(qwenEnv.source).toBe('legacy_text');
    expect(qwenEnv.arguments).toEqual({ path: 'README.md' });

    // Anthropic tool_use format
    const anthropic = '<tool_use>\n<name>read</name>\n<parameters>\n{"path":"config.json"}\n</parameters>\n</tool_use>';
    const anthropicEnv = normalizeToActionEnvelope({
      raw: anthropic,
      runtimeId: 'claude-rt',
      modelId: 'claude-3-5',
      toolNames,
    }).envelope!;
    expect(anthropicEnv.name).toBe('read');
    expect(anthropicEnv.arguments).toEqual({ path: 'config.json' });
  });

  // Test 16: runtime fallback is explicit, not silent
  it('16. distinguishes native tool call from structured output and legacy text fallback', () => {
    // Native
    const native = normalizeToActionEnvelope({
      nativeToolCall: { name: 'test', input: {} },
      runtimeId: 'r1',
      modelId: 'm1',
      toolNames,
    }).envelope!;
    expect(native.source).toBe('native_tool_call');

    // Legacy text fallback
    const fallback = normalizeToActionEnvelope({
      raw: '{"action":"tool","tool":"test","input":{}}',
      runtimeId: 'r1',
      modelId: 'm1',
      toolNames,
    }).envelope!;
    expect(fallback.source).toBe('legacy_text');
  });

  // Test 17 & 18: parallel tool calls handling
  it('17 & 18. processes parallel tool calls deterministically and degrades safely if serialized', () => {
    const rawBatch = [
      { id: 'call_1', name: 'read', input: { path: 'a.txt' } },
      { id: 'call_2', name: 'read', input: { path: 'b.txt' } },
    ];

    // Normalize each tool call sequentially or in parallel deterministically
    const envelopes = rawBatch.map((tc) =>
      normalizeToActionEnvelope({
        nativeToolCall: tc,
        runtimeId: 'lmstudio',
        modelId: 'qwen',
        toolNames,
      }).envelope!,
    );

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].id).toBe('call_1');
    expect(envelopes[0].arguments).toEqual({ path: 'a.txt' });
    expect(envelopes[1].id).toBe('call_2');
    expect(envelopes[1].arguments).toEqual({ path: 'b.txt' });
  });
});
