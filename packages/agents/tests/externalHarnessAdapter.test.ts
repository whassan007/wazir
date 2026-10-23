import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  ALLOWED_ENV_KEYS,
  discoverExternalHarnessCapabilities,
  EXTERNAL_HARNESS_PRESETS,
  getExternalHarnessPreset,
  sanitizeHarnessEnvironment,
} from '../src/acp/acpHarnessCapabilities.js';
import {
  ExternalHarnessAdapter,
  MAX_EXTERNAL_OUTPUT_CHARS,
  type UnifiedExecutionRequest,
} from '../src/externalHarnessAdapter.js';
import type { AcpConnectionLike } from '../src/acp/acpClient.js';

function createRequest(
  workspaceRoot: string,
  overrides: Partial<UnifiedExecutionRequest> = {},
): UnifiedExecutionRequest {
  return {
    schemaVersion: 1,
    executionId: 'exec-a3-1',
    taskId: 'task-a3-1',
    objective: 'Fix bug in src/app.ts',
    taskType: 'coding',
    workspace: {
      root: workspaceRoot,
      revision: 1,
    },
    constraints: {
      allowFallback: false,
      ...overrides.constraints,
    },
    verification: {
      requiredChecks: ['test'],
      protectedPaths: ['.env', 'config/secrets.json'],
      mutationRequired: true,
      ...overrides.verification,
    },
    policyContext: {
      projectRoot: workspaceRoot,
      ...overrides.policyContext,
    },
    ...overrides,
  };
}

