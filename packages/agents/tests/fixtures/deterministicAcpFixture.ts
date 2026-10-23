import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client } from '@agentclientprotocol/sdk';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AcpClientOptions, AcpConnectionLike } from '../../src/acp/acpClient.js';
import type { AcpAgentSpec, AcpPermissionMode } from '../../src/acp/acpAgentAdapter.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SDK_ENTRY_PATH = path.join(
  REPO_ROOT,
  'node_modules',
  '@agentclientprotocol',
  'sdk',
  'dist',
  'acp.js',
);

export type DeterministicAcpScenario =
  | 'normal-completion'
  | 'malicious-always-permission'
  | 'malformed-output'
  | 'crash-mid-turn'
  | 'hang-until-cancelled'
  | 'false-verification-claim'
  | 'unsupported-capability';

export interface DeterministicAcpFixtureOptions {
  scenario: DeterministicAcpScenario;
  /** Target file inside cwd for normal-completion or false-verification-claim. Defaults to 'solution.ts'. */
  targetFile?: string;
  /** Content written to targetFile when edit permission is granted. */
  targetContent?: string;
  /** Optional file path to record spawned child PIDs for process cleanup verification. */
  pidFile?: string;
  /** If true, hang-until-cancelled ignores ACP cancel and requires process group kill. */
  ignoreCancelSignal?: boolean;
  /** Protected path or traversal path attempted in malicious-always-permission scenario. */
  maliciousTargetPath?: string;
  /** Permission mode for the AcpAgentSpec helper. */
  permissionMode?: AcpPermissionMode;
  /** Custom wall-clock bound in ms. */
  maxWallClockMs?: number;
  /** Custom cancel grace period in ms. */
  cancelGraceMs?: number;
}

export interface DeterministicAcpAuditLog {
  initialized: boolean;
  sessionsCreated: string[];
  permissionRequests: Array<{
    title: string;
    toolKind: string;
    outcome: string;
    selectedOptionId?: string;
  }>;
  cancelledSessions: string[];
  promptsReceived: string[];
}

/**
 * Creates an in-memory `connect` test seam (`AcpClientOptions['connect']`) that deterministically
 * simulates an external ACP coding agent across normal, malicious, malformed, crash, hang,
 * false-verification-claim, and unsupported-capability scenarios without paid credentials.
 */
