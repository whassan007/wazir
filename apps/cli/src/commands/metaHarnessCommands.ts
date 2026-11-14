import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildServerAcceptanceTable,
  createDefaultFs5ExecutionPlan,
  findBestHostsForModelSize,
  formatServerAcceptanceTable,
  MetaHarnessService,
  parseExecutionPlanYamlOrJson,
  renderExecutionView,
  renderInfrastructureView,
  serializeExecutionPlanYaml,
  type DeclarativeExecutionPlan,
} from '@wazir/core';
import { discoverAuthorizedSshHost, discoverDetailedLocalHost } from '@wazir/workers';
import type { RookEngine } from '../engine.js';
import { table } from './formatters.js';

export function ensureMetaHarnessService(engine: RookEngine): MetaHarnessService {
  if (engine.metaHarness) {
    return engine.metaHarness;
  }
  const svc = new MetaHarnessService({
    store: engine.store,
    projectRoot: engine.projectRoot,
    configDir: engine.configDir,
    hostDiscoveryDriver: {
      discoverLocalHost: (opts) => discoverDetailedLocalHost(opts),
      discoverSshHost: (opts) => discoverAuthorizedSshHost(opts),
    },
    cliEntrypointPath: process.argv[1],
  });
  engine.metaHarness = svc;
  return svc;
}

export async function hardwareDiscoverCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; detail?: boolean; noInferenceTest?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const result = await svc.discoverInfrastructure({
    testRealInference: !options.noInferenceTest,
  });
  if (options.json) {
    return { code: 0, output: JSON.stringify(result, null, 2) };
  }
  const view = renderInfrastructureView(result.graph, result.acceptanceRows, {
    detail: Boolean(options.detail),
  });
  return { code: 0, output: view };
}

export async function hardwareRefreshCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; detail?: boolean } = {},
): Promise<{ code: number; output: string }> {
  return hardwareDiscoverCommand(svc, options);
}

export async function hardwareListCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; refresh?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const graph = await svc.getCapabilityGraph({ refresh: Boolean(options.refresh) });
  const hosts = Object.values(graph.hosts);
  if (options.json) {
    return { code: 0, output: JSON.stringify(hosts, null, 2) };
  }
  const rows = hosts.map((h) => {
    const gpuSummary =
      h.gpus.length > 0
        ? h.gpus.map((g) => `${g.model} (${(g.availableMemoryGB ?? g.totalMemoryGB).toFixed(1)}/${g.totalMemoryGB.toFixed(1)} GB)`).join(', ')
        : 'none';
    return [
      h.hostId,
      h.machineId.slice(0, 18),
      `${h.os.platform}/${h.os.architecture}`,
      `${h.cpu.brand} (${h.cpu.logicalCores}c)`,
      `${h.memory.availableGB.toFixed(1)}/${h.memory.totalGB.toFixed(1)} GB`,
      gpuSummary,
      h.localWorkerAvailable ? 'local-worker' : 'remote',
      h.provenance.join(','),
    ];
  });
  return {
    code: 0,
    output: table(
      ['HOST', 'MACHINE_ID', 'OS/ARCH', 'CPU', 'RAM (FREE/TOTAL)', 'GPU', 'WORKER', 'PROVENANCE'],
      rows,
    ),
  };
}

