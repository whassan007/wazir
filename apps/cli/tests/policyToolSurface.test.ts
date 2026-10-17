import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '@wazir/core';
import { policySupportsModelTool } from '../src/run.js';

describe('policy-supported model tool surface', () => {
  const engine = { projectRoot: '/tmp', policy: new PolicyEngine({ projectRoot: '/tmp', networkAllowed: false }) };
  it('keeps argument-gated builtins but hides unsupported registry names', () => {
    for (const tool of ['read', 'write', 'edit', 'search', 'glob', 'shell', 'git', 'test', 'build']) expect(policySupportsModelTool(engine, tool), tool).toBe(true);
    for (const tool of ['documentSymbols', 'findReferences', 'code_mode', 'terminal_open', 'invented']) expect(policySupportsModelTool(engine, tool), tool).toBe(false);
  });
  it('hides disabled web and unapproved MCP tools and retains fail-closed authorization', () => {
    for (const tool of ['web_search', 'web_fetch', 'mcp.unapproved.write']) expect(policySupportsModelTool(engine, tool), tool).toBe(false);
    expect(engine.policy.classify({ tool: 'code_mode', input: { script: 'return 1' } }).decision).toBe('deny');
    expect(engine.policy.classify({ tool: 'shell', input: { command: 'curl https://example.com' } }).decision).not.toBe('allow');
  });
});
