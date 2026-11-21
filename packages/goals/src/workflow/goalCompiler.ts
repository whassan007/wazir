import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GoalGraphDefinition, GoalTarget, PromptGraphNode, TargetId } from '../contracts.js';
import { criticalPath, topologicalOrder, validateGoalGraph } from '../graph/index.js';
import type { DeclaredCheck } from '../verification/types.js';
import type {
  GoalIntentAnalysis,
  LoopItemSpec,
  LoopPlanSpec,
  WorkflowCompiledBundle,
  WorkflowCompileRequest,
  WorkflowMode,
  WorkflowTargetCheckMap,
} from './contracts.js';

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.wazir', '.next', 'coverage', 'target']);

const GRAPH_DOMAIN_PATTERNS: ReadonlyArray<{ key: string; label: string; executor: string; pattern: RegExp }> = [
  { key: 'architecture', label: 'Architecture & domain contracts', executor: 'architect', pattern: /\b(architecture|platform|schema|contract|spec|design|multiplayer|production-ready|production ready)\b/i },
  { key: 'auth', label: 'Authentication, accounts & identity', executor: 'auth', pattern: /\b(auth|authentication|account|accounts|login|oauth|jwt|session|rbac|identity)\b/i },
  { key: 'database', label: 'Database schema & persistence', executor: 'database', pattern: /\b(database|db|postgres|sqlite|storage|persistence|migration|state|ledger)\b/i },
  { key: 'billing', label: 'Paid accounts & subscriptions', executor: 'billing', pattern: /\b(paid|payment|payments|subscription|subscriptions|billing|stripe|checkout|plan|pricing)\b/i },
  { key: 'multiplayer', label: 'Multiplayer servers & synchronization', executor: 'multiplayer', pattern: /\b(multiplayer|server|servers|socket|websocket|sync|synchronization|realtime|real-time|matchmaking|lobby)\b/i },
  { key: 'backend', label: 'Backend API & services', executor: 'backend', pattern: /\b(api|backend|service|services|endpoint|endpoints|worker|queue|orchestrat)\b/i },
  { key: 'frontend', label: 'Frontend & user experience', executor: 'frontend', pattern: /\b(frontend|ui|web|dashboard|client|portal|interface|view)\b/i },
  { key: 'deploy', label: 'Staging deployment & runtime integration', executor: 'deploy', pattern: /\b(deploy|deployment|staging|release|infra|docker|container|kubernetes|cloudflare)\b/i },
  { key: 'qa', label: 'End-to-end verification & QA suite', executor: 'qa', pattern: /\b(qa|test|tests|verify|validation|playwright|e2e|smoke|audit|production-ready|production ready)\b/i },
];

const LOOP_SIGNAL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'quantifier:every', pattern: /\bevery\b/i },
  { label: 'quantifier:each', pattern: /\beach\b/i },
  { label: 'quantifier:all_items', pattern: /\ball\s+(?:the\s+)?[a-z0-9_-]+(?:s|files|cities|modules|tests|docs|services|endpoints|packages)\b/i },
  { label: 'quantifier:per_item', pattern: /\bper\s+(?:city|file|module|package|service|endpoint|item|record|test)\b/i },
  { label: 'predicate:until', pattern: /\buntil\b/i },
  { label: 'keyword:iterate', pattern: /\b(iterate|repeatedly|loop|across every|across all|one by one)\b/i },
  { label: 'domain:city_collection', pattern: /\b(city|cities|lorecraft)\b/i },
];

const PROD_DEPLOY_PATTERN = /\b(?:deploy|publish|push|release|ship)(?:\s+directly)?\s+(?:to\s+)?prod(?:uction)?\b|\bproduction\s+(?:deploy|deployment|release|publish)\b/i;
const STAGING_ONLY_PATTERN = /\bstaging\b/i;
const UNSAFE_OUTSIDE_WORKSPACE_PATTERN = /(?:^|\s)(?:rm\s+-rf\s+(?:\/|~|\.\.)|(?:delete|wipe|destroy|remove|purge)\s+(?:all\s+)?(?:files\s+)?(?:outside|above|from\s+\/|in\s+\/etc|in\s+~\/)|format\s+\/)/i;

