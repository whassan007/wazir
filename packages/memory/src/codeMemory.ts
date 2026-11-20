import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface CodeProvenanceRecord {
  id: string;
  repositoryScope: string;
  filePath: string;
  startLine: number;
  endLine: number;
  executionId: string;
  sessionId?: string;
  taskPrompt: string;
  rationale: string;
  rejectedAlternatives: string[];
  commitSha?: string;
  createdAt: string;
}

/**
 * Code Memory ("Git blame for agent sessions"):
 * links specific file/line ranges to the originating agent execution,
 * rationale, and rejected alternatives so future agents preserve
 * deliberate workarounds and retry guards.
 */
export class CodeMemoryIndex {
  private readonly records: CodeProvenanceRecord[] = [];

  recordProvenance(input: Omit<CodeProvenanceRecord, 'id' | 'createdAt'>): CodeProvenanceRecord {
    const rec: CodeProvenanceRecord = {
      ...input,
      filePath: path.normalize(input.filePath),
      id: `cm-${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.records.push(rec);
    return rec;
  }

  /**
   * Queries provenance records overlapping `[startLine, endLine]` in `filePath`.
   */
  queryByLocation(repositoryScope: string, filePath: string, startLine?: number, endLine?: number): CodeProvenanceRecord[] {
    const normalized = path.normalize(filePath);
    return this.records.filter((r) => {
      if (r.repositoryScope !== repositoryScope) return false;
      if (r.filePath !== normalized) return false;
      if (startLine !== undefined && endLine !== undefined) {
        return r.startLine <= endLine && r.endLine >= startLine;
      }
      if (startLine !== undefined) {
        return r.startLine <= startLine && r.endLine >= startLine;
      }
      return true;
    });
  }

  queryByExecution(executionId: string): CodeProvenanceRecord[] {
    return this.records.filter((r) => r.executionId === executionId);
  }
}
