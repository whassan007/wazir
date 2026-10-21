export type HandoffStatus = 'active' | 'completed' | 'failed' | 'paused' | 'blocked' | 'cancelled' | 'unknown';
export interface HandoffRecord {
  schemaVersion: 1; id: string; createdAt: string; sourceSession?: string; sourceAgent?: string; targetAgent?: string; jobId?: string; taskId: string; executionId?: string;
  task: { objective: string; requirements: unknown; constraints: unknown[]; decisions: string[] }; status: HandoffStatus;
  completed: { actions: string[]; files: string[]; commits: string[]; tests: Array<{ name: string; command: string; ok: boolean }>; verification: unknown[] };
  remaining: { openTasks: string[]; defects: string[]; blockers: string[]; pendingApprovals: string[]; nextSteps: string[] };
  environment: { repositoryPath?: string; branch?: string; worktree?: string; baseCommit?: string; currentCommit?: string; runtime?: Record<string, unknown>; checkpointIds: string[] };
  evidence: { executionIds: string[]; artifactReferences: string[]; toolResults: string[]; verificationRecords: string[] };
  provenance: { generatedBy: string; sourceRevision?: number; sourceEventCount?: number; trigger?: string };
}