export function createDeterministicAcpConnect(
  options: DeterministicAcpFixtureOptions,
  auditLog?: DeterministicAcpAuditLog,
): NonNullable<AcpClientOptions['connect']> {
  const targetFile = options.targetFile ?? 'solution.ts';
  const targetContent = options.targetContent ?? 'export const answer = 42;\n';
  const maliciousPath = options.maliciousTargetPath ?? '../outside.txt';

  return async (
    client: Client,
    onExit: (info: { code: number | null; signal: string | null }) => void,
  ): Promise<AcpConnectionLike> => {
    const sessions = new Map<string, string>();
    let cancelWaiter: (() => void) | undefined;
    let sessionSeq = 0;

    const standardOptions = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ];

    const alwaysOnlyOptions = [
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
    ];

    return {
      async initialize() {
        if (options.scenario === 'unsupported-capability') {
          throw new Error(
            `UNSUPPORTED_CAPABILITY: Agent requires incompatible ACP protocol version 9999 (host=${PROTOCOL_VERSION})`,
          );
        }
        if (auditLog) auditLog.initialized = true;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { coding: true, streaming: true },
        };
      },

      async newSession(params: Record<string, unknown>) {
        if (options.scenario === 'unsupported-capability') {
          throw new Error('UNSUPPORTED_CAPABILITY: Session creation refused by agent capability gate');
        }
        if (auditLog) auditLog.initialized = true;
        sessionSeq += 1;
        const sessionId = `det-acp-session-${sessionSeq}`;
        const cwd = String(params.cwd ?? process.cwd());
        sessions.set(sessionId, cwd);
        auditLog?.sessionsCreated.push(sessionId);
        return { sessionId };
      },

      async cancel(params: Record<string, unknown>) {
        const sessionId = String(params.sessionId ?? '');
        auditLog?.cancelledSessions.push(sessionId);
        if (!options.ignoreCancelSignal) {
          cancelWaiter?.();
        }
      },

      async prompt(params: Record<string, unknown>): Promise<{ stopReason?: string }> {
        const sessionId = String(params.sessionId ?? '');
        const cwd = sessions.get(sessionId) ?? process.cwd();
        const promptParts = Array.isArray(params.prompt) ? params.prompt : [];
        const promptText = promptParts
          .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
          .join('\n');
        auditLog?.promptsReceived.push(promptText);

        const emitUpdate = async (update: Record<string, unknown>) => {
          await client.sessionUpdate({ sessionId, update } as any);
        };

        const askPermission = async (
          toolCallId: string,
          title: string,
          kind: string,
          permOptions: Array<Record<string, unknown>>,
        ) => {
          const res = await (client as any).requestPermission({
            requestId: `req-${toolCallId}`,
            sessionId,
            toolCall: { toolCallId, title, kind },
            options: permOptions,
          });
          const outcome = String(res?.outcome?.outcome ?? 'cancelled');
          const selectedOptionId =
            typeof res?.outcome?.optionId === 'string' ? res.outcome.optionId : undefined;
          auditLog?.permissionRequests.push({
            title,
            toolKind: kind,
            outcome,
            selectedOptionId,
          });
          return { outcome, selectedOptionId };
        };

        switch (options.scenario) {
          case 'normal-completion': {
            await emitUpdate({
              sessionUpdate: 'plan',
              entries: [
                { content: `Inspect workspace and write ${targetFile}`, status: 'in_progress', priority: 'high' },
              ],
            });
            await emitUpdate({
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-edit-1',
              title: `Write ${targetFile}`,
              kind: 'edit',
              status: 'pending',
              rawInput: { path: targetFile },
            });
            const perm = await askPermission('tc-edit-1', `Write ${targetFile}`, 'edit', standardOptions);
            if (perm.outcome === 'selected' && perm.selectedOptionId === 'allow-once') {
              writeFileSync(path.join(cwd, targetFile), targetContent, 'utf8');
              await emitUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-edit-1',
                title: `Write ${targetFile}`,
                status: 'completed',
              });
            } else {
              await emitUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-edit-1',
                title: `Write ${targetFile}`,
                status: 'failed',
              });
            }
            await emitUpdate({
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'INTERNAL_THOUGHT_NEVER_SURFACED' },
            });
            await emitUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Completed implementation in ${targetFile} (permission=${perm.outcome}).`,
              },
            });
            return { stopReason: 'end_turn' };
          }

          case 'malicious-always-permission': {
            // 1. Request permission offering ONLY 'allow_always' escalation
            const alwaysPerm = await askPermission(
              'tc-mal-always',
              `Persistent write access to ${targetFile}`,
              'edit',
              alwaysOnlyOptions,
            );
            // 2. Request 'execute' destructive command
            const execPerm = await askPermission(
              'tc-mal-exec',
              'rm -rf /important',
              'execute',
              standardOptions,
            );
            // 3. Request 'delete' on protected / outside path
            const deletePerm = await askPermission(
              'tc-mal-delete',
              `Delete ${maliciousPath}`,
              'delete',
              alwaysOnlyOptions,
            );

            // Never writes if denied
            if (
              alwaysPerm.outcome === 'selected' ||
              execPerm.outcome === 'selected' ||
              deletePerm.outcome === 'selected'
            ) {
              writeFileSync(path.join(cwd, 'compromised.txt'), 'should never happen\n', 'utf8');
            }

            await emitUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Permissions evaluated: always=${alwaysPerm.outcome}, exec=${execPerm.outcome}, delete=${deletePerm.outcome}`,
              },
            });
            return { stopReason: 'end_turn' };
          }

          case 'malformed-output': {
            // Emit malformed session updates (nulls, missing fields, non-object updates, unknown sessionUpdate types)
            await (client as any).sessionUpdate(null);
            await (client as any).sessionUpdate({});
            await (client as any).sessionUpdate({ sessionId, update: null });
            await (client as any).sessionUpdate({ sessionId, update: 'not-an-object' });
            await emitUpdate({
              sessionUpdate: 'unknown_corrupted_event_kind',
              content: { corrupted: 12345 },
            });
            await emitUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'non_text_garbage', text: null },
            });
            await emitUpdate({
              sessionUpdate: 'plan',
              entries: 'not-an-array',
            });
            // Followed by a valid chunk to confirm controller survived without crashing
            await emitUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Controller survived malformed output payloads.' },
            });
            return { stopReason: 'end_turn' };
          }

          case 'crash-mid-turn': {
            await emitUpdate({
              sessionUpdate: 'plan',
              entries: [{ content: 'Starting work before sudden crash', status: 'in_progress' }],
            });
            await emitUpdate({
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-crash-1',
              title: `Mutate ${targetFile}`,
              kind: 'edit',
              status: 'pending',
            });
            const crashErr = new Error(
              `ACP agent exited during the turn (code 137 / SIGKILL): simulated mid-turn process death`,
            );
            onExit({ code: 137, signal: 'SIGKILL' });
            throw crashErr;
          }

          case 'hang-until-cancelled': {
            await emitUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Entering long-running operation...' },
            });
            await new Promise<void>((resolve) => {
              cancelWaiter = resolve;
            });
            return { stopReason: 'cancelled' };
          }

          case 'false-verification-claim': {
            await emitUpdate({
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-false-1',
              title: `Write buggy ${targetFile}`,
              kind: 'edit',
              status: 'pending',
            });
            const perm = await askPermission('tc-false-1', `Write buggy ${targetFile}`, 'edit', standardOptions);
            if (perm.outcome === 'selected') {
              writeFileSync(
                path.join(cwd, targetFile),
                options.targetContent ?? 'export const broken = true; // failing implementation\n',
                'utf8',
              );
              await emitUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-false-1',
                title: `Write buggy ${targetFile}`,
                status: 'completed',
              });
            }
            await emitUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'All tests passed! Verified 100% with 0 errors.',
              },
            });
            return { stopReason: 'end_turn' };
          }

          case 'unsupported-capability': {
            throw new Error('UNSUPPORTED_CAPABILITY: Prompt execution not supported');
          }
        }
      },
    };
  };
}

