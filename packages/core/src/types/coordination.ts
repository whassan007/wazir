export const COORDINATION_SCHEMA_VERSION = '1.0' as const;
export const DEFAULT_MAX_INLINE_PAYLOAD_BYTES = 16_384;
export const DEFAULT_MAX_DELEGATION_DEPTH = 3;

export type KnownCoordinationEventType =
  | 'job.started'
  | 'job.completed'
  | 'job.failed'
  | 'job.cancelled'
  | 'job.paused'
  | 'job.resumed'
  | 'task.scheduled'
  | 'task.started'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.retry'
  | 'task.cancelled'
  | 'task.dependency_ready'
  | 'task.steered'
  | 'agent.message'
  | 'agent.help_request'
  | 'agent.help_response'
  | 'agent.handoff'
  | 'agent.error'
  | 'agent.evidence'
  | 'agent.heartbeat'
  | 'agent.registered'
  | 'resource.acquired'
  | 'resource.renewed'
  | 'resource.released'
  | 'resource.expired'
  | 'resource.conflict'
  | 'control.command'
  | 'fabric.dead_letter';

export type CoordinationEventType = KnownCoordinationEventType | (string & {});

export interface CoordinationEventEnvelope<TPayload = Record<string, unknown>> {
  event_id: string;
  schema_version: string;
  type: CoordinationEventType;
  workflow_id: string;
  task_id?: string;
  source_agent?: string;
  target_agent?: string;
  correlation_id: string;
  causation_id?: string;
  timestamp: string;
  payload: TPayload;
  artifact_refs: string[];
  fencing_token?: number;
  idempotency_key?: string;
  delegation_depth?: number;
  causation_chain?: string[];
  untrusted_peer_input?: boolean;
}

export type CoordinationTransportKind = 'in-process' | 'durable-local' | 'nats-core' | 'nats-jetstream';

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CoordinationTransportAdapter {
  readonly kind: CoordinationTransportKind;
  isConnected(): boolean;
  connect(timeoutMs?: number): Promise<void>;
  publishBatch(events: CoordinationEventEnvelope[]): Promise<void>;
  subscribe(handler: (event: CoordinationEventEnvelope) => void): Promise<() => void> | (() => void);
  close(): Promise<void>;
}

export interface ArtifactStoreAdapter {
  storeArtifact(input: { workflowId: string; taskId?: string; eventId: string; data: unknown }): Promise<string>;
  loadArtifact(ref: string): Promise<unknown>;
}

export interface OutboxEntry {
  id: string;
  envelope: CoordinationEventEnvelope;
  status: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InboxMessage {
  messageId: string;
  envelope: CoordinationEventEnvelope;
  status: 'queued' | 'delivered' | 'acked' | 'dead_letter';
  recipientAgent: string;
  attempts: number;
  maxDeliveries: number;
  visibleAt: number;
  deliveredAt?: number;
  ackedAt?: number;
  lastError?: string;
}

export interface ResourceLease {
  leaseId: string;
  workflowId: string;
  taskId: string;
  workerId: string;
  fencingToken: number;
  resourceKeys: string[];
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  status: 'active' | 'released' | 'expired';
  metadata?: Record<string, unknown>;
}

export interface FabricStatusReport {
  healthy: boolean;
  transport: CoordinationTransportKind;
  natsConfigured: boolean;
  natsConnected: boolean;
  circuitState: CircuitBreakerState;
  outboxPending: number;
  outboxDeadLetters: number;
  inboxPending: number;
  dlqCount: number;
  activeSubscriptions: number;
  staleConsumers: string[];
  consumerLag: number;
  activeLeases: number;
  totalEventsPublished: number;
  metrics: {
    publishLatencyMsP50?: number;
    publishLatencyMsP95?: number;
  };
}

export interface FabricDiagnosticsReport {
  ok: boolean;
  checkedAt: string;
  fabricDir?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    durationMs: number;
  }>;
  status: FabricStatusReport;
}

export interface CoordinationPublishInput<TPayload = Record<string, unknown>> {
  event_id?: string;
  eventId?: string;
  schema_version?: string;
  schemaVersion?: string;
  type: CoordinationEventType;
  workflow_id?: string;
  workflowId?: string;
  task_id?: string;
  taskId?: string;
  source_agent?: string;
  sourceAgent?: string;
  target_agent?: string;
  targetAgent?: string;
  correlation_id?: string;
  correlationId?: string;
  causation_id?: string;
  causationId?: string;
  timestamp?: string;
  payload?: TPayload;
  artifact_refs?: string[];
  artifactRefs?: string[];
  fencing_token?: number;
  fencingToken?: number;
  idempotency_key?: string;
  idempotencyKey?: string;
  delegation_depth?: number;
  delegationDepth?: number;
  causation_chain?: string[];
  causationChain?: string[];
  untrusted_peer_input?: boolean;
  untrustedPeerInput?: boolean;
}