describe('ExternalHarnessAdapter & ACP Harness Capabilities (Group A3)', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      tempDir = undefined;
    }
  });

  it('1. defines preset profiles for qwen-code, codex, claude-code, and opencode without auto-routing taskTypes', () => {
    const qwen = getExternalHarnessPreset('qwen-code');
    expect(qwen.command).toBe('qwen');
    expect(qwen.args).toEqual(['--acp']);
    expect(qwen.kind).toBe('acp');
    expect(qwen.protocol).toBe('acp');
    expect(qwen.supportedTaskTypes).toEqual([]);

    const codex = getExternalHarnessPreset('codex');
    expect(codex.command).toBe('codex');
    expect(codex.args).toEqual(['--acp']);
    expect(codex.kind).toBe('acp');

    const claude = getExternalHarnessPreset('claude-code');
    expect(claude.command).toBe('claude');
    expect(claude.args).toEqual(['--acp']);
    expect(claude.allowsModelSelection).toBe(true);

    const opencode = getExternalHarnessPreset('opencode');
    expect(opencode.command).toBe('opencode');
    expect(opencode.args).toEqual(['run']);
    expect(opencode.kind).toBe('external-cli');
    expect(opencode.protocol).toBe('stdio-cli');
    expect(opencode.supportedTaskTypes).toEqual([]);
  });

  it('2. sanitizes environment variables using ALLOWED_ENV_KEYS + spec allowlist and strips unauthorized secrets', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/tester',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      AWS_SECRET_ACCESS_KEY: 'aws-super-secret',
      GITHUB_TOKEN: 'ghp_1234567890abcdefghijklmnopqrstuv',
      DATABASE_PASSWORD: 'db-password',
      CUSTOM_UNLISTED_VAR: 'should-be-stripped',
      QWEN_API_KEY: 'qwen-allowed-key',
    };

    const qwenSpec = getExternalHarnessPreset('qwen-code');
    const { sanitizedEnv, strippedEnvKeys } = sanitizeHarnessEnvironment(qwenSpec, baseEnv);

    expect(ALLOWED_ENV_KEYS.has('PATH')).toBe(true);
    expect(sanitizedEnv.PATH).toBe('/usr/bin:/bin');
    expect(sanitizedEnv.HOME).toBe('/Users/tester');
    expect(sanitizedEnv.LC_ALL).toBe('en_US.UTF-8');
    // Explicitly allowlisted by qwen-code preset
    expect(sanitizedEnv.QWEN_API_KEY).toBe('qwen-allowed-key');

    // Unauthorized secrets and unlisted vars must be stripped
    expect(sanitizedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(sanitizedEnv.GITHUB_TOKEN).toBeUndefined();
    expect(sanitizedEnv.DATABASE_PASSWORD).toBeUndefined();
    expect(sanitizedEnv.CUSTOM_UNLISTED_VAR).toBeUndefined();
    expect(strippedEnvKeys).toEqual(
      expect.arrayContaining([
        'AWS_SECRET_ACCESS_KEY',
        'GITHUB_TOKEN',
        'DATABASE_PASSWORD',
        'CUSTOM_UNLISTED_VAR',
      ]),
    );
  });

  it('3. discovers binary availability, protocol compatibility, and clamps permission mode to ceiling', () => {
    const missingDiscovery = discoverExternalHarnessCapabilities('qwen-code', {
      resolveBinary: () => undefined,
      env: { PATH: '/nonexistent' },
    });
    expect(missingDiscovery.available).toBe(false);
    expect(missingDiscovery.binaryFound).toBe(false);
    expect(missingDiscovery.failureClassification).toBe('BINARY_NOT_FOUND');

    const incompatibleDiscovery = discoverExternalHarnessCapabilities('codex', {
      resolveBinary: () => '/usr/local/bin/codex',
      expectedAcpProtocolVersion: PROTOCOL_VERSION,
      reportedAcpProtocolVersion: PROTOCOL_VERSION + 99,
      requestedPermissionMode: 'full',
      maxPermissionMode: 'read',
    });
    expect(incompatibleDiscovery.binaryFound).toBe(true);
    expect(incompatibleDiscovery.protocolCompatible).toBe(false);
    expect(incompatibleDiscovery.available).toBe(false);
    expect(incompatibleDiscovery.failureClassification).toBe('ACP_PROTOCOL_INCOMPATIBLE');
    expect(incompatibleDiscovery.effectivePermissionMode).toBe('read');
    expect(incompatibleDiscovery.permissionModeClamped).toBe(true);
  });

  it('4. executes ACP harness turn, normalizes streaming messages & tool calls, and defaults verified=false & costStatus=UNKNOWN', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-acp-'));

    let clientHandler: any;
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: PROTOCOL_VERSION }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-qwen-1' }),
      prompt: vi.fn().mockImplementation(async () => {
        await clientHandler.sessionUpdate({
          sessionId: 'sess-qwen-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Edit src/app.ts',
            kind: 'edit',
            rawInput: { path: 'src/app.ts' },
          },
        });
        const perm = await clientHandler.requestPermission({
          requestId: 'tc-1',
          sessionId: 'sess-qwen-1',
          toolCall: { toolCallId: 'tc-1', title: 'Edit src/app.ts', kind: 'edit' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          ],
        });
        expect(perm.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });

        await clientHandler.sessionUpdate({
          sessionId: 'sess-qwen-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            title: 'Edit src/app.ts',
            status: 'completed',
          },
        });
        await clientHandler.sessionUpdate({
          sessionId: 'sess-qwen-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Fixed bug in ' },
          },
        });
        await clientHandler.sessionUpdate({
          sessionId: 'sess-qwen-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'src/app.ts.' },
          },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new ExternalHarnessAdapter({
      preset: 'qwen-code',
      connect: async (cl) => {
        clientHandler = cl;
        return mockConn;
      },
    });

    const result = await adapter.execute(createRequest(tempDir));

    expect(result.status).toBe('completed');
    // Invariant 1: External harness NEVER self-certifies without controller verifyHook
    expect(result.verified).toBe(false);
    expect(result.terminationReason).toBe('COMPLETED');
    // Invariant 3: Unpriced external harness defaults to costStatus: 'UNKNOWN', costUSD: undefined
    expect(result.usage.costStatus).toBe('UNKNOWN');
    expect(result.usage.costUSD).toBeUndefined();
    expect(result.output).toBe('Fixed bug in src/app.ts.');
    expect(result.filesChanged).toContain('src/app.ts');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      tool: 'edit',
      ok: true,
      policyEffect: 'allow',
    });
  });

  it('5. marks verified=true and VERIFICATION_PASSED only when independent controller verifyHook succeeds', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-verify-'));

    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: PROTOCOL_VERSION }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-verify-1' }),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new ExternalHarnessAdapter({
      preset: 'codex',
      connect: async () => mockConn,
      verifyHook: async ({ workspaceRevision }) => ({
        verified: true,
        workspaceRevision: Number(workspaceRevision) + 1,
        filesChanged: ['src/app.ts'],
        verificationEvidenceIds: ['ev-test-pass-1'],
        checks: [
          {
            name: 'test',
            command: 'vitest run',
            ok: true,
            output: '1 passed',
            durationMs: 45,
          },
        ],
      }),
    });

    const result = await adapter.execute(createRequest(tempDir));
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(result.terminationReason).toBe('VERIFICATION_PASSED');
    expect(result.verificationEvidenceIds).toEqual(['ev-test-pass-1']);
    expect(result.checks).toHaveLength(1);
  });

  it('6. never grants "always" permissions even in full mode when only allow_always is offered', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-always-'));

    let clientHandler: any;
    let permissionOutcome: any;
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: PROTOCOL_VERSION }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-always' }),
      prompt: vi.fn().mockImplementation(async () => {
        permissionOutcome = await clientHandler.requestPermission({
          requestId: 'req-always',
          sessionId: 'sess-always',
          toolCall: { toolCallId: 'req-always', title: 'Run tests', kind: 'execute' },
          options: [
            { optionId: 'always-id', name: 'Always allow', kind: 'allow_always' },
          ],
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new ExternalHarnessAdapter({
      preset: 'qwen-code',
      permissionMode: 'full',
      connect: async (cl) => {
        clientHandler = cl;
        return mockConn;
      },
    });

    await adapter.execute(createRequest(tempDir));
    expect(permissionOutcome).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('7. denies tool calls targeting protectedPaths and classifies PERMISSION_DENIED', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-prot-'));

    let clientHandler: any;
    let permResult: any;
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: PROTOCOL_VERSION }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-prot' }),
      prompt: vi.fn().mockImplementation(async () => {
        await clientHandler.sessionUpdate({
          sessionId: 'sess-prot',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-env',
            title: 'Write .env',
            kind: 'edit',
            rawInput: { path: '.env' },
          },
        });
        permResult = await clientHandler.requestPermission({
          requestId: 'tc-env',
          sessionId: 'sess-prot',
          toolCall: { toolCallId: 'tc-env', title: 'Write .env', kind: 'edit' },
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new ExternalHarnessAdapter({
      preset: 'qwen-code',
      permissionMode: 'edit',
      connect: async (cl) => {
        clientHandler = cl;
        return mockConn;
      },
    });

    const result = await adapter.execute(
      createRequest(tempDir, {
        verification: {
          requiredChecks: [],
          protectedPaths: ['.env', 'config/secrets.json'],
        },
      }),
    );

    expect(permResult).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('POLICY_DENIED');
    expect(result.errorKind).toBe('policy');
    expect(result.failureClassification).toBe('PERMISSION_DENIED');
    expect(result.toolCalls[0]?.policyEffect).toBe('deny');
    expect(result.toolCalls[0]?.policyRule).toContain('protected_path:.env');
  });

  it('8. enforces custom policyEvaluator and PolicyEngine denials on ACP tool calls', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-policy-'));

    let clientHandler: any;
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: PROTOCOL_VERSION }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-pol' }),
      prompt: vi.fn().mockImplementation(async () => {
        await clientHandler.requestPermission({
          requestId: 'tc-shell',
          sessionId: 'sess-pol',
          toolCall: { toolCallId: 'tc-shell', title: 'curl https://evil.example.com', kind: 'execute' },
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const policyEvaluator = vi.fn().mockReturnValue({
      allowed: false,
      reason: 'Outbound curl prohibited by security policy',
      rule: 'sec.no-curl',
    });

    const adapter = new ExternalHarnessAdapter({
      preset: 'claude-code',
      permissionMode: 'full',
      policyEvaluator,
      connect: async (cl) => {
        clientHandler = cl;
        return mockConn;
      },
    });

    const result = await adapter.execute(createRequest(tempDir));

    expect(policyEvaluator).toHaveBeenCalledOnce();
    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('POLICY_DENIED');
    expect(result.failureClassification).toBe('PERMISSION_DENIED');
    expect(result.errors?.[0]).toContain('Outbound curl prohibited');
  });

  it('9. bounds output capture to maxOutputChars so runaway child output cannot exhaust memory', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-bounded-'));

    let clientHandler: any;
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: PROTOCOL_VERSION }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-bounded' }),
      prompt: vi.fn().mockImplementation(async () => {
        const hugeChunk = 'A'.repeat(15_000);
        await clientHandler.sessionUpdate({
          sessionId: 'sess-bounded',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: hugeChunk },
          },
        });
        await clientHandler.sessionUpdate({
          sessionId: 'sess-bounded',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'B'.repeat(15_000) },
          },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new ExternalHarnessAdapter({
      preset: 'qwen-code',
      connect: async (cl) => {
        clientHandler = cl;
        return mockConn;
      },
    });

    const result = await adapter.execute(createRequest(tempDir));
    expect(result.status).toBe('completed');
    expect(result.output?.length).toBe(MAX_EXTERNAL_OUTPUT_CHARS);
    expect(result.output?.startsWith('A'.repeat(15_000))).toBe(true);
    expect(result.output?.endsWith('B'.repeat(5_000))).toBe(true);
  });

  it('10. handles missing binary (ENOENT) gracefully with BINARY_NOT_FOUND classification', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-enoent-'));

    const adapter = new ExternalHarnessAdapter({
      preset: 'qwen-code',
      command: '/nonexistent/path/to/qwen-binary-xyz',
    });

    const result = await adapter.execute(createRequest(tempDir));
    expect(result.status).toBe('failed');
    expect(result.verified).toBe(false);
    expect(result.errorKind).toBe('infrastructure');
    expect(result.terminationReason).toBe('RESOURCE_EXHAUSTED');
    expect(result.failureClassification).toBe('BINARY_NOT_FOUND');
  });

  it('11. detects incompatible ACP protocol version during initialization and fails with ACP_PROTOCOL_INCOMPATIBLE', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-proto-'));

    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: 9999 }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-proto' }),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new ExternalHarnessAdapter({
      preset: 'codex',
      expectedAcpProtocolVersion: PROTOCOL_VERSION,
      connect: async () => mockConn,
    });

    const result = await adapter.execute(createRequest(tempDir));
    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('protocol');
    expect(result.terminationReason).toBe('MODEL_PROTOCOL_BUDGET_EXHAUSTED');
    expect(result.failureClassification).toBe('ACP_PROTOCOL_INCOMPATIBLE');
    expect(result.errors?.[0]).toContain('ACP protocol version mismatch');
  });

  it('12. executes OpenCode external CLI subprocess, strips secret env vars, and bounds output', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-cli-'));
    const fakeCli = path.join(tempDir, 'fake-opencode.mjs');
    const envDumpFile = path.join(tempDir, 'env-dump.json');

    await fs.writeFile(
      fakeCli,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(envDumpFile)}, JSON.stringify({
  args: process.argv.slice(2),
  awsSecret: process.env.AWS_SECRET_ACCESS_KEY ?? null,
  ghToken: process.env.GITHUB_TOKEN ?? null,
  opencodeDir: process.env.OPENCODE_CONFIG_DIR ?? null,
}));
process.stdout.write('OpenCode CLI completed task: ' + process.argv.slice(2).join(' '));
`,
      { mode: 0o755 },
    );

    const adapter = new ExternalHarnessAdapter({
      preset: 'opencode',
      command: fakeCli,
      args: ['run'],
      baseEnv: {
        ...process.env,
        AWS_SECRET_ACCESS_KEY: 'should-not-leak',
        GITHUB_TOKEN: 'ghp_shouldnotleak1234567890123456',
        OPENCODE_CONFIG_DIR: '/custom/opencode/config',
      },
    });

    const result = await adapter.execute(createRequest(tempDir, { objective: 'Add unit tests' }));
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(false);
    expect(result.harnessKind).toBe('external-cli');
    expect(result.usage.costStatus).toBe('UNKNOWN');
    expect(result.usage.costUSD).toBeUndefined();
    expect(result.output).toContain('OpenCode CLI completed task: run Add unit tests');

    const dumped = JSON.parse(await fs.readFile(envDumpFile, 'utf8'));
    expect(dumped.args).toEqual(['run', 'Add unit tests']);
    expect(dumped.awsSecret).toBeNull();
    expect(dumped.ghToken).toBeNull();
    expect(dumped.opencodeDir).toBe('/custom/opencode/config');
  });

  it('13. classifies subprocess signal crash as status="interrupted" and SUBPROCESS_INTERRUPTED', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-crash-'));
    const crashCli = path.join(tempDir, 'crash-cli.mjs');

    await fs.writeFile(
      crashCli,
      `#!/usr/bin/env node
