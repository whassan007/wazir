import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KeyValueStore } from '@wazir/shared';
import {
  DEFAULT_MAX_DELEGATION_DEPTH,
  type AgentHandoffInput,
  type AgentHelpRequestInput,
  type AgentMessagingClient,
  type AgentNackOptions,
  type AgentReceiveOptions,
  type AgentSendInput,
  type AgentShareErrorInput,
  type CoordinationEventEnvelope,
  type CoordinationEventFilter,
  type CoordinationEventType,
  type InboxMessage,
} from '../types/coordination.js';
import type { JobMessage } from '../types/job.js';
import type { CoordinationFabric } from './coordinationFabric.js';
import type { DelegatedPolicyGate } from './delegatedPolicyGate.js';
import type { JobManager } from './jobManager.js';

const LOCK_RETRY_DELAY_MS = 5;
const LOCK_MAX_WAIT_MS = 10_000;
const LOCK_STALE_AFTER_MS = 30_000;
const DEFAULT_MAX_DELIVERIES = 5;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;
const DEFAULT_REPLAY_WINDOW_SIZE = 10_000;
const DEFAULT_MAX_INBOX_SIZE = 4096;

export class InboxBackpressureError extends Error {
  readonly code = 'INBOX_BACKPRESSURE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InboxBackpressureError';
  }
}

export class MessageAuthorizationError extends Error {
  readonly code = 'UNAUTHORIZED_MESSAGE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MessageAuthorizationError';
  }
}

export class MessageLoopError extends Error {
  readonly code = 'MESSAGE_LOOP_DETECTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MessageLoopError';
  }
}

export class MessageReplayError extends Error {
  readonly code = 'MESSAGE_REPLAY_DETECTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MessageReplayError';
  }
}

function safeSegment(value: string): string {
  if (!value) return '_empty_';
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (clean === value && clean.length <= 80) return clean;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const prefix = clean.slice(0, 48) || 'id';
  return `${prefix}_${digest}`;
}

async function inspectForeignHolder(lockFile: string): Promise<{ livePid?: number; deadForeignPid?: number }> {
  const content = await fs.readFile(lockFile, 'utf8').catch(() => '');
  if (!content.includes('\n')) return {};
  const pid = Number.parseInt(content.split('\n')[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return {};
  try {
    process.kill(pid, 0);
    return { livePid: pid };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? { livePid: pid } : { deadForeignPid: pid };
  }
}

const inProcessQueues = new Map<string, Promise<unknown>>();

function serializeInProcess<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inProcessQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => {
      if (inProcessQueues.get(key) === settled) inProcessQueues.delete(key);
    },
    () => {
      if (inProcessQueues.get(key) === settled) inProcessQueues.delete(key);
    },
  );
  inProcessQueues.set(key, settled);
  return next;
}