export async function hardwareInspectCommand(
  svc: MetaHarnessService,
  hostIdOrAlias?: string,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const data = await svc.inspectHost(hostIdOrAlias);
  if (hostIdOrAlias && !data.host) {
    const msg = `Host '${hostIdOrAlias}' not found in capability graph. Known hosts: ${Object.keys((await svc.getCapabilityGraph()).hosts).join(', ')}`;
    return {
      code: 1,
      output: options.json ? JSON.stringify({ error: msg }, null, 2) : msg,
    };
  }
  if (options.json) {
    return { code: 0, output: JSON.stringify(data, null, 2) };
  }
  const h = data.host;
  if (!h) {
    return hardwareListCommand(svc, {});
  }
  const lines: string[] = [
    `# Physical Host: ${h.hostId} (${h.hostname})`,
    `- **Stable Machine ID**: \`${h.machineId}\``,
    `- **Aliases**: ${h.aliases.join(', ')}`,
    `- **OS / Arch**: ${h.os.platform} ${h.os.release} (${h.os.architecture})`,
    `- **CPU**: ${h.cpu.brand} (${h.cpu.physicalCores ?? h.cpu.logicalCores} physical / ${h.cpu.logicalCores} logical cores, util=${h.cpu.utilizationPercent.toFixed(1)}%)`,
    `- **Memory**: ${h.memory.availableGB.toFixed(2)} GB available / ${h.memory.totalGB.toFixed(2)} GB total (${h.memory.unifiedMemory ? 'Unified Memory' : 'System RAM'}, pressure=${h.memory.pressureLevel})`,
    `- **Disk**: ${h.disk.freeGB.toFixed(1)} GB free / ${h.disk.totalGB.toFixed(1)} GB total`,
    `- **Provenance / Confidence**: ${h.provenance.join(', ')} (${(h.confidence * 100).toFixed(0)}%) — last discovered ${h.lastDiscoveredAt}`,
    `- **GPUs (${h.gpus.length})**:`,
    ...h.gpus.map(
      (g) =>
        `  - \`${g.gpuId}\`: ${g.vendor} ${g.model} — ${(g.availableMemoryGB ?? g.totalMemoryGB).toFixed(2)}/${g.totalMemoryGB.toFixed(2)} GB free (${g.unifiedMemory ? 'shared unified' : 'discrete VRAM'}, util=${g.utilizationPercent ?? 0}%, compute=${g.cudaVersion ? `CUDA ${g.cudaVersion}` : g.metalSupported ? 'Metal' : g.vendor})`,
    ),
    `- **Runtimes (${data.runtimes.length})**:`,
    ...data.runtimes.map((rt) => {
      const ep = data.endpoints.find((e) => e.runtimeId === rt.runtimeId);
      return `  - \`${rt.runtimeId}\` [${rt.role}] (${rt.runtimeType}, running=${rt.running}, acceptance=${ep?.acceptanceState ?? 'UNKNOWN'}, url=${ep?.rawUrl ?? 'n/a'}, visibility=${ep?.visibility ?? 'n/a'})`;
    }),
    `- **Models (${data.models.length})**:`,
    ...data.models.map(
      (m) =>
        `  - \`${m.modelId}\` on \`${m.runtimeId}\` — residency=**${m.residency}**, estWeight=${m.estimatedWeightsGB.toFixed(1)}GB, toolCalling=${m.toolCallingVerified ? 'verified' : m.toolCallingSupported ? 'supported' : 'unverified'}`,
    ),
  ];
  if (h.workloadConflicts.length > 0) {
    lines.push(
      `- **Co-Resident Workload Conflicts (${h.workloadConflicts.length})**:`,
      ...h.workloadConflicts.map(
        (c) => `  - \`${c.processName}\` (${c.kind}, reserved=${c.reservedVramGB.toFixed(1)} GB)`,
      ),
    );
  }
  return { code: 0, output: lines.join('\n') };
}

export async function hardwareTopologyCommand(
  svc: MetaHarnessService,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const graph = await svc.getCapabilityGraph({ refresh: false });
  if (options.json) {
    return { code: 0, output: JSON.stringify(graph, null, 2) };
  }
  const lines: string[] = [
    `# Capability Graph Topology (coordinator=\`${graph.coordinatorHostId}\`, generated=${graph.generatedAt})`,
    `- **1. Physical Hosts**: ${Object.keys(graph.hosts).length} (${Object.keys(graph.hosts).join(', ')})`,
    `- **2. Network Identities**: ${Object.keys(graph.networkIdentities).length}`,
    `- **3. Execution Workers**: ${Object.keys(graph.workers).length}`,
    `- **4. Runtime Processes**: ${Object.keys(graph.runtimeProcesses).length}`,
    `- **5. Inference API Endpoints**: ${Object.keys(graph.endpoints).length}`,
    `- **6. Models (Loaded / Installed)**: ${Object.values(graph.models).filter((m) => m.residency === 'loaded').length} loaded / ${Object.keys(graph.models).length} total`,
    `- **7. Cloud Coding-Agent Providers**: ${Object.keys(graph.cloudProviders).length} (${Object.values(graph.cloudProviders).map((p) => `${p.providerId}:${p.acceptanceState}`).join(', ')})`,
    `- **8. Agent Execution Slots**: ${Object.keys(graph.executionSlots).length}`,
    `- **Configured Secure Transports**: ${Object.values(graph.transports).map((t) => `${t.transportId} (${t.localEndpointUrl} -> ${t.targetHostId}:${t.remoteLoopbackUrl})`).join(', ') || 'none'}`,
  ];
  return { code: 0, output: lines.join('\n') };
}