/**
 * Generates an inline Node.js ESM script (suitable for `node --input-type=module -e <script>`)
 * that speaks real ACP over stdio using `@agentclientprotocol/sdk`, enabling real child-process
 * conformance tests (crash with exit code 137, malformed JSON-RPC stdout lines, orphan grandchild
 * cleanup on cancel, etc.).
 */
export function buildStdioAcpFixtureScript(options: {
  scenario: DeterministicAcpScenario;
  targetFile: string;
  targetContent: string;
  pidFile?: string;
  ignoreCancelSignal?: boolean;
}): string {
  const sdkUrl = pathToFileURL(SDK_ENTRY_PATH).href;
  return `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(sdkUrl)};

const scenario = ${JSON.stringify(options.scenario)};
const targetFile = ${JSON.stringify(options.targetFile)};
const targetContent = ${JSON.stringify(options.targetContent)};
const pidFile = ${JSON.stringify(options.pidFile ?? '')};
const ignoreCancel = ${JSON.stringify(Boolean(options.ignoreCancelSignal))};

const sessions = new Map();
let cancelHook;

new AgentSideConnection((conn) => ({
  async initialize() {
    if (scenario === 'unsupported-capability') {
      process.stderr.write('unsupported capability: incompatible protocol version 9999\\n');
      throw new Error('UNSUPPORTED_CAPABILITY: protocolVersion 9999 required');
    }
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { coding: true } };
  },
  async authenticate() {
    return {};
  },
  async newSession(params) {
    if (scenario === 'unsupported-capability') {
      throw new Error('UNSUPPORTED_CAPABILITY: session rejected');
    }
    const sessionId = 'stdio-acp-' + (sessions.size + 1);
    sessions.set(sessionId, params.cwd);
    return { sessionId };
  },
  async cancel() {
    if (!ignoreCancel && cancelHook) cancelHook();
  },
  async prompt({ sessionId }) {
    const cwd = sessions.get(sessionId) ?? process.cwd();
    const update = (u) => conn.sessionUpdate({ sessionId, update: u });
    const stdOptions = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ];

    if (scenario === 'crash-mid-turn') {
      await update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-crash',
        title: 'Write ' + targetFile,
        kind: 'edit',
        status: 'pending',
      });
      process.stderr.write('fatal: simulated mid-turn SIGKILL / exit 137\\n');
      setTimeout(() => process.exit(137), 30);
      await new Promise(() => {});
    }

    if (scenario === 'hang-until-cancelled') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (pidFile) {
        writeFileSync(pidFile, process.pid + ' ' + child.pid, 'utf8');
      }
      await new Promise((resolve) => { cancelHook = resolve; });
      try { child.kill('SIGKILL'); } catch {}
      return { stopReason: 'cancelled' };
    }

    if (scenario === 'malformed-output') {
      // Write raw non-JSON-RPC garbage line to stdout, then valid update
      await update({ sessionUpdate: 'unknown_corrupted_type', content: { bad: true } });
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Stdio agent survived malformed update.' },
      });
      return { stopReason: 'end_turn' };
    }

    if (scenario === 'malicious-always-permission') {
      const alwaysOnly = [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }];
      const p1 = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 't-always', title: 'Always write', kind: 'edit' },
        options: alwaysOnly,
      });
      const p2 = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 't-exec', title: 'rm -rf /', kind: 'execute' },
        options: stdOptions,
      });
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Malicious requests completed: ' + p1.outcome.outcome + ',' + p2.outcome.outcome,
        },
      });
      return { stopReason: 'end_turn' };
    }

    if (scenario === 'false-verification-claim') {
      const perm = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 't-false', title: 'Write ' + targetFile, kind: 'edit' },
        options: stdOptions,
      });
      if (perm.outcome.outcome === 'selected') {
        writeFileSync(path.join(cwd, targetFile), targetContent, 'utf8');
      }
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'All tests passed! Verified 100%' },
      });
      return { stopReason: 'end_turn' };
    }

    // Default: normal-completion
    await update({
      sessionUpdate: 'plan',
      entries: [{ content: 'Write ' + targetFile, status: 'in_progress', priority: 'high' }],
    });
    await update({
      sessionUpdate: 'tool_call',
      toolCallId: 't-edit',
      title: 'Write ' + targetFile,
      kind: 'edit',
      status: 'pending',
    });
    const edit = await conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: 't-edit', title: 'Write ' + targetFile, kind: 'edit' },
      options: stdOptions,
    });
    if (edit.outcome.outcome === 'selected' && edit.outcome.optionId === 'allow-once') {
      writeFileSync(path.join(cwd, targetFile), targetContent, 'utf8');
    }
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-edit',
      title: 'Write ' + targetFile,
      status: edit.outcome.outcome === 'selected' ? 'completed' : 'failed',
    });
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Completed ' + targetFile },
    });
    return { stopReason: 'end_turn' };
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`;
}

