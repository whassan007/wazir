export type TranscriptVerbosity = 'quiet' | 'normal' | 'verbose' | 'debug';

export interface TaskEventSummary {
  activity?: string;
  milestone?: { kind: 'success' | 'error' | 'info'; text: string };
}

/** Reduces progress events for display without changing or dropping engine telemetry. */
export class EventSummarizer {
  private readonly toolCounts = new Map<string, number>();
  private readonly checkNames = new Set<string>();
  private passedChecks = 0;
  private failedChecks = 0;
  private readonly files = new Set<string>();
  private readonly recent: string[] = [];

  constructor(private verbosity: TranscriptVerbosity = 'normal') {}

  setVerbosity(value: TranscriptVerbosity): void { this.verbosity = value; }
  getVerbosity(): TranscriptVerbosity { return this.verbosity; }

  progress(event: { kind?: string; phase?: string; content?: string; tool?: string; error?: string }, metadata?: Record<string, unknown>): TaskEventSummary {
    if (event.content?.startsWith('files-changed:')) {
      const file = event.content.slice('files-changed:'.length).trim();
      if (file) this.files.add(file);
    }
    const tool = event.tool?.toLowerCase();
    const isCheck = Boolean(tool && ['test', 'build', 'typecheck', 'lint', 'verify', 'verification'].includes(tool));
    if (isCheck && tool) this.checkNames.add(tool);
    if (event.error) {
      if (isCheck) this.failedChecks++;
      const text = `${event.tool ?? 'Execution'} failed: ${event.error.split(/\r?\n/, 1)[0]}`;
      this.pushRecent(text);
      return { milestone: { kind: 'error', text } };
    }
    if (!event.tool) {
      if (event.phase === 'verify' || event.phase === 'test') return { activity: 'Verifying changes...' };
      if (event.phase === 'plan') return { activity: 'Planning approach...' };
      if (event.content && this.verbosity === 'debug') this.pushRecent(event.content);
      return {};
    }
    const toolName = event.tool.toLowerCase();
    this.toolCounts.set(toolName, (this.toolCounts.get(toolName) ?? 0) + 1);
    if (isCheck && typeof metadata?.exitCode === 'number') {
      if (metadata.exitCode === 0) this.passedChecks++;
      else {
        this.failedChecks++;
        const detail = `${toolName} failed (exit ${metadata.exitCode})`;
        this.pushRecent(detail);
        return { milestone: { kind: 'error', text: detail } };
      }
    }
    const detail = `${toolName} succeeded${typeof metadata?.exitCode === 'number' ? ` (exit ${metadata.exitCode})` : ''}`;
    this.pushRecent(detail);
    if (this.verbosity === 'debug' || this.verbosity === 'verbose') {
      return { milestone: { kind: 'success', text: detail } };
    }
    return {};
  }

  completion(filesChanged: string[] = []): string[] {
    for (const file of filesChanged) if (file) this.files.add(file);
    const out: string[] = [];
    if (this.files.size) out.push(`Updated ${[...this.files].length} source file${this.files.size === 1 ? '' : 's'}`);
    if (this.checkNames.size) {
      const total = this.passedChecks + this.failedChecks;
      if (this.failedChecks) out.push(`${this.passedChecks}/${total} checks passed · ${this.failedChecks} failed`);
      else if (this.passedChecks) out.push(`${this.passedChecks} checks passed`);
    }
    if (!out.length && this.verbosity !== 'quiet') {
      const successful = [...this.toolCounts.values()].reduce((a, b) => a + b, 0);
      if (successful) out.push(`${successful} tool operation${successful === 1 ? '' : 's'} completed`);
    }
    return out;
  }

  logLines(limit = 80): string[] { return this.recent.slice(-Math.max(1, limit)); }

  private pushRecent(text: string): void {
    this.recent.push(text);
    if (this.recent.length > 300) this.recent.shift();
  }
}