export async function hardwareCapabilitiesCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; modelBillions?: number } = {},
): Promise<{ code: number; output: string }> {
  const graph = await svc.getCapabilityGraph({ refresh: false });
  const targetB = options.modelBillions ?? 35;
  const recommendations = findBestHostsForModelSize(graph, targetB);
  const plan = await svc.getActivePlan();
  const acceptanceRows = buildServerAcceptanceTable({ graph, plan });
  const payload = {
    coordinatorHostId: graph.coordinatorHostId,
    hosts: Object.values(graph.hosts).map((h) => ({
      hostId: h.hostId,
      machineId: h.machineId,
      availableMemoryGB: h.memory.availableGB,
      totalMemoryGB: h.memory.totalGB,
      gpus: h.gpus,
    })),
    cloudProviders: Object.values(graph.cloudProviders),
    modelFitRecommendations: recommendations,
    acceptanceRows,
  };
  if (options.json) {
    return { code: 0, output: JSON.stringify(payload, null, 2) };
  }
  const lines = [
    formatServerAcceptanceTable(acceptanceRows),
    '',
    `## Best Host Ranking for ${targetB}B Model`,
    ...recommendations.map(
      (r, idx) =>
        `${idx + 1}. **${r.hostId}** — fits=${r.fits}, score=${r.score.toFixed(1)}, usable=${r.usableMemoryGB.toFixed(1)} GB (${r.rationale})`,
    ),
  ];
  return { code: 0, output: lines.join('\n') };
}

export async function hardwareBenchmarkCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; host?: string; maxConcurrency?: number } = {},
): Promise<{ code: number; output: string }> {
  const results = await svc.benchmarkConcurrency({
    hostId: options.host,
    maxConcurrencyBound: options.maxConcurrency ?? 3,
  });
  if (options.json) {
    return { code: 0, output: JSON.stringify(results, null, 2) };
  }
  if (results.length === 0) {
    return { code: 0, output: 'No execution-verified runtimes matched for concurrency benchmarking.' };
  }
  const rows = results.map((r) => [
    r.hostId ?? '—',
    r.runtimeId,
    r.modelId,
    String(r.verifiedSafeConcurrency),
    r.testedConcurrencyLevels.join(','),
    `${r.endToEndLatencyMsP50.toFixed(0)}ms / ${r.endToEndLatencyMsP95.toFixed(0)}ms`,
    r.recoveredAfterLoad ? 'PASS' : 'FAIL',
  ]);
  return {
    code: 0,
    output: table(
      ['HOST', 'RUNTIME', 'MODEL', 'VERIFIED_SAFE_CONC', 'TESTED_LEVELS', 'LATENCY (P50/P95)', 'POST_LOAD_RECOVERY'],
      rows,
    ),
  };
}

export async function discoverFleetModelsCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; host?: string; runtime?: string } = {},
): Promise<{ code: number; output: string }> {
  const discovered = await svc.discoverInfrastructure({ testRealInference: true });
  let models = Object.values(discovered.graph.models);
  if (options.host) {
    models = models.filter((m) => m.hostId === options.host);
  }
  if (options.runtime) {
    models = models.filter((m) => m.runtimeId.includes(options.runtime!));
  }
  if (options.json) {
    return { code: 0, output: JSON.stringify(models, null, 2) };
  }
  const rows = models.map((m) => [
    m.hostId ?? m.providerId ?? '—',
    m.runtimeId,
    m.modelId,
    m.residency.toUpperCase(),
    m.parameterBillions !== undefined ? `${m.parameterBillions}B` : '—',
    `${m.estimatedWeightsGB.toFixed(1)} GB`,
    m.toolCallingVerified ? 'verified' : m.toolCallingSupported ? 'yes' : 'unverified',
  ]);
  return {
    code: 0,
    output: [
      `Discovered ${models.length} model(s) across ${Object.keys(discovered.graph.hosts).length} host(s) (${models.filter((m) => m.residency === 'loaded').length} loaded in memory):`,
      '',
      table(['HOST/PROVIDER', 'RUNTIME', 'MODEL', 'RESIDENCY', 'PARAMS', 'EST_WEIGHT', 'TOOLS'], rows),
    ].join('\n'),
  };
}

