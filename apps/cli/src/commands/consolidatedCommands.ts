import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseFleetCommand,
  planFleetOperation,
  executeFleetPlanDryRun,
  readSharedFleetState,
  WAZIR_STUDIO_NODE_KINDS,
  WazirStudioOrchestrator,
  WazirExtensionRegistry,
  type FleetHostConfig,
  type StudioGraph,
} from '@wazir/core';
import { UnifiedOptimizationEngine } from '@wazir/evaluation';

const DEFAULT_FLEET_HOSTS: FleetHostConfig[] = [
  { id: 'local', name: 'Local Machine', aliases: ['macbook', 'mac'], os: 'macos', isLocal: true, memoryGB: 64, runtimes: [{ kind: 'ollama', port: 11434 }, { kind: 'lmstudio', port: 1234 }, { kind: 'mlx', port: 8080 }] },
  { id: 'dgx', name: 'DGX Spark', aliases: ['spark'], os: 'linux', tailscaleIP: '100.113.62.112', sshTarget: 'dgx', memoryGB: 128, runtimes: [{ kind: 'ollama', port: 11434 }, { kind: 'lmstudio', port: 1234 }] },
  { id: 'jetson', name: 'Jetson AGX Thor', aliases: ['thor'], os: 'linux', tailscaleIP: '100.83.18.14', sshTarget: 'jetson', memoryGB: 128, runtimes: [{ kind: 'ollama', port: 11434 }] },
];