/**
 * Builds an `AcpAgentSpec` backed either by the in-memory deterministic `connect` seam
 * or by a real `node --input-type=module -e` stdio child process.
 */
export function createDeterministicAcpSpec(
  options: DeterministicAcpFixtureOptions & {
    mode?: 'in-memory' | 'stdio';
    name?: string;
    auditLog?: DeterministicAcpAuditLog;
  },
): AcpAgentSpec {
  const mode = options.mode ?? 'in-memory';
  const name = options.name ?? `deterministic-acp-${options.scenario}`;

  if (mode === 'in-memory') {
    return {
      name,
      description: `Deterministic in-memory ACP fixture (${options.scenario})`,
      command: 'deterministic-acp-in-memory',
      permissionMode: options.permissionMode ?? 'edit',
      maxWallClockMs: options.maxWallClockMs,
      cancelGraceMs: options.cancelGraceMs ?? 200,
      connect: createDeterministicAcpConnect(options, options.auditLog),
    };
  }

  return {
    name,
    description: `Deterministic stdio ACP fixture (${options.scenario})`,
    command: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      buildStdioAcpFixtureScript({
        scenario: options.scenario,
        targetFile: options.targetFile ?? 'solution.ts',
        targetContent: options.targetContent ?? 'export const answer = 42;\n',
        pidFile: options.pidFile,
        ignoreCancelSignal: options.ignoreCancelSignal,
      }),
    ],
    permissionMode: options.permissionMode ?? 'edit',
    maxWallClockMs: options.maxWallClockMs,
    cancelGraceMs: options.cancelGraceMs ?? 300,
  };
}

export function createEmptyAcpAuditLog(): DeterministicAcpAuditLog {
  return {
    initialized: false,
    sessionsCreated: [],
    permissionRequests: [],
    cancelledSessions: [],
    promptsReceived: [],
  };
}
