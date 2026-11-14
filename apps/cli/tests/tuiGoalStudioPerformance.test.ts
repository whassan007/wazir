import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  JobOrchestrator,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
  CheckpointService,
  VerificationEngine,
  SolutionSearchService,
  TaskCapabilityClassifier,
  ModelIntelligenceService,
  ProvenanceManager,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { MemoryStore } from '@wazir/shared';
import { EvaluationService, MetaOptimizerService, BenchmarkService } from '@wazir/evaluation';
import type { GoalGraphDefinition, GoalRunLedger } from '@wazir/goals';
import {
  StartupProfiler,
  createStartupProfiler,
  isStartupProfilingEnabled,
} from '../src/startupProfiler.js';
import {
  GOAL_PRIMARY_LIFECYCLE_PHASES,
  GOAL_RECOVERY_PHASES,
  TUI_KEYBOARD_SHORTCUTS,
  formatShortcutFooterHint,
  formatGoalPhaseIndicator,
  formatTargetStatusBadge,
  formatGoalRunStatusBadge,
  summarizeGoalTargets,
  renderGoalStudioPane,
  formatCommandFeedback,
} from '../src/tui/goalStudioPanel.js';
import { TuiTestHarness, MockTerminalStream } from '../src/tui/inputHarness.js';
import { TerminalSession } from '../src/tui/terminalSession.js';
import { MemoryTerminalAdapter } from '../src/tui/adapter.js';
import { TerminalScreen } from '../src/tui/screen.js';
import { FleetTui } from '../src/tui/fleetTui.js';
import type { RookEngine } from '../src/engine.js';

const execFileAsync = promisify(execFile);

