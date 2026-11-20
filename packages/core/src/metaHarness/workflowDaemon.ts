export interface WorkflowContract {
  tracker: 'linear' | 'github' | 'custom';
  pollIntervalMs: number;
  maxConcurrentIssues: number;
  baseBranch: string;
  requiredChecks: string[];
  autoRebase: boolean;
  instructions: string;
}

export interface TrackedIssue {
  id: string;
  title: string;
  description: string;
  state: 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  blockedBy: string[];
  labels?: string[];
  prUrl?: string;
}

export interface IssueWorkspaceState {
  issueId: string;
  workspacePath: string;
  branchName: string;
  status: 'queued' | 'running' | 'pr_open' | 'rebasing' | 'ci_passing' | 'ci_failed' | 'merged';
  lastAttemptAt?: string;
  attempts: number;
}

/**
 * Parses a version-controlled `WORKFLOW.md` contract (OpenAI Symphony pattern)
 * with optional YAML-like `---` frontmatter and markdown prompt instructions.
 */
export function parseWorkflowContract(markdown: string): WorkflowContract {
  const defaults: WorkflowContract = {
    tracker: 'github',
    pollIntervalMs: 30_000,
    maxConcurrentIssues: 3,
    baseBranch: 'main',
    requiredChecks: [],
    autoRebase: true,
    instructions: markdown.trim(),
  };

  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return defaults;

  const frontmatter = match[1];
  const body = match[2].trim();
  const parsed: WorkflowContract = { ...defaults, instructions: body };

  for (const line of frontmatter.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'tracker' && (val === 'linear' || val === 'github' || val === 'custom')) {
      parsed.tracker = val;
    } else if (key === 'pollIntervalMs' && Number.isFinite(Number(val))) {
      parsed.pollIntervalMs = Math.max(1000, Number(val));
    } else if (key === 'maxConcurrentIssues' && Number.isFinite(Number(val))) {
      parsed.maxConcurrentIssues = Math.max(1, Number(val));
    } else if (key === 'baseBranch' && val) {
      parsed.baseBranch = val;
    } else if (key === 'autoRebase') {
      parsed.autoRebase = val === 'true';
    } else if (key === 'requiredChecks') {
      parsed.requiredChecks = val
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return parsed;
}

/**
 * Issue-tracker daemon scheduler (OpenAI Symphony pattern):
 * selects unblocked issues up to `maxConcurrentIssues`, assigns per-issue
 * isolated workspaces, and tracks rebase/CI supervision state.
 */
export class WorkflowDaemon {
  private readonly workspaces = new Map<string, IssueWorkspaceState>();

  constructor(private readonly contract: WorkflowContract, private readonly workspaceRoot: string) {}

  getContract(): WorkflowContract {
    return this.contract;
  }

  /**
   * Returns issues that are in `todo` state, have all `blockedBy` issues in `done`,
   * and are not already active, capped by available concurrency slots.
   */
  selectRunnableIssues(issues: TrackedIssue[]): TrackedIssue[] {
    const doneIds = new Set(issues.filter((i) => i.state === 'done').map((i) => i.id));
    const activeCount = [...this.workspaces.values()].filter((w) => w.status === 'running' || w.status === 'rebasing').length;
    const availableSlots = Math.max(0, this.contract.maxConcurrentIssues - activeCount);
    if (availableSlots === 0) return [];

    const runnable: TrackedIssue[] = [];
    for (const issue of issues) {
      if (runnable.length >= availableSlots) break;
      if (issue.state !== 'todo') continue;
      if (this.workspaces.has(issue.id) && this.workspaces.get(issue.id)!.status === 'running') continue;
      const unblocked = issue.blockedBy.every((dep) => doneIds.has(dep));
      if (unblocked) runnable.push(issue);
    }
    return runnable;
  }

  provisionIssueWorkspace(issueId: string): IssueWorkspaceState {
    const existing = this.workspaces.get(issueId);
    const safeId = issueId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const state: IssueWorkspaceState = {
      issueId,
      workspacePath: existing?.workspacePath ?? `${this.workspaceRoot}/.wazir/issues/${safeId}`,
      branchName: existing?.branchName ?? `wazir/issue-${safeId}`,
      status: 'running',
      lastAttemptAt: new Date().toISOString(),
      attempts: (existing?.attempts ?? 0) + 1,
    };
    this.workspaces.set(issueId, state);
    return state;
  }

  updateWorkspaceStatus(issueId: string, status: IssueWorkspaceState['status']): IssueWorkspaceState | undefined {
    const ws = this.workspaces.get(issueId);
    if (!ws) return undefined;
    ws.status = status;
    return ws;
  }

  getWorkspace(issueId: string): IssueWorkspaceState | undefined {
    return this.workspaces.get(issueId);
  }
}
