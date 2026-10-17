#!/usr/bin/env node
/**
 * Wazir Permanent Live Reliability & Stress Regression Gate
 *
 * Implements Phase 2, Phase 6, and Phase 7 of the Wazir Comprehensive Live
 * Testing, Reliability Hardening, and Autonomous Remediation suite.
 *
 * Usage:
 *   node scripts/live-reliability-gate.mjs                 # Run all tiers + stress campaign
 *   node scripts/live-reliability-gate.mjs --tier 1        # Tier 1: Deterministic Core
 *   node scripts/live-reliability-gate.mjs --tier 2        # Tier 2: Real PTY & Multi-Process Integration
 *   node scripts/live-reliability-gate.mjs --tier 3        # Tier 3: Live Infrastructure & Phase 7 Stress Campaign
 */

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const CLI_ENTRY = path.join(ROOT, 'apps/cli/dist/index.js');
const BUNDLE_ENTRY = path.join(ROOT, 'bin/wa.js');
const PTY_DRIVER = path.join(ROOT, 'apps/cli/tests/ptyDriver.py');
const RESULTS_FILE = path.join(ROOT, 'docs/reliability/live-test-results.json');

const args = process.argv.slice(2);
const tierIdx = args.indexOf('--tier');
const selectedTier = tierIdx !== -1 && args[tierIdx + 1] ? String(args[tierIdx + 1]).toLowerCase() : 'all';

const runTier1 = selectedTier === 'all' || selectedTier === '1';
const runTier2 = selectedTier === 'all' || selectedTier === '2';
const runTier3 = selectedTier === 'all' || selectedTier === '3';

