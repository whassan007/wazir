import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  PolicyEngine,
  Scheduler,
  ModelRegistry,
  ComputerRegistry,
  RuntimeRegistry,
  estimateModelMemory,
} from '@wazir/core';
import {
  appendAuditEvent,
  readAuditEvents,
  getDefaultAuditLogPath,
} from '@wazir/shared';
import { auditCommand, explainPolicyCommand } from '../../apps/cli/src/commands.js';
import { doctor } from '../../apps/cli/src/doctor.js';
import type { RookEngine } from '../../apps/cli/src/engine.js';

describe('Audit Logging & Policy Explain & Model Cycle M0 (PROGRESS.md Next Steps)', () => {
  let tmpDir: string;
  let auditLogFile: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-audit-test-'));
    auditLogFile = path.join(tmpDir, 'audit.jsonl');
    process.env.WAZIR_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('PolicyEngine.explainCommand and wa policy explain', () => {
    it('correctly explains safe, ask, and denied shell commands without executing them', () => {
      const policy = new PolicyEngine({
        projectRoot: tmpDir,
        allowCommands: ['custom-allowed-cmd'],
        denyCommands: ['custom-denied-cmd'],
      });

      // Safe command
      const safe = policy.explainCommand('ls');
      expect(safe.decision).toBe('allow');
      expect(safe.rule).toBe('shell-safe-allow');
      expect(safe.command).toBe('ls');

      // Command reading path outside project root
      const outside = policy.explainCommand('cat /etc/passwd');
      expect(outside.decision).toBe('deny');
      expect(outside.rule).toBe('filesystem-outside-deny');
      expect(outside.reasons.some((r) => r.includes('outside project root'))).toBe(true);

      // Dangerous command
      const dangerous = policy.explainCommand('reboot');
      expect(dangerous.decision).toBe('deny');
      expect(dangerous.rule).toBe('shell-dangerous-deny');

      // Ask command (e.g. git commit)
      const ask = policy.explainCommand('git commit -m "update"');
      expect(ask.decision).toBe('ask');
      expect(ask.rule).toBe('shell-unknown-ask');

      // Custom allow command
      const customAllowed = policy.explainCommand('custom-allowed-cmd --flag');
      expect(customAllowed.decision).toBe('allow');
      expect(customAllowed.rule).toBe('shell-safe-allow');

      // Custom deny command
      const customDenied = policy.explainCommand('custom-denied-cmd --flag');
      expect(customDenied.decision).toBe('deny');
      expect(customDenied.rule).toBe('shell-dangerous-deny');
    });

    it('formats policy explanation in text and json via explainPolicyCommand', () => {
      const policy = new PolicyEngine({ projectRoot: tmpDir });
      const mockEngine = { policy } as unknown as RookEngine;

      const textOutput = explainPolicyCommand(mockEngine, 'cat /etc/shadow');
      expect(textOutput).toContain('Policy Explanation');
      expect(textOutput).toContain('cat /etc/shadow');
      expect(textOutput).toContain('DENY');

      const jsonOutput = explainPolicyCommand(mockEngine, 'cat /etc/shadow', { json: true });
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.decision).toBe('deny');
      expect(parsed.command).toBe('cat /etc/shadow');
    });
  });

  describe('Audit Logging (appendAuditEvent, readAuditEvents, wa audit)', () => {
    it('appends and reads audit events with filtering and correct permissions', async () => {
      await appendAuditEvent({
        type: 'policy_decision',
        tool: 'shell',
        decision: 'allow',
        rule: 'shell-safe-allow',
        reasons: ['safe command'],
        command: 'ls',
        executionId: 'exec-1',
      }, { auditPath: auditLogFile });

      await appendAuditEvent({
        type: 'policy_decision',
        tool: 'shell',
        decision: 'deny',
        rule: 'shell-dangerous-deny',
        reasons: ['dangerous command'],
        command: 'reboot',
        executionId: 'exec-2',
      }, { auditPath: auditLogFile });

      await appendAuditEvent({
        type: 'approval_resolution',
        tool: 'git',
        decision: 'allow',
        rule: 'git-write-ask+user-approved',
        reasons: ['approved by user'],
        executionId: 'exec-3',
        resolvedBy: 'test-user',
      }, { auditPath: auditLogFile });

      // Verify file permissions (0600)
      const stat = await fs.stat(auditLogFile);
      expect((stat.mode & 0o777)).toBe(0o600);

      // Read all events (reverse chronological)
      const all = await readAuditEvents({ auditPath: auditLogFile });
      expect(all.length).toBe(3);
      expect(all[0].executionId).toBe('exec-3');
      expect(all[1].executionId).toBe('exec-2');
      expect(all[2].executionId).toBe('exec-1');

      // Filter by decision
      const denied = await readAuditEvents({ auditPath: auditLogFile, decision: 'deny' });
      expect(denied.length).toBe(1);
      expect(denied[0].command).toBe('reboot');

      // Filter by tool
      const gitEvents = await readAuditEvents({ auditPath: auditLogFile, tool: 'git' });
      expect(gitEvents.length).toBe(1);
      expect(gitEvents[0].resolvedBy).toBe('test-user');

      // Filter by limit
      const limited = await readAuditEvents({ auditPath: auditLogFile, limit: 2 });
      expect(limited.length).toBe(2);

      // auditCommand text & json formatting
      const text = await auditCommand({ limit: 10 });
      expect(text).toContain('timestamp');
      expect(text).toContain('reboot');

      const jsonStr = await auditCommand({ json: true });
      const jsonParsed = JSON.parse(jsonStr);
      expect(Array.isArray(jsonParsed)).toBe(true);
      expect(jsonParsed.length).toBe(3);
    });
  });

  describe('Doctor Command: api security & tokens and WAZIR_CHILD_ENV', () => {
    it('reports warning when WAZIR_ALLOW_UNAUTHENTICATED=1 is set', () => {
      process.env.WAZIR_ALLOW_UNAUTHENTICATED = '1';
      delete process.env.WAZIR_API_TOKEN;
      delete process.env.WAZIR_REGISTRATION_TOKEN;

      const mockEngine = {
        config: {
          ollamaUrl: 'http://localhost:11434',
          apiToken: undefined,
          registrationToken: undefined,
        },
        executions: {},
        computers: { list: () => [], listOnline: () => [] },
        worker: { isRunning: false, info: { status: 'offline', runtimes: [], models: [] } },
        discovered: [],
        models: { list: () => [], listInstances: () => [] },
        policy: { rules: ['dummy'] },
        scheduler: {},
      } as unknown as RookEngine;

      const report = doctor(mockEngine);
      const secCheck = report.checks.find((c) => c.name === 'api security & tokens');
      expect(secCheck).toBeDefined();
      expect(secCheck!.status).toBe('WARN');
      expect(secCheck!.message).toContain('unauthenticated access enabled');
      expect(secCheck!.details).toContain('WAZIR_CHILD_ENV: not set');
    });

    it('reports pass when tokens are configured and documents WAZIR_CHILD_ENV', () => {
      delete process.env.WAZIR_ALLOW_UNAUTHENTICATED;
      process.env.WAZIR_API_TOKEN = 'secret-token';
      process.env.WAZIR_REGISTRATION_TOKEN = 'reg-token';
      process.env.WAZIR_CHILD_ENV = 'CUSTOM_KEY,ANOTHER_KEY';

      const mockEngine = {
        config: {
          ollamaUrl: 'http://localhost:11434',
          apiToken: 'secret-token',
          registrationToken: 'reg-token',
        },
        executions: {},
        computers: { list: () => [], listOnline: () => [] },
        worker: { isRunning: false, info: { status: 'offline', runtimes: [], models: [] } },
        discovered: [],
        models: { list: () => [], listInstances: () => [] },
        policy: { rules: ['dummy'] },
        scheduler: {},
      } as unknown as RookEngine;

      const report = doctor(mockEngine);
      const secCheck = report.checks.find((c) => c.name === 'api security & tokens');
      expect(secCheck).toBeDefined();
      expect(secCheck!.status).toBe('PASS');
      expect(secCheck!.details).toContain('WAZIR_CHILD_ENV: configured (2 additional variable(s)');
      expect(secCheck!.details).toContain('API operator token: configured');
      expect(secCheck!.details).toContain('Registration token: configured');
    });
  });

  describe('Scheduler: Available Memory & Runtime Compatibility (M0)', () => {
    it('rejects computer when available memory is less than model requiredSystemGB', () => {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();

      // Register computer with 64GB total RAM, but only 4GB currently available
      computers.register({
        id: 'tight-memory-box',
        name: 'Tight Memory Box',
        type: 'workstation',
        local: true,
        os: { platform: 'linux', architecture: 'x64', version: '6.0' },
        hardware: { cpu: 'x86_64', cpuCores: 16, memoryGB: 64 },
        capabilities: ['localExecution'],
      });
      computers.heartbeat('tight-memory-box', {
        load: {
          cpuPercent: 10,
          memoryUsedGB: 60,
          memoryAvailableGB: 4, // Only 4GB free
        },
      });

      runtimes.register({
        id: 'ollama',
        type: 'ollama',
        name: 'Ollama',
        version: '0.3.0',
        computerId: 'tight-memory-box',
        capabilities: {
          chat: true, streaming: true, toolCalling: true, structuredOutput: true,
          vision: false, embeddings: false, reasoning: false, modelLoad: true,
          modelUnload: true, modelDownload: true, statefulChat: false, mcp: false,
        },
      });

      // Model requires 16GB minSystemGB
      models.register({
        id: 'large-model:32b',
        name: 'Large Model',
        provider: 'ollama',
        family: 'qwen',
        contextMax: 32768,
        capabilities: ['generalChat'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        memory: { minSystemGB: 16 },
        runtimeCompatibility: 'any',
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      models.upsertInstance({
        id: 'large-model:32b::tight-memory-box::ollama',
        modelId: 'large-model:32b',
        computerId: 'tight-memory-box',
        runtimeId: 'ollama',
        runtimeModelId: 'large-model:32b',
        loaded: false,
        health: 'healthy',
        contextTokens: 32768,
      });

      const scheduler = new Scheduler({ computers, runtimes, models });

      // Planning should fail because available memory 4GB < required 16GB
      expect(() =>
        scheduler.plan({
          task: {
            id: 'task-1',
            type: 'coding',
            input: 'do something',
            requirements: {},
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
        }),
      ).toThrow(/available memory 4GB < required 16GB/);
    });

    it('filters by runtimeCompatibility when specified on ModelRecord', () => {
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();

      computers.register({
        id: 'local-box',
        name: 'Local Box',
        type: 'workstation',
        local: true,
        os: { platform: 'linux', architecture: 'x64', version: '6.0' },
        hardware: { cpu: 'x86_64', cpuCores: 16, memoryGB: 64 },
        capabilities: ['localExecution'],
      });
      computers.heartbeat('local-box', {
        load: { cpuPercent: 10, memoryUsedGB: 10, memoryAvailableGB: 54 },
      });

      // Register only lmstudio runtime
      runtimes.register({
        id: 'lmstudio',
        type: 'lmstudio',
        name: 'LM Studio',
        version: '0.2.0',
        computerId: 'local-box',
        capabilities: {
          chat: true, streaming: true, toolCalling: true, structuredOutput: true,
          vision: false, embeddings: false, reasoning: false, modelLoad: true,
          modelUnload: true, modelDownload: true, statefulChat: false, mcp: false,
        },
      });

      // Model requires runtimeCompatibility: ['ollama']
      models.register({
        id: 'ollama-only-model',
        name: 'Ollama Only Model',
        provider: 'lmstudio',
        family: 'qwen',
        contextMax: 8192,
        capabilities: ['generalChat'],
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        audio: false,
        embedding: false,
        reasoning: false,
        memory: { minSystemGB: 4 },
        runtimeCompatibility: ['ollama'],
        local: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      models.upsertInstance({
        id: 'ollama-only-model::local-box::lmstudio',
        modelId: 'ollama-only-model',
        computerId: 'local-box',
        runtimeId: 'lmstudio',
        runtimeModelId: 'ollama-only-model',
        loaded: false,
        health: 'healthy',
        contextTokens: 8192,
      });

      const scheduler = new Scheduler({ computers, runtimes, models });

      // Should fail because runtime lmstudio is incompatible with runtimeCompatibility ['ollama']
      expect(() =>
        scheduler.plan({
          task: {
            id: 'task-1',
            type: 'coding',
            input: 'do something',
            requirements: {},
            priority: 'normal',
            status: 'pending',
            createdAt: new Date(),
          },
        }),
      ).toThrow(/incompatible with model runtimeCompatibility/);
    });
  });
});
