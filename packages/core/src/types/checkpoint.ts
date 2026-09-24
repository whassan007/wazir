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

export interface RollbackResult {
  executionId: string;
  checkpointId: string;
  restoredRevision: number;
  filesRestored: string[];
  success: boolean;
  error?: string;
}