describe('Workstream 11: TUI, CLI & Startup Performance (Goal Studio)', () => {
  describe('1. CLI Startup Latency Budget & StartupProfiler', () => {
    const cliDistIndex = path.resolve(import.meta.dirname, '../dist/index.js');

    it('tracks startup phase marks, spans, and emits human or JSON telemetry when WAZIR_PROFILE_STARTUP is enabled', async () => {
      expect(isStartupProfilingEnabled({})).toBe(false);
      expect(isStartupProfilingEnabled({ WAZIR_PROFILE_STARTUP: '1' })).toBe(true);
      expect(isStartupProfilingEnabled({ WAZIR_PROFILE_STARTUP: 'json' })).toBe(true);

      const emittedLines: string[] = [];
      let fakeClock = 100;
      const profiler = createStartupProfiler({
        enabled: true,
        argv: ['--version'],
        startTimeMs: 100,
        now: () => fakeClock,
        sink: (line) => emittedLines.push(line),
      });

      fakeClock = 104.5;
      profiler.mark('cli.entry');
      fakeClock = 112.25;
      await profiler.measure('engine.config', async () => {
        fakeClock = 118.75;
      });
      fakeClock = 120.0;
      profiler.mark('cli.fast_version', '0.2.13');

      const report = profiler.getReport();
      expect(report.enabled).toBe(true);
      expect(report.argv).toEqual(['--version']);
      expect(report.totalElapsedMs).toBeCloseTo(20.0, 2);
      expect(report.marks).toHaveLength(2);
      expect(report.marks[0].phase).toBe('cli.entry');
      expect(report.marks[1].phase).toBe('cli.fast_version');
      expect(report.spans).toHaveLength(1);
      expect(report.spans[0].name).toBe('engine.config');
      expect(report.spans[0].durationMs).toBeCloseTo(6.5, 2);

      const humanText = profiler.formatReport('human');
      expect(humanText).toContain('[wazir:startup]');
      expect(humanText).toContain('cli.entry');
      expect(humanText).toContain('engine.config');

      const jsonText = profiler.formatReport('json');
      const parsed = JSON.parse(jsonText);
      expect(parsed.type).toBe('wazir.startup_profile');
      expect(parsed.marks).toHaveLength(2);

      expect(profiler.emitIfEnabled({ WAZIR_PROFILE_STARTUP: 'json' })).toBe(true);
      expect(emittedLines).toHaveLength(1);
      // Idempotent emission
      expect(profiler.emitIfEnabled({ WAZIR_PROFILE_STARTUP: 'json' })).toBe(false);
    });

    it('executes `wa --version` and `wa --help` within fast startup latency budget without loading heavy engine modules', async () => {
      const v0 = performance.now();
      const versionRes = await execFileAsync(process.execPath, [cliDistIndex, '--version'], {
        env: { ...process.env, WAZIR_PROFILE_STARTUP: 'json' },
      });
      const versionWallMs = performance.now() - v0;

      expect(versionRes.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      const versionProfile = JSON.parse(versionRes.stderr.trim());
      expect(versionProfile.type).toBe('wazir.startup_profile');
      expect(versionProfile.marks.some((m: { phase: string }) => m.phase === 'cli.fast_version')).toBe(true);
      // Keep internal JS time strict; allow 1500ms for virtualized CI process creation.
      expect(versionProfile.totalElapsedMs).toBeLessThan(25);
      expect(versionWallMs).toBeLessThan(1500);

      const h0 = performance.now();
      const helpRes = await execFileAsync(process.execPath, [cliDistIndex, '--help'], {
        env: { ...process.env, WAZIR_PROFILE_STARTUP: '1' },
      });
      const helpWallMs = performance.now() - h0;

      expect(helpRes.stdout).toContain('Usage: wa [options] [command]');
      expect(helpWallMs).toBeLessThan(1500);
    });
  });

  describe('2. Modular Goal Studio Panel, Keyboard Shortcut Discoverability & Immediate Command Feedback', () => {
    let projectRoot: string;
    let engine: RookEngine;
    let harness: TuiTestHarness;

    const sampleGraph: GoalGraphDefinition = {
      schemaVersion: '1.0',
      name: 'Wazir Goal Studio Release',
      purpose: 'Autonomous multi-target engineering verification',
      constitution: {
        objectiveOwner: 'human',
        invariants: ['Only completed unlocks dependents; verified alone never does.'],
        resourceLimits: {
          maxTasksPerRun: 25,
          maxRepairsPerTask: 3,
          maxSameActionNoProgress: 2,
          maxRunMinutes: 60,
          hostedSpendUsd: 5.0,
          localModelFirst: true,
          maxConcurrentWritersPerWorktree: 1,
        },
        allowedUnattended: ['read', 'test'],
        needsApproval: ['deploy'],
      },
      targets: [
        {
          id: 'G1.1',
          stage: 'foundation',
          title: 'Ledger & Lease Store',
          dependsOn: [],
          priority: 10,
          executor: 'coder',
          artifacts: ['packages/goals/src/ledger.ts'],
          acceptance: ['tsc --build passes'],
        },
        {
          id: 'G1.2',
          stage: 'verification',
          title: 'Independent Verifier Gate',
          dependsOn: ['G1.1'],
          priority: 9,
          executor: 'verifier',
          artifacts: ['packages/goals/src/verifier.ts'],
          acceptance: ['vitest passes'],
        },
        {
          id: 'G1.3',
          stage: 'tui',
          title: 'TUI Goal Studio Panel',
          dependsOn: ['G1.2'],
          priority: 8,
          executor: 'coder',
          artifacts: ['apps/cli/src/tui/goalStudioPanel.ts'],
          acceptance: ['tuiGoalStudioPerformance.test.ts passes'],
        },
      ],
      executionGraph: {
        entry: 'plan',
        nodes: [{ id: 'plan', next: ['execute'] }, { id: 'execute', next: [] }],
      },
    };

    const sampleLedger: GoalRunLedger = {
      runId: 'run-gs-001',
      graphId: 'graph-wazir-gs',
      graphRevision: 3,
      graphDigest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      status: 'running',
      ledgerRevision: 7,
      targets: {
        'G1.1': {
          targetId: 'G1.1',
          status: 'completed',
          attempts: 1,
          repairs: 0,
          evidenceIds: ['ev-001'],
          blockers: [],
          updatedAt: '2026-10-22T18:00:00.000Z',
        },
        'G1.2': {
          targetId: 'G1.2',
          status: 'verified',
          attempts: 1,
          repairs: 0,
          evidenceIds: ['ev-002'],
          blockers: [],
          updatedAt: '2026-10-22T18:05:00.000Z',
        },
        'G1.3': {
          targetId: 'G1.3',
          status: 'queued',
          attempts: 0,
          repairs: 0,
          evidenceIds: [],
          blockers: ['Waiting for G1.2 to reach COMPLETED (currently VERIFIED)'],
          updatedAt: '2026-10-22T18:05:00.000Z',
        },
      },
      resource: {
        tasksStarted: 2,
        hostedSpendUsd: 0.42,
        startedAt: '2026-10-22T18:00:00.000Z',
        deadlineAt: '2026-10-22T19:00:00.000Z',
      },
      createdBy: 'operator',
      createdAt: '2026-10-22T18:00:00.000Z',
      updatedAt: '2026-10-22T18:05:00.000Z',
    };

    beforeEach(async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-gs-tui-'));
      const computers = new ComputerRegistry();
      const runtimes = new RuntimeRegistry();
      const models = new ModelRegistry();
      const agents = new AgentRegistry();
      const tools = new ToolRegistry(defaultTools);
      const compiler = new ContextCompiler();
      const executions = new ExecutionEngine({ workspace: projectRoot });
      await executions.ready;
      const approvalQueue = new ApprovalQueue();
      const worktrees = new WorktreeManager({
        worktreeRootDir: path.join(projectRoot, '.wazir', 'worktrees'),
      });
      const store = new MemoryStore();
      const provenance = new ProvenanceManager(store);
      const policy = new PolicyEngine();
      const classifier = new TaskCapabilityClassifier();
      const modelIntelligence = new ModelIntelligenceService();
      const scheduler = new Scheduler({
        computers,
        runtimes,
        models,
        agents,
        tools,
        policy,
        classifier,
        modelIntelligence,
      });
      const checkpointService = new CheckpointService({ workspace: projectRoot, store });
      const verification = new VerificationEngine({ workspace: projectRoot });
      const solutionSearch = new SolutionSearchService({
        checkpoints: checkpointService,
        verification,
        executions,
      });
      const evaluation = new EvaluationService(store);
      const benchmark = new BenchmarkService(evaluation, store);
      const optimizer = new MetaOptimizerService(evaluation, benchmark, store);
      const orchestrator = new JobOrchestrator({
        scheduler,
        executions,
        worktrees,
        store,
      });

      engine = {
        projectRoot,
        config: { projectRoot, models: { startup: { mode: 'none' } } } as any,
        store,
        computers,
        runtimes,
        models,
        agents,
        tools,
        policy,
        scheduler,
        compiler,
        executions,
        approvalQueue,
        worktrees,
        orchestrator,
        provenance,
        checkpoints: checkpointService,
        verification,
        solutionSearch,
        evaluation,
        benchmark,
        optimizer,
        classifier,
        modelIntelligence,
        discovered: [],
      } as unknown as RookEngine;

      harness = new TuiTestHarness({ engine, cols: 120, rows: 40 });
      await harness.start();
    });

    afterEach(async () => {
      harness?.stop();
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
    });

    it('exposes discoverable keyboard shortcuts in header, help view (`?` and `/help`), and shortcut catalog', () => {
      expect(TUI_KEYBOARD_SHORTCUTS.some((s) => s.command === '/goals' && s.key.includes('7'))).toBe(true);
      expect(TUI_KEYBOARD_SHORTCUTS.some((s) => s.command === '/help' && s.key === '?')).toBe(true);
      expect(formatShortcutFooterHint(120)).toContain('7/g Goals');

      // Header line 3 immediately advertises 7/g Goals and ? Help
      const initialScreen = harness.getScreenBuffer();
      expect(initialScreen).toContain('7/g Goals');
      expect(initialScreen).toContain('? Help');

      // Pressing '?' when prompt is empty opens Help view with visible status feedback
      harness.sendKey('?');
      expect(harness.tui.getCurrentView()).toBe('help');
      expect(harness.tui.getStatusMessage()).toContain('Showing keyboard shortcuts & command reference');
      const helpScreen = harness.getScreenBuffer();
      expect(helpScreen).toContain('WAZIR FLEET TUI SHORTCUTS & COMMANDS');
      expect(helpScreen).toContain('/goals');
      expect(helpScreen).toContain('/status');
    });

    it('renders Goal Studio phase indicators, target dependency statuses, and enforces verified vs completed unlocking distinction in UI', () => {
      expect(GOAL_PRIMARY_LIFECYCLE_PHASES).toContain('INDEPENDENT_VERIFY');
      expect(GOAL_PRIMARY_LIFECYCLE_PHASES).toContain('ACCEPTANCE_GATE');
      expect(GOAL_PRIMARY_LIFECYCLE_PHASES).toContain('UNLOCK_DEPENDENCIES');
      expect(GOAL_RECOVERY_PHASES).toContain('DIAGNOSE');

      const verifyIndicator = formatGoalPhaseIndicator('INDEPENDENT_VERIFY', 120);
      expect(verifyIndicator).toContain('VERIFY');
      expect(verifyIndicator).toContain('INDEPENDENT_VERIFY');

      const recoveryIndicator = formatGoalPhaseIndicator('REPAIR_HYPOTHESIS', 120);
      expect(recoveryIndicator).toContain('RECOVERY:REPAIR_HYPOTHESIS');

      // Crucial contract distinction: completed unlocks deps; verified alone awaits gate/commit
      expect(formatTargetStatusBadge('completed')).toContain('COMPLETED ✓ unlocks deps');
      expect(formatTargetStatusBadge('verified')).toContain('VERIFIED · awaiting gate/commit');
      expect(formatTargetStatusBadge('needs_approval')).toContain('NEEDS APPROVAL');

      const summary = summarizeGoalTargets(sampleLedger.targets);
      expect(summary).toEqual({
        total: 3,
        completed: 1,
        verifiedOnly: 1,
        active: 0,
        eligible: 0,
        queued: 1,
        blockedOrFailed: 0,
        needsApproval: 0,
      });

      harness.tui.setGoalStudioSnapshot({
        run: sampleLedger,
        graph: sampleGraph,
        activePhase: 'ACCEPTANCE_GATE',
        selectedTargetIndex: 1,
      });

      // Switch via '7' key shortcut
      harness.sendKey('7');
      expect(harness.tui.getCurrentView()).toBe('goals');
      expect(harness.tui.getStatusMessage()).toContain('Goal Studio: graph-wazir-gs (RUNNING)');

      const goalScreen = harness.getScreenBuffer();
      expect(goalScreen).toContain('GOAL STUDIO — CONTINUOUS GOAL-DRIVEN AUTONOMY');
      expect(goalScreen).toContain('Only COMPLETED unlocks dependents; VERIFIED alone never does.');
      expect(goalScreen).toContain('run-gs-001');
      expect(goalScreen).toContain('graph-wazir-gs (rev 3)');
      expect(goalScreen).toContain('G1.1');
      expect(goalScreen).toContain('G1.2');
      expect(goalScreen).toContain('G1.3');
      expect(goalScreen).toContain('Waiting for G1.2 to reach');
    });

    it('provides immediate deterministic visible feedback for `/status`, `/goals`, view switches, and unknown `/...` commands', () => {
      harness.tui.setGoalStudioSnapshot({
        run: sampleLedger,
        graph: sampleGraph,
        activePhase: 'EXECUTE',
      });

      harness.sendLine('/status');
      expect(harness.tui.getStatusMessage()).toContain('Status: view=FLEET');
      expect(harness.tui.getStatusMessage()).toContain('Goal graph-wazir-gs [RUNNING]');

      harness.sendLine('/goals');
      expect(harness.tui.getCurrentView()).toBe('goals');
      expect(harness.tui.getStatusMessage()).toContain('Goal Studio: graph-wazir-gs (RUNNING)');

      harness.sendLine('/unknown-nonexistent-command');
      expect(harness.tui.getStatusMessage()).toContain("Unknown command '/unknown-nonexistent-command'");
      expect(harness.tui.getStatusMessage()).toContain('Type /help or press ?');
    });
  });

  describe('3. Terminal Cleanup & AbortController Cancellation', () => {
    it('restores terminal state and aborts session signal when TerminalSession is aborted via AbortController', () => {
      const adapter = new MemoryTerminalAdapter({ width: 120, height: 40, isTTY: true });
      const inStream = new MockTerminalStream();
      const abortController = new AbortController();

      const session = new TerminalSession({
        adapter,
        inStream: inStream as unknown as NodeJS.ReadableStream,
        signal: abortController.signal,
      });

      session.start();
      expect(session.isActive()).toBe(true);
      expect(adapter.isAltScreenActive()).toBe(true);
      expect(adapter.isRawMode()).toBe(true);
      expect(session.signal.aborted).toBe(false);

      // Aborting the controller immediately triggers idempotent terminal cleanup
      abortController.abort();

      expect(session.isActive()).toBe(false);
      expect(session.isCleanedUp()).toBe(true);
      expect(session.signal.aborted).toBe(true);
      expect(adapter.isAltScreenActive()).toBe(false);
      expect(adapter.isRawMode()).toBe(false);
      expect(adapter.isCursorVisible()).toBe(true);
    });

    it('cleanly stops FleetTui, leaves alternate screen, disables raw mode, and aborts FleetTui signal when AbortController aborts', async () => {
      const inStream = new MockTerminalStream();
      const outStream = new MockTerminalStream();
      outStream.columns = 120;
      outStream.rows = 40;
      const screen = new TerminalScreen(
        inStream as unknown as NodeJS.ReadableStream,
        outStream as unknown as NodeJS.WritableStream,
      );
      const abortController = new AbortController();

      const minimalEngine = {
        projectRoot: '/tmp/wazir-abort-test',
        config: { models: { startup: { mode: 'none' } } },
        computers: new ComputerRegistry(),
        runtimes: new RuntimeRegistry(),
        models: new ModelRegistry(),
        agents: new AgentRegistry(),
        approvalQueue: new ApprovalQueue(),
        orchestrator: { listJobs: () => [] },
        discovered: [],
      } as unknown as RookEngine;

      const tui = new FleetTui({
        engine: minimalEngine,
        screen,
        signal: abortController.signal,
      });

      await tui.start();
      expect(screen.isAltScreenActive()).toBe(true);
      expect(screen.isRawMode()).toBe(true);
      expect(tui.getAbortSignal().aborted).toBe(false);

      const exitWait = tui.waitForExit();
      abortController.abort();
      await exitWait;

      expect(tui.getExitReason()).toBe('interrupt');
      expect(tui.getAbortSignal().aborted).toBe(true);
      expect(screen.isAltScreenActive()).toBe(false);
      expect(screen.isRawMode()).toBe(false);
      // Verify ANSI cursor restore + alt screen leave sequences were written
      expect(outStream.getOutput()).toContain('\x1b[?1049l');
      expect(outStream.getOutput()).toContain('\x1b[?25h');
    });
  });
});
