import { describe, expect, it } from 'vitest';
import {
  ModelProtocolAdapter,
  parseGemmaProtocol,
  parseQwenProtocol,
  parseAnthropicProtocol,
  parseOpenAiProtocol,
} from '../src/protocolAdapters.js';
import { normalizeAction, parseAction } from '../src/codingAgent.js';

describe('ModelProtocolAdapter', () => {
  const toolNames = new Set(['read', 'write', 'shell', 'glob', 'test', 'git']);

  describe('Gemma Wire Protocol', () => {
    it('parses call:tool{tool:..., input:...}', () => {
      const raw = '<|tool_call>call:tool{tool:"shell","input":{"command":"mkdir -p quick_sort_sum"}}<|tool_response>';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action).toEqual({
        action: 'tool',
        tool: 'shell',
        input: { command: 'mkdir -p quick_sort_sum' },
        protocol: 'gemma',
      });
    });

    it('parses call:shell{command:...} directly', () => {
      const raw = '<|tool_call>call:shell{command:"mkdir -p quick_sort_sum"}';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action).toEqual({
        action: 'tool',
        tool: 'shell',
        input: { command: 'mkdir -p quick_sort_sum' },
        protocol: 'gemma',
      });
    });

    it('parses call:write{path:..., content:...} directly', () => {
      const raw = '<|tool_call>call:write{path:"main.cpp",content:"int main(){return 0;}"}';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action).toEqual({
        action: 'tool',
        tool: 'write',
        input: { path: 'main.cpp', content: 'int main(){return 0;}' },
        protocol: 'gemma',
      });
    });

    it('parses <|tool_call> with unquoted keys', () => {
      const raw = '<|tool_call>call:shell{command: "ls -la"}';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action?.tool).toBe('shell');
      expect((action?.input as { command: string }).command).toBe('ls -la');
    });

    it('parses <|tool_call>{"name":"shell",...}', () => {
      const raw = '<|tool_call>{"name":"shell","arguments":{"command":"ls"}}';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action?.tool).toBe('shell');
      expect(action?.input).toEqual({ command: 'ls' });
    });
  });

  describe('Qwen Wire Protocol', () => {
    it('parses <tool_call> tags with JSON content', () => {
      const raw = '<tool_call>\n{"name": "shell", "arguments": {"command": "g++ main.cpp -o main"}}\n</tool_call>';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action).toEqual({
        action: 'tool',
        tool: 'shell',
        input: { command: 'g++ main.cpp -o main' },
        protocol: 'qwen',
      });
    });

    it('parses <tool_call> when arguments is a stringified JSON', () => {
      const raw = '<tool_call>{"name":"write","arguments":"{\\"path\\":\\"test.txt\\",\\"content\\":\\"hi\\"}"}</tool_call>';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action?.tool).toBe('write');
      expect(action?.input).toEqual({ path: 'test.txt', content: 'hi' });
    });
  });

  describe('Anthropic Wire Protocol', () => {
    it('parses <tool_use> tags with XML parameter structure', () => {
      const raw = '<tool_use>\n<name>shell</name>\n<parameters>\n{"command":"make"}\n</parameters>\n</tool_use>';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action).toEqual({
        action: 'tool',
        tool: 'shell',
        input: { command: 'make' },
        protocol: 'anthropic',
      });
    });
  });

  describe('OpenAI Function Calling Format', () => {
    it('parses top-level name and arguments', () => {
      const raw = '{"name":"shell","arguments":{"command":"echo hello"}}';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action?.tool).toBe('shell');
      expect(action?.input).toEqual({ command: 'echo hello' });
    });

    it('parses tool_calls array format', () => {
      const raw = '{"tool_calls":[{"function":{"name":"shell","arguments":"{\\"command\\":\\"pwd\\"}"}}]}';
      const action = ModelProtocolAdapter.parse(raw, toolNames);
      expect(action?.tool).toBe('shell');
      expect(action?.input).toEqual({ command: 'pwd' });
    });
  });

  describe('End-to-End parseAction + normalizeAction Integration', () => {
    it('seamlessly normalizes Gemma call:tool format into valid CodingAgent action', () => {
      const raw = '<|tool_call>call:tool{tool:"shell","input":{"command":"mkdir -p quick_sort_sum"}}';
      const parsed = parseAction(raw, toolNames);
      const normalized = normalizeAction(parsed, toolNames);
      expect(normalized).toEqual({
        action: 'tool',
        tool: 'shell',
        input: { command: 'mkdir -p quick_sort_sum' },
        protocol: 'gemma',
      });
    });

    it('coerces argv array in Gemma format', () => {
      const raw = '<|tool_call>call:shell{command:["mkdir","-p","sort_dir"]}';
      const parsed = parseAction(raw, toolNames);
      const normalized = normalizeAction(parsed, toolNames);
      expect(normalized?.tool).toBe('shell');
      expect((normalized?.input as { command: string }).command).toBe("mkdir -p sort_dir");
    });
  });
});
