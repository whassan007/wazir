export type OracleType =
  | 'BUILD'
  | 'TEST'
  | 'LINT'
  | 'TYPECHECK'
  | 'STATIC_ANALYSIS'
  | 'STATIC_CHECK'
  | 'ACCEPTANCE'
  | 'BROWSER'
  | 'RUN';

export type EvidenceType = OracleType;

export type VerificationStatus = 'PASS' | 'FAIL' | 'ERROR';

export interface VerificationEvidence {
  id: string;
  executionId?: string;
  workspaceId?: string;
  workspaceRevision?: number;
  revision: number; // backward-compat alias
  oracle?: OracleType;
  type: OracleType; // backward-compat alias
  command?: string;
  exitCode: number;
  startedAt?: Date;
  completedAt?: Date;
  status?: VerificationStatus;
  evidenceHash?: string;
  artifacts?: string[];
  output?: string;
  durationMs?: number;
  artifactFingerprint?: string;
  reasons?: string[];
  metadata?: Record<string, unknown>;
}

export interface VerificationSet {
  workspaceRevision: number;
  evidence: VerificationEvidence[];
  collectedAt: Date;
}

export interface VerificationRequirements {
  requiredOracles?: OracleType[];
  requiredEvidence?: Array<OracleType | 'STATIC_CHECK'>;
  expectedFiles?: string[];
  protectedFiles?: string[];
  mutationRequired?: boolean;
  taskType?: string;
}

export interface CompletionEvaluation {
  complete: boolean;
  workspaceRevision: number;
  reasons: string[];
  satisfiedOracles: OracleType[];
  missingOracles: OracleType[];
  staleEvidence: VerificationEvidence[];
}

export interface PhysicalMutationInput {
  filePath: string;
  beforeContent: string | Buffer | null;
  afterContent: string | Buffer | null;
}

export interface PhysicalMutationOutcome {
  mutated: boolean;
  filePath: string;
  previousRevision: number;
  newRevision: number;
  invalidatedEvidenceCount: number;
  weakeningDetected?: boolean;
  weakeningReasons?: string[];
}
