import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunRequest, AgentRuntime, AgentTurn } from '@wazir/core';
import {
  AgentConfigurationDiscovery,
  classifyEndpointUrlLocality,
} from '../src/configurationDiscovery.js';
import {
  AcpSessionEventCollector,
  createInitialAcpMapperState,
  mapAcpSessionUpdate,
  type NormalizedAcpStreamEvent,
} from '../src/acp/acpEventMapper.js';
import {
  EXTERNAL_HARNESS_PRESETS,
  checkAcpPrivacyEligibility,
  discoverExternalHarnessCapabilities,
  resolveQwenAcpLaunchArgs,
} from '../src/acp/acpHarnessCapabilities.js';
import {
  AcpAgentAdapter,
  decideAcpPermission,
} from '../src/acp/acpAgentAdapter.js';
import { classifyAgentFailure, preflightAgent } from '../src/preflight.js';
import {
  DEFAULT_HARDWARE_DISTRIBUTION,
  DEFAULT_WORKLOAD_DISTRIBUTION,
  WorkloadDistributor,
  matchesAgentPool,
  parseWorkloadDistribution,
} from '../../core/src/services/workloadDistributor.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'wazir-qwen-acp-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Creates a self-contained Node ESM mock ACP server speaking newline-delimited JSON-RPC 2.0
 * over stdin/stdout (compatible with `@agentclientprotocol/sdk` ClientSideConnection).
 */
function writeMockQwenAcpServerScript(dir: string): string {
  const scriptPath = path.join(dir, 'mock-qwen-acp-server.mjs');
  const source = `
import fs from 'node:fs';
import readline from 'node:readline';

const mode = process.env.MOCK_ACP_SCENARIO || 'full_turn';
const markerFile = process.env.MOCK_ACP_SPAWN_MARKER;
const pidFile = process.env.MOCK_ACP_PID_FILE;
const argsCaptureFile = process.env.MOCK_ACP_ARGS_FILE;

if (markerFile) {
  fs.writeFileSync(markerFile, 'spawned', 'utf8');
}
if (pidFile) {
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
}
if (argsCaptureFile) {
  fs.writeFileSync(argsCaptureFile, JSON.stringify(process.argv.slice(2)), 'utf8');
}

let nextReqId = 1000;
const pendingClientRequests = new Map();
let activePromptId = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function requestClient(method, params) {
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Response to an agent-initiated request (e.g. session/request_permission)
  if (msg.id !== undefined && !msg.method) {
    const pending = pendingClientRequests.get(msg.id);
    if (pending) {
      pendingClientRequests.delete(msg.id);
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
    }
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'qwen-code', version: '0.12.0-mock' },
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    const sessionId = process.env.MOCK_ACP_SESSION_ID || 'qwen-session-bridge-001';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId },
    });
    return;
  }

  if (msg.method === 'session/cancel') {
    if (mode === 'hang_ignore_cancel') {
      // Intentionally ignore cancel to test cancelGraceMs hard kill
      return;
    }
    if (activePromptId !== null) {
      const id = activePromptId;
      activePromptId = null;
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'cancelled' },
      });
    }
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId || 'qwen-session-bridge-001';
    activePromptId = msg.id;

    if (mode === 'wait_for_cancel' || mode === 'hang_ignore_cancel') {
      sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Working on long-running analysis...' },
        },
      });
      // Stay open until cancelled or killed
      return;
    }

    if (mode === 'permission_matrix') {
      const readPerm = await requestClient('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'tc-perm-read',
          title: 'Read package.json',
          kind: 'read',
        },
        options: [
          { optionId: 'always-read', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'once-read', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-read', name: 'Reject', kind: 'reject_once' },
        ],
      });

      const editPerm = await requestClient('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'tc-perm-edit',
          title: 'Edit src/index.ts',
          kind: 'edit',
        },
        options: [
          { optionId: 'always-edit', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'once-edit', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-edit', name: 'Reject', kind: 'reject_once' },
        ],
      });

      const execPerm = await requestClient('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'tc-perm-exec',
          title: 'Run npm test',
          kind: 'execute',
        },
        options: [
          { optionId: 'always-exec', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'once-exec', name: 'Allow once', kind: 'allow_once' },
        ],
      });

      const alwaysOnlyPerm = await requestClient('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'tc-perm-always-only',
          title: 'Read README.md (always-only trap)',
          kind: 'read',
        },
        options: [
          { optionId: 'always-trap', name: 'Always allow forever', kind: 'allow_always' },
        ],
      });

      const summary = JSON.stringify({
        read: readPerm?.outcome,
        edit: editPerm?.outcome,
        exec: execPerm?.outcome,
        alwaysOnly: alwaysOnlyPerm?.outcome,
      });

      sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: summary },
        },
      });
      activePromptId = null;
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    // Default 'full_turn' scenario: thoughts, plan, multi-tool calls + diff updates, handoff, final answer
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'INTERNAL_SECRET_THOUGHT_PART_1: inspecting router. ' },
      },
    });
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'INTERNAL_SECRET_THOUGHT_PART_2: planning patch.' },
      },
    });

    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read existing module', status: 'completed', priority: 'high' },
          { content: 'Apply minimal fix', status: 'in_progress', priority: 'high' },
        ],
      },
    });

    // Tool 1: read
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-read-1',
        kind: 'read',
        title: 'Read src/math.ts',
        rawInput: { path: 'src/math.ts', startLine: 1, endLine: 20 },
        locations: [{ path: 'src/math.ts', line: 1 }],
      },
    });
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-read-1',
        status: 'completed',
        rawOutput: { output: 'export const add = (a, b) => a - b;' },
      },
    });

    // Tool 2: edit with streaming diff in in_progress followed by completed
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-edit-2',
        kind: 'edit',
        title: 'Edit src/math.ts',
        rawInput: { path: 'src/math.ts' },
        locations: [{ path: 'src/math.ts', line: 1, column: 14 }],
      },
    });
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-edit-2',
        status: 'in_progress',
        content: [
          {
            type: 'diff',
            path: 'src/math.ts',
            oldText: 'export const add = (a, b) => a - b;',
            newText: 'export const add = (a, b) => a + b;',
          },
        ],
      },
    });
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-edit-2',
        status: 'completed',
      },
    });

    // Session handoff / checkpoint metadata update via ACP-compliant current_mode_update + _meta
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'auto-edit',
        _meta: {
          resumeSessionId: sessionId,
          checkpointId: 'ckpt-qwen-009',
          modelId: 'qwen3-coder-plus',
        },
      },
    });

    // Final user-facing assistant answer chunks
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Fixed the addition bug in ' },
      },
    });
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'src/math.ts.' },
      },
    });

    activePromptId = null;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { stopReason: 'end_turn' },
    });
  }
});

// Keep event loop alive while stdin is open
process.stdin.resume();
`;
  writeFileSync(scriptPath, source, 'utf8');
  return scriptPath;
}

