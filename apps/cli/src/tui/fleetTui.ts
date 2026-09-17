import {
  type Job,
  type JobOrchestratorEvent,
  type JobRollup,
  type PendingApprovalRequest,
} from '@wazir/core';
import type { RookEngine } from '../engine.js';
import { color } from '../colors.js';
import { createFleetTaskExecutor } from '../fleetRunner.js';
import { TerminalScreen, type TerminalSize } from './screen.js';

export type TuiView = 'fleet' | 'tail' | 'approval' | 'worktrees' | 'help';

export interface AgentCardState {
  taskId: string;
  title: string;
  agentId: string;
  computerId: string;
  modelId: string;
  phase: string;
  lastMessage: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retry';
  startedAt?: Date;
  completedAt?: Date;
  durationMs: number;
  filesChanged: string[];
}

export interface FleetTuiOptions {
  engine: RookEngine;
  screen?: TerminalScreen;
  concurrencyLimit?: number;
  useWorktrees?: boolean;
  autoMerge?: boolean;
}

export class FleetTui {
  readonly engine: RookEngine;
  readonly screen: TerminalScreen;
  private readonly concurrencyLimit: number;
  private readonly useWorktrees: boolean;
  private readonly autoMerge: boolean;

  private currentView: TuiView = 'fleet';
  private highlightedIndex = 0;
  private selectedTaskId?: string;

  private readonly agents = new Map<string, AgentCardState>();
  private readonly agentLogs = new Map<string, Array<{ text: string; time: string; kind: string }>>();
  private pendingApprovals: PendingApprovalRequest[] = [];

  private currentJob?: Job;
  private currentRollup?: JobRollup;
  private isRunning = false;
  private shouldExit = false;

  private inputBuffer = '';
  private statusMessage = 'Ready. Type a task or /fanout <t1; t2; ...> to begin.';
  private renderTimer?: NodeJS.Timeout;

  private unsubscribeApprovals?: () => void;
  private unsubscribeJobEvents?: () => void;

  constructor(options: FleetTuiOptions) {
    this.engine = options.engine;
    this.screen = options.screen ?? new TerminalScreen();
    this.concurrencyLimit = options.concurrencyLimit ?? 4;
    this.useWorktrees = options.useWorktrees ?? true;
    this.autoMerge = options.autoMerge ?? false;
  }

  getCurrentView(): TuiView {
    return this.currentView;
  }

  getAgents(): AgentCardState[] {
    return Array.from(this.agents.values());
  }

  getPendingApprovals(): PendingApprovalRequest[] {
    return this.pendingApprovals;
  }

  getStatusMessage(): string {
    return this.statusMessage;
  }

  getCurrentJob(): Job | undefined {
    return this.currentJob;
  }

  private exitPromise?: Promise<void>;
  private exitResolver?: () => void;
  private inputListener?: (data: Buffer) => void;

  waitForExit(): Promise<void> {
    if (!this.exitPromise) {
      this.exitPromise = new Promise<void>((resolve) => {
        this.exitResolver = resolve;
      });
    }
    return this.exitPromise;
  }

  /**
   * Initializes and starts the interactive TUI session.
   */
  async start(): Promise<void> {
    this.isRunning = true;
    this.screen.enter();

    this.waitForExit();

    // Subscribe to approval queue
    this.unsubscribeApprovals = this.engine.approvalQueue.subscribe((requests) => {
      this.pendingApprovals = requests;
      if (requests.length > 0 && this.currentView !== 'tail') {
        this.currentView = 'approval';
      }
      this.draw();
    });

    // Listen to keypresses via screen input stream (works for both TTY and piped test streams)
    this.inputListener = (data: Buffer) => {
      this.onInputData(data);
    };
    this.screen.getInputStream().on('data', this.inputListener);

    // Refresh display periodically for live duration counters
    this.renderTimer = setInterval(() => {
      this.updateAgentDurations();
      this.draw();
    }, 250);

    this.draw();
  }

  stop(): void {
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.unsubscribeApprovals) this.unsubscribeApprovals();
    if (this.unsubscribeJobEvents) this.unsubscribeJobEvents();

    if (this.inputListener) {
      this.screen.getInputStream().off('data', this.inputListener);
      this.inputListener = undefined;
    }

