import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FastModelSelector,
  FastOrchestrator,
  ShellLatencyTracker,
  WAZIR_SHELL_COMMANDS,
  classifyWithFastOrchestrator,
  evaluateSafeArithmetic,
  formatLocalDate,
  formatLocalTime,
  formatLocalTimeAndDate,
  matchTier0Intent,
  selectFastLocalModel,
  type FastModelCandidate,
} from '../src/index.js';

describe('FastOrchestrator', () => {
  const savedTz = process.env.TZ;

  afterEach(() => {
    if (savedTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = savedTz;
    }
    vi.restoreAllMocks();
  });

  describe('WAZIR_SHELL_COMMANDS constraint', () => {
    it('keeps WAZIR_SHELL_COMMANDS size unchanged at 14', () => {
      expect(WAZIR_SHELL_COMMANDS.size).toBe(14);
    });
  });

  describe('Tier 0 clock and calendar formatting', () => {
    it('formats local time, date, and combined date-time dynamically with TZ and DST support', () => {
      // Winter PST (UTC-8)
      const winter = new Date('2026-11-21T22:01:00Z');
      expect(formatLocalTime(winter, 'America/Los_Angeles')).toBe('2:01 PM PST');
      expect(formatLocalDate(winter, 'America/Los_Angeles')).toBe('Saturday, November 21, 2026');
      expect(formatLocalTimeAndDate(winter, 'America/Los_Angeles')).toBe(
        '2:01 PM PST, Saturday, November 21, 2026',
      );

      // Summer PDT (UTC-7) for DST verification
      const summer = new Date('2026-07-15T21:05:00Z');
      expect(formatLocalTime(summer, 'America/Los_Angeles')).toBe('2:05 PM PDT');
      expect(formatLocalDate(summer, 'America/Los_Angeles')).toBe('Wednesday, July 15, 2026');

      // Respects process.env.TZ dynamically without caching
      process.env.TZ = 'America/New_York';
      expect(formatLocalTime(winter)).toBe('5:01 PM EST');
      process.env.TZ = 'UTC';
      expect(formatLocalTime(winter)).toBe('10:01 PM UTC');
    });

    it('matches Tier 0 clock/calendar intents without caching Date across calls', async () => {
      const t1 = new Date('2026-11-21T22:01:00Z');
      const t2 = new Date('2026-11-21T22:05:00Z');

      for (const phrase of ['what time is it', "what's the time", 'current time', 'tell me the time']) {
        const res = matchTier0Intent(phrase, { now: t1, timeZone: 'America/Los_Angeles' });
        expect(res, `expected '${phrase}' to match time_now`).toMatchObject({
          tier: 0,
          tier0Kind: 'time_now',
          tier0Payload: '2:01 PM PST',
        });
      }

      for (const phrase of [
        'what time is it today',
        "what's the time today",
        'current time and date',
        'date and time',
      ]) {
        const res = matchTier0Intent(phrase, { now: t1, timeZone: 'America/Los_Angeles' });
        expect(res, `expected '${phrase}' to match time_today`).toMatchObject({
          tier: 0,
          tier0Kind: 'time_today',
          tier0Payload: '2:01 PM PST, Saturday, November 21, 2026',
        });
      }

      for (const phrase of [
        'what day is today',
        'what day is it today',
        "today's date",
        "what is today's date",
        'what date is it today',
      ]) {
        const res = matchTier0Intent(phrase, { now: t1, timeZone: 'America/Los_Angeles' });
        expect(res, `expected '${phrase}' to match day_today`).toMatchObject({
          tier: 0,
          tier0Kind: 'day_today',
          tier0Payload: 'Saturday, November 21, 2026',
        });
      }

      // Live clock check via FastOrchestrator: never caches Date() across requests
      const orch = new FastOrchestrator({ timeZone: 'America/Los_Angeles' });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(t1);
        const first = await orch.dispatch('what time is it');
        expect(first.output).toBe('2:01 PM PST');

        vi.setSystemTime(t2);
        const second = await orch.dispatch('what time is it');
        expect(second.output).toBe('2:05 PM PST');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Tier 0 builtins, control, observability, and guardrails', () => {
    it('matches all deterministic Tier 0 builtin commands and normalizes whitespace', () => {
      const cwd = '/tmp/wazir-test-cwd';
      for (const v of ['version', 'wa version', 'wa --version', 'wa -V', 'wazir version']) {
        expect(matchTier0Intent(`  ${v}  `, { packageVersion: '0.4.0' })).toMatchObject({
          tier: 0,
          tier0Kind: 'version',
          tier0Payload: 'Wazir v0.4.0',
        });
      }

      expect(matchTier0Intent('whoami')).toMatchObject({
        tier: 0,
        tier0Kind: 'whoami',
      });
      expect(matchTier0Intent('who   am   i?')).toMatchObject({
        tier: 0,
        tier0Kind: 'whoami',
      });

      for (const p of ['pwd', 'where am i', 'what is my current directory']) {
        expect(matchTier0Intent(p, { cwd })).toMatchObject({
          tier: 0,
          tier0Kind: 'pwd',
          tier0Payload: cwd,
        });
      }

      for (const h of ['hostname', 'what is my hostname']) {
        expect(matchTier0Intent(h)).toMatchObject({
          tier: 0,
          tier0Kind: 'hostname',
          tier0Payload: os.hostname(),
        });
      }

      for (const helpCmd of ['help', 'wa help', 'wazir help']) {
        expect(matchTier0Intent(helpCmd)).toMatchObject({ tier: 0, tier0Kind: 'help', wazirCommand: 'help' });
      }
      for (const modelsCmd of ['models', 'wa models', 'wa models list']) {
        expect(matchTier0Intent(modelsCmd)).toMatchObject({ tier: 0, tier0Kind: 'models', wazirCommand: 'models' });
      }
      for (const jobsCmd of ['jobs', 'wa jobs']) {
        expect(matchTier0Intent(jobsCmd)).toMatchObject({ tier: 0, tier0Kind: 'jobs', wazirCommand: 'jobs' });
      }
      expect(matchTier0Intent('status')).toMatchObject({ tier: 0, tier0Kind: 'status', wazirCommand: 'status' });
      expect(matchTier0Intent('wa status run-42')).toMatchObject({
        tier: 0,
        tier0Kind: 'status',
        wazirCommand: 'status',
        wazirArgs: 'run-42',
      });
      expect(matchTier0Intent('agents')).toMatchObject({ tier: 0, tier0Kind: 'agents' });
      expect(matchTier0Intent('wa agents')).toMatchObject({ tier: 0, tier0Kind: 'agents' });
      expect(matchTier0Intent('fleet')).toMatchObject({ tier: 0, tier0Kind: 'fleet' });
      expect(matchTier0Intent('wa fleet')).toMatchObject({ tier: 0, tier0Kind: 'fleet' });
      expect(matchTier0Intent('history')).toMatchObject({ tier: 0, tier0Kind: 'history' });
      expect(matchTier0Intent('tools')).toMatchObject({ tier: 0, tier0Kind: 'tools' });
      expect(matchTier0Intent('wa-tools')).toMatchObject({ tier: 0, tier0Kind: 'tools' });

      expect(matchTier0Intent('wa debug on')).toMatchObject({
        tier: 0,
        tier0Kind: 'debug_toggle',
        tier0Payload: 'on',
      });
      expect(matchTier0Intent('/debug off')).toMatchObject({
        tier: 0,
        tier0Kind: 'debug_toggle',
        tier0Payload: 'off',
      });
      expect(matchTier0Intent('debug status')).toMatchObject({
        tier: 0,
        tier0Kind: 'debug_toggle',
        tier0Payload: 'status',
      });
      expect(matchTier0Intent('wa route ls -la')).toMatchObject({
        tier: 0,
        tier0Kind: 'route_explain',
        tier0Payload: 'ls -la',
      });
      expect(matchTier0Intent('wa route "explain chmod 755"')).toMatchObject({
        tier: 0,
        tier0Kind: 'route_explain',
        tier0Payload: 'explain chmod 755',
      });
      expect(matchTier0Intent("wa route 'explain chmod 755'")).toMatchObject({
        tier: 0,
        tier0Kind: 'route_explain',
        tier0Payload: 'explain chmod 755',
      });
      expect(matchTier0Intent('wa route explain chmod 755')).toMatchObject({
        tier: 0,
        tier0Kind: 'route_explain',
        tier0Payload: 'explain chmod 755',
      });
      expect(matchTier0Intent('/route what is TCP')).toMatchObject({
        tier: 0,
        tier0Kind: 'route_explain',
        tier0Payload: 'what is TCP',
      });
      expect(matchTier0Intent('wa latency --json')).toMatchObject({
        tier: 0,
        tier0Kind: 'latency_report',
        tier0Payload: '--json',
      });
      expect(matchTier0Intent('/latency reset')).toMatchObject({
        tier: 0,
        tier0Kind: 'latency_report',
        tier0Payload: 'reset',
      });

      expect(matchTier0Intent('/mode shell')).toMatchObject({ tier: 0, tier0Kind: 'control', tier0Payload: 'shell' });
      expect(matchTier0Intent('/model qwen3-8b')).toMatchObject({ tier: 0, tier0Kind: 'control', tier0Payload: 'qwen3-8b' });
      expect(matchTier0Intent('/permissions read-only')).toMatchObject({
        tier: 0,
        tier0Kind: 'control',
        tier0Payload: 'read-only',
      });
      expect(matchTier0Intent('cd /tmp')).toMatchObject({ tier: 0, tier0Kind: 'shell_builtin' });
      expect(matchTier0Intent('export FOO=bar')).toMatchObject({ tier: 0, tier0Kind: 'shell_builtin' });
      expect(matchTier0Intent('unset FOO')).toMatchObject({ tier: 0, tier0Kind: 'shell_builtin' });
      expect(matchTier0Intent('alias ll="ls -la"')).toMatchObject({ tier: 0, tier0Kind: 'shell_builtin' });
      expect(matchTier0Intent('unalias ll')).toMatchObject({ tier: 0, tier0Kind: 'shell_builtin' });
      expect(matchTier0Intent('FOO=bar')).toMatchObject({ tier: 0, tier0Kind: 'shell_builtin' });
    });

    it('rejects unrelated questions containing time/date/version and respects shell/escape/mode guardrails', () => {
      const nonTier0 = [
        'what time is it in Tokyo',
        'version of python',
        'time complexity of quicksort',
        'date of the last commit',
        'write a function to format the date',
        'date',
        'date +%Y-%m-%d',
        'uname -a',
        'FOO=bar node index.js',
        '! pwd',
        '! what time is it',
        '\\jobs',
        'os:status',
        'sh:history',
        '? what time is it',
        'jobs | wc -l',
        'status > status.log',
        'history && echo done',
        'what time is it | cat',
        'echo $(pwd)',
        'help me fix the tests',
        'inspect the auth module',
      ];
      for (const expr of nonTier0) {
        expect(matchTier0Intent(expr), `expected '${expr}' NOT to match Tier 0`).toBeNull();
      }

      // /mode shell guardrails: shell builtins & control commands work, NL clock/wazir go to Tier 1 shell
      expect(matchTier0Intent('what time is it today', { sessionMode: 'shell' })).toBeNull();
      expect(classifyWithFastOrchestrator('what time is it today', { sessionMode: 'shell' })).toMatchObject({
        tier: 1,
        handler: 'native-shell',
      });
      expect(classifyWithFastOrchestrator('jobs', { sessionMode: 'shell' })).toMatchObject({
        tier: 1,
        handler: 'native-shell',
      });
      expect(matchTier0Intent('pwd', { sessionMode: 'shell' })).toMatchObject({ tier: 0, tier0Kind: 'pwd' });
      expect(matchTier0Intent('cd /tmp', { sessionMode: 'shell' })).toMatchObject({
        tier: 0,
        tier0Kind: 'shell_builtin',
      });
      expect(matchTier0Intent('exit', { sessionMode: 'shell' })).toMatchObject({
        tier: 0,
        tier0Kind: 'shell_builtin',
      });
      expect(matchTier0Intent('/mode auto', { sessionMode: 'shell' })).toMatchObject({
        tier: 0,
        tier0Kind: 'control',
      });
      expect(matchTier0Intent('wa latency', { sessionMode: 'shell' })).toMatchObject({
        tier: 0,
        tier0Kind: 'latency_report',
      });

      // /mode ai guardrails: only exit/quit & control/observability bypass
      expect(matchTier0Intent('what time is it today', { sessionMode: 'ai' })).toBeNull();
      expect(matchTier0Intent('pwd', { sessionMode: 'ai' })).toBeNull();
      expect(matchTier0Intent('2 + 2', { sessionMode: 'ai' })).toBeNull();
      expect(matchTier0Intent('exit', { sessionMode: 'ai' })).toMatchObject({
        tier: 0,
        tier0Kind: 'shell_builtin',
      });
      expect(matchTier0Intent('/mode auto', { sessionMode: 'ai' })).toMatchObject({
        tier: 0,
        tier0Kind: 'control',
      });
      expect(matchTier0Intent('/debug on', { sessionMode: 'ai' })).toMatchObject({
        tier: 0,
        tier0Kind: 'debug_toggle',
      });
    });
  });

  describe('Safe recursive-descent arithmetic evaluator', () => {
    it('evaluates valid arithmetic expressions without eval or Function', () => {
      expect(evaluateSafeArithmetic('2 + 2')).toBe(4);
      expect(evaluateSafeArithmetic('(144 / 12) + 89')).toBe(101);
      expect(evaluateSafeArithmetic('what is 17 * 23?')).toBe(391);
      expect(evaluateSafeArithmetic('100 % 7')).toBe(2);
      expect(evaluateSafeArithmetic('-(4 + 6) * 2.5')).toBe(-25);
      expect(evaluateSafeArithmetic('3.5 + 1.25 * 2')).toBe(6);

      expect(matchTier0Intent('2 + 2')).toMatchObject({
        tier: 0,
        tier0Kind: 'arithmetic',
        tier0Payload: '4',
      });
      expect(matchTier0Intent('(144 / 12) + 89')).toMatchObject({
        tier: 0,
        tier0Kind: 'arithmetic',
        tier0Payload: '101',
      });
      expect(matchTier0Intent('what is 17 * 23?')).toMatchObject({
        tier: 0,
        tier0Kind: 'arithmetic',
        tier0Payload: '391',
      });

      // Audit source directly to confirm eval/Function are absent
      const sourcePath = path.resolve(__dirname, '../src/services/fastOrchestrator.ts');
      const src = fs.readFileSync(sourcePath, 'utf8');
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/\bnew\s+Function\b/);
    });

    it('rejects division by zero, non-arithmetic tokens, and malformed expressions', () => {
      expect(evaluateSafeArithmetic('10 / 0')).toBeNull();
      expect(evaluateSafeArithmetic('10 % 0')).toBeNull();
      expect(evaluateSafeArithmetic('10 / (3 - 3)')).toBeNull();
      expect(evaluateSafeArithmetic('process.exit(1)')).toBeNull();
      expect(evaluateSafeArithmetic('require("fs")')).toBeNull();
      expect(evaluateSafeArithmetic('2 + foo')).toBeNull();
      expect(evaluateSafeArithmetic('1.2.3 + 4')).toBeNull();
      expect(evaluateSafeArithmetic('(2 + 3')).toBeNull();
      expect(evaluateSafeArithmetic('2 + 3)')).toBeNull();
      expect(evaluateSafeArithmetic('()')).toBeNull();
      expect(evaluateSafeArithmetic('2(3)')).toBeNull();
      expect(evaluateSafeArithmetic('2 + * 3')).toBeNull();
      expect(evaluateSafeArithmetic('1e308 * 1e308')).toBeNull();

      expect(matchTier0Intent('10 / 0')).toBeNull();
      expect(matchTier0Intent('process.exit(1)')).toBeNull();
    });
  });

  describe('Four-tier classification (Tier 0 / Tier 1 / Tier 2 / Tier 3)', () => {
    it('routes native shell commands, escapes, operators, and ambiguous tokens to Tier 1', () => {
      const tier1ShellCases = [
        '! find the bug',
        '\\jobs',
        'os:status',
        'sh:history',
        'ls -la',
        'git status',
        'git log -3',
        'cat README.md',
        'uname -a',
        'df -h',
        'ps aux',
        'date',
        'cat foo.txt | wc -l',
        'jobs | wc -l',
        'status > status.log',
        './scripts/assure-verify.sh',
        'FOO=bar node index.js',
        'find . -name "*.ts"',
      ];
      for (const cmd of tier1ShellCases) {
        const res = classifyWithFastOrchestrator(cmd);
        expect(res, `expected '${cmd}' -> Tier 1 native-shell`).toMatchObject({
          tier: 1,
          handler: 'native-shell',
        });
      }

      const ambiguous = classifyWithFastOrchestrator('xyzzy_nonexistent_cmd_99');
      expect(ambiguous).toMatchObject({
        tier: 1,
        handler: 'ambiguous',
        ambiguous: true,
      });
    });

    it('routes straightforward explanatory/conversational queries to Tier 2 fast-local-llm', () => {
      const tier2Cases = [
        '? what is TCP',
        'what is TCP',
        'explain chmod 755',
        'what is a Python decorator',
        'summarize this short error: TypeError: Cannot read properties of undefined',
        'what does this git message mean',
        'how does DNS work',
        'compare TCP and UDP',
        'write a function to format the date',
        'what time is it in Tokyo',
        'time complexity of quicksort',
      ];
      for (const query of tier2Cases) {
        const res = classifyWithFastOrchestrator(query);
        expect(res, `expected '${query}' -> Tier 2 fast-local-llm`).toMatchObject({
          tier: 2,
          handler: 'fast-local-llm',
        });
      }
    });

    it('routes Wazir workflow commands and complex/repo/tool tasks to Tier 3', () => {
      const workflowCases = [
        'loop "Improve every city"',
        'graph "Build multiplayer platform"',
        'goal "Verify release readiness"',
        'inspect run-42',
        'pause run-42',
        'resume run-42',
        'stop run-42',
      ];
      for (const wf of workflowCases) {
        expect(classifyWithFastOrchestrator(wf), `expected '${wf}' -> Tier 3 wazir-workflow`).toMatchObject({
          tier: 3,
          handler: 'wazir-workflow',
        });
      }

      const agentCases = [
        '? What operating system am I running?',
        'build a REST API',
        'fix the failing tests',
        'review this repository',
        'deploy the application to staging',
        'run 12 agents to improve the code',
        'create an autonomous improvement graph',
        'create a file named hello.txt',
        'find the startup bottleneck in Wazir',
        'help me find the bug',
        'inspect this repository',
        'date of the last commit',
        'delete all old log files in my project',
      ];
      for (const task of agentCases) {
        expect(classifyWithFastOrchestrator(task), `expected '${task}' -> Tier 3 agent-orchestration`).toMatchObject({
          tier: 3,
          handler: 'agent-orchestration',
        });
      }

      expect(classifyWithFastOrchestrator('delete all old log files in my project').requiresConfirmation).toBe(true);
    });
  });

  describe('ShellLatencyTracker', () => {
    it('maintains bounded ring buffer, computes p50/p95/p99/min/max/mean per tier & model, and formats reports', () => {
      const tracker = new ShellLatencyTracker(5);
      expect(tracker.getSummary().totalSamples).toBe(0);

      for (let i = 1; i <= 8; i += 1) {
        tracker.record({
          input: `cmd-${i}`,
          tier: (i % 4) as 0 | 1 | 2 | 3,
          handler: i % 4 === 2 ? 'fast-local-llm' : 'native-shell',
          inputToDispatchMs: i * 0.5,
          classificationMs: i * 0.1,
          modelSelectionMs: i % 4 === 2 ? 1.2 : undefined,
          modelLoadMs: i % 4 === 2 ? 0 : undefined,
          providerConnectionMs: i % 4 === 2 ? 3 : undefined,
          firstTokenMs: i % 4 === 2 ? i * 20 : undefined,
          totalExecutionMs: i * 10,
          orchestrationOverheadMs: 0.4,
          shellCommandMs: i % 4 === 1 ? i * 9 : undefined,
          tokenThroughputTps: i % 4 === 2 ? 80 + i : undefined,
          outputTokens: i % 4 === 2 ? 64 : undefined,
          toolInvocationCount: i % 4 === 3 ? 2 : 0,
          status: i === 7 ? 'error' : 'success',
          error: i === 7 ? 'timeout' : undefined,
          timedOut: i === 7,
          model: i % 4 === 2 ? 'qwen3-8b' : undefined,
          provider: i % 4 === 2 ? 'ollama' : undefined,
        });
      }

      // Bounded ring buffer of 5 keeps items 4, 5, 6, 7, 8
      const entries = tracker.getMeasurements();
      expect(entries).toHaveLength(5);
      expect(entries.map((e) => e.input)).toEqual(['cmd-4', 'cmd-5', 'cmd-6', 'cmd-7', 'cmd-8']);

      const summary = tracker.getSummary();
      expect(summary.capacity).toBe(5);
      expect(summary.totalSamples).toBe(5);
      expect(summary.errorRate).toBeCloseTo(0.2, 4);
      expect(summary.timeoutRate).toBeCloseTo(0.2, 4);

      expect(summary.metrics.totalExecutionMs).toMatchObject({
        count: 5,
        min: 40,
        p50: 60,
        max: 80,
        mean: 60,
      });
      expect(summary.metrics.totalExecutionMs.p95).toBeGreaterThanOrEqual(76);
      expect(summary.metrics.totalExecutionMs.p99).toBeGreaterThanOrEqual(79);
      expect(summary.byTier[2].count).toBe(1); // cmd-6 -> 6 % 4 === 2
      expect(summary.byTier[3].count).toBe(1); // cmd-7 -> 7 % 4 === 3
      expect(summary.byTier[3].errorRate).toBe(1);
      expect(summary.byTier[3].timeoutRate).toBe(1);
      expect(summary.byModel['qwen3-8b']).toMatchObject({
        model: 'qwen3-8b',
        provider: 'ollama',
        calls: 1,
        errors: 0,
      });
      expect(summary.byModel['qwen3-8b'].ttft.p50).toBe(120);
      expect(summary.byModel['qwen3-8b'].tps.mean).toBe(86);

      const jsonReport = tracker.formatReport({ json: true });
      expect(JSON.parse(jsonReport)).toEqual(summary);

      const textReport = tracker.formatReport({ json: false });
      expect(textReport).toContain('Wazir Shell Latency Report');
      expect(textReport).toContain('qwen3-8b');

      tracker.reset();
      expect(tracker.count).toBe(0);
    });

    it('exports/imports snapshots cleanly up to capacity and flushes asynchronously without blocking', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-latency-snap-'));
      try {
        const snapshotFile = path.join(tmpDir, 'nested', 'shell_latency.json');
        const source = new ShellLatencyTracker(4);
        for (let i = 1; i <= 3; i += 1) {
          source.record({
            input: `query-${i}`,
            tier: 2,
            handler: 'fast-local-llm',
            inputToDispatchMs: 0.5,
            classificationMs: 0.1,
            firstTokenMs: i * 15,
            totalExecutionMs: i * 40,
            orchestrationOverheadMs: 0.3,
            tokenThroughputTps: 100 + i,
            status: 'success',
            model: 'qwen3-8b',
            provider: 'ollama',
          });
        }

        const exported = source.exportSnapshot();
        expect(exported.version).toBe(1);
        expect(exported.capacity).toBe(4);
        expect(exported.measurements).toHaveLength(3);

        await source.flushToFileAsync(snapshotFile);
        expect(fs.existsSync(snapshotFile)).toBe(true);

        // Loads cleanly into matching capacity tracker
        const restored = new ShellLatencyTracker(4);
        expect(restored.loadFromFileSync(snapshotFile)).toBe(3);
        expect(restored.exportSnapshot().measurements).toEqual(exported.measurements);

        // Truncates to newest measurements up to smaller capacity & filters invalid items
        const smaller = new ShellLatencyTracker(2);
        const mixedLoaded = smaller.importSnapshot({
          version: 1,
          capacity: 4,
          measurements: [
            { invalid: true },
            ...exported.measurements,
            { input: 'bad-tier', tier: 9, handler: 'x', status: 'success', inputToDispatchMs: 1, classificationMs: 1, totalExecutionMs: 1, orchestrationOverheadMs: 1 },
          ],
        });
        expect(mixedLoaded).toBe(2);
        expect(smaller.getMeasurements().map((m) => m.input)).toEqual(['query-2', 'query-3']);

        // Missing or corrupt files return 0 safely
        expect(smaller.loadFromFileSync(path.join(tmpDir, 'does-not-exist.json'))).toBe(0);
        const corruptPath = path.join(tmpDir, 'corrupt.json');
        fs.writeFileSync(corruptPath, '{not valid json', 'utf8');
        expect(smaller.loadFromFileSync(corruptPath)).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('selectFastLocalModel & FastModelSelector', () => {
    const candidates: FastModelCandidate[] = [
      {
        id: 'nomic-embed-text',
        provider: 'ollama',
        local: true,
        loaded: true,
        embedding: true,
        parameters: '137M',
      },
      {
        id: 'llama-3.3-70b',
        provider: 'ollama',
        local: true,
        loaded: false,
        parameters: '70B',
        measuredTtftMs: 1400,
        measuredTps: 14,
        memoryHeadroomGB: 2,
      },
      {
        id: 'qwen3-8b',
        provider: 'ollama',
        local: true,
        loaded: true,
        parameters: '8B',
        measuredTtftMs: 95,
        measuredTps: 110,
        memoryHeadroomGB: 20,
      },
      {
        id: 'qwen3-30b-a3b',
        provider: 'lmstudio',
        local: true,
        loaded: false,
        parameters: '30B',
        measuredTtftMs: 280,
        measuredTps: 65,
        memoryHeadroomGB: 12,
      },
      {
        id: 'gpt-4o-mini',
        provider: 'openai',
        local: false,
        loaded: true,
        measuredTtftMs: 120,
        measuredTps: 90,
      },
    ];

    it('prefers loaded fast <=35B local models with lower TTFT, higher TPS, and excludes embeddings', () => {
      const res = selectFastLocalModel(candidates);
      expect(res.model).toBe('qwen3-8b');
      expect(res.rejected.some((r) => r.candidate.id === 'nomic-embed-text')).toBe(true);

      // Even if unloaded, <=35B beats 70B+
      const coldOnly = candidates
        .filter((c) => c.id === 'llama-3.3-70b' || c.id === 'qwen3-30b-a3b')
        .map((c) => ({ ...c, loaded: false }));
      expect(selectFastLocalModel(coldOnly).model).toBe('qwen3-30b-a3b');
    });

    it('honors explicit overrideModel and WAZIR_FAST_MODEL and enforces localOnly privacy', () => {
      expect(selectFastLocalModel(candidates, { overrideModel: 'qwen3-30b-a3b' }).model).toBe('qwen3-30b-a3b');
      expect(
        selectFastLocalModel(candidates, { env: { WAZIR_FAST_MODEL: 'qwen3-30b-a3b' } }).model,
      ).toBe('qwen3-30b-a3b');

      // localOnly strictly forbids hosted remote cloud models even with override
      const localOnlyRes = selectFastLocalModel(candidates, {
        localOnly: true,
        overrideModel: 'gpt-4o-mini',
      });
      expect(localOnlyRes.selected).toBeUndefined();

      const onlyHosted = candidates.filter((c) => c.local === false);
      expect(selectFastLocalModel(onlyHosted, { localOnly: true }).selected).toBeUndefined();
    });

    it('uses FastModelSelector with tracker telemetry fallback for TTFT/TPS', () => {
      const tracker = new ShellLatencyTracker();
      tracker.record({
        input: 'explain tcp',
        tier: 2,
        handler: 'fast-local-llm',
        inputToDispatchMs: 1,
        classificationMs: 0.2,
        firstTokenMs: 40,
        totalExecutionMs: 120,
        orchestrationOverheadMs: 1,
        tokenThroughputTps: 150,
        status: 'success',
        model: 'model-b',
      });
      tracker.record({
        input: 'explain udp',
        tier: 2,
        handler: 'fast-local-llm',
        inputToDispatchMs: 1,
        classificationMs: 0.2,
        firstTokenMs: 900,
        totalExecutionMs: 1500,
        orchestrationOverheadMs: 1,
        tokenThroughputTps: 20,
        status: 'success',
        model: 'model-a',
      });
      const selector = new FastModelSelector({ tracker });
      const pick = selector.select([
        { id: 'model-a', local: true, loaded: true, parameters: '8B' },
        { id: 'model-b', local: true, loaded: true, parameters: '8B' },
      ]);
      expect(pick.model).toBe('model-b');
    });
  });

  describe('FastOrchestrator end-to-end dispatch and observability commands', () => {
    it('executes across all 4 tiers, supports debug/route/latency/cd/pwd, and records telemetry', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-fast-orch-'));
      try {
        const shellCalls: string[] = [];
        const llmCalls: Array<{ prompt: string; model?: string }> = [];
        const tier3Calls: string[] = [];

        const orch = new FastOrchestrator({
          cwd: tmpDir,
          packageVersion: '0.4.0',
          timeZone: 'America/Los_Angeles',
          models: [
            { id: 'qwen3-8b', provider: 'ollama', local: true, loaded: true, parameters: '8B', measuredTtftMs: 75 },
          ],
          executeShell: async (cmd) => {
            shellCalls.push(cmd);
            return { output: `ran:${cmd}`, exitCode: 0, status: 'success', shellCommandMs: 4 };
          },
          executeFastLlm: async (prompt, decision) => {
            llmCalls.push({ prompt, model: decision.model });
            return {
              output: `fast:${prompt}`,
              status: 'success',
              model: decision.model,
              provider: decision.provider,
              firstTokenMs: 75,
              tokenThroughputTps: 120,
              outputTokens: 48,
            };
          },
          executeTier3: async (request) => {
            tier3Calls.push(request);
            return {
              output: `tier3:${request}`,
              status: 'success',
              model: 'sonnet',
              provider: 'anthropic',
              firstTokenMs: 350,
              outputTokens: 200,
              toolInvocationCount: 3,
            };
          },
        });

        // Tier 0
        const arith = await orch.dispatch('what is 17 * 23?');
        expect(arith.status).toBe('success');
        expect(arith.output).toBe('391');
        expect(arith.decision?.tier).toBe(0);
        expect(shellCalls).toHaveLength(0);
        expect(llmCalls).toHaveLength(0);

        const ver = await orch.dispatch('wa --version');
        expect(ver.output).toBe('Wazir v0.4.0');

        const pwdRes = await orch.dispatch('pwd');
        expect(pwdRes.output).toBe(tmpDir);

        // Tier 0 debug & route
        const dbgOn = await orch.dispatch('wa debug on');
        expect(dbgOn.output).toContain('on');
        expect(orch.isDebugEnabled()).toBe(true);

        const routeExplain = await orch.dispatch('wa route what is TCP');
        expect(routeExplain.output).toContain('Tier: 2 (fast-local-llm)');
        const routeQuoted = await orch.dispatch('wa route "explain chmod 755"');
        expect(routeQuoted.output).toContain('Tier: 2 (fast-local-llm)');
        const routeUnquoted = await orch.dispatch('wa route explain chmod 755');
        expect(routeUnquoted.output).toContain('Tier: 2 (fast-local-llm)');
        expect(llmCalls).toHaveLength(0); // route never executes

        // Tier 1 (and ambiguous exitCode 2)
        const shRes = await orch.dispatch('ls -la');
        expect(shRes.decision?.tier).toBe(1);
        expect(shRes.output).toBe('ran:ls -la');
        expect(shellCalls).toEqual(['ls -la']);

        const ambRes = await orch.dispatch('xyzzy_nonexistent_cmd_99');
        expect(ambRes.status).toBe('error');
        expect(ambRes.exitCode).toBe(2);
        expect(ambRes.decision?.ambiguous).toBe(true);

        // Tier 2 (strips ? prefix when passing prompt to LLM)
        const t2Res = await orch.dispatch('? what is TCP');
        expect(t2Res.decision?.tier).toBe(2);
        expect(t2Res.output).toBe('fast:what is TCP');
        expect(llmCalls).toEqual([{ prompt: 'what is TCP', model: 'qwen3-8b' }]);

        // Tier 3
        const t3Res = await orch.dispatch('fix the failing tests');
        expect(t3Res.decision?.tier).toBe(3);
        expect(t3Res.output).toBe('tier3:fix the failing tests');
        expect(t3Res.telemetry?.toolInvocationCount).toBe(3);
        expect(tier3Calls).toEqual(['fix the failing tests']);

        // Tier 0 latency reporting & reset
        const latJson = await orch.dispatch('wa latency --json');
        const parsedSummary = JSON.parse(latJson.output ?? '{}');
        expect(parsedSummary.totalSamples).toBeGreaterThanOrEqual(8);
        expect(parsedSummary.byModel['qwen3-8b'].calls).toBe(1);

        const latReset = await orch.dispatch('/latency reset');
        expect(latReset.output).toBe('Latency telemetry reset.');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