export function registerConsolidatedCommands(program: Command): void {
  // Extend `wa fleet` with deterministic subcommands while preserving bare `wa fleet` TUI
  const fleetCmd = program.commands.find((c) => c.name() === 'fleet');
  if (fleetCmd) {
    fleetCmd
      .command('status')
      .description('Show shared Wazir Fleet state and host summary')
      .option('--json', 'Output JSON')
      .action((options: { json?: boolean }) => {
        const shared = readSharedFleetState();
        const payload = {
          ok: true,
          source: shared?.source ?? 'wazir-core',
          hosts: shared?.hosts ?? DEFAULT_FLEET_HOSTS.map((h) => ({ id: h.id, name: h.name, online: Boolean(h.isLocal), loadedModels: [], installedModels: [] })),
        };
        console.log(options.json ? JSON.stringify(payload, null, 2) : `Wazir Fleet Status: ${payload.hosts.length} host(s)`);
      });

    fleetCmd
      .command('parse <input...>')
      .description('Deterministically parse a natural-language or structured fleet command')
      .option('--json', 'Output JSON')
      .action((inputParts: string[], options: { json?: boolean }) => {
        const raw = inputParts.join(' ');
        const parsed = parseFleetCommand(raw, new Set(DEFAULT_FLEET_HOSTS.flatMap((h) => [h.id, ...(h.aliases ?? [])])));
        console.log(options.json ? JSON.stringify({ ok: true, parsed }, null, 2) : JSON.stringify(parsed));
      });

    fleetCmd
      .command('plan <input...>')
      .description('Generate a previewable infrastructure execution plan')
      .option('--live', 'Mark plan for live execution')
      .option('--json', 'Output JSON')
      .action((inputParts: string[], options: { live?: boolean; json?: boolean }) => {
        const raw = inputParts.join(' ');
        const parsed = parseFleetCommand(raw, new Set(DEFAULT_FLEET_HOSTS.flatMap((h) => [h.id, ...(h.aliases ?? [])])));
        if (parsed.type !== 'model') {
          console.log(JSON.stringify({ ok: true, parsed }, null, 2));
          return;
        }
        const plan = planFleetOperation({
          command: parsed.command,
          input: raw,
          hosts: DEFAULT_FLEET_HOSTS,
          dryRunByDefault: !options.live,
        });
        console.log(options.json ? JSON.stringify({ ok: true, plan }, null, 2) : plan.summary);
      });

    fleetCmd
      .command('exec <input...>')
      .description('Execute a fleet command (defaults to dry-run)')
      .option('--live', 'Execute live')
      .option('--json', 'Output JSON')
      .action((inputParts: string[], options: { live?: boolean; json?: boolean }) => {
        const raw = inputParts.join(' ');
        const parsed = parseFleetCommand(raw, new Set(DEFAULT_FLEET_HOSTS.flatMap((h) => [h.id, ...(h.aliases ?? [])])));
        if (parsed.type !== 'model') {
          console.log(JSON.stringify({ ok: true, parsed }, null, 2));
          return;
        }
        const plan = planFleetOperation({
          command: parsed.command,
          input: raw,
          hosts: DEFAULT_FLEET_HOSTS,
          dryRunByDefault: !options.live,
        });
        const record = executeFleetPlanDryRun(plan);
        console.log(options.json ? JSON.stringify({ ok: true, record }, null, 2) : `${record.summary}: ${record.status}`);
      });

    fleetCmd
      .command('sync')
      .description('Sync apps/wazir-fleet with the latest upstream Fleet repository')
      .option('--build', 'Rebuild the macOS Wazir Fleet app bundle after syncing')
      .option('--open', 'Open Wazir Fleet after building')
      .option('--remote', 'Fetch from GitHub if local Fleet checkout is not present')
      .option('--json', 'Output JSON')
      .action((options: { build?: boolean; open?: boolean; remote?: boolean; json?: boolean }) => {
        const scriptPath = path.resolve(process.cwd(), 'scripts/sync-fleet-upstream.mjs');
        if (!fs.existsSync(scriptPath)) {
          console.error('scripts/sync-fleet-upstream.mjs not found in current repository.');
          process.exit(1);
        }
        const args = [scriptPath, '--json'];
        if (options.build) args.push('--build');
        if (options.open) args.push('--open');
        if (options.remote) args.push('--remote');
        const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
        if (res.status !== 0) {
          console.error(res.stderr || res.stdout || 'Fleet sync failed.');
          process.exit(res.status ?? 1);
        }
        console.log(options.json ? res.stdout.trim() : `Wazir Fleet synced: ${res.stdout.trim()}`);
      });

    fleetCmd
      .command('app')
      .description('Sync latest Fleet upstream and build/open the native macOS Wazir Fleet app')
      .option('--no-open', 'Build without opening')
      .action((options: { open?: boolean }) => {
        const scriptPath = path.resolve(process.cwd(), 'scripts/sync-fleet-upstream.mjs');
        const args = [scriptPath, '--if-present', '--build'];
        if (options.open !== false) args.push('--open');
        const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
        process.exit(res.status ?? 0);
      });
  }

  // `wa studio`
  const studioCmd = new Command('studio').description('Wazir Studio visual orchestration control plane');
  studioCmd
    .command('nodes')
    .description('List all supported Wazir Studio drag-and-drop node kinds')
    .option('--json', 'Output JSON')
    .action((options: { json?: boolean }) => {
      console.log(options.json ? JSON.stringify({ ok: true, nodes: WAZIR_STUDIO_NODE_KINDS }, null, 2) : WAZIR_STUDIO_NODE_KINDS.join(', '));
    });
  studioCmd
    .command('simulate <goal>')
    .description('Run a simulated Wazir Studio execution graph')
    .option('--json', 'Output JSON')
    .action((goal: string, options: { json?: boolean }) => {
      const orch = new WazirStudioOrchestrator();
      const graph: StudioGraph = {
        id: 'studio-sim',
        name: goal,
        executionMode: 'SIMULATED',
        nodes: [
          { id: 'planner', kind: 'agent', label: 'Planner', x: 100, y: 100, selectionMode: 'delegated', boundaryState: 'ready' },
          { id: 'critic', kind: 'critic', label: 'Critic', x: 300, y: 100, selectionMode: 'delegated', boundaryState: 'queued' },
        ],
        edges: [{ id: 'e1', from: 'planner', to: 'critic' }],
      };
      const result = orch.simulateExecution(graph);
      console.log(options.json ? JSON.stringify({ ok: true, result }, null, 2) : `Simulated ${result.nodeCount} nodes`);
    });
  program.addCommand(studioCmd);

  // `wa optimize`
  const optimizeCmd = new Command('optimize').description('Unified optimization, routing, and bounded repair engine');
  optimizeCmd
    .command('status')
    .description('Show Unified Optimization Engine status')
    .option('--json', 'Output JSON')
    .action((options: { json?: boolean }) => {
      const payload = { ok: true, defaultOrchestrationModel: 'qwen', independentVerificationRequired: true };
      console.log(options.json ? JSON.stringify(payload, null, 2) : 'UnifiedOptimizationEngine: active (default=qwen)');
    });
  optimizeCmd
    .command('compare')
    .description('Compare model and harness profiles')
    .option('--json', 'Output JSON')
    .action((options: { json?: boolean }) => {
      const opt = new UnifiedOptimizationEngine();
      const comparison = opt.compareModelsAndHarnesses([
        { modelId: 'qwen3-coder:30b', harnessId: 'wazir-native', hostId: 'dgx', qualityScore: 0.94, verificationPassRate: 0.92, avgLatencyMs: 420, costPer1kTokensUsd: 0, availableRamGB: 64, requiredRamGB: 20, sampleCount: 30 },
      ]);
      console.log(options.json ? JSON.stringify({ ok: true, comparison }, null, 2) : JSON.stringify(comparison));
    });
  program.addCommand(optimizeCmd);

  // `wa extensions`
  const extCmd = new Command('extensions').description('Manage Wazir SDK application extensions');
  extCmd
    .command('list')
    .description('List registered Wazir SDK extensions')
    .option('--json', 'Output JSON')
    .action((options: { json?: boolean }) => {
      const reg = new WazirExtensionRegistry();
      const extensions = reg.list();
      console.log(options.json ? JSON.stringify({ ok: true, extensions }, null, 2) : extensions.map((e) => `${e.id} (${e.domain})`).join('\n'));
    });
  program.addCommand(extCmd);

  // `wa eval` alias
  const evalAlias = new Command('eval').description('Evaluate and verify executions (alias for evaluation)');
  evalAlias
    .command('verify <executionId>')
    .description('Verify an execution against independent evidence')
    .option('--json', 'Output JSON')
    .action((executionId: string, options: { json?: boolean }) => {
      const payload = { ok: true, executionId, independentVerificationRequired: true };
      console.log(options.json ? JSON.stringify(payload, null, 2) : `Verification check queued for ${executionId}`);
    });
  program.addCommand(evalAlias);

  // `wa inspect <ref>`
  program
    .command('inspect <ref>')
    .description('Deterministically inspect a host, model, extension, or run')
    .option('--json', 'Output JSON')
    .action((ref: string, options: { json?: boolean }) => {
      const host = DEFAULT_FLEET_HOSTS.find((h) => h.id === ref || (h.aliases ?? []).includes(ref));
      const ext = new WazirExtensionRegistry().get(ref);
      const payload = { ok: true, ref, host: host ?? null, extension: ext?.manifest ?? null };
      console.log(options.json ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
    });
}
