import { FailureClass, isFailureClass } from '@wazir/shared';

export type DiagnosticHint = string;

export interface FailureObservation {
  readonly executionId: string;
  readonly workspaceRevision?: number;

  // Category & Phase
  readonly category: FailureClass;
  readonly phase: 'validation' | 'execution' | 'policy' | 'runtime' | 'verification' | 'model';

  // Context
  readonly tool?: string;
  readonly runtimeId?: string;
  readonly workerId?: string;
  readonly modelId?: string;

  /** 
   * References to specific pieces of evidence (e.g., event IDs, file paths, or logs) 
   * that substantiate this failure. 
   */
  readonly evidenceRefs: string[];

  // Properties
  readonly isDeterministic: boolean;
  readonly isRetryable: boolean;

  /** 
   * A stable signature used for detecting repeated failures (e.g., "test:scheduler:lease-expiry").
   * Does not include timestamps or volatile data.
   */
  readonly repeatedSignature?: string;

  diagnosticHints: DiagnosticHint[];
  observedAt: Date;
}

export interface FailureIntelligence {
  /** 
   * The sequence of failures that led to the current state, 
   * useful for detecting progress (e.g., SAME_FAILURE -> DIFFERENT_FAILURE).
   */
  history: FailureObservation[];
  current: FailureObservation;
  progressStatus: 'NONE' | 'PARTIAL_PROGRESS' | 'REGRESSION' | 'SAME_FAILURE' | 'DIFFERENT_FAILURE';
}

export type ProgressStatus = 
  | 'NONE' 
  | 'PARTIAL_PROGRESS' 
  | 'REGRESSION' 
  | 'SAME_FAILURE' 
  | 'DIFFERENT_FAILURE';