async function collectTurns(iterable: AsyncIterable<AgentTurn>): Promise<AgentTurn[]> {
  const turns: AgentTurn[] = [];
  for await (const turn of iterable) {
    turns.push(turn);
  }
  return turns;
}

function makeBaseRunRequest(projectRoot: string, overrides: Record<string, unknown> = {}): AgentRunRequest {
  return {
    modelId: 'qwen-code-external',
    taskType: 'coding',
    taskDescription: 'Fix the bug in src/math.ts',
    projectRoot,
    ...overrides,
  } as unknown as AgentRunRequest;
}

describe('Wave 1: Qwen ACP External Bridge (A009-A016)', () => {
  describe('1. AgentConfigurationDiscovery for qwen-code (A009)', () => {
    it('discovers qwen binary, ~/.qwen/settings.json, .qwen/settings.json, and enforces trust & secret redaction', () => {
      const workspace = makeTempDir('wazir-qwen-disc-');
      const repoRoot = path.join(workspace, 'repo');
      const binDir = path.join(workspace, 'bin');
      const homeDir = path.join(workspace, 'home');
      mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
      mkdirSync(path.join(repoRoot, '.qwen'), { recursive: true });
      mkdirSync(path.join(homeDir, '.qwen'), { recursive: true });
      mkdirSync(binDir, { recursive: true });

      const qwenBin = path.join(binDir, 'qwen');
      writeFileSync(qwenBin, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(qwenBin, 0o755);

      const leakedDashscopeSecret = 'sk-dashscope-super-secret-value-999';
      writeFileSync(
        path.join(homeDir, '.qwen', 'settings.json'),
        JSON.stringify({
          model: { name: 'qwen3-coder-plus' },
          security: { auth: { selectedType: 'qwen-oauth' } },
          env: { DASHSCOPE_API_KEY: leakedDashscopeSecret },
          mcpServers: { filesystem: { command: 'npx' } },
        }),
        'utf8',
      );

      writeFileSync(
        path.join(repoRoot, '.qwen', 'settings.json'),
        JSON.stringify({
          model: 'qwen2.5-coder-32b-instruct',
        }),
        'utf8',
      );

      const discovery = new AgentConfigurationDiscovery();

      // Untrusted project withholds project settings model override
      const untrusted = discovery
        .discover({
          cwd: repoRoot,
          home: homeDir,
          env: { PATH: binDir },
          trustedProject: false,
        })
        .find((d) => d.agent === 'qwen-code');

      expect(untrusted).toBeDefined();
      expect(untrusted!.executable).toBe(qwenBin);
      expect(untrusted!.state).toBe('CONFIGURED');
      expect(untrusted!.model).toEqual({
        status: 'CONFIGURED',
        value: 'qwen3-coder-plus',
        source: path.join(homeDir, '.qwen', 'settings.json'),
      });
      expect(untrusted!.credentialConfigured).toBe(true);
      expect(untrusted!.endpointLocality).toBe('cloud');
      expect(JSON.stringify(untrusted)).not.toContain(leakedDashscopeSecret);

      // Trusted project allows .qwen/settings.json to participate
      const trusted = discovery
        .discover({
          cwd: repoRoot,
          home: homeDir,
          env: { PATH: binDir },
          trustedProject: true,
        })
        .find((d) => d.agent === 'qwen-code');

      expect(trusted).toBeDefined();
      expect(trusted!.model.value).toBe('qwen2.5-coder-32b-instruct');
      expect(trusted!.fingerprint).not.toBe(untrusted!.fingerprint);
      expect(JSON.stringify(trusted)).not.toContain(leakedDashscopeSecret);
    });

    it('rejects project .qwen/settings.json symlinks escaping the repository root', () => {
      const workspace = makeTempDir('wazir-qwen-symlink-');
      const repoRoot = path.join(workspace, 'repo');
      const outsideDir = path.join(workspace, 'outside');
      const homeDir = path.join(workspace, 'home');
      mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
      mkdirSync(path.join(repoRoot, '.qwen'), { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });

      const outsideFile = path.join(outsideDir, 'escaped-settings.json');
      writeFileSync(outsideFile, JSON.stringify({ model: 'evil-escaped-model' }), 'utf8');
      symlinkSync(outsideFile, path.join(repoRoot, '.qwen', 'settings.json'));

      const qwen = new AgentConfigurationDiscovery()
        .discover({
          cwd: repoRoot,
          home: homeDir,
          env: { PATH: '' },
          trustedProject: true,
        })
        .find((d) => d.agent === 'qwen-code');

      expect(qwen).toBeDefined();
      expect(qwen!.diagnostics).toContain('Project configuration symlink escapes repository; ignored.');
      expect(qwen!.model.status).toBe('UNKNOWN');
      expect(JSON.stringify(qwen)).not.toContain('evil-escaped-model');
    });

    it('detects loopback local endpointLocality vs cloud endpoints and fingerprints Qwen env keys', () => {
      expect(classifyEndpointUrlLocality('http://127.0.0.1:11434/v1')).toBe('local');
      expect(classifyEndpointUrlLocality('http://localhost:8080/v1')).toBe('local');
      expect(classifyEndpointUrlLocality('http://[::1]:11434/v1')).toBe('local');
      expect(classifyEndpointUrlLocality('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('cloud');
      expect(classifyEndpointUrlLocality('not-a-valid-url')).toBe('invalid');

      const workspace = makeTempDir('wazir-qwen-locality-');
      const repoRoot = path.join(workspace, 'repo');
      const homeDir = path.join(workspace, 'home');
      mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
      mkdirSync(homeDir, { recursive: true });

      const discovery = new AgentConfigurationDiscovery();

      const localCfg = discovery
        .discover({
          cwd: repoRoot,
          home: homeDir,
          env: {
            PATH: '',
            OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
            OPENAI_API_KEY: 'ollama',
          },
        })
        .find((d) => d.agent === 'qwen-code')!;
      expect(localCfg.endpointLocality).toBe('local');

      // Adding DASHSCOPE_API_KEY flips locality to 'cloud' and changes fingerprint
      const hybridCloudCfg = discovery
        .discover({
          cwd: repoRoot,
          home: homeDir,
          env: {
            PATH: '',
            OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
            OPENAI_API_KEY: 'ollama',
            DASHSCOPE_API_KEY: 'sk-dashscope-cloud',
          },
        })
        .find((d) => d.agent === 'qwen-code')!;
      expect(hybridCloudCfg.endpointLocality).toBe('cloud');
      expect(hybridCloudCfg.fingerprint).not.toBe(localCfg.fingerprint);
      expect(JSON.stringify(hybridCloudCfg)).not.toContain('sk-dashscope-cloud');
    });
  });

  describe('2. acpEventMapper + AcpAgentAdapter stdio streaming, diffs, and session handoff (A012, A013)', () => {
    it('maps thoughts, text, tool calls, unified diffs, plans, and handoff metadata purely without polluting answer', () => {
      let state = createInitialAcpMapperState();
      const sid = 'sess-pure-01';

      const t1 = mapAcpSessionUpdate(
        sid,
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hidden chain of thought' } },
        state,
      );
      state = t1.nextState;
      expect(t1.answerDelta).toBe('');
      expect(t1.thoughtDelta).toBe('Hidden chain of thought');
      expect(t1.turns).toHaveLength(0);
      expect(t1.events).toEqual([{ kind: 'thought', acpSessionId: sid, text: 'Hidden chain of thought' }]);

      const tc = mapAcpSessionUpdate(
        sid,
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          kind: 'edit',
          title: 'Patch file.ts',
          rawInput: { file: 'file.ts' },
          locations: [{ path: 'file.ts', line: 10 }],
        },
        state,
      );
      state = tc.nextState;
      expect(tc.turns[0]).toMatchObject({
        kind: 'tool_call',
        tool: 'edit',
        toolInput: {
          title: 'Patch file.ts',
          toolCallId: 'tc-1',
          acpSessionId: sid,
          input: { file: 'file.ts' },
          locations: [{ path: 'file.ts', line: 10 }],
        },
      });

      const tcuProgress = mapAcpSessionUpdate(
        sid,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'in_progress',
          content: [{ type: 'diff', path: 'file.ts', oldText: 'const x = 1;', newText: 'const x = 2;' }],
        },
        state,
      );
      state = tcuProgress.nextState;
      expect(tcuProgress.events).toHaveLength(1);
      expect(tcuProgress.events[0]).toMatchObject({
        kind: 'diff',
        acpSessionId: sid,
        toolCallId: 'tc-1',
      });

      const tcuDone = mapAcpSessionUpdate(
        sid,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
        },
        state,
      );
      expect(tcuDone.turns).toHaveLength(1);
      expect(tcuDone.turns[0]).toMatchObject({
        kind: 'tool_result',
        tool: 'Patch file.ts',
        toolResult: {
          ok: true,
          toolCallId: 'tc-1',
          acpSessionId: sid,
          toolKind: 'edit',
          locations: [{ path: 'file.ts', line: 10 }],
        },
      });
      const resultDiffs = (tcuDone.turns[0]!.toolResult as Record<string, any>).diffs;
      expect(resultDiffs).toHaveLength(1);
      expect(resultDiffs[0].unifiedDiff).toContain('-const x = 1;');
      expect(resultDiffs[0].unifiedDiff).toContain('+const x = 2;');
    });

    it('streams a full mock Qwen ACP stdio session with thoughts isolated from done.content, diffs preserved, and resume/model args forwarded', async () => {
      const dir = makeTempDir('wazir-qwen-stdio-');
      const serverScript = writeMockQwenAcpServerScript(dir);
      const argsFile = path.join(dir, 'captured-args.json');
      const streamEvents: NormalizedAcpStreamEvent[] = [];

      const adapter = new AcpAgentAdapter({
        name: 'qwen-code',
        description: 'Mock Qwen Code ACP server',
        command: process.execPath,
        args: [serverScript, '--acp'],
        env: {
          MOCK_ACP_SCENARIO: 'full_turn',
          MOCK_ACP_SESSION_ID: 'qwen-sess-resume-777',
          MOCK_ACP_ARGS_FILE: argsFile,
        },
        onAcpStreamEvent: (ev) => streamEvents.push(ev),
      });

      const turns = await collectTurns(
        adapter.run(
          makeBaseRunRequest(dir, {
            modelId: 'qwen3-coder-plus',
            resumeSessionId: 'prior-sess-000',
          }),
          {} as AgentRuntime,
        ),
      );

      const doneTurn = turns.at(-1);
      expect(doneTurn).toEqual({
        kind: 'done',
        content: 'Fixed the addition bug in src/math.ts.',
        terminationReason: 'COMPLETED',
      });
      // Internal thoughts must NEVER pollute user-facing answer or message turns
      expect(doneTurn?.content).not.toContain('INTERNAL_SECRET_THOUGHT');
      for (const turn of turns) {
        expect(JSON.stringify(turn)).not.toContain('INTERNAL_SECRET_THOUGHT');
      }

      // Thoughts are still captured cleanly in normalized stream events & collector
      const collector = adapter.getLastCollector()!;
      expect(collector.getThoughts()).toContain('INTERNAL_SECRET_THOUGHT_PART_1');
      expect(collector.getThoughts()).toContain('INTERNAL_SECRET_THOUGHT_PART_2');
      expect(streamEvents.filter((e) => e.kind === 'thought')).toHaveLength(2);

      // Plan turn & event
      expect(turns.some((t) => t.kind === 'message' && t.content?.includes('Plan:\n- [completed] Read existing module'))).toBe(true);
      expect(streamEvents.some((e) => e.kind === 'plan')).toBe(true);

      // Multi-tool calls & diff preservation
      const toolCalls = turns.filter((t) => t.kind === 'tool_call');
      const toolResults = turns.filter((t) => t.kind === 'tool_result');
      expect(toolCalls).toHaveLength(2);
      expect(toolResults).toHaveLength(2);
      expect(collector.getDiffs()).toHaveLength(1);
      expect(collector.getDiffs()[0]).toMatchObject({
        path: 'src/math.ts',
        oldText: 'export const add = (a, b) => a - b;',
        newText: 'export const add = (a, b) => a + b;',
      });

      // Session handoff metadata preserved for checkpoint/resume
      expect(adapter.getLastSessionHandoff()).toEqual({
        acpSessionId: 'qwen-sess-resume-777',
        resumeSessionId: 'qwen-sess-resume-777',
        checkpointId: 'ckpt-qwen-009',
        modeId: 'auto-edit',
        modelId: 'qwen3-coder-plus',
        canResume: true,
      });

      // Verify --model and --resume CLI flags were safely passed to Qwen process
      const capturedArgs = JSON.parse(
        await import('node:fs/promises').then((fs) => fs.readFile(argsFile, 'utf8')),
      );
      expect(capturedArgs).toEqual(['--acp', '--model', 'qwen3-coder-plus', '--resume', 'prior-sess-000']);
    });

    it('enhances qwen-code capability preset and sanitizes resolveQwenAcpLaunchArgs', () => {
      const preset = EXTERNAL_HARNESS_PRESETS['qwen-code']!;
      expect(preset.allowsModelSelection).toBe(true);
      expect(preset.capabilities).toContain('checkpoint-resume');
      expect(preset.allowedEnvKeys).toEqual(
        expect.arrayContaining(['QWEN_CODE_HOME', 'QWEN_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DASHSCOPE_API_KEY']),
      );

      const discovered = discoverExternalHarnessCapabilities('qwen-code', {
        env: {
          PATH: '/usr/bin',
          OPENAI_API_KEY: 'local-ollama-token',
          AWS_SECRET_ACCESS_KEY: 'must-never-leak',
        },
        resolveBinary: () => '/usr/local/bin/qwen',
      });
      expect(discovered.available).toBe(true);
      expect(discovered.sanitizedEnv.OPENAI_API_KEY).toBe('local-ollama-token');
      expect(discovered.sanitizedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(discovered.strippedEnvKeys).toContain('AWS_SECRET_ACCESS_KEY');

      expect(
        resolveQwenAcpLaunchArgs({
          modelId: 'qwen3-coder-plus',
          resumeSessionId: 'sess_123',
          approvalMode: 'plan',
        }),
      ).toEqual(['--acp', '--model', 'qwen3-coder-plus', '--resume', 'sess_123', '--approval-mode', 'plan']);

      // Sentinel model IDs and unsafe flag-injection strings are ignored safely
      expect(
        resolveQwenAcpLaunchArgs({
          modelId: '--malicious-flag',
          resumeSessionId: 'bad;rm -rf /',
        }),
      ).toEqual(['--acp']);
      expect(resolveQwenAcpLaunchArgs({ modelId: 'external' })).toEqual(['--acp']);
    });
  });

  describe('3. Permission brokerage (read vs edit vs full; one-time grants only, never always)', () => {
    it('grants only one-time permissions matching mode and rejects always-only escalations over live ACP stdio', async () => {
      const dir = makeTempDir('wazir-qwen-perm-');
      const serverScript = writeMockQwenAcpServerScript(dir);

      const runWithMode = async (permissionMode: 'read' | 'edit' | 'full') => {
        const adapter = new AcpAgentAdapter({
          name: 'qwen-code',
          description: 'Permission brokerage test',
          command: process.execPath,
          args: [serverScript, '--acp'],
          permissionMode,
          env: { MOCK_ACP_SCENARIO: 'permission_matrix' },
        });
        const turns = await collectTurns(adapter.run(makeBaseRunRequest(dir), {} as AgentRuntime));
        const done = turns.find((t) => t.kind === 'done');
        expect(done).toBeDefined();
        return JSON.parse(done!.content!);
      };

      const readOutcomes = await runWithMode('read');
      expect(readOutcomes).toEqual({
        read: { outcome: 'selected', optionId: 'once-read' },
        edit: { outcome: 'cancelled' },
        exec: { outcome: 'cancelled' },
        alwaysOnly: { outcome: 'cancelled' },
      });

      const editOutcomes = await runWithMode('edit');
      expect(editOutcomes).toEqual({
        read: { outcome: 'selected', optionId: 'once-read' },
        edit: { outcome: 'selected', optionId: 'once-edit' },
        exec: { outcome: 'cancelled' },
        alwaysOnly: { outcome: 'cancelled' },
      });

      const fullOutcomes = await runWithMode('full');
      expect(fullOutcomes).toEqual({
        read: { outcome: 'selected', optionId: 'once-read' },
        edit: { outcome: 'selected', optionId: 'once-edit' },
        exec: { outcome: 'selected', optionId: 'once-exec' },
        alwaysOnly: { outcome: 'cancelled' },
      });

      // Direct unit check on decideAcpPermission never picking escalation === 'always'
      expect(
        decideAcpPermission('full', 'read', [
          { optionId: 'always-1', label: 'Always', kind: 'proceed', escalation: 'always' },
        ]),
      ).toEqual({ cancelled: true });
    });
  });

  describe('4. FH-A8-02 localOnly / sensitive dataClassification privacy enforcement (A011)', () => {
    it('blocks cloud-authenticated qwen-code BEFORE spawning any child process when localOnly or sensitive classification is set', async () => {
      const dir = makeTempDir('wazir-qwen-privacy-block-');
      const serverScript = writeMockQwenAcpServerScript(dir);
      const spawnMarker = path.join(dir, 'should-never-exist.marker');
      const connectSpy = vi.fn();

      const cloudAdapter = new AcpAgentAdapter({
        name: 'qwen-code',
        description: 'Cloud Qwen Code',
        command: process.execPath,
        args: [serverScript, '--acp'],
        env: {
          DASHSCOPE_API_KEY: 'sk-cloud-secret',
          MOCK_ACP_SPAWN_MARKER: spawnMarker,
        },
        connect: connectSpy,
      });

      const localOnlyTurns = await collectTurns(
        cloudAdapter.run(makeBaseRunRequest(dir, { localOnly: true }), {} as AgentRuntime),
      );
      expect(localOnlyTurns).toHaveLength(1);
      expect(localOnlyTurns[0]).toMatchObject({
        kind: 'error',
        terminationReason: 'POLICY_DENIED',
        errorKind: 'policy',
      });
      expect(localOnlyTurns[0]!.error).toContain('FH-A8-02');
      expect(existsSync(spawnMarker)).toBe(false);
      expect(connectSpy).not.toHaveBeenCalled();

      const sensitiveTurns = await collectTurns(
        cloudAdapter.run(
          makeBaseRunRequest(dir, { dataClassification: 'sensitive' }),
          {} as AgentRuntime,
        ),
      );
      expect(sensitiveTurns).toHaveLength(1);
      expect(sensitiveTurns[0]).toMatchObject({
        kind: 'error',
        terminationReason: 'POLICY_DENIED',
        errorKind: 'policy',
      });
      expect(existsSync(spawnMarker)).toBe(false);
      expect(connectSpy).not.toHaveBeenCalled();

      // Direct helper checks for codex / claude-code / gemini under restricted classifications
      expect(
        checkAcpPrivacyEligibility({
          harnessId: 'claude-code',
          dataClassification: 'secret',
          env: { ANTHROPIC_API_KEY: 'sk-ant-123' },
        }).allowed,
      ).toBe(false);
      expect(
        checkAcpPrivacyEligibility({
          harnessId: 'qwen-code',
          localOnly: true,
          env: {},
        }).allowed,
      ).toBe(false);
    });

    it('allows qwen-code under localOnly: true and dataClassification: sensitive when OPENAI_BASE_URL is loopback with no cloud keys', async () => {
      const dir = makeTempDir('wazir-qwen-privacy-allow-');
      const serverScript = writeMockQwenAcpServerScript(dir);
      const spawnMarker = path.join(dir, 'local-spawned.marker');

      const loopbackAdapter = new AcpAgentAdapter({
        name: 'qwen-code',
        description: 'Loopback Ollama Qwen Code',
        command: process.execPath,
        args: [serverScript, '--acp'],
        env: {
          OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
          OPENAI_API_KEY: 'ollama',
          MOCK_ACP_SCENARIO: 'full_turn',
          MOCK_ACP_SPAWN_MARKER: spawnMarker,
        },
      });

      const turns = await collectTurns(
        loopbackAdapter.run(
          makeBaseRunRequest(dir, {
            localOnly: true,
            dataClassification: 'sensitive',
          }),
          {} as AgentRuntime,
        ),
      );

      expect(existsSync(spawnMarker)).toBe(true);
      expect(turns.at(-1)).toEqual({
        kind: 'done',
        content: 'Fixed the addition bug in src/math.ts.',
        terminationReason: 'COMPLETED',
      });
    });
  });

  describe('5. Cancellation and wall-clock timeout clean teardown', () => {
    it('propagates cancellation cleanly through session/cancel and terminates subprocess', async () => {
      const dir = makeTempDir('wazir-qwen-cancel-');
      const serverScript = writeMockQwenAcpServerScript(dir);
      const pidFile = path.join(dir, 'server.pid');

      let cancelled = false;
      setTimeout(() => {
        cancelled = true;
      }, 150);

      const adapter = new AcpAgentAdapter({
        name: 'qwen-code',
        description: 'Cancel test',
        command: process.execPath,
        args: [serverScript, '--acp'],
        env: {
          MOCK_ACP_SCENARIO: 'wait_for_cancel',
          MOCK_ACP_PID_FILE: pidFile,
        },
      });

      const turns = await collectTurns(
        adapter.run(
          makeBaseRunRequest(dir, { isCancelled: () => cancelled }),
          {} as AgentRuntime,
        ),
      );

      expect(turns.at(-1)).toEqual({
        kind: 'error',
        error: 'cancelled',
        terminationReason: 'CANCELLED',
        errorKind: 'cancelled',
      });
    });

    it('enforces maxWallClockMs and kills hung ACP process after cancelGraceMs', async () => {
      const dir = makeTempDir('wazir-qwen-timeout-');
      const serverScript = writeMockQwenAcpServerScript(dir);
      const pidFile = path.join(dir, 'hung-server.pid');

      const adapter = new AcpAgentAdapter({
        name: 'qwen-code',
        description: 'Wall-clock timeout test',
        command: process.execPath,
        args: [serverScript, '--acp'],
        cancelGraceMs: 150,
        env: {
          MOCK_ACP_SCENARIO: 'hang_ignore_cancel',
          MOCK_ACP_PID_FILE: pidFile,
        },
      });

      const turns = await collectTurns(
        adapter.run(
          makeBaseRunRequest(dir, { maxWallClockMs: 200 }),
          {} as AgentRuntime,
        ),
      );

      expect(turns.at(-1)).toMatchObject({
        kind: 'error',
        terminationReason: 'MAX_WALL_CLOCK',
        errorKind: 'other',
      });

      if (existsSync(pidFile)) {
        const pid = Number(
          await import('node:fs/promises').then((fs) => fs.readFile(pidFile, 'utf8')),
        );
        await new Promise((r) => setTimeout(r, 100));
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    });
  });

  describe('6. Preflight hints & WorkloadDistributor Qwen pool support (A010, A011)', () => {
    it('provides actionable qwen --acp / auth hints and redacts leaked secrets in preflight detail', async () => {
      const missingHint = classifyAgentFailure('qwen-code', "could not start ACP agent 'qwen-code': spawn qwen ENOENT");
      expect(missingHint.status).toBe('FAILED');
      expect(missingHint.hint).toContain('qwen');
      expect(missingHint.hint).toContain('--acp');

      const authHint = classifyAgentFailure('qwen-code', '401 Unauthorized: invalid api key');
      expect(authHint.status).toBe('FAILED');
      expect(authHint.hint).toContain('~/.qwen/settings.json');
      expect(authHint.hint).toContain('--acp');

      const privacyHint = classifyAgentFailure('qwen-code', 'FH-A8-02 policy denied: local-only privacy mode');
      expect(privacyHint.status).toBe('BLOCKED');
      expect(privacyHint.hint).toContain('OPENAI_BASE_URL');

      // Verify preflightAgent scrubs raw secret tokens if an external CLI echoes them
      const leakyAdapter = {
        descriptor: {
          name: 'qwen-code',
          version: 'acp',
          description: 'leaky',
          capabilities: [],
          requiredTools: [],
          modelRequirements: { capabilities: [] },
          permissions: [],
        },
        async *run() {
          yield {
            kind: 'error' as const,
            error: 'Auth failed for DASHSCOPE_API_KEY=sk-liveSecretToken123456 with Bearer eyJhbGciOiJIUzI1NiJ9.secret',
          };
        },
      };
      const preflight = await preflightAgent(leakyAdapter);
      expect(preflight.status).toBe('FAILED');
      expect(preflight.detail).not.toContain('sk-liveSecretToken123456');
      expect(preflight.detail).not.toContain('eyJhbGciOiJIUzI1NiJ9.secret');
      expect(preflight.detail).toContain('[REDACTED]');
    });

    it('supports qwen / qwen-code / qwen-acp in WorkloadDistributor while keeping DEFAULT_WORKLOAD_DISTRIBUTION unchanged', () => {
      expect(DEFAULT_WORKLOAD_DISTRIBUTION.shares).toEqual([
        { pool: 'local', weight: 70 },
        { pool: 'antigravity', weight: 15 },
        { pool: 'codex', weight: 5 },
        { pool: 'auto', weight: 10 },
      ]);
      expect(DEFAULT_HARDWARE_DISTRIBUTION).toEqual(DEFAULT_WORKLOAD_DISTRIBUTION);

      expect(matchesAgentPool('qwen', ['qwen-code'])).toBe(true);
      expect(matchesAgentPool('qwen-acp', ['qwen-code'])).toBe(true);
      expect(matchesAgentPool('qwen-code', ['qwen'])).toBe(true);
      expect(matchesAgentPool('qwen', ['codex'])).toBe(false);

      const dist = new WorkloadDistributor(parseWorkloadDistribution('local:50,qwen:50'));
      const allocations = dist.allocateBatch(4, {
        hasLocalHardware: true,
        hardwareComputerIds: ['mac-studio'],
        externalAgents: ['qwen-code'],
      });
      expect(allocations.filter((a) => a.pool === 'local')).toHaveLength(2);
      expect(allocations.filter((a) => a.targetAgentId === 'qwen-code')).toHaveLength(2);

      // LOCAL_ONLY routing mode never dispatches to external qwen-code
      const localOnlyAllocations = dist.allocateBatch(4, {
        hasLocalHardware: true,
        hardwareComputerIds: ['mac-studio'],
        externalAgents: ['qwen-code'],
        routingMode: 'LOCAL_ONLY',
      });
      expect(localOnlyAllocations.every((a) => a.pool === 'local' && !a.targetAgentId)).toBe(true);
    });
  });
});
