export interface ExecutionCheckpoint {
  id: string;
  executionId: string;
  parentCheckpointId?: string;
  createdAt: Date;
  workspaceRevision: number;
  workspaceRoot: string;
  worktreeState: {
    branch?: string;
    commitSha?: string;
    isGit: boolean;
    treeSha?: string;
    filesSnapshot: Record<string, string>; // relative path -> file content
  };
  contextSnapshot?: {
    itemUris: string[];
    tokenCount?: number;
    metadata?: Record<string, unknown>;
  };
  planState?: {
    jobId?: string;
    stepIndex?: number;
    status?: string;
    metadata?: Record<string, unknown>;
  };
  verificationState: {
    revision: number;
    evidenceIds: string[];
    checksPass: boolean;
  };
  provenanceCursor?: number;
  evidenceReferences?: Array<{ id: string; type: string; revision: number; status?: string }>;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointCreateOptions {
  description?: string;
  contextSnapshot?: ExecutionCheckpoint['contextSnapshot'];
  planState?: ExecutionCheckpoint['planState'];
  metadata?: Record<string, unknown>;
}

export interface ForkExecutionResult {
  forkedExecutionId: string;
  parentExecutionId: string;
  checkpointId: string;
  forkedWorktreePath: string;
  branch: string;
  workspaceRevision: number;
}

export interface IrreversibleSideEffectReport {
  tool: string;
  callId?: string;
  sideEffectClass: string;
  description: string;
  at: Date;
}

export interface RollbackResult {
  executionId: string;
  checkpointId: string;
  restoredRevision: number;
  filesRestored: string[];
  success: boolean;
  irreversibleSideEffects?: IrreversibleSideEffectReport[];
  error?: string;
}

export interface SubagentFinding {
  type: string;
  description: string;
  path?: string;
  line?: number;
  metadata?: Record<string, unknown>;
}

export interface SubagentArtifactReference {
  path: string;
  description?: string;
  hash?: string;
}

export interface SubagentEvidenceReference {
  id: string;
  oracle: string;
  revision: number;
  status: 'PASS' | 'FAIL' | 'ERROR';
}

export interface SubagentResult {
  status: 'completed' | 'failed' | 'cancelled' | 'budget_exhausted';
  findings: SubagentFinding[];
  artifacts: SubagentArtifactReference[];
  evidence: SubagentEvidenceReference[];
  unresolved: string[];
  childExecutionId: string;
  summary?: string;
  turnsUsed?: number;
  tokensUsed?: number;
  durationMs?: number;
}

