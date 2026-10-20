import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine } from '@wazir/core';

describe('Integration: Policy Enforcement', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine({
      projectRoot: '/test/project',
      networkAllowed: false,
      allowedMcpServers: [],
    });
  });

  it('allows filesystem read inside project root', async () => {
    const request = { tool: 'read', input: { path: '/test/project/file.txt' } };
    const decision = await engine.authorize(request);
    expect(decision.decision).toBe('allow');
    expect(decision.tool).toBe('read');
  });

  it('denies filesystem write outside project root', async () => {
    const request = { tool: 'write', input: { path: '/outside/project/file.txt' } };
    const decision = await engine.authorize(request);
    expect(decision.decision).toBe('deny');
    expect(decision.tool).toBe('write');
  });

  it('denies unknown tools', async () => {
    const request = { tool: 'unknown-tool', input: {} };
    const decision = await engine.authorize(request);
    expect(decision.decision).toBe('deny');
    expect(decision.tool).toBe('unknown-tool');
  });

  it('allows project checks (test, lint, typecheck, build)', async () => {
    for (const tool of ['test', 'lint', 'typecheck', 'build']) {
      const decision = await engine.authorize({ tool, input: {} });
      expect(decision.decision).toBe('allow');
    }
  });

  it('denies network commands when network not allowed', async () => {
    const request = { tool: 'shell', input: { command: 'curl https://example.com' } };
    const decision = await engine.authorize(request);
    expect(decision.decision).toBe('deny');
  });
});