export async function runtimesStatusCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; refresh?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const graph = await svc.getCapabilityGraph({ refresh: Boolean(options.refresh) });
  const runtimes = Object.values(graph.runtimeProcesses).map((rt) => {
    const ep = Object.values(graph.endpoints).find((e) => e.runtimeId === rt.runtimeId);
    const loadedCount = Object.values(graph.models).filter(
      (m) => m.runtimeId === rt.runtimeId && m.residency === 'loaded',
    ).length;
    const totalCount = Object.values(graph.models).filter((m) => m.runtimeId === rt.runtimeId).length;
    return {
      runtimeId: rt.runtimeId,
      hostId: rt.hostId,
      role: rt.role,
      runtimeType: rt.runtimeType,
      running: rt.running,
      acceptanceState: ep?.acceptanceState ?? 'UNKNOWN',
      rawUrl: ep?.rawUrl ?? '—',
      visibility: ep?.visibility ?? '—',
      loadedModels: loadedCount,
      installedModels: totalCount,
    };
  });
  if (options.json) {
    return { code: 0, output: JSON.stringify(runtimes, null, 2) };
  }
  return {
    code: 0,
    output: table(
      ['RUNTIME_ID', 'HOST', 'ROLE', 'TYPE', 'RUNNING', 'ACCEPTANCE_STATE', 'ENDPOINT', 'VISIBILITY', 'MODELS (LOADED/TOTAL)'],
      runtimes.map((r) => [
        r.runtimeId,
        r.hostId,
        r.role,
        r.runtimeType,
        r.running ? 'yes' : 'no',
        r.acceptanceState,
        r.rawUrl,
        r.visibility,
        `${r.loadedModels}/${r.installedModels}`,
      ]),
    ),
  };
}

export async function workersStatusCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; refresh?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const graph = await svc.getCapabilityGraph({ refresh: Boolean(options.refresh) });
  const workers = Object.values(graph.workers);
  if (options.json) {
    return { code: 0, output: JSON.stringify(workers, null, 2) };
  }
  return {
    code: 0,
    output: table(
      ['WORKER_ID', 'HOST', 'MACHINE_ID', 'STATUS', 'VERSION', 'BROWSER', 'CAPABILITIES'],
      workers.map((w) => [
        w.workerId,
        w.hostId,
        w.machineId.slice(0, 18),
        w.status,
        w.version,
        w.browserCapable ? 'yes' : 'no',
        w.capabilities.join(','),
      ]),
    ),
  };
}

export async function executionPlanCommand(
  svc: MetaHarnessService,
  goal: string,
  options: {
    scale?: number;
    speedOptimize?: boolean;
    out?: string;
    json?: boolean;
  } = {},
): Promise<{ code: number; output: string }> {
  const totalAgents = options.scale ?? 20;
  const plan = createDefaultFs5ExecutionPlan({
    goal,
    totalAgents,
    speedOptimization: options.speedOptimize ?? totalAgents > 20,
  });
  const planned = await svc.planExecution(plan, {
    refreshDiscovery: plan.spec.discovery.refresh_before_execution,
  });
  if (options.out) {
    const outPath = path.resolve(options.out);
    writeFileSync(outPath, serializeExecutionPlanYaml(planned.plan), 'utf8');
  }
  if (options.json) {
    return { code: 0, output: JSON.stringify(planned, null, 2) };
  }
  const execView = renderExecutionView(planned.plan, planned.resolved.poolQuantities, [], undefined, {});
  return {
    code: 0,
    output: [execView, '', formatServerAcceptanceTable(planned.acceptanceRows)].join('\n'),
  };
}

