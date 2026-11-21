#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  classifyWithFastOrchestrator,
  computeLatencyPercentiles,
} from '../packages/core/dist/src/index.js';
import {
  createInitialShellState,
  executeShellLine,
} from '../apps/cli/dist/commands/shellCommand.js';
import {
  benchmarkFastLocalModels,
  streamFastLocalCompletion,
} from '../apps/cli/dist/fastLlm.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIST = path.join(REPO_ROOT, 'apps/cli/dist/index.js');
const jsonOut = process.argv.includes('--json');

function measureSpawn(args, cwd = REPO_ROOT) {
  const start = performance.now();
  const res = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, WAZIR_SKIP_RUNTIME_DISCOVERY: '1' },
    timeout: 15_000,
  });
  const durationMs = performance.now() - start;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, durationMs };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-live-bench-'));
  const origLog = console.log;
  const origErr = console.error;

  try {
    // 1. Cold CLI process startup checks
    const coldSamples = {
      versionFlag: [],
      shellVersion: [],
      shellTime: [],
      routeExplain: [],
    };
    for (let i = 0; i < 5; i += 1) {
      coldSamples.versionFlag.push(measureSpawn(['--version']).durationMs);
      coldSamples.shellVersion.push(measureSpawn(['shell', '--no-ai', '-c', 'version']).durationMs);
      coldSamples.shellTime.push(measureSpawn(['shell', '--no-ai', '-c', 'what time is it today']).durationMs);
      coldSamples.routeExplain.push(measureSpawn(['route', 'explain chmod 755']).durationMs);
    }

    // 2. Tier 0 in-session 1,000-request throughput benchmark
    const tier0Queries = ['what time is it today', 'version', 'pwd', '2 + 2', 'whoami', 'hostname'];
    const tier0State = createInitialShellState({
      initialCwd: tmpDir,
      env: { ...process.env, WAZIR_HOME: tmpDir, WAZIR_SKIP_RUNTIME_DISCOVERY: '1' },
      debug: false,
    });
    const tier0Latencies = [];
    console.log = () => {};
    console.error = () => {};
    for (let i = 0; i < 1000; i += 1) {
      const q = tier0Queries[i % tier0Queries.length];
      const t0 = performance.now();
      await executeShellLine(q, tier0State);
      tier0Latencies.push(performance.now() - t0);
    }
    console.log = origLog;
    console.error = origErr;

    // 3. Tier 1 native shell overhead benchmark
    const tier1Latencies = [];
    for (let i = 0; i < 10; i += 1) {
      console.log = () => {};
      const t0 = performance.now();
      await executeShellLine('! true', tier0State);
      tier1Latencies.push(performance.now() - t0);
      console.log = origLog;
    }

    // 4. Tier 2 live local/fleet model discovery, benchmark & warm TTFT/TPS
    let tier2Result;
    try {
      const bench = await benchmarkFastLocalModels({ env: process.env, timeoutMs: 2000, forceRefresh: true });
      const warmPrompts = [
        'what is TCP in one concise sentence',
        'explain chmod 755 in one concise sentence',
        'what does HTTP 429 mean in one concise sentence',
        'what is a Python decorator in one concise sentence',
        'what is UDP in one concise sentence',
      ];
      const warmTtftSamples = [];
      const warmTpsSamples = [];
      let lastWarmStream;
      if (bench.selected) {
        for (const prompt of warmPrompts) {
          const res = await streamFastLocalCompletion(prompt, {
            sessionModel: bench.selected.candidate.id,
            env: process.env,
            maxTokens: 48,
            timeoutMs: 12_000,
          });
          lastWarmStream = res;
          if (res.status === 'success') {
            if (typeof res.firstTokenMs === 'number') warmTtftSamples.push(res.firstTokenMs);
            if (typeof res.tokenThroughputTps === 'number') warmTpsSamples.push(res.tokenThroughputTps);
          }
        }
      }
      tier2Result = {
        discoveredCount: bench.entries.length,
        selectedModel: bench.selected?.candidate.id ?? null,
        selectedEndpoint: bench.selected?.endpoint ?? null,
        selectedRuntime: bench.selected?.runtimeType ?? null,
        coldBenchTtftMs: bench.selected?.candidate.measuredTtftMs ?? null,
        coldBenchTps: bench.selected?.candidate.measuredTps ?? null,
        warmStreamStatus: lastWarmStream?.status ?? null,
        warmTtftStatsMs: computeLatencyPercentiles(warmTtftSamples),
        warmTpsStats: computeLatencyPercentiles(warmTpsSamples),
        warmOutput: lastWarmStream?.output?.slice(0, 120) ?? null,
        errors: bench.errors,
      };
    } catch (err) {
      tier2Result = { error: err instanceof Error ? err.message : String(err) };
    }

    // 5. Tier 3 routing classification benchmark (zero network)
    const tier3Samples = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      classifyWithFastOrchestrator('build a REST API with PostgreSQL and integration tests', {
        sessionMode: 'auto',
      });
      tier3Samples.push(performance.now() - t0);
    }

    const report = {
      hardware: {
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cores: os.cpus().length,
        totalMemoryGb: Number((os.totalmem() / (1024 ** 3)).toFixed(1)),
        nodeVersion: process.version,
      },
      coldCliMs: {
        versionFlag: computeLatencyPercentiles(coldSamples.versionFlag),
        shellVersion: computeLatencyPercentiles(coldSamples.shellVersion),
        shellTime: computeLatencyPercentiles(coldSamples.shellTime),
        routeExplain: computeLatencyPercentiles(coldSamples.routeExplain),
      },
      tier0InSessionMs: computeLatencyPercentiles(tier0Latencies),
      tier1SubprocessMs: computeLatencyPercentiles(tier1Latencies),
      tier2LiveLocalLlm: tier2Result,
      tier3ClassificationMs: computeLatencyPercentiles(tier3Samples),
    };

    if (jsonOut) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log('=== Wazir FastOrchestrator Live Benchmark ===');
    console.log(`Hardware: ${report.hardware.cpu} (${report.hardware.cores} cores, ${report.hardware.totalMemoryGb} GiB RAM), ${report.hardware.platform}, Node ${report.hardware.nodeVersion}`);
    console.log(`Cold CLI --version:      p50=${report.coldCliMs.versionFlag.p50Ms.toFixed(1)}ms  p95=${report.coldCliMs.versionFlag.p95Ms.toFixed(1)}ms`);
    console.log(`Cold shell -c version:   p50=${report.coldCliMs.shellVersion.p50Ms.toFixed(1)}ms  p95=${report.coldCliMs.shellVersion.p95Ms.toFixed(1)}ms`);
    console.log(`Cold shell -c time:      p50=${report.coldCliMs.shellTime.p50Ms.toFixed(1)}ms  p95=${report.coldCliMs.shellTime.p95Ms.toFixed(1)}ms`);
    console.log(`Cold wa route:           p50=${report.coldCliMs.routeExplain.p50Ms.toFixed(1)}ms  p95=${report.coldCliMs.routeExplain.p95Ms.toFixed(1)}ms`);
    console.log(`Tier 0 (1,000 samples):  p50=${report.tier0InSessionMs.p50Ms.toFixed(3)}ms  p95=${report.tier0InSessionMs.p95Ms.toFixed(3)}ms  p99=${report.tier0InSessionMs.p99Ms.toFixed(3)}ms`);
    console.log(`Tier 1 (! true x10):     p50=${report.tier1SubprocessMs.p50Ms.toFixed(2)}ms  p95=${report.tier1SubprocessMs.p95Ms.toFixed(2)}ms`);
    console.log(`Tier 2 Live LLM:         ${JSON.stringify(report.tier2LiveLocalLlm)}`);
    console.log(`Tier 3 Classify (x200):  p50=${report.tier3ClassificationMs.p50Ms.toFixed(3)}ms  p95=${report.tier3ClassificationMs.p95Ms.toFixed(3)}ms`);
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

void main();
