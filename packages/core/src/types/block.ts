export type BlockStatus = 'running' | 'success' | 'failed' | 'cancelled';
export type SubmissionSource = 'keyboard-submit' | 'confirmed-paste-submit' | 'cli' | 'system';

export interface InteractiveSubmission {
  submissionId: string;
  sessionId: string;
  source: SubmissionSource;
  text: string;
  timestamp: Date;
}

export interface Block {
  id: string;                    // sequential, e.g. "1843"
  sessionId: string;
  submissionId?: string;          // explicit InteractiveSubmission id
  source?: SubmissionSource;      // provenance of the block submission
  sequence: number;
  timestamp: Date;
  command: string;                // "task run", "doctor", etc.
  argv: string[];
  status: BlockStatus;
  exitCode?: number;
  durationMs?: number;
  stdout: string;                 // captured, truncated at 64KB
  stderr: string;
  executionId?: string;           // link to ExecutionRecord, when applicable
  jobId?: string;                 // link to Job, when applicable
  filesChanged: string[];
  errors: string[];
}
