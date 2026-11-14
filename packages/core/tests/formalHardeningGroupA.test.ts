import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  PolicyEngine,
  DelegatedPolicyGate,
  type DelegatedGrant,
  type DelegatedApproval,
} from '../src/index.js';

describe('Group A Formal Hardening Regression Suite', () => {
  let tempDir: string;
  let engine: PolicyEngine;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-formal-a-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tempDir, 'safe.txt'), 'hello world');
    engine = new PolicyEngine({ projectRoot: tempDir, networkAllowed: false });
  });

  // -------------------------------------------------------------------------
  // FORMAL-A01-AUTH-01: find -exec recursive argument and command validation
  // -------------------------------------------------------------------------
  describe('FORMAL-A01-AUTH-01: find -exec recursive validation', () => {
    it('denies host-escaping reads via cat/head/tail/grep inside find -exec', () => {
      const escapedCommands = [
        'find . -exec cat /etc/passwd \\;',
        'find . -exec cat /etc/shadow ;',
        'find . -exec head -n 5 ../../../etc/passwd \\;',
        'find . -exec grep -f /etc/passwd file.txt ;',
        'find . -exec tail -f /var/log/syslog \\;',
      ];

      for (const cmd of escapedCommands) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: cmd },
          projectRoot: tempDir,
        });
        expect(decision.decision, `Expected deny for: ${cmd}`).toBe('deny');
        expect(decision.rule).toBe('filesystem-outside-deny');
      }
    });

    it('denies host-escaping writes via output flags inside find -exec', () => {
      const escapedWrites = [
        'find . -exec sort -o /etc/passwd safe.txt \\;',
        'find . -exec sort --output=/root/evil.txt safe.txt ;',
      ];

      for (const cmd of escapedWrites) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: cmd },
          projectRoot: tempDir,
        });
        expect(decision.decision, `Expected deny for: ${cmd}`).toBe('deny');
        expect(decision.rule).toBe('filesystem-outside-deny');
      }
    });

    it('denies code-executing flags on safe binaries inside find -exec', () => {
      const codeExecCommands = [
        'find . -exec rg --pre=/tmp/evil.sh pattern {} \\;',
        'find . -exec rg --hostname-bin id pattern {} ;',
        'find . -exec sort --compress-program=sh file.txt \\;',
      ];

      for (const cmd of codeExecCommands) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: cmd },
          projectRoot: tempDir,
        });
        expect(decision.decision, `Expected deny for: ${cmd}`).toBe('deny');
        expect(decision.rule).toBe('shell-dangerous-deny');
      }
    });

    it('denies system-level destructive commands inside find -exec', () => {
      const destructive = [
        'find . -exec reboot \\;',
        'find . -exec shutdown -h now ;',
      ];

      for (const cmd of destructive) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: cmd },
          projectRoot: tempDir,
        });
        expect(decision.decision, `Expected deny for: ${cmd}`).toBe('deny');
        expect(decision.rule).toBe('shell-dangerous-deny');
      }
    });

    it('requires interactive approval for mutating or interpreter commands inside find -exec', () => {
      const askCommands = [
        'find . -name "*.log" -exec rm {} \\;',
        'find . -name "*.js" -exec node {} ;',
        'find . -name "*.py" -exec python3 {} \\;',
        'find . -delete',
      ];

      for (const cmd of askCommands) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: cmd },
          projectRoot: tempDir,
        });
        expect(decision.decision, `Expected ask for: ${cmd}`).toBe('ask');
      }
    });

    it('denies find -exec when missing inner command', () => {
      const malformed = [
        'find . -exec ;',
        'find . -exec',
        'find . -exec +',
      ];

      for (const cmd of malformed) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: cmd },
          projectRoot: tempDir,
        });
        expect(decision.decision).toBe('deny');
        expect(decision.rule).toBe('shell-dangerous-deny');
      }
    });

    it('allows genuine read-only, project-contained find -exec invocations', () => {
      const safeCommands = [
        'find . -exec cat {} \\;',
        'find . -name "*.ts" -exec cat {} +',
        'find . -exec cat safe.txt ;',
        'find . -exec sort safe.txt \\;',
      ];

      for (const cmd of safeCommands) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: cmd },
          projectRoot: tempDir,
        });
        expect(decision.decision, `Expected allow for: ${cmd}`).toBe('allow');
        expect(decision.rule).toBe('shell-safe-allow');
      }
    });

    it('recursively checks -execdir and -ok flags', () => {
      expect(
        engine.classify({
          tool: 'shell',
          input: { command: 'find . -execdir cat /etc/passwd \\;' },
          projectRoot: tempDir,
        }).decision,
      ).toBe('deny');

      expect(
        engine.classify({
          tool: 'shell',
          input: { command: 'find . -ok cat safe.txt \\;' },
          projectRoot: tempDir,
        }).decision,
      ).toBe('allow');
    });
  });

  // -------------------------------------------------------------------------
  // FORMAL-A01-AUTH-02: Subagent delegation file-laundering fence
  // -------------------------------------------------------------------------
  describe('FORMAL-A01-AUTH-02: Subagent written-paths delegation inheritance', () => {
    it('prevents subagent from laundering model-authored test files via delegation link', () => {
      const parentExecId = 'exec-parent-101';
      const childExecId = 'exec-child-202';
      const testPath = 'exploit.test.js';

      // 1. Parent writes a test file
      const writeDecision = engine.classify({
        tool: 'write',
        input: { path: testPath, content: 'process.exit(1);' },
        executionId: parentExecId,
        projectRoot: tempDir,
      });
      expect(writeDecision.decision).toBe('allow');

      // 2. Direct run by parent requires approval (cannot auto-allow)
      const parentRun = engine.classify({
        tool: 'shell',
        input: { command: `node ${testPath}` },
        executionId: parentExecId,
        projectRoot: tempDir,
      });
      expect(parentRun.decision).toBe('ask');
      expect(parentRun.rule).toBe('shell-unknown-ask');

      // 3. Link child execution to parent execution
      engine.linkParentExecution(childExecId, parentExecId);

      // 4. Child subagent attempts to execute the same test file
      const childRun = engine.classify({
        tool: 'shell',
        input: { command: `node ${testPath}` },
        executionId: childExecId,
        projectRoot: tempDir,
      });
      // MUST NOT be allowed as shell-test-workspace-allow; MUST be ask!
      expect(childRun.decision).toBe('ask');
      expect(childRun.rule).toBe('shell-unknown-ask');
    });

    it('propagates written paths through multi-hop delegation chains (root -> agent1 -> agent2)', () => {
      const rootId = 'exec-root-301';
      const midId = 'exec-mid-302';
      const leafId = 'exec-leaf-303';
      const testFile = 'multiHop.test.js';

      // Root writes the test file
      engine.classify({
        tool: 'write',
        input: { path: testFile, content: 'console.log("danger");' },
        executionId: rootId,
        projectRoot: tempDir,
      });

      // Register delegation chain
      engine.linkParentExecution(midId, rootId);
      engine.linkParentExecution(leafId, midId);

      // Leaf subagent cannot launder the file written by root
      const leafDecision = engine.classify({
        tool: 'shell',
        input: { command: `node ${testFile}` },
        executionId: leafId,
        projectRoot: tempDir,
      });
      expect(leafDecision.decision).toBe('ask');
      expect(leafDecision.rule).toBe('shell-unknown-ask');
    });

    it('automatically links parent delegation when parentExecutionId is provided in request', () => {
      const parentId = 'exec-parent-auto';
      const childId = 'exec-child-auto';
      const testFile = 'autoLink.test.js';

      engine.classify({
        tool: 'write',
        input: { path: testFile, content: 'test payload' },
        executionId: parentId,
        projectRoot: tempDir,
      });

      const childDecision = engine.classify({
        tool: 'shell',
        input: { command: `node ${testFile}` },
        executionId: childId,
        parentExecutionId: parentId,
        projectRoot: tempDir,
      });

      expect(childDecision.decision).toBe('ask');
      expect(childDecision.rule).toBe('shell-unknown-ask');
    });

    it('allows subagents to run existing, pre-existing project tests that were not written in the session', () => {
      const parentId = 'exec-p-clean';
      const childId = 'exec-c-clean';
      const existingTest = 'existing.test.js';

      // Create an existing test on disk without model write tool classification
      fs.writeFileSync(path.join(tempDir, existingTest), 'test("ok", () => {});');
      engine.linkParentExecution(childId, parentId);

      const decision = engine.classify({
        tool: 'shell',
        input: { command: `node ${existingTest}` },
        executionId: childId,
        projectRoot: tempDir,
      });
      expect(decision.decision).toBe('allow');
      expect(decision.rule).toBe('shell-test-workspace-allow');
    });
  });

  // -------------------------------------------------------------------------
  // FORMAL-A01-AUTH-03: bash -c / sh -c subshell wrapper anti-laundering fence
  // -------------------------------------------------------------------------
  describe('FORMAL-A01-AUTH-03: Subshell wrappers preserve executionId and anti-laundering', () => {
    it('prevents bash -c wrapper from laundering model-authored test scripts', () => {
      const execId = 'exec-subshell-1';
      const testPath = 'wrapped.test.js';

      engine.classify({
        tool: 'write',
        input: { path: testPath, content: 'evil();' },
        executionId: execId,
        projectRoot: tempDir,
      });

      // Direct call asks
      expect(
        engine.classify({
          tool: 'shell',
          input: { command: `node ${testPath}` },
          executionId: execId,
          projectRoot: tempDir,
        }).decision,
      ).toBe('ask');

      // Wrapped in bash -c must also ask (not shell-test-workspace-allow)
      const wrappedDecision = engine.classify({
        tool: 'shell',
        input: { command: `bash -c "node ${testPath}"` },
        executionId: execId,
        projectRoot: tempDir,
      });
      expect(wrappedDecision.decision).toBe('ask');
      expect(wrappedDecision.rule).toBe('shell-unknown-ask');
    });

    it('prevents sh -c and dash -c wrappers from laundering model-authored test scripts', () => {
      const execId = 'exec-subshell-2';
      const testPath = 'shWrapped.test.js';

      engine.classify({
        tool: 'write',
        input: { path: testPath, content: 'evil();' },
        executionId: execId,
        projectRoot: tempDir,
      });

      for (const shellCmd of ['sh', 'dash']) {
        const decision = engine.classify({
          tool: 'shell',
          input: { command: `${shellCmd} -c "node ${testPath}"` },
          executionId: execId,
          projectRoot: tempDir,
        });
        expect(decision.decision, `Expected ask for ${shellCmd}`).toBe('ask');
        expect(decision.rule).toBe('shell-unknown-ask');
      }
    });

    it('prevents subagent delegation combined with bash -c wrapper laundering', () => {
      const parentId = 'exec-combo-p';
      const childId = 'exec-combo-c';
      const testPath = 'combo.test.js';

      engine.classify({
        tool: 'write',
        input: { path: testPath, content: 'payload' },
        executionId: parentId,
        projectRoot: tempDir,
      });

      engine.linkParentExecution(childId, parentId);

      const decision = engine.classify({
        tool: 'shell',
        input: { command: `bash -c "node ${testPath}"` },
        executionId: childId,
        projectRoot: tempDir,
      });
      expect(decision.decision).toBe('ask');
      expect(decision.rule).toBe('shell-unknown-ask');
    });

    it('still allows safe commands inside subshells', () => {
      const decision = engine.classify({
        tool: 'shell',
        input: { command: 'bash -c "cat safe.txt"' },
        projectRoot: tempDir,
      });
      expect(decision.decision).toBe('allow');
      expect(decision.rule).toBe('shell-safe-allow');
    });

    it('still denies dangerous commands inside subshells', () => {
      const decision = engine.classify({
        tool: 'shell',
        input: { command: 'bash -c "reboot"' },
        projectRoot: tempDir,
      });
      expect(decision.decision).toBe('deny');
      expect(decision.rule).toBe('shell-dangerous-deny');
    });
  });

  // -------------------------------------------------------------------------
  // DelegatedPolicyGate: Multi-hop chain intersection & least-privilege attenuation
  // -------------------------------------------------------------------------
  describe('DelegatedPolicyGate: Multi-hop chain intersection', () => {
    let gate: DelegatedPolicyGate;
    let mockTime: number;

    beforeEach(() => {
      mockTime = 1000000;
      gate = new DelegatedPolicyGate(() => mockTime);
    });

    it('enforces tool and path scope intersection down a 3-hop delegation chain', () => {
      // Root -> Agent-A (mid) -> Agent-B (leaf)
      const grantA: DelegatedGrant = {
        id: 'grant-root-to-a',
        parentAgentId: 'root',
        childAgentId: 'agent-a',
        allowedTools: ['read', 'write', 'shell'],
        capabilities: ['file:read', 'file:write'],
        pathScopes: ['/srv/project'],
        canDelegate: true,
        maxDepth: 3,
      };

      const grantB: DelegatedGrant = {
        id: 'grant-a-to-b',
        parentAgentId: 'agent-a',
        childAgentId: 'agent-b',
        allowedTools: ['read', 'shell'], // attenuated: no write
        capabilities: ['file:read'],
        pathScopes: ['/srv/project/src'], // attenuated: subpath only
        canDelegate: false,
        maxDepth: 1,
      };

      expect(gate.registerGrant(grantA).allowed).toBe(true);
      expect(gate.registerGrant(grantB).allowed).toBe(true);

      // Agent-B can read within its scope
      const evalRead = gate.evaluate({
        agentId: 'agent-b',
        tool: 'read',
        capability: 'file:read',
        path: '/srv/project/src/app.ts',
      });
      expect(evalRead.allowed).toBe(true);
      expect(evalRead.reason).toContain('authorized by complete delegation chain');

      // Agent-B cannot write even inside its scope (tool not allowed)
      const evalWrite = gate.evaluate({
        agentId: 'agent-b',
        tool: 'write',
        capability: 'file:write',
        path: '/srv/project/src/app.ts',
      });
      expect(evalWrite.allowed).toBe(false);
      expect(evalWrite.reason).toContain('exceeds grant');

      // Agent-B cannot read outside its path scope (even though Root and Agent-A could)
      const evalOutside = gate.evaluate({
        agentId: 'agent-b',
        tool: 'read',
        capability: 'file:read',
        path: '/srv/project/package.json',
      });
      expect(evalOutside.allowed).toBe(false);
      expect(evalOutside.reason).toContain('exceeds grant');
    });

    it('rejects registering child grant that exceeds parent scope (privilege escalation prevention)', () => {
      const grantParent: DelegatedGrant = {
        id: 'grant-parent',
        parentAgentId: 'root',
        childAgentId: 'parent-agent',
        allowedTools: ['read'],
        capabilities: ['file:read'],
        pathScopes: ['/srv/project/docs'],
        canDelegate: true,
        maxDepth: 2,
      };
      expect(gate.registerGrant(grantParent).allowed).toBe(true);

      // Child tries to gain 'write' tool not granted to parent
      const escalatingTool: DelegatedGrant = {
        id: 'grant-escalate-tool',
        parentAgentId: 'parent-agent',
        childAgentId: 'child-1',
        allowedTools: ['read', 'write'],
        capabilities: ['file:read'],
        pathScopes: ['/srv/project/docs'],
        canDelegate: false,
        maxDepth: 1,
      };
      expect(gate.registerGrant(escalatingTool).allowed).toBe(false);

      // Child tries to expand path scope beyond parent
      const escalatingPath: DelegatedGrant = {
        id: 'grant-escalate-path',
        parentAgentId: 'parent-agent',
        childAgentId: 'child-2',
        allowedTools: ['read'],
        capabilities: ['file:read'],
        pathScopes: ['/srv/project'], // broader than /srv/project/docs
        canDelegate: false,
        maxDepth: 1,
      };
      expect(gate.registerGrant(escalatingPath).allowed).toBe(false);
    });

    it('revocation of an ancestor grant immediately revokes all descendant permissions', () => {
      const grant1: DelegatedGrant = {
        id: 'g1',
        parentAgentId: 'root',
        childAgentId: 'sub1',
        allowedTools: ['read'],
        capabilities: ['file:read'],
        pathScopes: ['/srv/project'],
        canDelegate: true,
        maxDepth: 3,
      };
      const grant2: DelegatedGrant = {
        id: 'g2',
        parentAgentId: 'sub1',
        childAgentId: 'sub2',
        allowedTools: ['read'],
        capabilities: ['file:read'],
        pathScopes: ['/srv/project'],
        canDelegate: false,
        maxDepth: 2,
      };

      gate.registerGrant(grant1);
      gate.registerGrant(grant2);

      // Pre-revocation: sub2 is authorized
      expect(gate.evaluate({ agentId: 'sub2', tool: 'read', path: '/srv/project/file.txt' }).allowed).toBe(true);

      // Revoke ancestor grant1 (sub1)
      gate.revokeGrant('sub1');

      // Post-revocation: sub2 is immediately denied
      const postRevoke = gate.evaluate({ agentId: 'sub2', tool: 'read', path: '/srv/project/file.txt' });
      expect(postRevoke.allowed).toBe(false);
      expect(postRevoke.reason).toContain('revoked or expired');
    });

    it('enforces delegation maxDepth limit', () => {
      const grant1: DelegatedGrant = {
        id: 'g-depth-1',
        parentAgentId: 'root',
        childAgentId: 'level-1',
        allowedTools: ['read'],
        capabilities: [],
        pathScopes: ['/srv'],
        canDelegate: true,
        maxDepth: 2, // allows at most 2 edges from root
      };
      gate.registerGrant(grant1);

      const grant2: DelegatedGrant = {
        id: 'g-depth-2',
        parentAgentId: 'level-1',
        childAgentId: 'level-2',
        allowedTools: ['read'],
        capabilities: [],
        pathScopes: ['/srv'],
        canDelegate: true,
        maxDepth: 1,
      };
      gate.registerGrant(grant2);

      // Level-2 trying to delegate to level-3 exceeds root's maxDepth of 2
      const grant3: DelegatedGrant = {
        id: 'g-depth-3',
        parentAgentId: 'level-2',
        childAgentId: 'level-3',
        allowedTools: ['read'],
        capabilities: [],
        pathScopes: ['/srv'],
        canDelegate: false,
        maxDepth: 1,
      };
      const reg3 = gate.registerGrant(grant3);
      expect(reg3.allowed).toBe(false);
      expect(reg3.reason).toContain('exceeds maxDepth');
    });

    it('enforces canDelegate boundary', () => {
      const grantNonDelegator: DelegatedGrant = {
        id: 'g-no-del',
        parentAgentId: 'root',
        childAgentId: 'leaf-worker',
        allowedTools: ['read'],
        capabilities: [],
        pathScopes: ['/srv'],
        canDelegate: false, // forbidden from delegating further
        maxDepth: 2,
      };
      gate.registerGrant(grantNonDelegator);

      const grantAttempt: DelegatedGrant = {
        id: 'g-attempt',
        parentAgentId: 'leaf-worker',
        childAgentId: 'sub-leaf',
        allowedTools: ['read'],
        capabilities: [],
        pathScopes: ['/srv'],
        canDelegate: false,
        maxDepth: 1,
      };
      const reg = gate.registerGrant(grantAttempt);
      expect(reg.allowed).toBe(false);
      expect(reg.reason).toContain('forbids delegation');
    });

    it('handles one-time approval consumption correctly', () => {
      const grant: DelegatedGrant = {
        id: 'g-appr',
        parentAgentId: 'root',
        childAgentId: 'worker',
        allowedTools: ['deploy'],
        capabilities: [],
        pathScopes: ['/srv'],
        canDelegate: false,
        maxDepth: 1,
      };
      gate.registerGrant(grant);

      const approval: DelegatedApproval = {
        id: 'appr-001',
        agentId: 'worker',
        tool: 'deploy',
        oneTime: true,
      };
      gate.registerApproval(approval);

      // First execution consumes the approval
      const first = gate.evaluate({
        agentId: 'worker',
        tool: 'deploy',
        approvalId: 'appr-001',
      });
      expect(first.allowed).toBe(true);

      // Second execution with same approval fails (replay protection)
      const second = gate.evaluate({
        agentId: 'worker',
        tool: 'deploy',
        approvalId: 'appr-001',
      });
      expect(second.allowed).toBe(false);
      expect(second.reason).toContain('consumed');
    });
  });
});
