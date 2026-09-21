import { describe, it, expect, beforeEach, vi } from 'vitest';


import { PolicyEngine } from '../src/services/policyEngine.js';

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine({
      projectRoot: '/test/project',
      networkAllowed: false,
      allowCommands: ['echo', 'cat'],
      denyCommands: ['rm -rf', 'dd'],
      allowedMcpServers: ['my-mcp-server'],
    });
  });

  describe('classify', () => {
    it('denies unknown tools', () => {
      const result = engine.classify({
        tool: 'unknown-tool',
        input: {},
      });

      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('unknown-tool');
    });

    it('allows project checks (test, lint, typecheck, build)', () => {
      ['test', 'lint', 'typecheck', 'build'].forEach(tool => {
        const result = engine.classify({
          tool,
          input: {},
        });
        expect(result.decision).toBe('allow');
        expect(result.rule).toBe('project-checks-allow');
      });
    });

    it('allows allowed commands', () => {
      const result = engine.classify({
        tool: 'shell',
        input: { command: 'echo hello' },
      });

      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('shell-safe-allow');
    });

    it('denies denied commands', () => {
      const result = engine.classify({
        tool: 'shell',
        input: { command: 'rm -rf /tmp' },
      });

      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('shell-dangerous-deny');
    });

    it('denies network commands when network is not allowed', () => {
      const result = engine.classify({
        tool: 'shell',
        input: { command: 'curl https://example.com' },
      });

      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('network-default-deny');
    });

    it('allows network commands when network is allowed', () => {
      const engineWithNetwork = new PolicyEngine({
        projectRoot: '/test/project',
        networkAllowed: true,
      });
      
      const result = engineWithNetwork.classify({
        tool: 'shell',
        input: { command: 'curl https://example.com' },
      });

      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('network-default-deny');
    });

    it('allows MCP servers in allowed list', () => {
      const result = engine.classify({
        tool: 'mcp:my-mcp-server:some-action',
        input: {},
      });

      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('mcp-explicit-approval');
    });

    it('denies MCP servers not in allowed list', () => {
      const result = engine.classify({
        tool: 'mcp:unknown-server:some-action',
        input: {},
      });

      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('mcp-explicit-approval');
    });
  });

  describe('filesystem path containment', () => {
    // Regression coverage: a relative `path` must be resolved against the
    // task's projectRoot, not the running process's cwd. `projectRoot` here
    // ('/test/project') deliberately never matches this test process's real
    // cwd, so a resolver that (bug) used `path.resolve(rawPath)` alone would
    // resolve against the wrong base and wrongly deny every relative path —
    // exactly the defect this test file previously had zero coverage for.
    it('allows a relative read/write path inside the project root', () => {
      for (const tool of ['read', 'write', 'edit']) {
        const result = engine.classify({ tool, input: { path: 'src/index.ts' } });
        expect(result.decision).toBe('allow');
        expect(result.rule).toBe('filesystem-project-allow');
      }
    });

    it('allows an absolute path that is inside the project root', () => {
      const result = engine.classify({ tool: 'write', input: { path: '/test/project/src/index.ts' } });
      expect(result.decision).toBe('allow');
    });

    it('denies a relative path that escapes the project root via ..', () => {
      const result = engine.classify({ tool: 'read', input: { path: '../../etc/passwd' } });
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('filesystem-outside-deny');
    });

    it('denies an absolute path outside the project root', () => {
      const result = engine.classify({ tool: 'write', input: { path: '/etc/passwd' } });
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('filesystem-outside-deny');
    });

    it('denies when no path or file argument is given', () => {
      const result = engine.classify({ tool: 'read', input: {} });
      expect(result.decision).toBe('deny');
      expect(result.reasons[0]).toContain('requires a path argument');
    });

    it('accepts `file` as an alias for `path`', () => {
      const result = engine.classify({ tool: 'read', input: { file: 'README.md' } });
      expect(result.decision).toBe('allow');
    });

    it('honors a projectRoot override on the request itself, not just the engine default', () => {
      // Absolute path inside the override root, outside the engine's
      // default ('/test/project') — only allowed if the override wins.
      const allowed = engine.classify({
        tool: 'write',
        input: { path: '/somewhere/else/notes.txt' },
        projectRoot: '/somewhere/else',
      });
      expect(allowed.decision).toBe('allow');

      // Same path, no override: must fall back to the engine default and deny.
      const denied = engine.classify({
        tool: 'write',
        input: { path: '/somewhere/else/notes.txt' },
      });
      expect(denied.decision).toBe('deny');
    });
  });

  describe('authorize', () => {
    it('approves allow decisions directly', async () => {
      // Shell command that is safe
      const request = {
        tool: 'shell',
        input: { command: 'echo hello' },
      };
      
      const decision = await engine.authorize(request);
      expect(decision.decision).toBe('allow');
    });

    it('denies ask decisions when no approver is configured', async () => {
      // Shell commands that require approval
      const request = {
        tool: 'shell',
        input: { command: 'git status' },
      };
      
      const decision = await engine.authorize(request);
      expect(decision.decision).toBe('deny');
    });

    it('allows ask decisions when approver approves', async () => {
      const engineWithApprover = new PolicyEngine({
        projectRoot: '/test/project',
        approveCallback: async (request, decision) => true,
      });
      
      const request = {
        tool: 'shell',
        input: { command: 'git status' },
      };
      
      const decision = await engineWithApprover.authorize(request);
      expect(decision.decision).toBe('allow');
      expect(decision.rule).toContain('user-approved');
    });

    it('contextual workspace artifact execution auto-allows binaries inside projectRoot without global whitelisting', async () => {
      const engineWithArtifacts = new PolicyEngine({
        projectRoot: '/test/project',
        allowWorkspaceArtifactExecution: true,
      });

      // Executing ./main inside projectRoot is auto-allowed
      const mainDecision = engineWithArtifacts.classify({
        tool: 'shell',
        input: { command: './main' },
      });
      expect(mainDecision.decision).toBe('allow');
      expect(mainDecision.rule).toBe('shell-workspace-artifact-allow');

      // Executing with arguments
      const argsDecision = engineWithArtifacts.classify({
        tool: 'shell',
        input: { command: './build/test --arg 123' },
      });
      expect(argsDecision.decision).toBe('allow');
      expect(argsDecision.rule).toBe('shell-workspace-artifact-allow');

      // Traversal outside project root is rejected
      const outsideDecision = engineWithArtifacts.classify({
        tool: 'shell',
        input: { command: './../outside_bin' },
      });
      expect(outsideDecision.decision).toBe('ask');
      expect(outsideDecision.rule).not.toBe('shell-workspace-artifact-allow');

      // Executable inside protected paths (node_modules, .git) requires approval
      const protectedDecision = engineWithArtifacts.classify({
        tool: 'shell',
        input: { command: './node_modules/.bin/foo' },
      });
      expect(protectedDecision.decision).toBe('ask');
      expect(protectedDecision.rule).toBe('shell-workspace-artifact-ask');

      const gitHookDecision = engineWithArtifacts.classify({
        tool: 'shell',
        input: { command: './.git/hooks/pre-commit' },
      });
      expect(gitHookDecision.decision).toBe('ask');
      expect(gitHookDecision.rule).toBe('shell-workspace-artifact-ask');
    });
  });
});