function slugify(input: string, maxLen = 48): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return s || 'workflow';
}

function clampInt(val: number | undefined, fallback: number, min: number, max: number): number {
  if (val === undefined || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(val)));
}

function walkFilesBounded(rootDir: string, maxFiles = 200, maxDepth = 4): string[] {
  const out: string[] = [];
  if (!rootDir || !fs.existsSync(rootDir)) return out;

  const visit = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        visit(abs, depth + 1);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };

  visit(rootDir, 0);
  return out;
}

function tryLoadCityRegistry(workspaceRoot: string): { source: string; items: Array<{ id: string; label: string; path?: string; metadata?: Record<string, unknown> }> } | undefined {
  const candidateJsonFiles = [
    'cities.json',
    'data/cities.json',
    'registry/cities.json',
    'lorecraft/cities.json',
    'src/data/cities.json',
    'world/cities.json',
  ];
  for (const rel of candidateJsonFiles) {
    const abs = path.join(workspaceRoot, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown;
      const rawList = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cities?: unknown[] }).cities)
          ? (parsed as { cities: unknown[] }).cities
          : parsed && typeof parsed === 'object'
            ? Object.entries(parsed as Record<string, unknown>).map(([k, v]) =>
                typeof v === 'object' && v !== null ? { id: k, ...(v as Record<string, unknown>) } : { id: k, value: v },
              )
            : [];
      if (rawList.length > 0) {
        return {
          source: rel,
          items: rawList.map((entry, idx) => {
            if (typeof entry === 'string') {
              return { id: slugify(entry, 32) || `city-${idx + 1}`, label: entry, path: rel };
            }
            const obj = entry as Record<string, unknown>;
            const name = String(obj.name ?? obj.title ?? obj.id ?? `city-${idx + 1}`);
            const id = String(obj.id ?? slugify(name, 32) ?? `city-${idx + 1}`);
            return {
              id,
              label: name,
              path: typeof obj.path === 'string' ? obj.path : rel,
              metadata: obj,
            };
          }),
        };
      }
    } catch {
      // ignore invalid JSON and keep probing
    }
  }

  for (const dirRel of ['cities', 'src/cities', 'lorecraft/cities', 'data/cities']) {
    const absDir = path.join(workspaceRoot, dirRel);
    if (!fs.existsSync(absDir)) continue;
    try {
      const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      const items = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => {
          const base = e.name.replace(/\.(json|ts|js|md|yaml|yml)$/i, '');
          return {
            id: slugify(base, 32),
            label: base,
            path: `${dirRel}/${e.name}`,
          };
        });
      if (items.length > 0) {
        return { source: dirRel, items };
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

export function discoverLoopCollection(
  workspaceRoot: string,
  prompt: string,
  maxIterations = 25,
  explicitItems?: string[],
): LoopPlanSpec {
  const limit = clampInt(maxIterations, 25, 1, 100);
  const completionMatch = prompt.match(/\buntil\s+(.+)$/i);
  const completionPredicate = completionMatch
    ? completionMatch[1]!.trim()
    : 'Every target artifact is non-empty and all verification checks pass cleanly';

  if (explicitItems && explicitItems.length > 0) {
    const items: LoopItemSpec[] = explicitItems.slice(0, limit).map((raw, idx) => ({
      index: idx,
      targetId: `L-${String(idx + 1).padStart(3, '0')}`,
      itemId: slugify(raw, 40) || `item-${idx + 1}`,
      label: raw,
      path: fs.existsSync(path.join(workspaceRoot, raw)) ? raw : undefined,
      kind: 'item',
    }));
    return {
      kind: 'collection',
      collectionSource: 'explicit-items',
      completionPredicate,
      maxIterations: limit,
      maxConcurrency: 1,
      cursor: 0,
      items,
    };
  }

  // 1. Canonical Lorecraft/city registry discovery
  if (/\b(city|cities|lorecraft)\b/i.test(prompt)) {
    const cityReg = tryLoadCityRegistry(workspaceRoot);
    if (cityReg && cityReg.items.length > 0) {
      const sliced = cityReg.items.slice(0, limit);
      return {
        kind: 'collection',
        collectionSource: cityReg.source,
        completionPredicate,
        maxIterations: limit,
        maxConcurrency: 1,
        cursor: 0,
        items: sliced.map((entry, idx) => ({
          index: idx,
          targetId: `L-${String(idx + 1).padStart(3, '0')}`,
          itemId: entry.id,
          label: entry.label,
          path: entry.path,
          kind: 'city',
          metadata: entry.metadata,
        })),
      };
    }
  }

  // 2. Workspace file/module/doc discovery
  const files = walkFilesBounded(workspaceRoot, 200, 4);
  const wantsMd = /\b(markdown|\.md|docs|documentation|readme)\b/i.test(prompt);
  const wantsTests = /\b(tests?|specs?)\b/i.test(prompt) && /\b(every|each|all)\s+(?:test|spec)/i.test(prompt);
  const wantsCode = /\b(files?|modules?|services?|packages?|endpoints?|scripts?)\b/i.test(prompt);

  if (wantsMd || wantsTests || wantsCode) {
    let matched = files;
    if (wantsMd) {
      matched = files.filter((f) => /\.md$/i.test(f));
    } else if (wantsTests) {
      matched = files.filter((f) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(f));
    } else {
      matched = files.filter((f) => /\.(?:[cm]?[jt]sx?|json|py|rs|go|md)$/i.test(f));
    }
    if (matched.length > 0) {
      const sliced = matched.slice(0, limit);
      const kind: LoopItemSpec['kind'] = /\bmodules?\b/i.test(prompt)
        ? 'module'
        : /\bservices?\b/i.test(prompt)
          ? 'service'
          : /\bendpoints?\b/i.test(prompt)
            ? 'endpoint'
            : 'file';
      return {
        kind: 'collection',
        collectionSource: `workspace:${wantsMd ? '*.md' : wantsTests ? '*.test.*' : 'files'}`,
        completionPredicate,
        maxIterations: limit,
        maxConcurrency: 1,
        cursor: 0,
        items: sliced.map((rel, idx) => ({
          index: idx,
          targetId: `L-${String(idx + 1).padStart(3, '0')}`,
          itemId: slugify(rel, 40),
          label: rel,
          path: rel,
          kind,
        })),
      };
    }
  }

  // 3. Explicit count ("3 iterations", "4 passes")
  const countMatch = prompt.match(/\b(\d{1,2})\s+(?:iterations?|times|passes|cycles|steps)\b/i);
  const iterCount = countMatch
    ? Math.min(limit, Math.max(1, Number.parseInt(countMatch[1]!, 10)))
    : Math.min(limit, 3);

  return {
    kind: completionMatch ? 'predicate' : 'bounded_iterations',
    completionPredicate,
    maxIterations: limit,
    maxConcurrency: 1,
    cursor: 0,
    items: Array.from({ length: iterCount }, (_, idx) => ({
      index: idx,
      targetId: `L-${String(idx + 1).padStart(3, '0')}`,
      itemId: `iter-${idx + 1}`,
      label: `Iteration ${idx + 1} of ${iterCount}`,
      kind: 'iteration',
    })),
  };
}

export function analyzeGoalIntent(request: WorkflowCompileRequest): GoalIntentAnalysis {
  const prompt = request.prompt.trim();
  const loopSignals = LOOP_SIGNAL_PATTERNS.filter((p) => p.pattern.test(prompt)).map((p) => p.label);
  const graphMatches = GRAPH_DOMAIN_PATTERNS.filter((d) => d.pattern.test(prompt));
  const graphSignals = graphMatches.map((d) => d.key);

  const policyFlags: string[] = [];
  const requiresApprovalGates: string[] = [];
  const blockedUnsafeActions: string[] = [];

  if (UNSAFE_OUTSIDE_WORKSPACE_PATTERN.test(prompt)) {
    policyFlags.push('unsafe_outside_workspace');
    blockedUnsafeActions.push('Destructive filesystem operation targeting paths outside the active workspace');
  }
  if (PROD_DEPLOY_PATTERN.test(prompt) && !STAGING_ONLY_PATTERN.test(prompt)) {
    policyFlags.push('production_release_gate');
    if (!request.allowProductionDeploy && !request.approveAll) {
      requiresApprovalGates.push('Production deployment requires explicit human approval gate');
    }
  }

  const loopPreview =
    loopSignals.length > 0 || request.requestedMode === 'loop' || request.overrideMode === 'loop' || request.overrideMode === 'hybrid'
      ? discoverLoopCollection(request.workspaceRoot, prompt, request.maxIterations, request.items)
      : undefined;

  let selectedMode: WorkflowMode;
  let overridden = false;
  const reasons: string[] = [];

  if (request.overrideMode) {
    selectedMode = request.overrideMode;
    overridden = true;
    reasons.push(`Execution mode explicitly overridden to '${selectedMode}' by operator/CLI flag.`);
  } else if (request.requestedMode && request.requestedMode !== 'auto') {
    selectedMode = request.requestedMode;
    reasons.push(`Execution mode selected directly via '${selectedMode}' command.`);
  } else {
    const hasLoop = loopSignals.length > 0 && (loopPreview?.items.length ?? 0) >= 2;
    const hasMultiDomainGraph = graphMatches.length >= 3 || (/\bproduction-ready\b|\bproduction ready\b/i.test(prompt) && graphMatches.length >= 2);
    if (hasLoop && hasMultiDomainGraph) {
      selectedMode = 'hybrid';
      reasons.push(
        `Detected both multi-stage dependencies (${graphSignals.join(', ')}) and iterative collection work (${loopSignals.join(', ')}) -> compiled a DAG containing bounded Loop items.`,
      );
    } else if (hasMultiDomainGraph || graphMatches.length >= 2) {
      selectedMode = 'graph';
      reasons.push(
        `Detected multi-domain outcome (${graphSignals.join(', ')}) requiring dependency-ordered milestones and parallel branches -> compiled a DAG Graph.`,
      );
    } else if (loopSignals.length > 0) {
      selectedMode = 'loop';
      reasons.push(
        `Detected iterative/collection criteria (${loopSignals.join(', ')}) -> compiled a bounded Loop over ${loopPreview?.items.length ?? 1} item(s).`,
      );
    } else {
      selectedMode = 'single';
      reasons.push('Detected a focused single-outcome request -> compiled a single independently verified bounded task.');
    }
  }

  if (requiresApprovalGates.length > 0) {
    reasons.push('Production deployment gate flagged with requiresApproval: true.');
  }

  return {
    selectedMode,
    overridden,
    confidence: overridden ? 1.0 : selectedMode === 'single' ? 0.78 : 0.9,
    reasons,
    signals: {
      loopSignals,
      graphSignals,
      iterativeTargetsCount: loopPreview?.items.length ?? 0,
      dependencyCount: selectedMode === 'graph' || selectedMode === 'hybrid' ? Math.max(1, graphMatches.length) : 0,
      policyFlags,
    },
    policyAssessment: {
      localModelFirst: request.localModelFirst ?? true,
      requiresApprovalGates,
      hostedSpendUsd: Math.max(0, request.maxBudgetUsd ?? 0),
      blockedUnsafeActions,
    },
  };
}

function standardExecutionGraph(): { entry: string; nodes: PromptGraphNode[] } {
  const mkRole = (id: string, promptId: string, next: string[]): PromptGraphNode => ({
    id,
    promptId,
    next,
  });
  return {
    entry: 'interpret',
    nodes: [
      mkRole('interpret', 'interpret-v1', ['plan']),
      mkRole('plan', 'plan-v1', ['task_worker', 'loop_worker', 'architect']),
      mkRole('task_worker', 'task-worker-v1', ['verify']),
      mkRole('loop_worker', 'loop-worker-v1', ['verify']),
      mkRole('architect', 'architect-v1', ['verify']),
      mkRole('database', 'database-v1', ['verify']),
      mkRole('auth', 'auth-v1', ['verify']),
      mkRole('billing', 'billing-v1', ['verify']),
      mkRole('multiplayer', 'multiplayer-v1', ['verify']),
      mkRole('backend', 'backend-v1', ['verify']),
      mkRole('frontend', 'frontend-v1', ['verify']),
      mkRole('deploy', 'deploy-v1', ['verify']),
      mkRole('qa', 'qa-v1', ['verify']),
      mkRole('release_gate', 'release-gate-v1', ['verify']),
      mkRole('verify', 'verify-v1', ['repair', 'report']),
      mkRole('repair', 'repair-v1', ['verify']),
      mkRole('report', 'report-v1', []),
    ],
  };
}

function buildTargetChecks(
  targetId: TargetId,
  artifactPath: string,
  verifyCommands: string[] | undefined,
  attachCommands: boolean,
): DeclaredCheck[] {
  const checks: DeclaredCheck[] = [
    {
      id: `${targetId}-non-empty`,
      kind: 'non-empty',
      artifact: artifactPath,
      criterion: '#1',
    },
    {
      id: `${targetId}-evidence-schema`,
      kind: 'json-schema',
      artifact: artifactPath,
      schema: {
        type: 'object',
        required: ['targetId', 'summary', 'completedAt'],
      },
      criterion: '#1',
    },
  ];
  if (attachCommands && verifyCommands && verifyCommands.length > 0) {
    verifyCommands.forEach((cmd, idx) => {
      checks.push({
        id: `${targetId}-cmd-${idx + 1}`,
        kind: 'command',
        command: cmd,
        testSuite: true,
        criterion: '#1',
      });
    });
  }
  return checks;
}

function buildGraphMilestones(
  prompt: string,
  graphSlug: string,
  analysis: GoalIntentAnalysis,
  loopSpec: LoopPlanSpec | undefined,
  verifyCommands: string[] | undefined,
): { targets: GoalTarget[]; checks: WorkflowTargetCheckMap; nestedLoops: Array<{ targetId: TargetId; loop: LoopPlanSpec }> } {
  const matched = GRAPH_DOMAIN_PATTERNS.filter((d) => d.pattern.test(prompt));
  const selectedKeys = new Set(matched.map((m) => m.key));
  if (selectedKeys.size === 0) {
    selectedKeys.add('architecture');
    selectedKeys.add('backend');
    selectedKeys.add('qa');
  } else {
    if (!selectedKeys.has('architecture') && selectedKeys.size >= 2) selectedKeys.add('architecture');
    if (!selectedKeys.has('qa')) selectedKeys.add('qa');
  }

  const targets: GoalTarget[] = [];
  const checks: WorkflowTargetCheckMap = {};
  const nestedLoops: Array<{ targetId: TargetId; loop: LoopPlanSpec }> = [];

  const artifactFor = (id: string) => `.wazir/artifacts/${graphSlug}/${id}.json`;
  const addTarget = (target: GoalTarget, attachCmds = false) => {
    targets.push(target);
    checks[target.id] = buildTargetChecks(target.id, target.artifacts[0]!, verifyCommands, attachCmds);
  };

  // Root milestone: architecture & specification
  const rootIds: TargetId[] = [];
  if (selectedKeys.has('architecture')) {
    const art = artifactFor('G1.architecture');
    addTarget({
      id: 'G1.architecture',
      stage: 'architecture',
      title: `Analyze goal & define architecture contracts for: ${prompt.slice(0, 72)}`,
      dependsOn: [],
      priority: 100,
      executor: 'architect',
      artifacts: [art],
      acceptance: ['Architecture specification and contracts written and verified'],
    });
    rootIds.push('G1.architecture');
  }

  // Optional nested bounded loop items (for Hybrid mode)
  const loopLeafIds: TargetId[] = [];
  if (analysis.selectedMode === 'hybrid' && loopSpec && loopSpec.items.length > 0) {
    for (const item of loopSpec.items) {
      const art = artifactFor(item.targetId);
      addTarget({
        id: item.targetId,
        stage: 'loop_iterations',
        title: `Bounded loop item [${item.index + 1}/${loopSpec.items.length}]: ${item.label}`,
        dependsOn: [...rootIds],
        priority: 90 - Math.min(20, item.index),
        executor: 'loop_worker',
        artifacts: [art],
        acceptance: [`Completed and verified item ${item.label}`],
      });
      loopLeafIds.push(item.targetId);
    }
    nestedLoops.push({ targetId: 'G_LOOP.aggregate', loop: loopSpec });
  }

  // Parallel core workstream milestones
  const coreDeps = loopLeafIds.length > 0 ? loopLeafIds : rootIds;
  const foundationIds: TargetId[] = [];
  const midParallel: Array<{ id: TargetId; stage: string; title: string; executor: string; priority: number }> = [
    { id: 'G2.database', stage: 'foundation', title: 'Implement persistence schema and migrations', executor: 'database', priority: 90 },
    { id: 'G2.auth', stage: 'foundation', title: 'Implement authentication, identity & session policy', executor: 'auth', priority: 90 },
    { id: 'G2.multiplayer', stage: 'foundation', title: 'Implement multiplayer server & state synchronization', executor: 'multiplayer', priority: 88 },
  ];

  for (const spec of midParallel) {
    const key = spec.executor;
    if (selectedKeys.has(key)) {
      const art = artifactFor(spec.id);
      addTarget({
        id: spec.id,
        stage: spec.stage,
        title: spec.title,
        dependsOn: [...coreDeps],
        priority: spec.priority,
        executor: spec.executor,
        artifacts: [art],
        acceptance: [`${spec.title} passes independent checks`],
      });
      foundationIds.push(spec.id);
    }
  }

  // Service / monetization / API layer depending on auth/db where present
  const serviceLayerIds: TargetId[] = [];
  const serviceDeps = foundationIds.length > 0 ? foundationIds : coreDeps;
  if (selectedKeys.has('billing')) {
    const art = artifactFor('G3.billing');
    addTarget({
      id: 'G3.billing',
      stage: 'services',
      title: 'Implement paid accounts, subscriptions & billing controls',
      dependsOn: foundationIds.includes('G2.auth') ? ['G2.auth', ...(foundationIds.includes('G2.database') ? ['G2.database'] : [])] : [...serviceDeps],
      priority: 82,
      executor: 'billing',
      artifacts: [art],
      acceptance: ['Billing and subscription entitlements verified'],
    });
    serviceLayerIds.push('G3.billing');
  }
  if (selectedKeys.has('backend') || (!foundationIds.length && !selectedKeys.has('billing'))) {
    const art = artifactFor('G3.backend');
    addTarget({
      id: 'G3.backend',
      stage: 'services',
      title: 'Implement backend API endpoints & orchestration services',
      dependsOn: [...serviceDeps],
      priority: 80,
      executor: 'backend',
      artifacts: [art],
      acceptance: ['Backend API endpoints verified cleanly'],
    });
    serviceLayerIds.push('G3.backend');
  }

  const allPriorIds = [...foundationIds, ...serviceLayerIds];
  const dependedOnByLater = new Set<TargetId>();
  for (const id of serviceLayerIds) {
    const t = targets.find((item) => item.id === id);
    t?.dependsOn.forEach((d) => dependedOnByLater.add(d));
  }
  const unconsumedFoundations = foundationIds.filter((id) => !dependedOnByLater.has(id));
  const uiDeps = Array.from(new Set([...(serviceLayerIds.length > 0 ? serviceLayerIds : serviceDeps), ...unconsumedFoundations]));
  if (allPriorIds.length === 0 && uiDeps.length === 0 && rootIds.length > 0) {
    uiDeps.push(...rootIds);
  }
  const uiIds: TargetId[] = [];
  if (selectedKeys.has('frontend')) {
    const art = artifactFor('G4.frontend');
    addTarget({
      id: 'G4.frontend',
      stage: 'interface',
      title: 'Implement frontend UI & client integration',
      dependsOn: [...uiDeps],
      priority: 72,
      executor: 'frontend',
      artifacts: [art],
      acceptance: ['Frontend UI builds and renders cleanly'],
    });
    uiIds.push('G4.frontend');
  }

  const integrationDeps = uiIds.length > 0 ? uiIds : uiDeps;
  const deployIds: TargetId[] = [];
  if (selectedKeys.has('deploy')) {
    const art = artifactFor('G5.staging_deploy');
    addTarget({
      id: 'G5.staging_deploy',
      stage: 'deployment',
      title: 'Deploy verified build to authorized staging environment',
      dependsOn: [...integrationDeps],
      priority: 65,
      executor: 'deploy',
      artifacts: [art],
      acceptance: ['Staging deployment artifact verified'],
    });
    deployIds.push('G5.staging_deploy');
  }

  const qaDeps = deployIds.length > 0 ? deployIds : integrationDeps;
  const qaArt = artifactFor('G6.qa');
  addTarget(
    {
      id: 'G6.qa',
      stage: 'verification',
      title: 'Run independent integration & QA acceptance verification',
      dependsOn: [...qaDeps],
      priority: 60,
      executor: 'qa',
      artifacts: [qaArt],
      acceptance: ['Independent QA suite passes all acceptance criteria'],
    },
    true,
  );

  // Explicit human approval gate for production release when requested
  if (analysis.policyAssessment.requiresApprovalGates.length > 0) {
    const prodArt = artifactFor('G7.prod_release_gate');
    addTarget({
      id: 'G7.prod_release_gate',
      stage: 'release_gate',
      title: 'Production release gate (requires explicit human approval)',
      dependsOn: ['G6.qa'],
      priority: 50,
      executor: 'release_gate',
      artifacts: [prodArt],
      acceptance: ['Explicit operator approval recorded prior to production rollout'],
      requiresApproval: true,
    });
  }

  return { targets, checks, nestedLoops };
}

export function compileWorkflow(request: WorkflowCompileRequest): WorkflowCompiledBundle {
  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error('Workflow prompt must be a non-empty string');
  }

  const analysis = analyzeGoalIntent(request);
  const shortHash = createHash('sha256').update(`${prompt}:${Date.now()}`).digest('hex').slice(0, 8);
  const graphName = request.graphName?.trim() || `${analysis.selectedMode}-${slugify(prompt, 32)}-${shortHash}`;
  const projectId = request.projectId?.trim() || 'wazir-default';
  const graphSlug = `${slugify(projectId, 24)}--${slugify(graphName, 40)}`;
  const concurrency = clampInt(
    request.maxConcurrency,
    analysis.selectedMode === 'loop' ? 1 : 3,
    1,
    16,
  );
  const maxRepairs = clampInt(request.maxRepairsPerTask, 3, 0, 10);
  const maxNoProgress = clampInt(request.maxSameActionNoProgress, 2, 1, 10);
  const maxRunMinutes = clampInt(request.maxDurationMinutes, 60, 1, 1440);
  const hostedSpendUsd = Math.max(0, request.maxBudgetUsd ?? 0);

  let targets: GoalTarget[] = [];
  let targetChecks: WorkflowTargetCheckMap = {};
  let loopSpec: LoopPlanSpec | undefined;
  let nestedLoops: Array<{ targetId: TargetId; loop: LoopPlanSpec }> | undefined;

  if (analysis.selectedMode === 'single') {
    const art = `.wazir/artifacts/${graphSlug}/T1.json`;
    targets = [
      {
        id: 'T1',
        stage: 'execute',
        title: prompt.slice(0, 140),
        dependsOn: [],
        priority: 100,
        executor: 'task_worker',
        artifacts: [art],
        acceptance: [`Independently verified completion for: ${prompt.slice(0, 80)}`],
      },
    ];
    targetChecks['T1'] = buildTargetChecks('T1', art, request.verifyCommands, true);
  } else if (analysis.selectedMode === 'loop') {
    loopSpec = discoverLoopCollection(
      request.workspaceRoot,
      prompt,
      request.maxIterations,
      request.items,
    );
    loopSpec.maxConcurrency = concurrency;
    if (request.completionCondition) {
      loopSpec.completionPredicate = request.completionCondition;
    }

    targets = loopSpec.items.map((item, idx) => {
      const art = `.wazir/artifacts/${graphSlug}/${item.targetId}.json`;
      targetChecks[item.targetId] = buildTargetChecks(item.targetId, art, request.verifyCommands, true);
      return {
        id: item.targetId,
        stage: 'loop',
        title: `Loop item ${idx + 1}/${loopSpec!.items.length}: ${item.label}`,
        dependsOn: [],
        priority: Math.max(1, 1000 - idx),
        executor: 'loop_worker',
        artifacts: [art],
        acceptance: [`Completed and verified loop item '${item.label}'`],
      };
    });

    // Optional production gate even in loop mode if explicit production rollout was asked
    if (analysis.policyAssessment.requiresApprovalGates.length > 0) {
      const gateArt = `.wazir/artifacts/${graphSlug}/L-GATE-PROD.json`;
      const allLoopIds = targets.map((t) => t.id);
      targets.push({
        id: 'L-GATE-PROD',
        stage: 'release_gate',
        title: 'Production release gate (requires explicit human approval)',
        dependsOn: allLoopIds,
        priority: 1,
        executor: 'release_gate',
        artifacts: [gateArt],
        acceptance: ['Explicit operator approval recorded prior to production rollout'],
        requiresApproval: true,
      });
      targetChecks['L-GATE-PROD'] = buildTargetChecks('L-GATE-PROD', gateArt, request.verifyCommands, false);
    }
  } else {
    // 'graph' or 'hybrid'
    if (analysis.selectedMode === 'hybrid' || /\b(city|cities|every|each)\b/i.test(prompt)) {
      loopSpec = discoverLoopCollection(
        request.workspaceRoot,
        prompt,
        request.maxIterations,
        request.items,
      );
      loopSpec.maxConcurrency = concurrency;
    }
    const built = buildGraphMilestones(prompt, graphSlug, analysis, loopSpec, request.verifyCommands);
    targets = built.targets;
    targetChecks = built.checks;
    nestedLoops = built.nestedLoops.length > 0 ? built.nestedLoops : undefined;
  }

  const maxTasksPerRun = Math.max(20, targets.length * (maxRepairs + 3));
  const definition: GoalGraphDefinition = {
    schemaVersion: '1.0',
    name: graphName,
    purpose: prompt,
    constitution: {
      objectiveOwner: 'human',
      invariants: [
        'Never mark completed without independent verification',
        'Keep target dependency graph strictly acyclic',
        'Never auto-publish to production without an explicit release approval gate',
      ],
      resourceLimits: {
        maxTasksPerRun,
        maxRepairsPerTask: maxRepairs,
        maxSameActionNoProgress: maxNoProgress,
        maxRunMinutes,
        hostedSpendUsd,
        localModelFirst: request.localModelFirst ?? true,
        maxConcurrentWritersPerWorktree: concurrency,
        maxConcurrentTargets: concurrency,
      },
      allowedUnattended: [
        'discover workspace items and construct execution plan',
        'modify files inside workspace',
        'run compilation, validation, and test suites',
        'deploy to authorized staging when requested',
      ],
      needsApproval: [
        'deploy to production',
        'destructive deletion outside workspace',
        'exceeding configured spend limit',
      ],
    },
    targets,
    executionGraph: standardExecutionGraph(),
  };

  const validation = validateGoalGraph(definition);
  const cp = validation.valid ? criticalPath(definition) : { path: [] as TargetId[], weight: 0 };
  const order = validation.valid ? topologicalOrder(definition) : targets.map((t) => t.id);

  return {
    definition,
    validation,
    plan: {
      format: 1,
      projectId,
      prompt,
      originInterface: request.originInterface ?? 'cli',
      mode: analysis.selectedMode,
      requestedMode: request.overrideMode ? analysis.selectedMode : request.requestedMode ?? analysis.selectedMode,
      overridden: analysis.overridden,
      explanation: analysis,
      dryRun: Boolean(request.dryRun),
      createdBy: request.actor ?? 'user:local',
      workspaceRoot: request.workspaceRoot,
      preferredModel: request.preferredModel,
      preferredComputer: request.computer,
      localModelFirst: request.localModelFirst ?? true,
      allowProductionDeploy: Boolean(request.allowProductionDeploy || request.approveAll),
      loop: loopSpec,
      nestedLoops,
      targetChecks,
      criticalPath: {
        targets: cp.path,
        depth: cp.path.length,
      },
      topologicalOrder: order,
      verifyCommands: request.verifyCommands ?? [],
    },
  };
}
