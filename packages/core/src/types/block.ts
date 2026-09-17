export type BlockStatus = 'running' | 'success' | 'failed' | 'cancelled';

export interface Block {
  id: string;                    // sequential, e.g. "1843"
  sessionId: string;
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
