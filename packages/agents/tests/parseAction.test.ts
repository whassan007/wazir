import { describe, expect, it } from 'vitest';
import { normalizeAction, parseAction } from '../src/codingAgent.js';

describe('normalizeAction', () => {
  const tools = new Set(['read', 'write', 'test']);

  it('rewrites a tool name used as the action into a tool call', () => {
    const action = normalizeAction(parseAction('{"action":"read","input":{"path":"greet.js"}}'), tools);
    expect(action).toEqual({ action: 'tool', tool: 'read', input: { path: 'greet.js' } });
  });

  it('lifts sibling fields into input when input is missing', () => {
    const action = normalizeAction(parseAction('{"action":"read","path":"greet.js"}'), tools);
    expect(action).toEqual({ action: 'tool', tool: 'read', input: { path: 'greet.js' } });
  });

  it('accepts name as an alias for tool', () => {
    const action = normalizeAction(parseAction('{"action":"tool","name":"test","input":{}}'), tools);
    expect(action?.tool).toBe('test');
  });

  it('leaves plan/done and unknown actions alone', () => {
    expect(normalizeAction(parseAction('{"action":"plan","content":"x"}'), tools)?.action).toBe('plan');
    expect(normalizeAction(parseAction('{"action":"frobnicate"}'), tools)?.action).toBe('frobnicate');
    expect(normalizeAction(null, tools)).toBeNull();
  });
});

describe('parseAction', () => {
  it('parses a well-formed tool action', () => {
    const action = parseAction('{"action":"tool","tool":"read","input":{"path":"greet.js"}}');
    expect(action).toEqual({ action: 'tool', tool: 'read', input: { path: 'greet.js' } });
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const action = parseAction('Sure!\n```json\n{"action":"plan","content":"1. read\\n2. edit"}\n```\n');
    expect(action?.action).toBe('plan');
    expect(action?.content).toBe('1. read\n2. edit');
  });

  it('repairs an array that was never closed', () => {
    const action = parseAction('{"action":"plan","content":["inspect greet.js","add shout"}');
    expect(action?.action).toBe('plan');
    expect(action?.content).toBe('inspect greet.js\nadd shout');
  });

  it('repairs an array closed after the object', () => {
    const action = parseAction('{"action":"plan","content":["inspect greet.js\\n","add shout"}]');
    expect(action?.action).toBe('plan');
    expect(action?.content).toBe('inspect greet.js\nadd shout');
  });

  it('escapes raw newlines left unescaped inside a string value', () => {
    const action = parseAction('{"action":"plan","content":["1. inspect\n2. edit\n3. verify"}');
    expect(action?.action).toBe('plan');
    expect(action?.content).toBe('1. inspect\n2. edit\n3. verify');
  });

  it('takes only the first object when the model stacks several in one turn', () => {
    const action = parseAction(
      '{"action":"tool","tool":"read","input":{"path":"a.ts"}}\n' +
        '{"action":"tool","tool":"read","input":{"path":"b.ts"}}\n' +
        '{"action":"tool","tool":"read","input":{"path":"c.ts"}}',
    );
    expect(action).toEqual({ action: 'tool', tool: 'read', input: { path: 'a.ts' } });
  });

  it('joins array summaries on done', () => {
    const action = parseAction('{"action":"done","summary":["added shout","tests pass"]}');
    expect(action?.summary).toBe('added shout\ntests pass');
  });

  it('does not touch brackets inside strings', () => {
    const action = parseAction('{"action":"tool","tool":"write","input":{"path":"a.js","content":"const x = [1, {a: 2}"}}');
    expect(action?.action).toBe('tool');
    expect((action?.input as { content: string }).content).toBe('const x = [1, {a: 2}');
  });

  it('returns null when there is no action object', () => {
    expect(parseAction('I will now read the file.')).toBeNull();
    expect(parseAction('{"foo":"bar"}')).toBeNull();
  });
});