export async function executionRunCommand(
  svc: MetaHarnessService,
  options: {
    planPath?: string;
    goal?: string;
    scale?: number;
    speedOptimize?: boolean;
    workspace?: string;
    json?: boolean;
  } = {},
): Promise<{ code: number; output: string }> {
  let plan: DeclarativeExecutionPlan;
  if (options.planPath) {
    const absPlan = path.resolve(options.planPath);
    if (!existsSync(absPlan)) {
      const candidates = [
        path.resolve(process.cwd(), 'examples', options.planPath),
        path.resolve((svc as unknown as { projectRoot?: string }).projectRoot ?? process.cwd(), 'examples', options.planPath),
      ];
      const found = candidates.find((c) => existsSync(c));
      if (!found) {
        const err = `ExecutionPlan file not found: ${options.planPath}`;
        return { code: 1, output: options.json ? JSON.stringify({ error: err }, null, 2) : err };
      }
      plan = parseExecutionPlanYamlOrJson(readFileSync(found, 'utf8'));
    } else {
      plan = parseExecutionPlanYamlOrJson(readFileSync(absPlan, 'utf8'));
    }
    if (options.scale !== undefined) {
      plan.spec.execution.total_agents = options.scale;
    }
    if (options.speedOptimize !== undefined) {
      plan.spec.execution.speed_optimization = options.speedOptimize;
    }
    if (options.goal) {
      plan.spec.goal = options.goal;
    }
  } else {
    const totalAgents = options.scale ?? 20;
    plan = createDefaultFs5ExecutionPlan({
      goal: options.goal ?? 'Execute a distributed Forge Sovereign-5 software engineering task',
      totalAgents,
      speedOptimization: options.speedOptimize ?? totalAgents > 20,
    });
  }

  const executed = await svc.runExecutionPlan(plan, {
    workspaceDir: options.workspace,
    executeRealInference: true,
  });

  if (options.json) {
    return { code: 0, output: JSON.stringify(executed.liveReport, null, 2) };
  }
  const execView = renderExecutionView(
    executed.plan,
    executed.quantities,
    executed.tasks,
    executed.reconciliation,
    {},
  );
  return {
    code: 0,
    output: [execView, '', formatServerAcceptanceTable(executed.acceptanceRows)].join('\n'),
  };
}

export async function executionStatusCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; detail?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const status = await svc.getExecutionStatus({ detail: Boolean(options.detail) });
  if (options.json) {
    return {
      code: 0,
      output: JSON.stringify(
        {
          plan: status.plan,
          quantities: status.quantities,
          tasksCount: status.tasks.length,
          acceptanceRows: status.acceptanceRows,
          reconciliation: status.reconciliation,
        },
        null,
        2,
      ),
    };
  }
  return { code: 0, output: status.renderedView };
}

export async function executionReportCommand(
  svc: MetaHarnessService,
  options: { json?: boolean; out?: string } = {},
): Promise<{ code: number; output: string }> {
  const report = await svc.getExecutionReport();
  const formatted = JSON.stringify(report, null, 2);
  if (options.out) {
    writeFileSync(path.resolve(options.out), formatted, 'utf8');
  }
  if (options.json) {
    return { code: 0, output: formatted };
  }
  const lines = [
    `# Execution Provenance Report (\`${report.plan}\`)`,
    `- **Report Mode**: \`${report.reportMode}\``,
    `- **Generated At**: ${report.generatedAt}`,
    `- **Allocation**: requested=${report.allocation.requested_agents}, assigned=${report.allocation.assigned_agents}, claude=${report.pools['claude']?.target_share ?? 0}%`,
    `- **Qualification Status**: \`${report.qualification.status}\``,
    '',
    formatted,
  ];
  return { code: 0, output: lines.join('\n') };
}

export async function qualifyMetaHarnessCommand(
  svc: MetaHarnessService,
  scope: 'all' | 'journeys' | 'faults' | 'acceptance' = 'all',
  options: { json?: boolean; detail?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const res = await svc.runQualification(scope);
  const allPassed = res.acceptanceTests.every((t) => t.passed);
  if (options.json) {
    return {
      code: allPassed ? 0 : 1,
      output: JSON.stringify(
        {
          journeys: res.journeys,
          faults: res.faults,
          acceptanceTests: res.acceptanceTests,
        },
        null,
        2,
      ),
    };
  }
  return { code: allPassed ? 0 : 1, output: res.renderedView };
}
