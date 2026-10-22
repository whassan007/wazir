import { describe, it, expect, afterEach } from 'vitest';
import { PolicyEngine, CodeModeService, type CodeModeToolExecutor } from '../src/index.js';
import { codeModeTool, createCodeModeTool } from '../../tools/src/codeModeTool.js';
import { ToolRegistry } from '../../tools/src/registry.js';
import { detectEffectiveIsolation, resetSandboxProbe, sandboxStatus } from '../../tools/src/sandbox.js';
import { createControlledExecution } from '../../../apps/api/src/toolExecution.js';
import { FleetTui } from '../../../apps/cli/src/tui/fleetTui.js';

describe('Phase 4C (ISS-018): Sandbox Enforcement, Policy Isolation & CodeMode Hardening', () => {
  const originalSandboxEnv = process.env.WAZIR_SANDBOX;

  afterEach(() => {
    if (originalSandboxEnv === undefined) {
      delete process.env.WAZIR_SANDBOX;
    } else {
      process.env.WAZIR_SANDBOX = originalSandboxEnv;
    }
    resetSandboxProbe();
  });

  describe('1. PolicyEngine requiredIsolation & effectiveIsolation enforcement', () => {
    it('denies tool execution when requiredIsolation is "os" and effectiveIsolation is "none"', async () => {
      const policy = new PolicyEngine({
        projectRoot: '/test/project',
        requiredIsolation: 'os',
      });

      const check = policy.checkIsolationCompliance({
        tool: 'shell',
        input: { command: 'echo hello' },
        effectiveIsolation: 'none',
      });
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("policy requires 'os' sandbox isolation");

      const classified = policy.classify({
        tool: 'shell',
        input: { command: 'echo hello' },
        effectiveIsolation: 'none',
      });
      expect(classified.decision).toBe('deny');
      expect(classified.rule).toBe('isolation-unavailable');

      const authorized = await policy.authorize({
        tool: 'shell',
        input: { command: 'echo hello' },
        effectiveIsolation: 'none',
      });
      expect(authorized.decision).toBe('deny');
      expect(authorized.rule).toBe('isolation-unavailable');
    });

    it('allows tool execution when requiredIsolation is "os" and effectiveIsolation is an active OS sandbox', async () => {
      const policy = new PolicyEngine({
        projectRoot: '/test/project',
        requiredIsolation: 'os',
      });

      for (const mode of ['bwrap', 'sandbox-exec', 'seatbelt', 'container'] as const) {
        const decision = await policy.authorize({
          tool: 'shell',
          input: { command: 'echo hello' },
          effectiveIsolation: mode,
        });
        expect(decision.decision).toBe('allow');
        expect(decision.rule).toBe('shell-safe-allow');
      }
    });

    it('propagates effectiveIsolation from sandboxStatus in API createControlledExecution', async () => {
      process.env.WAZIR_SANDBOX = 'none';
      resetSandboxProbe();
      expect(detectEffectiveIsolation()).toBe('none');

      const policy = new PolicyEngine({
        projectRoot: process.cwd(),
        requiredIsolation: 'os',
      });
      const controlled = createControlledExecution({
        tools: new ToolRegistry(),
        projectRoot: process.cwd(),
        policy,
      });

      const res = await controlled.executeTool({
        name: 'shell',
        input: { command: 'echo hi' },
        principal: { id: 'test-operator', scopes: ['execute'] } as any,
        executionId: 'exec-iso-1',
        source: 'agent-protocol',
      });

      expect(res.ok).toBe(false);
      expect(res.failureClass).toBe('POLICY_DENIED');
      expect(res.policy?.rule).toBe('isolation-unavailable');
    });
  });

  describe('2. allowWorkspaceArtifactExecution under disabled sandbox', () => {
    it('does not auto-allow workspace binary execution when effectiveIsolation is "none" or WAZIR_SANDBOX=none', async () => {
      const policy = new PolicyEngine({
        projectRoot: '/test/project',
        allowWorkspaceArtifactExecution: true,
      });

      // With effectiveIsolation === 'none', classify must require approval ('ask') and authorize must deny without approver
      const noneClassified = policy.classify({
        tool: 'shell',
        input: { command: './main' },
        effectiveIsolation: 'none',
      });
      expect(noneClassified.decision).toBe('ask');
      expect(noneClassified.rule).toBe('shell-workspace-artifact-ask');

      const noneAuthorized = await policy.authorize({
        tool: 'shell',
        input: { command: './main' },
        effectiveIsolation: 'none',
      });
      expect(noneAuthorized.decision).toBe('deny');

      // With WAZIR_SANDBOX=none in environment, even without explicit effectiveIsolation parameter
      process.env.WAZIR_SANDBOX = 'none';
      const envNoneClassified = policy.classify({
        tool: 'shell',
        input: { command: './build/runner --verify' },
      });
      expect(envNoneClassified.decision).toBe('ask');
      expect(envNoneClassified.rule).toBe('shell-workspace-artifact-ask');

      // With active sandbox isolation, workspace artifact execution remains allowed
      delete process.env.WAZIR_SANDBOX;
      const isolatedClassified = policy.classify({
        tool: 'shell',
        input: { command: './main' },
        effectiveIsolation: 'sandbox-exec',
      });
      expect(isolatedClassified.decision).toBe('allow');
      expect(isolatedClassified.rule).toBe('shell-workspace-artifact-allow');
    });
  });

  describe('3. FleetTui.executeInlineShellCommand policy & sandbox routing', () => {
    it('routes inline shell commands through policy.authorize and denies blocked commands', async () => {
      const authorizeCalls: Array<{ tool: string; command: unknown; effectiveIsolation?: string }> = [];
      const policy = new PolicyEngine({
        projectRoot: process.cwd(),
        denyCommands: ['rm -rf'],
      });
      const origAuthorize = policy.authorize.bind(policy);
      policy.authorize = async (req) => {
        authorizeCalls.push({
          tool: req.tool,
          command: req.input?.command,
          effectiveIsolation: req.effectiveIsolation,
        });
        return origAuthorize(req);
      };

      const fakeEngine: any = {
        projectRoot: process.cwd(),
        policy,
        config: { networkAllowed: false },
      };

      const appendedLines: string[] = [];
      const fakeTuiContext: any = {
        engine: fakeEngine,
        presentationMode: 'conversation',
        conversationRenderer: {
          append: (line: string) => appendedLines.push(line),
        },
        statusMessage: '',
        lastShellOutput: undefined,
        draw: () => {},
        refreshRecentBlocks: async () => {},
      };

      await (FleetTui.prototype as any).executeInlineShellCommand.call(
        fakeTuiContext,
        'sudo rm -rf /',
        {
          submissionId: 'sub-1',
          text: '!sudo rm -rf /',
          source: 'keyboard',
          sessionId: 'sess-1',
          timestamp: Date.now(),
        },
      );

      expect(authorizeCalls).toHaveLength(1);
      expect(authorizeCalls[0].tool).toBe('shell');
      expect(authorizeCalls[0].command).toBe('sudo rm -rf /');
      expect(authorizeCalls[0].effectiveIsolation).toBe(sandboxStatus().mode);
      expect(fakeTuiContext.lastShellOutput).toBeDefined();
      expect(fakeTuiContext.lastShellOutput.exitCode).toBe(126);
      expect(fakeTuiContext.lastShellOutput.stderr).toContain('shell-dangerous-deny');
      expect(appendedLines.join('\n')).toContain('✗ Command failed · exit 126');
    });
  });

  describe('4. codeModeTool side-effect classification and concurrency safety', () => {
    it('declares non-READ_ONLY sideEffectClass/sideEffectLevel and exclusive concurrencySafety', () => {
      expect(codeModeTool.descriptor.sideEffectClass).not.toBe('READ_ONLY');
      expect(codeModeTool.descriptor.sideEffectClass).toBe('NON_IDEMPOTENT_WRITE');
      expect((codeModeTool.descriptor as any).sideEffectLevel).not.toBe('READ_ONLY');
      expect((codeModeTool.descriptor as any).sideEffectLevel).toBe('MUTATING');
      expect(codeModeTool.descriptor.concurrencySafety).toBe('exclusive');
      expect(codeModeTool.descriptor.permissions).toContain('filesystem_write');

      const registry = new ToolRegistry();
      const registered = registry.get('code_mode');
      expect(registered?.descriptor.sideEffectClass).toBe('NON_IDEMPOTENT_WRITE');
      expect(registered?.descriptor.concurrencySafety).toBe('exclusive');

      const instance = createCodeModeTool(registry);
      expect(instance.descriptor.sideEffectClass).toBe('NON_IDEMPOTENT_WRITE');
      expect((instance.descriptor as any).sideEffectLevel).toBe('MUTATING');
      expect(instance.descriptor.concurrencySafety).toBe('exclusive');
    });
  });

  describe('5. CodeModeService VM prototype/constructor escape prevention', () => {
    const createService = () => {
      const toolExecutor: CodeModeToolExecutor = async (toolName, input) => {
        if (toolName === 'read') {
          if (input.path === 'fail.txt') {
            return { ok: false, output: '', error: 'simulated read failure', durationMs: 1 };
          }
          return { ok: true, output: `content:${String(input.path)}`, durationMs: 1 };
        }
        return { ok: true, output: 'ok', durationMs: 1 };
      };
      return new CodeModeService({ toolExecutor });
    };

    it('blocks this.constructor.constructor("return process")()', async () => {
      const service = createService();
      const res = await service.executeScript(`
        return this.constructor.constructor("return process")();
      `);
      expect(res.ok).toBe(false);
    });

    it('blocks wazir.read.constructor("return process")() and sdk.fs.read.constructor("return process")()', async () => {
      const service = createService();

      const res1 = await service.executeScript(`
        return wazir.read.constructor("return process")();
      `);
      expect(res1.ok).toBe(false);

      const res2 = await service.executeScript(`
        return sdk.fs.read.constructor("return process")();
      `);
      expect(res2.ok).toBe(false);
    });

    it('blocks object/function/promise/error/timer prototype chain escapes without mutating host globals', async () => {
      const hostFnCtorBefore = Function.prototype.constructor;
      const hostObjCtorBefore = Object.prototype.constructor;
      const service = createService();

      const objEscape = await service.executeScript(`
        return ({}).constructor.constructor("return process")();
      `);
      expect(objEscape.ok).toBe(false);

      const asyncFnEscape = await service.executeScript(`
        return (async () => {}).constructor("return process")();
      `);
      expect(asyncFnEscape.ok).toBe(false);

      const errorEscape = await service.executeScript(`
        try {
          await wazir.read("fail.txt");
        } catch (e) {
          return e.constructor.constructor("return process")();
        }
      `);
      expect(errorEscape.ok).toBe(false);

      const timerEscape = await service.executeScript(`
        const t = setTimeout(() => {}, 100);
        clearTimeout(t);
        return t.constructor.constructor("return process")();
      `);
      expect(timerEscape.ok).toBe(false);

      // Verify host globals were never mutated
      expect(Function.prototype.constructor).toBe(hostFnCtorBefore);
      expect(Object.prototype.constructor).toBe(hostObjCtorBefore);
      expect((function () {}).constructor).toBe(Function);
    });
  });
});
