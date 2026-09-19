export type ArtifactType =
  | 'source'
  | 'generated_code'
  | 'modified_code'
  | 'patch'
  | 'diff'
  | 'build_output'
  | 'test_result'
  | 'log'
  | 'report'
  | 'model_output'
  | 'dataset'
  | 'binary'
  | 'container'
  | 'package'
  | 'document'
  | 'session_export';

export interface ArtifactGitMetadata {
  repository?: string;
  remote?: string;
  branch?: string;
  commit?: string;
  dirty: boolean;
  diffHash?: string;
  changedFiles: string[];
}

export interface ArtifactProvenance {
  artifactId: string;
  type: ArtifactType;
  name: string;
  location: string;
  contentHash: string;
  sizeBytes: number;
  createdAt: Date;
  modifiedAt: Date;
  git?: ArtifactGitMetadata;
  workspace: string;
  jobId?: string;
  executionId: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  workerId?: string;
  toolsUsed: string[];
  mcpServersUsed: string[];
  connectorsUsed: string[];
  policyDecisions: string[];
  inputArtifactIds: string[];
  parentArtifactIds: string[];
  evaluations: string[];
  reviewers: string[];
  provenanceVersion: '1.0';
  metadata?: Record<string, unknown>;
}

export interface ArtifactWhyReport {
  artifactId: string;
  executionContext: {
    jobId?: string;
    executionId: string;
    agentId: string;
    modelId: string;
    computerId: string;
  };
  policyDecisions: Array<{
    rule: string;
    decision: 'allow' | 'deny';
    reason: string;
    timestamp: Date;
  }>;
  modelRationale?: {
    modelId: string;
    reasoningSteps: string[];
    confidence?: number;
  };
  checks: Array<{
    checkId: string;
    name: string;
    status: 'passed' | 'failed';
    details?: string;
  }>;
}

export interface ArtifactFilter {
  type?: ArtifactType;
  executionId?: string;
  jobId?: string;
  agentId?: string;
  modelId?: string;
  workspace?: string;
  limit?: number;
  offset?: number;
  since?: Date;
  until?: Date;
}