    this.screen.leave();
    this.isRunning = false;
    this.exitResolver?.();
  }

  private onInputData = (data: Buffer): void => {
    const str = data.toString('utf8');
    this.handleKey(str);
  };

  /**
   * Dispatches input keys (accessible to both live keyboard and automated test harness).
   */
  handleKey(key: string): void {
    // Check for Ctrl+C
    if (key === '\u0003') {
      this.stop();
      process.exit(0);
    }

    // Escape: return to fleet view
    if (key === '\u001b' || key === '\x1b') {
      this.currentView = 'fleet';
      this.draw();
      return;
    }

    // Tab: cycle views
    if (key === '\t') {
      const views: TuiView[] = ['fleet', 'tail', 'approval', 'worktrees'];
      const idx = views.indexOf(this.currentView);
      this.currentView = views[(idx + 1) % views.length];
      this.draw();
      return;
    }

    // Approval pane actions (y/n/a/d) when in approval view
    if (this.currentView === 'approval' && this.pendingApprovals.length > 0) {
      const first = this.pendingApprovals[0];
      if (key === 'y' || key === 'Y') {
        this.engine.approvalQueue.approve(first.id);
        this.statusMessage = `Approved policy request for ${first.tool}`;
        this.draw();
        return;
      }
      if (key === 'n' || key === 'N') {
        this.engine.approvalQueue.deny(first.id);
        this.statusMessage = `Denied policy request for ${first.tool}`;
        this.draw();
        return;
      }
      if (key === 'a' || key === 'A') {
        const count = this.engine.approvalQueue.approveAll();
        this.statusMessage = `Approved all ${count} pending policy requests`;
        this.draw();
        return;
      }
      if (key === 'd' || key === 'D') {
        const count = this.engine.approvalQueue.denyAll();
        this.statusMessage = `Denied all ${count} pending policy requests`;
        this.draw();
        return;
      }
    }

    // Arrow keys
    if (key === '\u001b[A') {
      // Up
      const list = this.getAgents();
      if (list.length > 0) {
        this.highlightedIndex = Math.max(0, this.highlightedIndex - 1);
        this.selectedTaskId = list[this.highlightedIndex]?.taskId;
      }
      this.draw();
      return;
    }
    if (key === '\u001b[B') {
      // Down
      const list = this.getAgents();
      if (list.length > 0) {
        this.highlightedIndex = Math.min(list.length - 1, this.highlightedIndex + 1);
        this.selectedTaskId = list[this.highlightedIndex]?.taskId;
      }
      this.draw();
      return;
    }

    // Left/Right: in tail view, switch between agents
    if (key === '\u001b[D' || key === '\u001b[C') {
      const list = this.getAgents();
      if (list.length > 0) {
        if (key === '\u001b[D') {
          this.highlightedIndex = Math.max(0, this.highlightedIndex - 1);
        } else {
          this.highlightedIndex = Math.min(list.length - 1, this.highlightedIndex + 1);
        }
        this.selectedTaskId = list[this.highlightedIndex]?.taskId;
      }
      this.draw();
      return;
    }

    // Enter key
    if (key === '\r' || key === '\n') {
      if (this.inputBuffer.trim().length > 0) {
        const command = this.inputBuffer.trim();
        this.inputBuffer = '';
        void this.submitCommand(command);
      } else if (this.currentView === 'fleet') {
        // Focus/tail highlighted agent
        const list = this.getAgents();
        if (list.length > 0) {
          this.selectedTaskId = list[this.highlightedIndex]?.taskId;
          this.currentView = 'tail';
        }
      }
      this.draw();
      return;
    }

    // Backspace
    if (key === '\u0008' || key === '\x7f') {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.draw();
      return;
    }

    // Printable characters
    if (key.length === 1 && key >= ' ') {
      this.inputBuffer += key;
      this.draw();
    }
  }

  /**
   * Submits a user command or task prompt.
   */
  async submitCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'q') {
      this.stop();
      return;
    }

    if (trimmed === '/help') {
      this.currentView = 'help';
      this.draw();
      return;
    }

    if (trimmed === '/fleet') {
      this.currentView = 'fleet';
      this.draw();
      return;
    }

    if (trimmed === '/tail') {
      this.currentView = 'tail';
      this.draw();
      return;
    }

    if (trimmed === '/worktrees') {
      this.currentView = 'worktrees';
      this.draw();
      return;
    }

    if (trimmed.startsWith('/cancel')) {
      const parts = trimmed.split(/\s+/);
      const targetTaskId = parts[1] ?? this.selectedTaskId;
      if (this.currentJob && targetTaskId) {
        await this.engine.orchestrator.cancelTask(this.currentJob.id, targetTaskId);
        this.statusMessage = `Cancelled task ${targetTaskId}`;
      } else if (this.currentJob) {
        await this.engine.orchestrator.cancelJob(this.currentJob.id);
        this.statusMessage = `Cancelled job ${this.currentJob.id}`;
      }
      this.draw();
      return;
    }

    if (trimmed.startsWith('/steer ')) {
      const instruction = trimmed.slice(7).trim();
      const targetTaskId = this.selectedTaskId ?? this.getAgents()[this.highlightedIndex]?.taskId;
      if (this.currentJob && targetTaskId) {
        this.engine.orchestrator.steerTask(this.currentJob.id, targetTaskId, instruction);
        this.statusMessage = `Injected steering into ${targetTaskId}: "${instruction}"`;
      } else if (this.currentJob) {
        this.engine.orchestrator.steerJob(this.currentJob.id, instruction);
        this.statusMessage = `Injected fleet-wide steering: "${instruction}"`;
      } else {
        this.statusMessage = `Injected steering: "${instruction}"`;
      }
      this.draw();
      return;
    }

    // Submit a new task or fan-out job
    await this.launchJobFromPrompt(trimmed);
  }

  /**
   * Decomposes or parses a user prompt and launches concurrent execution.
   */
  async launchJobFromPrompt(prompt: string): Promise<void> {
    this.statusMessage = 'Planning & scheduling job...';
    this.draw();

    let taskDescriptions: string[] = [];

    if (prompt.startsWith('/fanout ')) {
      const raw = prompt.slice(8).trim();
      taskDescriptions = raw.split(';').map((s) => s.trim()).filter(Boolean);
    } else if (prompt.includes('\n- ') || prompt.includes('\n* ')) {
      taskDescriptions = prompt.split(/\n[-*]\s+/).map((s) => s.trim()).filter(Boolean);
    } else {
      taskDescriptions = [prompt];
    }

    // Build tasks with dependency edges (chain or independent)
    const jobTasks = taskDescriptions.map((desc, i) => ({
      task: {
        id: `task-${i + 1}`,
        type: 'coding',
        title: desc.slice(0, 50),
        input: desc,
      },
    }));

    try {
      const job = await this.engine.orchestrator.createJob({
        title: prompt.slice(0, 60),
        concurrencyLimit: this.concurrencyLimit,
        tasks: jobTasks,
      });

      this.currentJob = job;
      this.agents.clear();
      this.agentLogs.clear();

      for (const t of job.tasks) {
        const card: AgentCardState = {
          taskId: t.id,
          title: t.title ?? t.input.slice(0, 40),
          agentId: 'wazir-coding',
          computerId: 'evaluating...',
          modelId: 'evaluating...',
          phase: 'queued',
          lastMessage: 'Waiting for scheduler slot',
          status: 'idle',
          durationMs: 0,
          filesChanged: [],
        };
        this.agents.set(t.id, card);
        this.agentLogs.set(t.id, []);
      }

      this.highlightedIndex = 0;
      this.selectedTaskId = job.tasks[0]?.id;

      // Subscribe to live orchestrator events
      if (this.unsubscribeJobEvents) this.unsubscribeJobEvents();
      this.unsubscribeJobEvents = this.engine.orchestrator.subscribe(job.id, this.onJobEvent);

      // Create executor and launch job
      const executor = createFleetTaskExecutor(this.engine, {
        useWorktrees: this.useWorktrees,
        autoMerge: this.autoMerge,
      });

      this.statusMessage = `Job ${job.id} running up to ${this.concurrencyLimit} agents concurrently...`;
      this.draw();

      // Run asynchronously
      void (async () => {
        try {
          await this.engine.orchestrator.runJob(job.id, {
            concurrencyLimit: this.concurrencyLimit,
            taskExecutor: executor,
          });

          this.currentRollup = await this.engine.orchestrator.getJobRollup(job.id);
          this.statusMessage = `Job ${job.id} ${job.status}! Tokens: ${this.currentRollup.tokens.total}, Dur: ${(this.currentRollup.durationMs / 1000).toFixed(1)}s`;
        } catch (err) {
          this.statusMessage = `Job execution error: ${err instanceof Error ? err.message : String(err)}`;
        }
        this.draw();
      })();
    } catch (err) {
      this.statusMessage = `Scheduling failed: ${err instanceof Error ? err.message : String(err)}`;
      this.draw();
    }
  }

  private onJobEvent = (ev: JobOrchestratorEvent): void => {
    const taskId = ev.taskId;
    const now = new Date();
    const timeStr = now.toISOString().slice(11, 19);

    if (taskId && this.agents.has(taskId)) {
      const agent = this.agents.get(taskId)!;

      if (ev.type === 'task:started') {
        agent.status = 'running';
        agent.startedAt = agent.startedAt ?? now;
        if (ev.computerId) agent.computerId = ev.computerId;
        if (ev.modelId) agent.modelId = ev.modelId;
        if (ev.agentId) agent.agentId = ev.agentId;
        agent.phase = 'plan';
        agent.lastMessage = 'Agent started';
      } else if (ev.type === 'task:progress') {
        const p = ev.event as { kind?: string; phase?: string; content?: string; tool?: string; error?: string };
        if (p.phase) agent.phase = p.phase;
        if (p.content) agent.lastMessage = p.content.slice(0, 60);
        if (p.tool) agent.lastMessage = `Tool: ${p.tool}`;
        if (p.error) agent.lastMessage = `Error: ${p.error.slice(0, 60)}`;

        const log = this.agentLogs.get(taskId);
        if (log) {
          log.push({
            time: timeStr,
            text: p.content ?? p.error ?? (p.tool ? `tool: ${p.tool}` : `phase: ${p.phase}`),
            kind: p.kind ?? 'info',
          });
          if (log.length > 500) log.shift();
        }
      } else if (ev.type === 'task:completed') {
        agent.status = 'completed';
        agent.completedAt = now;
        agent.phase = 'complete';
        agent.lastMessage = 'Task completed';
        if (ev.filesChanged) agent.filesChanged = ev.filesChanged;
      } else if (ev.type === 'task:failed') {
        agent.status = 'failed';
        agent.completedAt = now;
        agent.phase = 'failed';
        agent.lastMessage = ev.error ?? 'Task failed';
      } else if (ev.type === 'task:retry') {
        agent.status = 'retry';
        agent.phase = 'repair';
        agent.lastMessage = `Retry ${ev.retryCount}/${ev.maxRetries}`;
      } else if (ev.type === 'task:cancelled') {
        agent.status = 'cancelled';
        agent.phase = 'cancelled';
        agent.lastMessage = 'Cancelled';
      } else if (ev.type === 'task:steered') {
        agent.lastMessage = `Steered: ${ev.instruction?.slice(0, 40)}`;
      }
    }

    this.draw();
  };

  private updateAgentDurations(): void {
    const now = Date.now();
    for (const agent of this.agents.values()) {
      if (agent.status === 'running' && agent.startedAt) {
        agent.durationMs = Math.max(0, now - agent.startedAt.getTime());
      } else if (agent.startedAt && agent.completedAt) {
        agent.durationMs = Math.max(0, agent.completedAt.getTime() - agent.startedAt.getTime());
      }
    }
  }

  /**
   * Renders the current view frame to the terminal screen buffer.
   */
  draw(): void {
    const size = this.screen.getSize();
    const lines: string[] = [];

    // 1. Header Bar
    lines.push(this.renderHeader(size.columns));
    lines.push(color.gray('─'.repeat(size.columns)));

    // 2. Main Content View
    const contentHeight = Math.max(5, size.rows - 7);

    switch (this.currentView) {
      case 'fleet':
        lines.push(...this.renderFleetDashboard(size.columns, contentHeight));
        break;
      case 'tail':
        lines.push(...this.renderAgentTail(size.columns, contentHeight));
        break;
      case 'approval':
        lines.push(...this.renderApprovalPane(size.columns, contentHeight));
        break;
      case 'worktrees':
        lines.push(...this.renderWorktreesPane(size.columns, contentHeight));
        break;
      case 'help':
        lines.push(...this.renderHelpPane(size.columns, contentHeight));
        break;
    }

    // 3. Status Bar & Active Approval Alert
    lines.push(color.gray('─'.repeat(size.columns)));
    lines.push(this.renderStatusBar(size.columns));

    // 4. Command Input Bar
    lines.push(this.renderInputBar(size.columns));

    const frame = lines.slice(0, size.rows).join('\n');
    this.screen.render(frame);
  }

  private renderHeader(cols: number): string {
    const title = color.bold(color.cyan(' WAZIR FLEET ENGINE '));
    const activeCount = Array.from(this.agents.values()).filter((a) => a.status === 'running').length;
    const totalCount = this.agents.size;

    const stats = color.gray(
      `[Concurrency: ${activeCount}/${this.concurrencyLimit}] [Total: ${totalCount}] [View: ${this.currentView.toUpperCase()}]`,
    );

    const pendingCount = this.pendingApprovals.length;
    const alert = pendingCount > 0 ? color.yellow(` [! ${pendingCount} APPROVALS]`) : '';

    const left = `${title} ${stats}${alert}`;
    return left;
  }

  private renderFleetDashboard(cols: number, maxRows: number): string[] {
    const lines: string[] = [];
    const list = this.getAgents();

    // Table Header
    const hdr = `  ${'TASK ID'.padEnd(10)} ${'TITLE'.padEnd(22)} ${'COMPUTER'.padEnd(14)} ${'MODEL'.padEnd(14)} ${'PHASE'.padEnd(12)} ${'DURATION'.padEnd(10)} ${'LAST ACTIVITY'.padEnd(Math.max(10, cols - 90))}`;
    lines.push(color.bold(hdr));
    lines.push(color.gray('  ' + '─'.repeat(Math.max(20, cols - 4))));

    if (list.length === 0) {
      lines.push(color.gray('  No active agents. Submit a prompt below to launch tasks.'));
      while (lines.length < maxRows) lines.push('');
      return lines;
    }

    for (let i = 0; i < list.length && lines.length < maxRows; i++) {
      const a = list[i];
      const isSelected = i === this.highlightedIndex;
      const marker = isSelected ? color.cyan('▸ ') : '  ';

      let statusColor = color.gray;
      if (a.status === 'running') statusColor = color.cyan;
      else if (a.status === 'completed') statusColor = color.green;
      else if (a.status === 'failed') statusColor = color.red;
      else if (a.status === 'retry') statusColor = color.yellow;

      const durStr = a.durationMs > 0 ? `${(a.durationMs / 1000).toFixed(1)}s` : '—';
      const titleStr = a.title.slice(0, 20).padEnd(22);
      const row = `${marker}${statusColor(a.taskId.padEnd(10))} ${titleStr} ${a.computerId.padEnd(14)} ${a.modelId.padEnd(14)} ${statusColor(a.phase.padEnd(12))} ${durStr.padEnd(10)} ${color.gray(a.lastMessage.slice(0, Math.max(10, cols - 90)))}`;

      lines.push(isSelected ? color.bold(row) : row);
    }

    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  private renderAgentTail(cols: number, maxRows: number): string[] {
    const lines: string[] = [];
    const targetTaskId = this.selectedTaskId ?? this.getAgents()[this.highlightedIndex]?.taskId;

    if (!targetTaskId || !this.agents.has(targetTaskId)) {
      lines.push(color.gray('  Select an agent from the fleet dashboard to tail its stream.'));
      while (lines.length < maxRows) lines.push('');
      return lines;
    }

    const agent = this.agents.get(targetTaskId)!;
    lines.push(
      color.bold(
        `  Tail: ${agent.taskId} (${agent.title}) | ${agent.computerId} | ${agent.modelId} | [${agent.status.toUpperCase()}]`,
      ),
    );
    lines.push(color.gray('  ' + '─'.repeat(cols - 4)));

    const logs = this.agentLogs.get(targetTaskId) ?? [];
    const visibleLogs = logs.slice(-(maxRows - 2));

    for (const log of visibleLogs) {
      const prefix = color.gray(`[${log.time}] `);
      let content = log.text;
      if (log.kind === 'error') content = color.red(content);
      else if (log.kind === 'tool') content = color.yellow(content);
      lines.push(`  ${prefix}${content.slice(0, cols - 20)}`);
    }

    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  private renderApprovalPane(cols: number, maxRows: number): string[] {
    const lines: string[] = [];
    lines.push(color.bold(color.yellow('  POLICY APPROVAL QUEUE (Non-Blocking)')));
    lines.push(color.gray('  N-1 sibling agents continue running while these wait for your decision:'));
    lines.push('');

    if (this.pendingApprovals.length === 0) {
      lines.push(color.green('  ✓ No pending approval requests. All agents are running smoothly.'));
      while (lines.length < maxRows) lines.push('');
      return lines;
    }

    for (let i = 0; i < this.pendingApprovals.length && lines.length < maxRows - 4; i++) {
      const req = this.pendingApprovals[i];
      lines.push(color.bold(`  [${i + 1}] Request for ${color.cyan(req.taskId ?? 'agent')} on ${color.yellow(req.tool)}`));
      lines.push(`      rule:    ${color.cyan(req.rule)}`);
      for (const reason of req.reasons) {
        lines.push(`      reason:  ${color.gray(reason)}`);
      }
      lines.push(`      args:    ${color.gray(JSON.stringify(req.input).slice(0, cols - 20))}`);
      lines.push('');
    }

    lines.push(color.bold('  Actions: [y] Approve  [n] Deny  [a] Approve All  [d] Deny All  [Esc] Back'));

    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  private renderWorktreesPane(cols: number, maxRows: number): string[] {
    const lines: string[] = [];
    lines.push(color.bold(color.cyan('  GIT WORKTREE ISOLATION & MERGE-BACK')));
    lines.push(color.gray('  Each agent runs in an isolated git branch without colliding writes:'));
    lines.push('');

    const list = this.getAgents();
    if (list.length === 0) {
      lines.push(color.gray('  No active worktrees.'));
    } else {
      for (const a of list) {
        const branch = this.currentJob ? `wazir/${this.currentJob.id}/${a.taskId}` : `wazir/${a.taskId}`;
        lines.push(`  ${color.cyan(a.taskId.padEnd(12))} Branch: ${color.bold(branch)}  Status: ${a.status}`);
        if (a.filesChanged.length > 0) {
          lines.push(`    Files: ${color.gray(a.filesChanged.join(', '))}`);
        }
      }
    }

    lines.push('');
    lines.push(color.gray('  Merge-back story: Changes are verified on isolated branches before merge into target.'));
    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  private renderHelpPane(cols: number, maxRows: number): string[] {
    const lines: string[] = [
      color.bold('  WAZIR FLEET TUI SHORTCUTS & COMMANDS'),
      '',
      '  Navigation:',
      '    Tab          Cycle through views (Fleet -> Tail -> Approvals -> Worktrees)',
      '    Up / Down    Navigate agents in Fleet Dashboard',
      '    Enter        Drill down into highlighted agent stream (Tail view)',
      '    Left / Right Switch between agents in Tail view',
      '    Esc          Return to Fleet Dashboard',
      '',
      '  Commands & Controls:',
      '    /fanout t1; t2; t3   Decompose and run N sub-tasks concurrently',
      '    /steer <text>        Inject mid-run follow-up instruction to agent',
      '    /cancel [taskId]     Cancel one agent or all agents',
      '    y / n                Approve / Deny pending policy ask (in approval pane)',
      '    /exit or q           Exit TUI and restore terminal',
      '',
      '  Distributed Scheduling:',
      '    Each agent is automatically routed by the 2-phase Scheduler based on model capability,',
      '    VRAM headroom, and CPU utilization across all local and remote computers.',
    ];
    while (lines.length < maxRows) lines.push('');
    return lines;
  }

  private renderStatusBar(cols: number): string {
    return `  ${color.gray('Status:')} ${this.statusMessage.slice(0, cols - 15)}`;
  }

  private renderInputBar(cols: number): string {
    const promptPrefix = color.cyan('wa> ');
    return `${promptPrefix}${this.inputBuffer}`;
  }
}
