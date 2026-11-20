import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FastPathTelemetry,
  HybridShellSession,
  ExecutionBackendRegistry,
  computePercentiles,
} from '../../packages/ubuntu-os/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const BENCHMARK_TASKS: Array<{ id: number; category: string; input: string; expectedRoute: 'shell' | 'ai' }> = [
  // Standard Linux commands (10)
  { id: 1, category: 'standard-linux', input: 'pwd', expectedRoute: 'shell' },
  { id: 2, category: 'standard-linux', input: 'uname -a', expectedRoute: 'shell' },
  { id: 3, category: 'standard-linux', input: 'whoami', expectedRoute: 'shell' },
  { id: 4, category: 'standard-linux', input: 'date -u', expectedRoute: 'shell' },
  { id: 5, category: 'standard-linux', input: 'echo ok', expectedRoute: 'shell' },
  { id: 6, category: 'filesystem-nav', input: 'ls -la', expectedRoute: 'shell' },
  { id: 7, category: 'filesystem-nav', input: 'ls /tmp', expectedRoute: 'shell' },
  { id: 8, category: 'file-search', input: 'find . -maxdepth 1 -name package.json', expectedRoute: 'shell' },
  { id: 9, category: 'storage-analysis', input: 'df -h', expectedRoute: 'shell' },
  { id: 10, category: 'process-monitoring', input: 'ps -ef | head -n 5', expectedRoute: 'shell' },
  // Pipes, redirects & forced shell (10)
  { id: 11, category: 'standard-linux', input: 'printf "a\\nb\\nc\\n" | wc -l', expectedRoute: 'shell' },
  { id: 12, category: 'code-repo', input: 'git --version', expectedRoute: 'shell' },
  { id: 13, category: 'code-repo', input: 'git status -s', expectedRoute: 'shell' },
  { id: 14, category: 'dev-env', input: 'node -v', expectedRoute: 'shell' },
  { id: 15, category: 'dev-env', input: 'python3 --version', expectedRoute: 'shell' },
  { id: 16, category: 'network', input: 'hostname', expectedRoute: 'shell' },
  { id: 17, category: 'package-updates', input: '!echo simulated apt update', expectedRoute: 'shell' },
  { id: 18, category: 'package-install', input: '!echo simulated apt install', expectedRoute: 'shell' },
  { id: 19, category: 'service-diagnostics', input: '!echo systemctl status wazir-api', expectedRoute: 'shell' },
  { id: 20, category: 'app-launch', input: '!echo gtk-launch firefox', expectedRoute: 'shell' },
  // Natural-language AI tasks across required categories (30)
  { id: 21, category: 'filesystem-nav', input: 'Find the largest files in Downloads', expectedRoute: 'ai' },
  { id: 22, category: 'file-search', input: 'Find all TypeScript files modified today', expectedRoute: 'ai' },
  { id: 23, category: 'app-launch', input: 'Open Firefox and load localhost dashboard', expectedRoute: 'ai' },
  { id: 24, category: 'package-install', input: 'Install Python and configure a development environment', expectedRoute: 'ai' },
  { id: 25, category: 'package-updates', input: 'Check which Ubuntu packages have security updates', expectedRoute: 'ai' },
  { id: 26, category: 'service-diagnostics', input: 'Explain why wazir-api systemd unit restarted', expectedRoute: 'ai' },
  { id: 27, category: 'process-monitoring', input: 'What processes are using the most memory?', expectedRoute: 'ai' },
  { id: 28, category: 'network', input: 'Diagnose my Wi-Fi problem', expectedRoute: 'ai' },
  { id: 29, category: 'storage-analysis', input: 'Explain why my disk is almost full', expectedRoute: 'ai' },
  { id: 30, category: 'dev-env', input: 'Create a Python virtual environment for testing', expectedRoute: 'ai' },
  { id: 31, category: 'code-repo', input: 'Optimize this repository using local models', expectedRoute: 'ai' },
  { id: 32, category: 'code-repo', input: 'Summarize recent commits in this repository', expectedRoute: 'ai' },
  { id: 33, category: 'desktop-settings', input: 'Switch Wazir OS to local-only privacy mode', expectedRoute: 'ai' },
  { id: 34, category: 'desktop-settings', input: 'Enable high contrast accessibility theme', expectedRoute: 'ai' },
  { id: 35, category: 'voice-instructions', input: '?Show my downloads', expectedRoute: 'ai' },
  { id: 36, category: 'voice-instructions', input: '?Cancel the current operation', expectedRoute: 'ai' },
  { id: 37, category: 'backend-changes', input: '?Switch execution backend to qwen-code', expectedRoute: 'ai' },
  { id: 38, category: 'backend-changes', input: '?Verify active execution backend health', expectedRoute: 'ai' },
  { id: 39, category: 'provider-failure', input: '?Retry task after primary Ollama endpoint timeout', expectedRoute: 'ai' },
  { id: 40, category: 'provider-failure', input: '?Fallback to local Liquid AI model when cloud is offline', expectedRoute: 'ai' },
  { id: 41, category: 'recovery-cancel', input: '?Resume interrupted checkpoint from last verified step', expectedRoute: 'ai' },
  { id: 42, category: 'recovery-cancel', input: '?Cancel pending autonomous goal safely', expectedRoute: 'ai' },
  { id: 43, category: 'standard-linux', input: 'Explain the difference between grep and ripgrep?', expectedRoute: 'ai' },
  { id: 44, category: 'network', input: 'Show active listening TCP ports and explain each', expectedRoute: 'ai' },
  { id: 45, category: 'storage-analysis', input: 'Find old log files larger than 100MB', expectedRoute: 'ai' },
  { id: 46, category: 'process-monitoring', input: 'Explain if any zombie processes are running', expectedRoute: 'ai' },
  { id: 47, category: 'dev-env', input: 'Check Node.js and Rust toolchain versions', expectedRoute: 'ai' },
  { id: 48, category: 'code-repo', input: 'Audit pull request diff for security regressions', expectedRoute: 'ai' },
  { id: 49, category: 'desktop-settings', input: 'Configure push-to-talk shortcut for Wazir Voice', expectedRoute: 'ai' },
  { id: 50, category: 'service-diagnostics', input: 'Summarize journalctl errors from the last boot', expectedRoute: 'ai' },
];