process.kill(process.pid, 'SIGTERM');
`,
      { mode: 0o755 },
    );

    const adapter = new ExternalHarnessAdapter({
      preset: 'opencode',
      command: crashCli,
      args: [],
    });

    const result = await adapter.execute(createRequest(tempDir));
    expect(result.status).toBe('interrupted');
    expect(result.verified).toBe(false);
    expect(result.failureClassification).toBe('SUBPROCESS_INTERRUPTED');
  });

  it('14. handles mid-turn cancellation cleanly with status="cancelled" and CANCELLED classification', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-a3-cancel-'));

    let cancelTriggered = false;
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: PROTOCOL_VERSION }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-cancel' }),
      prompt: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            const check = setInterval(() => {
              if (cancelTriggered) {
                clearInterval(check);
                resolve({ stopReason: 'cancelled' });
              }
            }, 20);
          }),
      ),
      cancel: vi.fn().mockImplementation(async () => {
        cancelTriggered = true;
      }),
    };

    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 60);

    const adapter = new ExternalHarnessAdapter({
      preset: 'qwen-code',
      connect: async () => mockConn,
    });

    const result = await adapter.execute(
      createRequest(tempDir, {
        isCancelled: () => cancelled,
      }),
    );

    expect(result.status).toBe('cancelled');
    expect(result.terminationReason).toBe('CANCELLED');
    expect(result.errorKind).toBe('cancelled');
    expect(result.failureClassification).toBe('CANCELLED');
    expect(mockConn.cancel).toHaveBeenCalledWith({ sessionId: 'sess-cancel' });
  });
});