export interface CoordinationEventFilter {
  workflowId?: string;
  taskId?: string;
  type?: CoordinationEventType | CoordinationEventType[];
  sourceAgent?: string;
  targetAgent?: string;
  agentId?: string;
  correlationId?: string;
  since?: string | number;
  until?: string | number;
  limit?: number;
}

export interface ConsumerInfo {
  consumerId: string;
  workflowId?: string;
  group?: string;
  lastHeartbeatAt: number;
  lastEventId?: string;
  lastEventTimestamp?: number;
  processedCount: number;
  registeredAt: number;
  metadata?: Record<string, unknown>;
}

export interface AgentSendInput<TPayload = Record<string, unknown>> {
  toAgent: string;
  type?: CoordinationEventType;
  payload: TPayload;
  taskId?: string;
  correlationId?: string;
  causationId?: string;
  artifactRefs?: string[];
  idempotencyKey?: string;
  causationChain?: string[];
  delegationDepth?: number;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  controlAction?: string;
  trustedControl?: boolean;
  sequence?: number;
  nonce?: string;
  approvalId?: string;
}

export interface AgentReceiveOptions {
  limit?: number;
  visibilityTimeoutMs?: number;
  types?: CoordinationEventType[];
  workflowId?: string;
  allWorkflows?: boolean;
}

export interface AgentNackOptions {
  error?: string;
  reason?: string;
  delayMs?: number;
}

export interface AgentHelpRequestInput<TPayload = Record<string, unknown>> {
  toAgent: string;
  question?: string;
  reason?: string;
  payload?: TPayload;
  taskId?: string;
  correlationId?: string;
  causationId?: string;
  artifactRefs?: string[];
  causationChain?: string[];
  delegationDepth?: number;
  idempotencyKey?: string;
}

export interface AgentShareErrorInput {
  error: string | Error;
  toAgent?: string;
  taskId?: string;
  details?: Record<string, unknown>;
  recoverable?: boolean;
  correlationId?: string;
  causationId?: string;
  artifactRefs?: string[];
  idempotencyKey?: string;
}

export interface AgentHandoffInput<TPayload = Record<string, unknown>> {
  toAgent: string;
  summary?: string;
  payload?: TPayload;
  artifacts?: string[];
  artifactRefs?: string[];
  evidenceRefs?: string[];
  changedFiles?: string[];
  taskId?: string;
  correlationId?: string;
  causationId?: string;
  causationChain?: string[];
  delegationDepth?: number;
  idempotencyKey?: string;
}

export interface AgentMessagingClient {
  readonly agentId: string;
  readonly workflowId: string;
  readonly taskId?: string;
  send<TPayload = Record<string, unknown>>(
    input: AgentSendInput<TPayload>,
  ): Promise<CoordinationEventEnvelope<TPayload>>;
  receive(options?: AgentReceiveOptions): Promise<InboxMessage[]>;
  ack(messageId: string): Promise<InboxMessage | undefined>;
  nack(messageId: string, options?: AgentNackOptions | string): Promise<InboxMessage | undefined>;
  subscribe(
    handler: (event: CoordinationEventEnvelope) => void | Promise<void>,
    filter?: CoordinationEventFilter | string,
  ): () => void;
  publishProgress<TPayload = Record<string, unknown>>(
    payload: TPayload,
    options?: {
      taskId?: string;
      targetAgent?: string;
      correlationId?: string;
      causationId?: string;
      artifactRefs?: string[];
    },
  ): Promise<CoordinationEventEnvelope<TPayload>>;
  requestHelp<TPayload = Record<string, unknown>>(
    input: AgentHelpRequestInput<TPayload>,
  ): Promise<CoordinationEventEnvelope<TPayload | Record<string, unknown>>>;
  shareError(input: AgentShareErrorInput): Promise<CoordinationEventEnvelope>;
  handoff<TPayload = Record<string, unknown>>(
    input: AgentHandoffInput<TPayload>,
  ): Promise<CoordinationEventEnvelope<TPayload | Record<string, unknown>>>;
  loadArtifact(ref: string): Promise<unknown>;
}
