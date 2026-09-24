export type VerificationScope = 'targeted' | 'package' | 'subsystem' | 'full';

export interface AffectedSymbolInfo {
  name: string;
  file: string;
  callers: string[];
  dependents: string[];
}

export interface ImpactAnalysisResult {
  workspaceRevision: number;
  changedFiles: string[];
  affectedSymbols: AffectedSymbolInfo[];
  affectedPackages: string[];
  affectedTests: string[];
  affectedBuildTargets: string[];
  affectedArtifacts: string[];
  confidence: 'high' | 'medium' | 'ambiguous';
  ambiguityReasons?: string[];
}

export interface VerificationPlanCheck {
  id: string;
  name: string;
  kind: 'test' | 'build' | 'typecheck' | 'static' | 'browser' | 'acceptance';
  target: string;
  command?: string;
  reason: string;
  scope: VerificationScope;
}

export interface VerificationPlan {
  id: string;
  workspaceRevision: number;
  scope: VerificationScope;
  changedFiles: string[];
  affectedPackages: string[];
  checks: VerificationPlanCheck[];
  summary: string;
  escalationReason?: string;
  generatedAt: Date;
}