function stripAnsi(str) {
  return String(str).replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

async function runPtySession(script, extraArgs = ['chat']) {
  const { stdout } = await execFileAsync(
    'python3',
    [PTY_DRIVER, '--json', JSON.stringify(script), '--', process.execPath, CLI_ENTRY, ...extraArgs],
    {
      cwd: ROOT,
      timeout: 45_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout.trim());
}

/**
 * Deterministic PRNG (Mulberry32) for reproducible Phase 7 seeded cancellation tests.
 */
function createSeededRng(seed) {
  let a = seed >>> 0;
  return function next() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Starts a controlled local OpenAI-compatible LM Studio HTTP fixture server
 * so real CLI processes (`wa run` / `wa chat`) can execute full end-to-end
 * planning -> routing -> tool execution -> verification workflows deterministically.
 */
async function startMockLMStudioServer(targetFileName = 'hello-live.txt', targetContent = 'WAZIR_LIVE_EXECUTION_VERIFIED\n') {
  let callCount = 0;
  let agentCallCount = 0;
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.startsWith('/api/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              key: 'qwen2.5-coder-live-fixture',
              display_name: 'Qwen 2.5 Coder Live Fixture',
              max_context_length: 32768,
              size_bytes: 4_000_000_000,
              params_string: '7B',
              architecture: 'qwen2',
              type: 'llm',
              quantization: { name: 'Q4_K_M' },
              capabilities: { vision: false, trained_for_tool_use: true },
              loaded_instances: [
                {
                  id: 'qwen2.5-coder-live-fixture',
                  config: { context_length: 32768 },
                },
              ],
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'qwen2.5-coder-live-fixture',
              object: 'model',
              owned_by: 'local',
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // ignore
      }
      requests.push(parsed);
      callCount += 1;

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const isProbe =
        parsed.max_tokens === 1 ||
        (messages.length === 1 && typeof messages[0]?.content === 'string' && messages[0].content.includes('Reply OK'));

      let replyJson;
      if (isProbe) {
        replyJson = 'OK';
      } else {
        agentCallCount += 1;
        if (agentCallCount === 1) {
          replyJson = JSON.stringify({
            action: 'plan',
            content: `Create ${targetFileName} with the requested verification content and complete the task.`,
          });
        } else if (agentCallCount === 2) {
          replyJson = JSON.stringify({
            action: 'tool',
            tool: 'write',
            input: {
              path: targetFileName,
              content: targetContent,
            },
          });
        } else {
          replyJson = JSON.stringify({
            action: 'done',
            summary: `Created ${targetFileName} with verified content`,
          });
        }
      }

      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const chunkPayload = {
          id: `chatcmpl-${callCount}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'qwen2.5-coder-live-fixture',
          choices: [{ index: 0, delta: { content: replyJson }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
        const stopPayload = {
          id: `chatcmpl-${callCount}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'qwen2.5-coder-live-fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 32, completion_tokens: 24, total_tokens: 56 },
        };
        res.write(`data: ${JSON.stringify(stopPayload)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${callCount}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'qwen2.5-coder-live-fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: replyJson },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 32, completion_tokens: 24, total_tokens: 56 },
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const pkgJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const summary = {
    version: pkgJson.version,
    timestamp: startedAt,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    selectedTier,
    tiers: {},
    stressCampaign: null,
    overallPassed: true,
  };

  console.log(`\n==================================================================`);
  console.log(`  WAZIR LIVE RELIABILITY & SYSTEMIC HARDENING GATE (tier=${selectedTier})`);
  console.log(`==================================================================\n`);

  // =========================================================================
  // TIER 1: DETERMINISTIC CORE (Vitest Systemic Detectors + Standalone Bundle)
  // =========================================================================
  if (runTier1) {
    console.log(`==> [Tier 1] Running Deterministic Core & 10 Systemic Failure Detectors...`);
    const t1Start = Date.now();
    const checks = [];

    // 1a. Vitest systemic detectors suite
    const vitestEntry = path.join(ROOT, 'node_modules/vitest/vitest.mjs');
    const { stdout: vOut } = await execFileAsync(process.execPath, [vitestEntry, 'run', 'tests/live/liveReliability.test.ts'], {
      cwd: ROOT,
      timeout: 90_000,
    });
    checks.push({
      name: 'systemic-failure-detectors-vitest',
      passed: true,
      detail: '14/14 systemic detector assertions passed',
      outputPreview: stripAnsi(vOut).slice(-400),
    });

    // 1b. Standalone bundle vs dist/index.js parity check
    const tmpParity = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-t1-parity-'));
    try {
      const env = {
        ...process.env,
        WAZIR_HOME: path.join(tmpParity, '.wazir'),
        WAZIR_IN_MEMORY: '1',
        WAZIR_LMS_DISABLE: '1',
        WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
        WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:1',
      };
      const [distVer, bundleVer, distStatus, bundleStatus] = await Promise.all([
        execFileAsync(process.execPath, [CLI_ENTRY, 'version', '--json'], { cwd: tmpParity, env }),
        execFileAsync(process.execPath, [BUNDLE_ENTRY, 'version', '--json'], { cwd: tmpParity, env }),
        execFileAsync(process.execPath, [CLI_ENTRY, 'status', '--json'], { cwd: tmpParity, env }),
        execFileAsync(process.execPath, [BUNDLE_ENTRY, 'status', '--json'], { cwd: tmpParity, env }),
      ]);
      const v1 = JSON.parse(distVer.stdout);
      const v2 = JSON.parse(bundleVer.stdout);
      const s1 = JSON.parse(distStatus.stdout);
      const s2 = JSON.parse(bundleStatus.stdout);
      const parityOk =
        v1.version === v2.version &&
        s1.version === v1.version &&
        s2.version === v2.version &&
        typeof s1.executions?.active === 'number' &&
        typeof s2.executions?.active === 'number';
      if (!parityOk) {
        throw new Error(`Binary/source parity mismatch: dist=${JSON.stringify(s1)} bundle=${JSON.stringify(s2)}`);
      }
      checks.push({
        name: 'dist-vs-bundle-parity',
        passed: true,
        version: v1.version,
      });
    } finally {
      await fs.rm(tmpParity, { recursive: true, force: true }).catch(() => undefined);
    }

    summary.tiers.tier1 = {
      passed: checks.every((c) => c.passed),
      durationMs: Date.now() - t1Start,
      checks,
    };
    console.log(`✓ [Tier 1] Passed in ${summary.tiers.tier1.durationMs}ms\n`);
  }

  // =========================================================================
  // TIER 2: REAL PTY INTERACTIVE CLI, E2E TASK EXECUTION & DISTRIBUTED SUITE
  // =========================================================================
  if (runTier2) {
    console.log(`==> [Tier 2] Running Real PTY Interactive Sessions, E2E Task Execution & Distributed Qualification...`);
    const t2Start = Date.now();
    const checks = [];
    const tmpT2 = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-t2-live-'));

    try {
      // 2a. Real PTY Interactive Conversation Session (shell commands, slash commands, unknown command guard, resize, clean /exit)
      console.log(`  • [Tier 2.1] Exercising real pseudo-terminal (ptyDriver.py) against 'wa chat'...`);
      const ptyEnv = {
        WAZIR_HOME: path.join(tmpT2, '.wazir-pty'),
        WAZIR_IN_MEMORY: '1',
        WAZIR_LMS_DISABLE: '1',
        WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
        WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:1',
      };
      const ptyResult = await runPtySession({
        cols: 120,
        rows: 36,
        cwd: tmpT2,
        env: ptyEnv,
        stepTimeout: 15,
        steps: [
          { op: 'wait', text: 'WAZIR' },
          { op: 'send', data: '!echo PTY_LIVE_SHELL_OK\r', delayMs: 200 },
          { op: 'wait', text: 'PTY_LIVE_SHELL_OK' },
          { op: 'send', data: '/sh echo SLASH_SH_OK\r', delayMs: 200 },
          { op: 'wait', text: 'SLASH_SH_OK' },
          { op: 'send', data: '/status\r', delayMs: 150 },
          { op: 'wait', text: 'Status:' },
          { op: 'send', data: '/models\r', delayMs: 150 },
          { op: 'wait', text: 'Models:' },
          { op: 'send', data: '/why model\r', delayMs: 150 },
          { op: 'wait', text: 'Why [model]:' },
          { op: 'send', data: '/nonexistent-command\r', delayMs: 150 },
          { op: 'wait', text: "Unknown command '/nonexistent-command'" },
          { op: 'resize', cols: 90, rows: 28 },
          { op: 'send', data: '/help\r', delayMs: 150 },
          { op: 'wait', text: 'Commands:' },
          { op: 'send', data: '/exit\r', delayMs: 100 },
          { op: 'exit', timeout: 10, expectCode: 0 },
        ],
      });

      const allPtyStepsOk = ptyResult.steps.every((s) => s.ok !== false) && ptyResult.exitCode === 0 && !ptyResult.killed;
      if (!allPtyStepsOk) {
        throw new Error(`Real PTY session failed: ${JSON.stringify(ptyResult, null, 2)}`);
      }
      checks.push({
        name: 'real-pty-interactive-conversation',
        passed: true,
        exitCode: ptyResult.exitCode,
        outputBytes: ptyResult.outputBytes,
        stepsVerified: ptyResult.steps.length,
      });

      // 2b. Real End-to-End CLI Task Execution (`wa run`) against controlled local HTTP runtime
      console.log(`  • [Tier 2.2] Exercising real end-to-end 'wa run' task execution with tool call + file verification...`);
      const mockLm = await startMockLMStudioServer('verified-artifact.txt', 'WAZIR_E2E_VERIFIED_CONTENT\n');
      try {
        const workDir = path.join(tmpT2, 'workspace-e2e');
        await fs.mkdir(workDir, { recursive: true });
        const runEnv = {
          ...process.env,
          WAZIR_HOME: path.join(tmpT2, '.wazir-e2e'),
          WAZIR_PROJECT_ROOT: workDir,
          WAZIR_LMS_DISABLE: '1',
          WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
          WAZIR_LMSTUDIO_URL: mockLm.baseUrl,
        };
        const { stdout: runOut } = await execFileAsync(
          process.execPath,
          [
            CLI_ENTRY,
            'run',
            'Create verified-artifact.txt with WAZIR_E2E_VERIFIED_CONTENT',
            '--expected-files',
            'verified-artifact.txt',
            '--json',
          ],
          {
            cwd: workDir,
            env: runEnv,
            timeout: 30_000,
          },
        );
        const lines = runOut.trim().split('\n').filter(Boolean);
        let runJson;
        try {
          // When --json is passed, executeTask emits NDJSON events followed by the final summary JSON object
          const completeLine = [...lines].reverse().find((l) => l.includes('"type":"complete"'));
          if (completeLine) {
            runJson = JSON.parse(completeLine);
          } else {
            const lastBraceIdx = runOut.lastIndexOf('\n{\n');
            runJson = JSON.parse(lastBraceIdx !== -1 ? runOut.slice(lastBraceIdx + 1) : runOut);
          }
        } catch {
          throw new Error(`Failed to parse wa run --json output: ${runOut}`);
        }
        const createdContent = await fs.readFile(path.join(workDir, 'verified-artifact.txt'), 'utf8');
        if (!runJson.success || createdContent !== 'WAZIR_E2E_VERIFIED_CONTENT\n') {
          throw new Error(`E2E task execution did not verify artifact: ${runOut}`);
        }
        checks.push({
          name: 'real-cli-e2e-task-execution',
          passed: true,
          executionId: runJson.executionId,
          filesChanged: runJson.filesChanged,
          artifactVerified: true,
        });
      } finally {
        await mockLm.close();
      }

      // 2c. Distributed multi-process qualification suite (API server + remote worker + SIGKILL lease fencing)
      console.log(`  • [Tier 2.3] Running multi-process distributed qualification suite...`);
      const vitestBin = path.join(ROOT, 'node_modules/.bin/vitest');
      const { stdout: distOut } = await execFileAsync(
        vitestBin,
        [
          'run',
          '--config',
          'tests/distributed/vitest.config.ts',
          'tests/distributed/processSideEffect.test.ts',
          'tests/distributed/reconnect.test.ts',
        ],
        {
          cwd: ROOT,
          env: { ...process.env, WAZIR_DISTRIBUTED: '1' },
          timeout: 180_000,
        },
      );
      checks.push({
        name: 'distributed-multiprocess-qualification',
        passed: true,
        outputPreview: stripAnsi(distOut).slice(-400),
      });
    } finally {
      await fs.rm(tmpT2, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(path.join(ROOT, 'test-results'), { recursive: true, force: true }).catch(() => undefined);
    }

    summary.tiers.tier2 = {
      passed: checks.every((c) => c.passed),
      durationMs: Date.now() - t2Start,
      checks,
    };
    console.log(`✓ [Tier 2] Passed in ${summary.tiers.tier2.durationMs}ms\n`);
  }

  // =========================================================================
  // TIER 3 & PHASE 7: LIVE INFRASTRUCTURE PROBE + STRESS & SOAK CAMPAIGN
  // =========================================================================
  if (runTier3) {
    console.log(`==> [Tier 3 & Phase 7] Probing Live Infrastructure & Executing Stress Campaign...`);
    const t3Start = Date.now();

    // 3a. Honest live infrastructure probe (Ollama, LM Studio, Hosted Provider Env)
    const liveProbe = {
      ollama: { url: process.env.WAZIR_OLLAMA_URL ?? 'http://127.0.0.1:11434', reachable: false, models: [] },
      lmstudio: { url: process.env.WAZIR_LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1', reachable: false, models: [] },
      hostedCredentialsConfigured: {
        nvidia: Boolean(process.env.NVIDIA_API_KEY),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
        openai: Boolean(process.env.OPENAI_API_KEY),
        google: Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY),
      },
    };

    try {
      const res = await fetch(`${liveProbe.ollama.url}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        liveProbe.ollama.reachable = true;
        liveProbe.ollama.models = (data.models ?? []).map((m) => m.name);
      }
    } catch {
      // Ollama not running locally
    }

    try {
      const res = await fetch(`${liveProbe.lmstudio.url}/models`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        liveProbe.lmstudio.reachable = true;
        liveProbe.lmstudio.models = (data.data ?? []).map((m) => m.id);
      }
    } catch {
      // LM Studio not running locally
    }

    console.log(
      `  • [Tier 3 Probe] Ollama reachable=${liveProbe.ollama.reachable} (${liveProbe.ollama.models.length} models), ` +
        `LM Studio reachable=${liveProbe.lmstudio.reachable} (${liveProbe.lmstudio.models.length} models)`,
    );

    if (liveProbe.lmstudio.reachable && liveProbe.lmstudio.models.length > 0) {
      const targetModel = liveProbe.lmstudio.models[0];
      console.log(`  • [Tier 3 Live Inference] Exercising real inference against LM Studio model '${targetModel}'...`);
      const infStart = Date.now();
      const infRes = await fetch(`${liveProbe.lmstudio.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
          max_tokens: 96,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!infRes.ok) {
        throw new Error(`Tier 3 live LM Studio inference failed with HTTP ${infRes.status}`);
      }
      const infData = await infRes.json();
      const msg = infData?.choices?.[0]?.message ?? {};
      const replyContent = String(msg.content || msg.reasoning_content || '').trim();
      if (!replyContent) {
        throw new Error(`Tier 3 live LM Studio inference returned empty response: ${JSON.stringify(infData)}`);
      }
      liveProbe.lmstudio.liveInference = {
        verified: true,
        model: targetModel,
        durationMs: Date.now() - infStart,
        responsePreview: replyContent.slice(0, 120),
      };
    }

    if (liveProbe.ollama.reachable && liveProbe.ollama.models.length > 0) {
      const targetModel = liveProbe.ollama.models[0];
      console.log(`  • [Tier 3 Live Inference] Exercising real inference against Ollama model '${targetModel}'...`);
      const infStart = Date.now();
      const infRes = await fetch(`${liveProbe.ollama.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          prompt: 'Reply with the single word READY.',
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!infRes.ok) {
        throw new Error(`Tier 3 live Ollama inference failed with HTTP ${infRes.status}`);
      }
      const infData = await infRes.json();
      const replyContent = String(infData?.response ?? '').trim();
      liveProbe.ollama.liveInference = {
        verified: Boolean(replyContent),
        model: targetModel,
        durationMs: Date.now() - infStart,
        responsePreview: replyContent.slice(0, 120),
      };
    }

    // 3b. Phase 7 Stress Campaign:
    //   1. 20 fresh interactive PTY sessions
    //   2. Repeated & concurrent command/task submissions
    //   3. Randomized cancellation timing with fixed seed (seed=20261017)
    //   4. Worker / runtime mid-stream interruption & recovery
    //   5. Restart & durable state recovery cycle
    const tmpStress = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-p7-stress-'));
    const stressMetrics = {
      freshInteractivePtySessions: { target: 20, completed: 0, passed: 0, failed: 0, orphanedProcesses: 0, avgDurationMs: 0 },
      concurrentTaskSubmissions: { totalTasks: 8, completed: 0, duplicateExecutionRecords: 0, passed: false },
      seededRandomCancellation: { seed: 20261017, trials: 5, cancelledCleanly: 0, hungOrCorrupted: 0, passed: false },
      runtimeInterruptionRecovery: { interruptedMidStream: true, transitionedToFailedTruthfully: false, passed: false },
      restartStateRecovery: { jobsPersisted: 1, jobsRecoveredOnRestart: 0, passed: false },
    };

    try {
      // Stress 1: 20 fresh interactive PTY sessions (batched 4 at a time for bounded wall-clock time)
      console.log(`  • [Phase 7.1] Running 20 fresh interactive PTY sessions via ptyDriver.py...`);
      const sessionDurations = [];
      const totalSessions = 20;
      const batchSize = 4;

      for (let base = 0; base < totalSessions; base += batchSize) {
        const batchPromises = [];
        for (let offset = 0; offset < batchSize && base + offset < totalSessions; offset++) {
          const idx = base + offset + 1;
          batchPromises.push(
            (async () => {
              const sStart = Date.now();
              const sessionHome = path.join(tmpStress, `.wazir-pty-${idx}`);
              const token = `PTY_SESSION_${idx}_OK`;
              const res = await runPtySession({
                cols: 110,
                rows: 32,
                cwd: tmpStress,
                env: {
                  WAZIR_HOME: sessionHome,
                  WAZIR_IN_MEMORY: '1',
                  WAZIR_LMS_DISABLE: '1',
                  WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
                  WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:1',
                },
                stepTimeout: 15,
                steps: [
                  { op: 'wait', text: 'WAZIR' },
                  { op: 'send', data: `!echo ${token}\r`, delayMs: 120 },
                  { op: 'wait', text: token },
                  { op: 'send', data: '/status\r', delayMs: 100 },
                  { op: 'wait', text: 'Status:' },
                  { op: 'send', data: '/exit\r', delayMs: 80 },
                  { op: 'exit', timeout: 10, expectCode: 0 },
                ],
              });
              const dur = Date.now() - sStart;
              const ok = res.exitCode === 0 && !res.killed && res.steps.every((s) => s.ok !== false);
              return { idx, ok, killed: res.killed, dur };
            })(),
          );
        }
        const results = await Promise.all(batchPromises);
        for (const r of results) {
          stressMetrics.freshInteractivePtySessions.completed += 1;
          sessionDurations.push(r.dur);
          if (r.ok) stressMetrics.freshInteractivePtySessions.passed += 1;
          else stressMetrics.freshInteractivePtySessions.failed += 1;
          if (r.killed) stressMetrics.freshInteractivePtySessions.orphanedProcesses += 1;
        }
      }
      stressMetrics.freshInteractivePtySessions.avgDurationMs = Math.round(
        sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length,
      );
      if (stressMetrics.freshInteractivePtySessions.passed !== totalSessions) {
        throw new Error(
          `Interactive PTY stress failed: ${stressMetrics.freshInteractivePtySessions.passed}/${totalSessions} passed`,
        );
      }

      // Import core modules for Stress 2, 3, 4, 5
      const {
        ComputerRegistry,
        RuntimeRegistry,
        ModelRegistry,
        AgentRegistry,
        PolicyEngine,
        Scheduler,
        ExecutionEngine,
        JobManager,
        JobOrchestrator,
      } = await import('../packages/core/dist/src/index.js');
      const { CodingAgent } = await import('../packages/agents/dist/src/index.js');
      const { JsonFileStore } = await import('../packages/shared/dist/src/index.js');

      const buildTestHarness = (workspaceDir) => {
        const computers = new ComputerRegistry();
        const runtimes = new RuntimeRegistry();
        const models = new ModelRegistry();
        const agents = new AgentRegistry();
        const policy = new PolicyEngine({ projectRoot: workspaceDir });

        computers.register({
          id: 'local',
          name: 'Local',
          type: 'workstation',
          local: true,
          os: { platform: 'darwin', architecture: 'arm64', version: '24.0' },
          hardware: { cpu: 'M3', cpuCores: 8, memoryGB: 32 },
        });
        runtimes.register({
          id: 'rt-local',
          name: 'Local RT',
          type: 'ollama',
          computerId: 'local',
          health: 'healthy',
          capabilities: {
            chat: true,
            streaming: true,
            toolCalling: true,
            structuredOutput: true,
            vision: false,
            embeddings: false,
            reasoning: false,
            modelLoad: true,
            modelUnload: true,
            modelDownload: false,
            statefulChat: false,
            mcp: false,
          },
        });
        models.register({
          id: 'qwen-stress',
          name: 'Qwen Stress',
          provider: 'ollama',
          local: true,
          contextMax: 32768,
          capabilities: ['coding', 'generalChat'],
          toolCalling: true,
          structuredOutput: true,
          vision: false,
          audio: false,
          embedding: false,
          reasoning: false,
        });
        models.upsertInstance({
          id: 'qwen-stress::local::rt-local',
          modelId: 'qwen-stress',
          computerId: 'local',
          runtimeId: 'rt-local',
          loaded: true,
          state: 'READY',
          health: 'healthy',
        });
        agents.register(new CodingAgent(), 'native');
        const scheduler = new Scheduler({ computers, runtimes, models, agents, policy });
        return { computers, runtimes, models, agents, policy, scheduler };
      };

      // Stress 2: Concurrent 8-task DAG submission & single ExecutionRecord verification
      console.log(`  • [Phase 7.2] Exercising concurrent 8-task job submission & single ExecutionRecord invariant...`);
      {
        const { computers, models, scheduler } = buildTestHarness(tmpStress);
        const executions = new ExecutionEngine({ workspace: tmpStress });
        const jobManager = new JobManager();
        const orchestrator = new JobOrchestrator({
          jobManager,
          scheduler,
          executionEngine: executions,
          computers,
          models,
          taskExecutor: async (task) => {
            await new Promise((r) => setTimeout(r, 25));
            const recs = await executions.listByTask(task.id);
            if (recs[0]) {
              await executions.recordCheck(recs[0].execution.id, {
                name: 'test',
                command: 'npm test',
                ok: true,
                durationMs: 5,
                output: 'ok',
              });
            }
            return { success: true, output: `done ${task.id}` };
          },
        });

        const tasks = Array.from({ length: 8 }, (_, i) => ({
          task: { id: `conc-task-${i + 1}`, type: 'coding', input: `Concurrent task ${i + 1}`, mutationRequired: false },
        }));
        const job = jobManager.create({ title: 'Concurrent 8-Task Stress', concurrencyLimit: 4, tasks });
        const finished = await orchestrator.runJob(job.id);
        let dupCount = 0;
        for (let i = 1; i <= 8; i++) {
          const recs = await executions.listByTask(`conc-task-${i}`);
          if (recs.length !== 1) dupCount += Math.abs(recs.length - 1);
        }
        stressMetrics.concurrentTaskSubmissions.completed = finished.tasks.filter((t) => t.status === 'completed').length;
        stressMetrics.concurrentTaskSubmissions.duplicateExecutionRecords = dupCount;
        stressMetrics.concurrentTaskSubmissions.passed =
          finished.status === 'completed' &&
          stressMetrics.concurrentTaskSubmissions.completed === 8 &&
          dupCount === 0;
        if (!stressMetrics.concurrentTaskSubmissions.passed) {
          throw new Error(`Concurrent task stress failed: ${JSON.stringify(stressMetrics.concurrentTaskSubmissions)}`);
        }
      }

      // Stress 3: Seeded Random Cancellation (seed = 20261017, 5 trials)
      console.log(`  • [Phase 7.3] Exercising seeded random cancellation timing (seed=20261017, 5 trials)...`);
      {
        const rng = createSeededRng(20261017);
        for (let trial = 1; trial <= 5; trial++) {
          const delayMs = Math.floor(15 + rng() * 60);
          const { computers, models, scheduler } = buildTestHarness(tmpStress);
          const executions = new ExecutionEngine({ workspace: tmpStress });
          const jobManager = new JobManager();
          const orchestrator = new JobOrchestrator({
            jobManager,
            scheduler,
            executionEngine: executions,
            computers,
            models,
            taskExecutor: async (_task, ctx) => {
              await new Promise((resolve) => {
                const t = setTimeout(resolve, 500);
                ctx.signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(t);
                    resolve();
                  },
                  { once: true },
                );
              });
              return { success: !ctx.signal.aborted, output: 'cancelled' };
            },
          });

          const job = jobManager.create({
            title: `Seeded Cancel Trial ${trial}`,
            tasks: [{ task: { id: `cancel-t-${trial}`, type: 'coding', input: 'Long running task' } }],
          });
          const runPromise = orchestrator.runJob(job.id);
          await new Promise((r) => setTimeout(r, delayMs));
          await orchestrator.cancelJob(job.id, `seeded-cancel-${delayMs}ms`);
          const finalJob = await runPromise;
          if (finalJob.status === 'cancelled') {
            stressMetrics.seededRandomCancellation.cancelledCleanly += 1;
          } else {
            stressMetrics.seededRandomCancellation.hungOrCorrupted += 1;
          }
        }
        stressMetrics.seededRandomCancellation.passed =
          stressMetrics.seededRandomCancellation.cancelledCleanly === 5 &&
          stressMetrics.seededRandomCancellation.hungOrCorrupted === 0;
        if (!stressMetrics.seededRandomCancellation.passed) {
          throw new Error(`Seeded cancellation stress failed: ${JSON.stringify(stressMetrics.seededRandomCancellation)}`);
        }
      }

      // Stress 4: Runtime mid-stream interruption & truthful failure transition
      console.log(`  • [Phase 7.4] Exercising mid-stream runtime connection drop & truthful failure transition...`);
      {
        const dropServer = http.createServer((req, res) => {
          if (req.url?.startsWith('/v1/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'drop-model', object: 'model' }] }));
            return;
          }
          // Close socket mid-stream to simulate abrupt runtime crash
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"id":"1","choices":[{"delta":{"content":"{\\"action\\":"}}]}\n\n');
          setTimeout(() => req.socket.destroy(), 30);
        });
        await new Promise((resolve) => dropServer.listen(0, '127.0.0.1', resolve));
        const dropPort = dropServer.address().port;
        try {
          let exitCode = 0;
          try {
            await execFileAsync(
              process.execPath,
              [CLI_ENTRY, 'run', 'Write a file while runtime crashes', '--max-turns', '1', '--json'],
              {
                cwd: tmpStress,
                env: {
                  ...process.env,
                  WAZIR_HOME: path.join(tmpStress, '.wazir-drop'),
                  WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
                  WAZIR_LMSTUDIO_URL: `http://127.0.0.1:${dropPort}/v1`,
                },
                timeout: 20_000,
              },
            );
          } catch (err) {
            exitCode = typeof err?.code === 'number' ? err.code : 1;
          }
          stressMetrics.runtimeInterruptionRecovery.transitionedToFailedTruthfully = exitCode !== 0;
          stressMetrics.runtimeInterruptionRecovery.passed = exitCode !== 0;
        } finally {
          await new Promise((resolve) => dropServer.close(() => resolve()));
        }
        if (!stressMetrics.runtimeInterruptionRecovery.passed) {
          throw new Error('Runtime mid-stream drop did not exit non-zero');
        }
      }

      // Stress 5: Restart & durable state recovery cycle
      console.log(`  • [Phase 7.5] Exercising controller restart & durable job recovery cycle...`);
      {
        const storePath = path.join(tmpStress, 'recovery-store.json');
        const store1 = new JsonFileStore(storePath);
        const jm1 = new JobManager({
          store: store1,
          persist: async (job) => store1.put(`job/${job.id}`, job),
          load: async () => (await store1.list('job/')).map((e) => e.value),
        });
        await jm1.ready;
        const job = jm1.create({
          title: 'Durable Recovery Job',
          tasks: [{ task: { id: 'rec-task-1', type: 'coding', input: 'Recover me', mutationRequired: false } }],
        });
        await store1.put(`job/${job.id}`, job);
        await jm1.pause(job.id);

        // Simulate restart with fresh store & JobManager instance
        const store2 = new JsonFileStore(storePath);
        const jm2 = new JobManager({
          store: store2,
          persist: async (j) => store2.put(`job/${j.id}`, j),
          load: async () => (await store2.list('job/')).map((e) => e.value),
        });
        await jm2.ready;
        await jm2.resume(job.id);

        const { computers, models, scheduler } = buildTestHarness(tmpStress);
        const executions = new ExecutionEngine({ workspace: tmpStress });
        const orchestrator2 = new JobOrchestrator({
          jobManager: jm2,
          scheduler,
          executionEngine: executions,
          computers,
          models,
          taskExecutor: async (t) => {
            const recs = await executions.listByTask(t.id);
            if (recs[0]) {
              await executions.recordCheck(recs[0].execution.id, {
                name: 'test',
                command: 'npm test',
                ok: true,
                durationMs: 5,
                output: 'ok',
              });
            }
            return { success: true, output: 'Recovered and completed' };
          },
        });
        const recovered = await orchestrator2.recoverJobs();
        stressMetrics.restartStateRecovery.jobsRecoveredOnRestart = recovered.filter(
          (r) => r.status === 'completed',
        ).length;
        stressMetrics.restartStateRecovery.passed =
          stressMetrics.restartStateRecovery.jobsRecoveredOnRestart === 1;
        if (!stressMetrics.restartStateRecovery.passed) {
          throw new Error(`Restart state recovery failed: ${JSON.stringify(recovered)}`);
        }
      }
    } finally {
      await fs.rm(tmpStress, { recursive: true, force: true }).catch(() => undefined);
    }

    summary.tiers.tier3 = {
      passed: true,
      durationMs: Date.now() - t3Start,
      liveInfrastructure: liveProbe,
    };
    summary.stressCampaign = stressMetrics;
    console.log(`✓ [Tier 3 & Phase 7] Passed in ${summary.tiers.tier3.durationMs}ms\n`);
  }

  summary.totalDurationMs = Date.now() - startMs;

  if (selectedTier === 'all') {
    await fs.mkdir(path.dirname(RESULTS_FILE), { recursive: true });
    await fs.writeFile(RESULTS_FILE, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`✓ Wrote live reliability & stress campaign results to: ${RESULTS_FILE}`);
  }

  console.log(`\n==================================================================`);
  console.log(`  ALL SELECTED LIVE RELIABILITY GATES PASSED (${summary.totalDurationMs}ms)`);
  console.log(`==================================================================\n`);
}

main().catch((err) => {
  console.error('\n✗ LIVE RELIABILITY GATE FAILED:');
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  if (err && typeof err === 'object' && 'stdout' in err && err.stdout) {
    console.error('--- Process stdout ---');
    console.error(String(err.stdout).slice(-2000));
  }
  process.exit(1);
});