async function withFileLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  return serializeInProcess(lockFile, async () => {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    const token = `${process.pid}\n${new Date().toISOString()}\n${randomBytes(8).toString('hex')}\n`;

    for (;;) {
      try {
        const handle = await fs.open(lockFile, 'wx', 0o600);
        await handle.writeFile(token);
        await handle.close();
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        const staleSince = await fs.stat(lockFile).then((s) => s.mtimeMs).catch(() => undefined);
        const old = staleSince !== undefined && Date.now() - staleSince > LOCK_STALE_AFTER_MS;
        const holder = await inspectForeignHolder(lockFile);
        if (holder.deadForeignPid !== undefined || (old && holder.livePid === undefined)) {
          const stolen = `${lockFile}.stale.${process.pid}.${Date.now()}`;
          const won = await fs.rename(lockFile, stolen).then(() => true).catch(() => false);
          if (won) {
            await fs.unlink(stolen).catch(() => undefined);
            continue;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for inbox lock '${lockFile}'`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
      }
    }

    try {
      return await fn();
    } finally {
      const current = await fs.readFile(lockFile, 'utf8').catch(() => undefined);
      if (current === token) {
        await fs.unlink(lockFile).catch(() => undefined);
      }
    }
  });
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export interface MessageRouterOptions {
  fabric: CoordinationFabric;
  jobManager?: JobManager;
  policyGate?: DelegatedPolicyGate;
  fabricDir?: string;
  store?: KeyValueStore;
  maxDelegationDepth?: number;
  maxDeliveries?: number;
  maxInboxSize?: number;
  defaultVisibilityTimeoutMs?: number;
  replayWindowSize?: number;
  requireExplicitWorkflowAuth?: boolean;
  now?: () => number;
}

export interface WorkflowAuthorizationOptions {
  trustedControl?: boolean;
}

export interface RouteMessageInput<TPayload = Record<string, unknown>> {
  eventId?: string;
  workflowId: string;
  taskId?: string;
  fromAgent?: string;
  toAgent: string;
  type?: CoordinationEventType;
  payload: TPayload;
  correlationId?: string;
  causationId?: string;
  artifactRefs?: string[];
  fencingToken?: number;
  idempotencyKey?: string;
  delegationDepth?: number;
  causationChain?: string[];
  trustedControl?: boolean;
  controlAction?: string;
  sequence?: number;
  controlSequence?: number;
  nonce?: string;
  controlNonce?: string;
  approvalId?: string;
  authorizedWorkflows?: string[];
  maxDeliveries?: number;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  durable?: boolean;
}

export interface ReceiveInboxOptions {
  limit?: number;
  visibilityTimeoutMs?: number;
  types?: CoordinationEventType[];
  workflowId?: string;
}

export interface NackInboxOptions {
  error?: string;
  reason?: string;
  delayMs?: number;
}

export interface AgentClientOptions {
  workflowId: string;
  taskId?: string;
  agentId: string;
  fencingToken?: number;
  trustedControl?: boolean;
}

interface WorkflowAuthGrant {
  trustedControl?: boolean;
}

interface RouterReplayState {
  seenEventIds: string[];
  seenIdempotencyKeys: string[];
  seenControlNonces: string[];
  lastControlSequences: Record<string, number>;
}

const PRIORITY_WEIGHT: Record<'low' | 'normal' | 'high' | 'critical', number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export class MessageRouter {
  private readonly fabric: CoordinationFabric;
  private readonly jobManager?: JobManager;
  private readonly policyGate?: DelegatedPolicyGate;
  private readonly fabricDir?: string;
  private readonly inboxesDir?: string;
  private readonly store?: KeyValueStore;
  private readonly maxDelegationDepth: number;
  private readonly maxDeliveries: number;
  private readonly maxInboxSize: number;
  private readonly defaultVisibilityTimeoutMs: number;
  private readonly replayWindowSize: number;
  private readonly requireExplicitWorkflowAuth: boolean;
  private readonly now: () => number;

  private readonly agentWorkflowAcls = new Map<string, Map<string, WorkflowAuthGrant>>();
  private readonly workflowsWithAcl = new Set<string>();
  private readonly inMemoryInboxes = new Map<string, InboxMessage[]>();
  private readonly inMemoryReplayState: RouterReplayState = {
    seenEventIds: [],
    seenIdempotencyKeys: [],
    seenControlNonces: [],
    lastControlSequences: {},
  };

  constructor(options: MessageRouterOptions) {
    this.fabric = options.fabric;
    this.jobManager = options.jobManager;
    this.policyGate = options.policyGate;
    this.fabricDir = options.fabricDir ? path.resolve(options.fabricDir) : options.fabric.getFabricDir();
    this.inboxesDir = this.fabricDir ? path.join(this.fabricDir, 'inboxes') : undefined;
    this.store = options.store ?? options.fabric.getStore();
    this.maxDelegationDepth = options.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
    this.maxDeliveries = Math.max(1, options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES);
    this.maxInboxSize = Math.max(1, options.maxInboxSize ?? DEFAULT_MAX_INBOX_SIZE);
    this.defaultVisibilityTimeoutMs = Math.max(1, options.defaultVisibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS);
    this.replayWindowSize = Math.max(16, options.replayWindowSize ?? DEFAULT_REPLAY_WINDOW_SIZE);
    this.requireExplicitWorkflowAuth = options.requireExplicitWorkflowAuth ?? false;
    this.now = options.now ?? Date.now;
  }

  authorizeAgentWorkflow(agentId: string, workflowId: string, options: WorkflowAuthorizationOptions = {}): void {
    if (!agentId || !workflowId) {
      throw new MessageAuthorizationError('agentId and workflowId are required for authorization');
    }
    let agentMap = this.agentWorkflowAcls.get(agentId);
    if (!agentMap) {
      agentMap = new Map();
      this.agentWorkflowAcls.set(agentId, agentMap);
    }
    agentMap.set(workflowId, { trustedControl: options.trustedControl });
    this.workflowsWithAcl.add(workflowId);
  }

  revokeAgentWorkflow(agentId: string, workflowId: string): void {
    const agentMap = this.agentWorkflowAcls.get(agentId);
    if (agentMap) {
      agentMap.delete(workflowId);
    }
    // Keep workflowId in workflowsWithAcl and agentId in agentWorkflowAcls so revoked agents stay denied.
    if (!agentMap) {
      this.agentWorkflowAcls.set(agentId, new Map());
    }
    this.workflowsWithAcl.add(workflowId);
  }

  isAgentAuthorized(agentId: string, workflowId: string): boolean {
    const agentMap = this.agentWorkflowAcls.get(agentId);
    if (agentMap && agentMap.has(workflowId)) {
      return true;
    }
    if (this.requireExplicitWorkflowAuth || this.workflowsWithAcl.has(workflowId) || this.agentWorkflowAcls.has(agentId)) {
      return false;
    }
    return true;
  }

  private assertAgentWorkflowAccess(agentId: string | undefined, workflowId: string, authorizedWorkflows?: string[]): void {
    if (authorizedWorkflows !== undefined && !authorizedWorkflows.includes(workflowId)) {
      throw new MessageAuthorizationError(
        `Sender '${agentId ?? 'unknown'}' is not authorized for workflow '${workflowId}'`,
      );
    }
    const mustCheckAcl =
      this.requireExplicitWorkflowAuth ||
      this.workflowsWithAcl.has(workflowId) ||
      (agentId !== undefined && this.agentWorkflowAcls.has(agentId));

    if (!mustCheckAcl) return;

    if (!agentId) {
      throw new MessageAuthorizationError(`Anonymous sender is not authorized for workflow '${workflowId}'`);
    }
    const grant = this.agentWorkflowAcls.get(agentId)?.get(workflowId);
    if (!grant) {
      throw new MessageAuthorizationError(`Agent '${agentId}' is not authorized for workflow '${workflowId}'`);
    }
  }

  private assertControlAuthorized(input: RouteMessageInput): boolean {
    const payloadObj =
      input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : undefined;
    const controlAction =
      input.controlAction ??
      (typeof payloadObj?.controlAction === 'string' ? payloadObj.controlAction : undefined);
    const isControl = input.type === 'control.command' || controlAction !== undefined;
    if (!isControl) return false;

    const grant = input.fromAgent ? this.agentWorkflowAcls.get(input.fromAgent)?.get(input.workflowId) : undefined;

    // 1. Check DelegatedPolicyGate if available
    if (this.policyGate && input.fromAgent) {
      const candidates = controlAction
        ? [
            { agentId: input.fromAgent, tool: controlAction, approvalId: input.approvalId },
            { agentId: input.fromAgent, tool: 'control.command', capability: controlAction, approvalId: input.approvalId },
            { agentId: input.fromAgent, tool: 'control.command', capability: 'control', approvalId: input.approvalId },
          ]
        : [
            { agentId: input.fromAgent, tool: 'control.command', approvalId: input.approvalId },
            { agentId: input.fromAgent, tool: 'control.command', capability: 'control', approvalId: input.approvalId },
          ];
      for (const action of candidates) {
        const decision = this.policyGate.evaluate(action);
        if (decision.allowed) {
          return true;
        }
      }
    }

    // 2. Explicit denial in workflow ACL overrides caller flag
    if (grant && grant.trustedControl === false) {
      throw new MessageAuthorizationError(
        `Agent '${input.fromAgent}' is denied trusted control in workflow '${input.workflowId}'`,
      );
    }

    // 3. Explicit trustedControl in workflow ACL or trusted system call
    if (grant?.trustedControl === true || input.trustedControl === true) {
      return true;
    }

    throw new MessageAuthorizationError(
      `Unauthorized control command '${controlAction ?? 'control.command'}' from '${input.fromAgent ?? 'unknown'}'`,
    );
  }

  private assertAntiLoop(input: RouteMessageInput): string[] {
    if (input.fromAgent && input.toAgent && input.fromAgent === input.toAgent) {
      throw new MessageLoopError(`Direct message loop detected: '${input.fromAgent}' cannot message itself`);
    }

    const incomingChain = [...(input.causationChain ?? [])];
    if (incomingChain.includes(input.toAgent)) {
      throw new MessageLoopError(
        `Causation loop detected: target '${input.toAgent}' already appears in causation chain [${incomingChain.join(' -> ')}]`,
      );
    }

    const depth = input.delegationDepth ?? 0;
    if (!Number.isInteger(depth) || depth < 0 || depth > this.maxDelegationDepth) {
      throw new MessageLoopError(
        `Delegation depth ${depth} exceeds maxDelegationDepth (${this.maxDelegationDepth})`,
      );
    }

    if (input.fromAgent && !incomingChain.includes(input.fromAgent)) {
      incomingChain.push(input.fromAgent);
    }
    return incomingChain;
  }

  private async checkAndRecordReplay(input: RouteMessageInput, eventId: string): Promise<void> {
    const payloadObj =
      input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : undefined;
    const controlAction =
      input.controlAction ??
      (typeof payloadObj?.controlAction === 'string' ? payloadObj.controlAction : undefined);
    const isControl = input.type === 'control.command' || controlAction !== undefined;
    const controlSeq =
      input.controlSequence ??
      input.sequence ??
      (typeof payloadObj?.controlSequence === 'number'
        ? payloadObj.controlSequence
        : typeof payloadObj?.sequence === 'number'
          ? payloadObj.sequence
          : undefined);
    const controlNonce =
      input.controlNonce ??
      input.nonce ??
      (typeof payloadObj?.controlNonce === 'string'
        ? payloadObj.controlNonce
        : typeof payloadObj?.nonce === 'string'
          ? payloadObj.nonce
          : undefined);

    const mutateReplayState = (state: RouterReplayState): RouterReplayState => {
      if (state.seenEventIds.includes(eventId)) {
        throw new MessageReplayError(`Duplicate eventId '${eventId}' rejected`);
      }

      if (input.idempotencyKey && state.seenIdempotencyKeys.includes(input.idempotencyKey)) {
        throw new MessageReplayError(`Duplicate idempotencyKey '${input.idempotencyKey}' rejected`);
      }

      if (isControl) {
        if (controlNonce !== undefined) {
          const nonceKey = `${input.workflowId}\0${controlAction ?? 'control.command'}\0${controlNonce}`;
          if (state.seenControlNonces.includes(nonceKey)) {
            throw new MessageReplayError(`Replayed control nonce '${controlNonce}' rejected`);
          }
          pushBounded(state.seenControlNonces, nonceKey, this.replayWindowSize);
        }

        if (controlSeq !== undefined) {
          if (!Number.isFinite(controlSeq)) {
            throw new MessageReplayError('Control sequence must be a finite number');
          }
          const seqKey = `${input.workflowId}\0${input.fromAgent ?? ''}\0${controlAction ?? 'control.command'}`;
          const prevSeq = state.lastControlSequences[seqKey];
          if (prevSeq !== undefined && controlSeq <= prevSeq) {
            throw new MessageReplayError(
              `Replayed or stale control sequence ${controlSeq} <= ${prevSeq} for '${controlAction ?? 'control.command'}'`,
            );
          }
          state.lastControlSequences[seqKey] = controlSeq;
        }
      }

      pushBounded(state.seenEventIds, eventId, this.replayWindowSize);
      if (input.idempotencyKey) {
        pushBounded(state.seenIdempotencyKeys, input.idempotencyKey, this.replayWindowSize);
      }
      return state;
    };

    if (this.inboxesDir) {
      const stateFile = path.join(this.inboxesDir, '_router_state.json');
      const lockFile = `${stateFile}.lock`;
      await withFileLock(lockFile, async () => {
        const current = await readJsonFile<RouterReplayState>(stateFile, createEmptyReplayState);
        const next = mutateReplayState(current);
        await writeFileAtomic(stateFile, JSON.stringify(next));
      });
      return;
    }

    if (this.store?.update) {
      await this.store.update<RouterReplayState>('coord/router-state', (current) =>
        mutateReplayState(current ? cloneReplayState(current) : createEmptyReplayState()),
      );
      return;
    }

    await serializeInProcess('router:memory-replay', async () => {
      mutateReplayState(this.inMemoryReplayState);
    });
  }

  async send<TPayload = Record<string, unknown>>(
    input: RouteMessageInput<TPayload>,
  ): Promise<CoordinationEventEnvelope<TPayload>> {
    if (!input.workflowId || !input.toAgent) {
      throw new MessageAuthorizationError('workflowId and toAgent are required');
    }

    // 1. Authorization & ACL checks
    this.assertAgentWorkflowAccess(input.fromAgent, input.workflowId, input.authorizedWorkflows);
    if (this.agentWorkflowAcls.has(input.toAgent)) {
      this.assertAgentWorkflowAccess(input.toAgent, input.workflowId);
    }
    const isTrustedControl = this.assertControlAuthorized(input as RouteMessageInput);

    // 2. Anti-loop & delegation depth checks
    const nextChain = this.assertAntiLoop(input as RouteMessageInput);

    // 3. Replay & deduplication checks
    const eventId = input.eventId ?? `evt-${randomUUID()}`;
    await this.checkAndRecordReplay(input as RouteMessageInput, eventId);

    const payloadWithMeta =
      input.priority &&
      input.payload &&
      typeof input.payload === 'object' &&
      !Array.isArray(input.payload) &&
      !('priority' in (input.payload as Record<string, unknown>))
        ? { ...(input.payload as Record<string, unknown>), priority: input.priority }
        : input.payload;

    // 4. Publish onto CoordinationFabric (which validates envelope + offloads large payloads + persists event/outbox)
    const envelope = await this.fabric.publish(
      {
        event_id: eventId,
        type: input.type ?? 'agent.message',
        workflow_id: input.workflowId,
        task_id: input.taskId,
        source_agent: input.fromAgent,
        target_agent: input.toAgent,
        correlation_id: input.correlationId ?? eventId,
        causation_id: input.causationId,
        payload: payloadWithMeta as TPayload,
        artifact_refs: input.artifactRefs ?? [],
        fencing_token: input.fencingToken,
        idempotency_key: input.idempotencyKey,
        delegation_depth: input.delegationDepth,
        causation_chain: nextChain.length > 0 ? nextChain : undefined,
        untrusted_peer_input: isTrustedControl ? false : true,
      },
      { durable: input.durable },
    );

    // 5. Enqueue into durable per-agent inbox (deduplicated)
    const inboxMessage: InboxMessage = {
      messageId: `msg-${randomUUID()}`,
      envelope: envelope as CoordinationEventEnvelope,
      status: 'queued',
      recipientAgent: input.toAgent,
      attempts: 0,
      maxDeliveries: Math.max(1, input.maxDeliveries ?? this.maxDeliveries),
      visibleAt: this.now(),
    };
    await this.mutateAgentInbox(input.toAgent, (messages) => {
      const duplicate = messages.some(
        (existing) =>
          existing.envelope.event_id === envelope.event_id ||
          (envelope.idempotency_key !== undefined && existing.envelope.idempotency_key === envelope.idempotency_key),
      );
      if (!duplicate) {
        let activeCount = messages.filter((m) => m.status === 'queued' || m.status === 'delivered').length;
        if (messages.length >= this.maxInboxSize) {
          const activeOnly = messages.filter((m) => m.status === 'queued' || m.status === 'delivered');
          messages.length = 0;
          messages.push(...activeOnly);
          activeCount = messages.length;
        }
        if (activeCount >= this.maxInboxSize) {
          throw new InboxBackpressureError(
            `Agent '${input.toAgent}' inbox capacity exceeded (${this.maxInboxSize} active messages)`,
          );
        }
        messages.push(inboxMessage);
      }
      return messages;
    });

    // 6. Optional JobManager mirroring
    if (this.jobManager && this.jobManager.get(input.workflowId)) {
      const jobMsg = toJobMessage(envelope as CoordinationEventEnvelope, input.priority ?? 'normal');
      await this.jobManager.addMessage(input.workflowId, jobMsg).catch(() => undefined);
    }

    return envelope;
  }

  async receive(agentId: string, options: ReceiveInboxOptions = {}): Promise<InboxMessage[]> {
    const nowMs = this.now();
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const visibilityTimeoutMs = Math.max(1, options.visibilityTimeoutMs ?? this.defaultVisibilityTimeoutMs);
    const typeFilter = options.types ? new Set(options.types) : undefined;
    const received: InboxMessage[] = [];
    const deadLettered: InboxMessage[] = [];

    await this.mutateAgentInbox(agentId, (messages) => {
      // First expire any timed-out delivered messages
      for (const msg of messages) {
        if (msg.status === 'delivered' && msg.visibleAt <= nowMs) {
          if (msg.attempts >= msg.maxDeliveries) {
            msg.status = 'dead_letter';
            msg.lastError = msg.lastError ?? 'max deliveries exceeded';
            deadLettered.push(structuredClone(msg));
          } else {
            msg.status = 'queued';
            msg.visibleAt = nowMs;
          }
        }
      }

      // Order eligible queued messages by priority then visibility
      const eligible = messages
        .filter((msg) => {
          if (msg.status !== 'queued' || msg.visibleAt > nowMs) return false;
          if (options.workflowId && msg.envelope.workflow_id !== options.workflowId) return false;
          if (typeFilter && !typeFilter.has(msg.envelope.type)) return false;
          return true;
        })
        .sort((a, b) => {
          const pa = extractPriorityWeight(a.envelope);
          const pb = extractPriorityWeight(b.envelope);
          if (pa !== pb) return pb - pa;
          return a.visibleAt - b.visibleAt;
        });

      for (const msg of eligible) {
        if (received.length >= limit) break;
        msg.status = 'delivered';
        msg.attempts += 1;
        msg.deliveredAt = nowMs;
        msg.visibleAt = nowMs + visibilityTimeoutMs;
        received.push(structuredClone(msg));
      }
      return messages;
    });

    for (const dl of deadLettered) {
      await this.fabric.recordDeadLetter(dl.envelope, dl.lastError ?? 'max deliveries exceeded', dl.attempts, dl.messageId);
    }

    return received;
  }

  async ack(agentId: string, messageId: string): Promise<InboxMessage | undefined> {
    const nowMs = this.now();
    let acked: InboxMessage | undefined;
    await this.mutateAgentInbox(agentId, (messages) => {
      const msg = messages.find((m) => m.messageId === messageId);
      if (msg && msg.status !== 'dead_letter') {
        msg.status = 'acked';
        msg.ackedAt = msg.ackedAt ?? nowMs;
        acked = structuredClone(msg);
      }
      return messages;
    });
    return acked;
  }

  async nack(
    agentId: string,
    messageId: string,
    options: NackInboxOptions | string = {},
  ): Promise<InboxMessage | undefined> {
    const opts: NackInboxOptions = typeof options === 'string' ? { error: options } : options;
    const nowMs = this.now();
    const errorMsg = opts.error ?? opts.reason ?? 'nacked by consumer';
    const delayMs = Math.max(0, opts.delayMs ?? 0);

    let updated: InboxMessage | undefined;
    let movedToDlq: InboxMessage | undefined;

    await this.mutateAgentInbox(agentId, (messages) => {
      const msg = messages.find((m) => m.messageId === messageId);
      if (!msg || msg.status === 'acked') return messages;

      msg.lastError = errorMsg;
      if (msg.attempts >= msg.maxDeliveries) {
        msg.status = 'dead_letter';
        movedToDlq = structuredClone(msg);
      } else {
        msg.status = 'queued';
        msg.visibleAt = nowMs + delayMs;
      }
      updated = structuredClone(msg);
      return messages;
    });

    if (movedToDlq) {
      await this.fabric.recordDeadLetter(movedToDlq.envelope, errorMsg, movedToDlq.attempts, movedToDlq.messageId);
    }

    return updated;
  }

  async redeliverExpired(agentId?: string): Promise<InboxMessage[]> {
    const agentIds = agentId ? [agentId] : await this.listKnownInboxAgents();
    const nowMs = this.now();
    const affected: InboxMessage[] = [];
    const deadLettered: InboxMessage[] = [];

    for (const targetAgent of agentIds) {
      await this.mutateAgentInbox(targetAgent, (messages) => {
        for (const msg of messages) {
          if (msg.status === 'delivered' && msg.visibleAt <= nowMs) {
            if (msg.attempts >= msg.maxDeliveries) {
              msg.status = 'dead_letter';
              msg.lastError = msg.lastError ?? 'visibility lease expired at max deliveries';
              const snap = structuredClone(msg);
              affected.push(snap);
              deadLettered.push(snap);
            } else {
              msg.status = 'queued';
              msg.visibleAt = nowMs;
              affected.push(structuredClone(msg));
            }
          }
        }
        return messages;
      });
    }

    for (const dl of deadLettered) {
      await this.fabric.recordDeadLetter(dl.envelope, dl.lastError ?? 'max deliveries exceeded', dl.attempts, dl.messageId);
    }

    return affected;
  }

  async listMessages(
    workflowId?: string,
    options: { agentId?: string; status?: InboxMessage['status'] } = {},
  ): Promise<InboxMessage[]> {
    const agentIds = options.agentId ? [options.agentId] : await this.listKnownInboxAgents();
    const all: InboxMessage[] = [];

    for (const agent of agentIds) {
      const messages = await this.readAgentInbox(agent);
      for (const msg of messages) {
        if (workflowId !== undefined && msg.envelope.workflow_id !== workflowId) continue;
        if (options.status !== undefined && msg.status !== options.status) continue;
        all.push(msg);
      }
    }

    return all.sort((a, b) => a.envelope.timestamp.localeCompare(b.envelope.timestamp));
  }

  createAgentClient(clientOptions: AgentClientOptions): AgentMessagingClient {
    const { workflowId, taskId, agentId, fencingToken, trustedControl } = clientOptions;
    const router = this;

    return {
      agentId,
      workflowId,
      taskId,

      async send<TPayload = Record<string, unknown>>(
        input: AgentSendInput<TPayload>,
      ): Promise<CoordinationEventEnvelope<TPayload>> {
        return router.send({
          workflowId,
          taskId: input.taskId ?? taskId,
          fromAgent: agentId,
          toAgent: input.toAgent,
          type: input.type,
          payload: input.payload,
          correlationId: input.correlationId,
          causationId: input.causationId,
          artifactRefs: input.artifactRefs,
          idempotencyKey: input.idempotencyKey,
          causationChain: input.causationChain,
          delegationDepth: input.delegationDepth,
          fencingToken,
          priority: input.priority,
          controlAction: input.controlAction,
          trustedControl: trustedControl === true ? input.trustedControl ?? true : false,
          sequence: input.sequence,
          nonce: input.nonce,
          approvalId: input.approvalId,
        });
      },

      async receive(options: AgentReceiveOptions = {}): Promise<InboxMessage[]> {
        return router.receive(agentId, {
          limit: options.limit,
          visibilityTimeoutMs: options.visibilityTimeoutMs,
          types: options.types,
          workflowId: options.allWorkflows ? undefined : options.workflowId ?? workflowId,
        });
      },

      async ack(messageId: string): Promise<InboxMessage | undefined> {
        return router.ack(agentId, messageId);
      },

      async nack(messageId: string, options?: AgentNackOptions | string): Promise<InboxMessage | undefined> {
        return router.nack(agentId, messageId, options);
      },

      subscribe(
        handler: (event: CoordinationEventEnvelope) => void | Promise<void>,
        filter?: CoordinationEventFilter | string,
      ): () => void {
        if (filter === undefined) {
          return router.fabric.subscribe({ workflowId, targetAgent: agentId }, handler);
        }
        if (typeof filter === 'string') {
          return router.fabric.subscribe(filter, (event) => {
            if (event.workflow_id !== workflowId) return;
            return handler(event);
          });
        }
        return router.fabric.subscribe({ workflowId, ...filter }, handler);
      },

      async publishProgress<TPayload = Record<string, unknown>>(
        payload: TPayload,
        options?: {
          taskId?: string;
          targetAgent?: string;
          correlationId?: string;
          causationId?: string;
          artifactRefs?: string[];
        },
      ): Promise<CoordinationEventEnvelope<TPayload>> {
        router.assertAgentWorkflowAccess(agentId, workflowId);
        return router.fabric.publish({
          type: 'task.progress',
          workflow_id: workflowId,
          task_id: options?.taskId ?? taskId,
          source_agent: agentId,
          target_agent: options?.targetAgent,
          correlation_id: options?.correlationId,
          causation_id: options?.causationId,
          artifact_refs: options?.artifactRefs,
          fencing_token: fencingToken,
          payload,
        });
      },

      async requestHelp<TPayload = Record<string, unknown>>(
        input: AgentHelpRequestInput<TPayload>,
      ): Promise<CoordinationEventEnvelope<TPayload | Record<string, unknown>>> {
        const helpPayload: TPayload | Record<string, unknown> =
          input.payload !== undefined
            ? input.payload
            : {
                question: input.question ?? '',
                ...(input.reason ? { reason: input.reason } : {}),
              };
        return router.send<TPayload | Record<string, unknown>>({
          workflowId,
          taskId: input.taskId ?? taskId,
          fromAgent: agentId,
          toAgent: input.toAgent,
          type: 'agent.help_request',
          payload: helpPayload,
          correlationId: input.correlationId,
          causationId: input.causationId,
          artifactRefs: input.artifactRefs,
          causationChain: input.causationChain,
          delegationDepth: input.delegationDepth,
          idempotencyKey: input.idempotencyKey,
          fencingToken,
        });
      },

      async shareError(input: AgentShareErrorInput): Promise<CoordinationEventEnvelope> {
        const errorPayload = {
          error: typeof input.error === 'string' ? input.error : input.error.message,
          ...(input.error instanceof Error && input.error.name ? { errorName: input.error.name } : {}),
          ...(input.recoverable !== undefined ? { recoverable: input.recoverable } : {}),
          ...(input.details ? { details: input.details } : {}),
        };
        if (input.toAgent) {
          return router.send({
            workflowId,
            taskId: input.taskId ?? taskId,
            fromAgent: agentId,
            toAgent: input.toAgent,
            type: 'agent.error',
            payload: errorPayload,
            correlationId: input.correlationId,
            causationId: input.causationId,
            artifactRefs: input.artifactRefs,
            idempotencyKey: input.idempotencyKey,
            fencingToken,
          });
        }
        router.assertAgentWorkflowAccess(agentId, workflowId);
        return router.fabric.publish({
          type: 'agent.error',
          workflow_id: workflowId,
          task_id: input.taskId ?? taskId,
          source_agent: agentId,
          correlation_id: input.correlationId,
          causation_id: input.causationId,
          artifact_refs: input.artifactRefs,
          idempotency_key: input.idempotencyKey,
          fencing_token: fencingToken,
          payload: errorPayload,
        });
      },

      async handoff<TPayload = Record<string, unknown>>(
        input: AgentHandoffInput<TPayload>,
      ): Promise<CoordinationEventEnvelope<TPayload | Record<string, unknown>>> {
        const artifactRefs = input.artifactRefs ?? input.artifacts ?? [];
        const handoffPayload: TPayload | Record<string, unknown> =
          input.payload !== undefined
            ? input.payload
            : {
                summary: input.summary ?? '',
                artifacts: artifactRefs,
                evidenceRefs: input.evidenceRefs ?? [],
                changedFiles: input.changedFiles ?? [],
              };
        return router.send<TPayload | Record<string, unknown>>({
          workflowId,
          taskId: input.taskId ?? taskId,
          fromAgent: agentId,
          toAgent: input.toAgent,
          type: 'agent.handoff',
          payload: handoffPayload,
          correlationId: input.correlationId,
          causationId: input.causationId,
          artifactRefs,
          causationChain: input.causationChain,
          delegationDepth: input.delegationDepth,
          idempotencyKey: input.idempotencyKey,
          fencingToken,
        });
      },

      async loadArtifact(ref: string): Promise<unknown> {
        return router.fabric.loadArtifact(ref);
      },
    };
  }

  private inboxFilePath(agentId: string): string {
    return path.join(this.inboxesDir!, safeSegment(agentId), 'inbox.json');
  }

  private async mutateAgentInbox(
    agentId: string,
    mutate: (messages: InboxMessage[]) => InboxMessage[],
  ): Promise<InboxMessage[]> {
    if (this.inboxesDir) {
      const file = this.inboxFilePath(agentId);
      const lockFile = `${file}.lock`;
      return withFileLock(lockFile, async () => {
        const current = await readJsonFile<InboxMessage[]>(file, () => []);
        const next = mutate(current);
        await writeFileAtomic(file, JSON.stringify(next));
        return next;
      });
    }

    if (this.store?.update) {
      return this.store.update<InboxMessage[]>(`coord/inboxes/${agentId}`, (current) =>
        mutate(current ? structuredClone(current) : []),
      );
    }

    return serializeInProcess(`inbox:${agentId}`, async () => {
      const current = this.inMemoryInboxes.get(agentId) ?? [];
      const next = mutate(current);
      this.inMemoryInboxes.set(agentId, next);
      return next;
    });
  }

  private async readAgentInbox(agentId: string): Promise<InboxMessage[]> {
    if (this.inboxesDir) {
      return readJsonFile<InboxMessage[]>(this.inboxFilePath(agentId), () => []);
    }
    if (this.store) {
      return (await this.store.get<InboxMessage[]>(`coord/inboxes/${agentId}`)) ?? [];
    }
    return structuredClone(this.inMemoryInboxes.get(agentId) ?? []);
  }

  private async listKnownInboxAgents(): Promise<string[]> {
    if (this.inboxesDir) {
      let entries: string[];
      try {
        entries = await fs.readdir(this.inboxesDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const agents = new Set<string>();
      for (const dir of entries) {
        if (dir.startsWith('_') || dir.startsWith('.')) continue;
        const messages = await readJsonFile<InboxMessage[]>(path.join(this.inboxesDir, dir, 'inbox.json'), () => []);
        if (messages.length > 0 && messages[0].recipientAgent) {
          agents.add(messages[0].recipientAgent);
        } else {
          agents.add(dir);
        }
      }
      return Array.from(agents);
    }

    if (this.store) {
      const rows = await this.store.list('coord/inboxes/');
      return rows.map((r) => r.key.slice('coord/inboxes/'.length));
    }

    return Array.from(this.inMemoryInboxes.keys());
  }
}

export function createMessageRouter(options: MessageRouterOptions): MessageRouter {
  return new MessageRouter(options);
}

function createEmptyReplayState(): RouterReplayState {
  return {
    seenEventIds: [],
    seenIdempotencyKeys: [],
    seenControlNonces: [],
    lastControlSequences: {},
  };
}

function cloneReplayState(state: RouterReplayState): RouterReplayState {
  return {
    seenEventIds: [...(state.seenEventIds ?? [])],
    seenIdempotencyKeys: [...(state.seenIdempotencyKeys ?? [])],
    seenControlNonces: [...(state.seenControlNonces ?? [])],
    lastControlSequences: { ...(state.lastControlSequences ?? {}) },
  };
}

function pushBounded(arr: string[], item: string, maxLen: number): void {
  arr.push(item);
  if (arr.length > maxLen) {
    arr.splice(0, arr.length - maxLen);
  }
}

async function readJsonFile<T>(filePath: string, fallback: () => T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback();
    }
    if (err instanceof SyntaxError) {
      await fs.rename(filePath, `${filePath}.corrupt.${Date.now()}`).catch(() => undefined);
      return fallback();
    }
    throw err;
  }
}

function extractPriorityWeight(envelope: CoordinationEventEnvelope): number {
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const p = payload?.priority;
  if (p === 'critical' || p === 'high' || p === 'normal' || p === 'low') {
    return PRIORITY_WEIGHT[p];
  }
  return PRIORITY_WEIGHT.normal;
}

function toJobMessageType(type: CoordinationEventType): JobMessage['type'] {
  switch (type) {
    case 'agent.handoff':
      return 'handoff';
    case 'agent.help_request':
      return 'question';
    case 'agent.help_response':
      return 'review_result';
    case 'agent.error':
    case 'task.failed':
      return 'task_failure';
    case 'task.completed':
      return 'task_result';
    case 'task.scheduled':
      return 'task_assignment';
    case 'task.cancelled':
    case 'job.cancelled':
      return 'cancel';
    case 'task.dependency_ready':
      return 'dependency_ready';
    default:
      return 'task_update';
  }
}

function toJobMessage(envelope: CoordinationEventEnvelope, priority: JobMessage['priority']): JobMessage {
  return {
    id: envelope.event_id,
    jobId: envelope.workflow_id,
    taskId: envelope.task_id,
    fromAgent: envelope.source_agent,
    toAgent: envelope.target_agent,
    type: toJobMessageType(envelope.type),
    payload: envelope.payload,
    artifactReferences: envelope.artifact_refs,
    priority,
    timestamp: new Date(envelope.timestamp),
  };
}