describe('50-Task Wazir OS Automated Benchmark (Agent 12)', () => {
  it('executes 50 representative OS tasks, enforces Tier-0 <50ms p95 dispatch, and writes raw JSON telemetry', async () => {
    const telemetry = new FastPathTelemetry();
    const backends = new ExecutionBackendRegistry();
    const session = new HybridShellSession({
      cwd: repoRoot,
      aiHandler: async (prompt, cwd) => {
        const backend = backends.getBackendForExecution(`bench-${prompt.slice(0, 12)}`);
        const res = await backend.execute({
          executionId: `bench-${Date.now()}`,
          prompt,
          cwd,
        });
        return { exitCode: res.status === 'completed' ? 0 : 1, stdout: res.output, stderr: '' };
      },
    });

    const records: Array<Record<string, unknown>> = [];
    for (const task of BENCHMARK_TASKS) {
      const res = await session.executeLine(task.input);
      expect(res.executedAs).toBe(task.expectedRoute);
      expect(res.exitCode).toBe(0);

      telemetry.record({
        tier: task.expectedRoute === 'shell' ? 0 : 1,
        label: task.category,
        dispatchOverheadMs: res.dispatchOverheadMs,
        totalDurationMs: res.totalDurationMs,
      });

      records.push({
        id: task.id,
        category: task.category,
        route: res.executedAs,
        backend: task.expectedRoute === 'shell' ? 'posix-shell' : backends.getActiveId(),
        dispatchOverheadMs: res.dispatchOverheadMs,
        totalDurationMs: res.totalDurationMs,
        exitCode: res.exitCode,
      });
    }

    const tier0 = telemetry.summarizeTier(0);
    expect(tier0.dispatch.count).toBe(20);
    expect(tier0.dispatch.p95Ms).toBeLessThan(50);

    const outPath = path.join(repoRoot, 'tests/wazir-os-ubuntu/benchmark-results.json');
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totalTasks: BENCHMARK_TASKS.length,
          tier0Summary: tier0,
          tier1Summary: telemetry.summarizeTier(1),
          allDispatchPercentiles: computePercentiles(records.map((r) => Number(r.dispatchOverheadMs))),
          records,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    expect(fs.existsSync(outPath)).toBe(true);
  });
});
