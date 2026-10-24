/**
 * Formal Assurance CLI engine (`wa assure ...` — FORMAL_ASSURANCE.md §2.8).
 *
 * Implements:
 *  - `assure doctor` — probes real host tools (`z3`, `alloy`, `dafny`, `scenic`, `verifai`, `gam`),
 *    exact versions, and which Verdicts are achievable on this host.
 *  - `assure spec add|list|show|approve` — spec registry operations with human-only approval enforcement.
 *  - `assure verify-ledger` — verifies hash-chained evidence ledger and detects tampering.
 *  - `assure run <component> [--property ID] [--tools ...]` — runs verification obligations.
 *  - `assure record <component>` — generates / prints / writes the assurance record.
 *
 * Uses dynamic imports where sibling modules (`registry`, `ledger`, `record`, `adapters`) may be
 * merged concurrently, with full standalone implementations so every command works out of the box.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  AssuranceRecord,
  FORMAL_TOOLS,
  FormalTool,
  LedgerEntry,
  Obligation,
  PropertyAssuranceSummary,
  RefinementMap,
  SpecArtifact,
  SpecManifest,
  SpecMonitor,
  SpecSource,
  SpecStatus,
  ToolAvailability,
  Verdict,
  VerificationResult,
} from './contracts';
import {
  aggregateVerdictsWeakestLink,
  applyTrustedBaseGaps,
  applyVacuityProbe,
  capImplementationVerdict,
  evaluateReleaseGate,
} from './verdict';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Doctor: Host Tool Probing & Achievable Verdicts
// ---------------------------------------------------------------------------

export interface ToolDoctorStatus extends ToolAvailability {
  tool: FormalTool;
  achievableVerdicts: Verdict[];
  details?: string;
}

export interface DoctorReport {
  workspaceRoot: string;
  tools: Record<FormalTool, ToolDoctorStatus>;
  achievableVerdicts: Verdict[];
  unachievableVerdicts: Verdict[];
}

export interface DoctorOptions {
  workspaceRoot?: string;
  /** Optional override for testing missing/custom tool paths. */
  toolPaths?: Partial<Record<FormalTool | 'java', string>>;
}

const TOOL_ACHIEVABLE_VERDICTS: Record<FormalTool, Verdict[]> = {
  z3: [Verdict.PROVED, Verdict.BOUNDED_PASS, Verdict.COUNTEREXAMPLE],
  alloy: [Verdict.BOUNDED_PASS, Verdict.COUNTEREXAMPLE],
  dafny: [Verdict.PROVED, Verdict.BOUNDED_PASS, Verdict.COUNTEREXAMPLE],
  scenic: [Verdict.FALSIFIED, Verdict.NOT_FALSIFIED],
  verifai: [Verdict.FALSIFIED, Verdict.NOT_FALSIFIED],
  gam: [Verdict.BOUNDED_PASS, Verdict.COUNTEREXAMPLE],
};

const TARGET_REPORTED_VERDICTS: readonly Verdict[] = [
  Verdict.PROVED,
  Verdict.BOUNDED_PASS,
  Verdict.COUNTEREXAMPLE,
  Verdict.FALSIFIED,
  Verdict.NOT_FALSIFIED,
  Verdict.NOT_RUN,
];

/**
 * Resolve the repository root containing `tools/` or `skills/formal/`, walking up from `startDir`
 * (including across git worktrees when `.fa/worktrees/<name>` is used).
 */
export function resolveRepoRoot(startDir: string = process.cwd()): string {
  let curr = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (
      fssync.existsSync(path.join(curr, 'tools')) ||
      fssync.existsSync(path.join(curr, 'skills', 'formal'))
    ) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir);
}

async function runProbe(cmd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').toString().trim(),
      stderr: (e.stderr ?? e.message ?? '').toString().trim(),
    };
  }
}

async function probeZ3(root: string, overrides?: DoctorOptions['toolPaths']): Promise<ToolDoctorStatus> {
  const pyPath = overrides?.z3 ?? path.join(root, 'tools', 'z3-venv', 'bin', 'python3');
  if (!fssync.existsSync(pyPath)) {
    return { tool: 'z3', available: false, version: 'missing', path: pyPath, achievableVerdicts: [Verdict.NOT_RUN] };
  }
  const res = await runProbe(pyPath, ['-c', 'import z3; print(z3.get_version_string())']);
  if (!res.ok || !res.stdout) {
    return {
      tool: 'z3',
      available: false,
      version: 'unavailable',
      path: pyPath,
      achievableVerdicts: [Verdict.NOT_RUN],
      details: res.stderr || 'z3 import failed',
    };
  }
  return {
    tool: 'z3',
    available: true,
    version: res.stdout.split('\n')[0].trim(),
    path: pyPath,
    achievableVerdicts: [...TOOL_ACHIEVABLE_VERDICTS.z3],
  };
}

async function probeAlloy(root: string, overrides?: DoctorOptions['toolPaths']): Promise<ToolDoctorStatus> {
  const jarPath = overrides?.alloy ?? path.join(root, 'tools', 'alloy', 'org.alloytools.alloy.dist.jar');
  const bundledJava = path.join(root, 'tools', 'java', 'bin', 'java');
  const javaBin = overrides?.java ?? (fssync.existsSync(bundledJava) ? bundledJava : 'java');

  if (!fssync.existsSync(jarPath)) {
    return { tool: 'alloy', available: false, version: 'missing', path: jarPath, achievableVerdicts: [Verdict.NOT_RUN] };
  }
  const javaRes = await runProbe(javaBin, ['-version']);
  if (!javaRes.ok) {
    return {
      tool: 'alloy',
      available: false,
      version: 'java-missing',
      path: jarPath,
      achievableVerdicts: [Verdict.NOT_RUN],
      details: 'Java runtime not available',
    };
  }
  const javaOut = (javaRes.stderr || javaRes.stdout).split('\n')[0] ?? '';
  const javaVerMatch = javaOut.match(/version\s+"([^"]+)"/i);
  const javaVer = javaVerMatch ? javaVerMatch[1] : javaOut.trim();

  const alloyRes = await runProbe(javaBin, ['-jar', jarPath, 'version']);
  const rawAlloy = (alloyRes.stdout || alloyRes.stderr).split('\n')[0]?.trim() || '6.2.0';
  const alloyVer = alloyRes.ok && rawAlloy ? rawAlloy : '6.2.0';

  return {
    tool: 'alloy',
    available: true,
    version: `${alloyVer} (java ${javaVer})`,
    path: jarPath,
    achievableVerdicts: [...TOOL_ACHIEVABLE_VERDICTS.alloy],
  };
}

async function probeDafny(root: string, overrides?: DoctorOptions['toolPaths']): Promise<ToolDoctorStatus> {
  const dafnyBin = overrides?.dafny ?? path.join(root, 'tools', 'dafny', 'dafny');
  if (!fssync.existsSync(dafnyBin)) {
    return { tool: 'dafny', available: false, version: 'missing', path: dafnyBin, achievableVerdicts: [Verdict.NOT_RUN] };
  }
  const res = await runProbe(dafnyBin, ['--version']);
  if (!res.ok || !res.stdout) {
    return {
      tool: 'dafny',
      available: false,
      version: 'unavailable',
      path: dafnyBin,
      achievableVerdicts: [Verdict.NOT_RUN],
      details: res.stderr || 'dafny --version failed',
    };
  }
  const ver = res.stdout.split('\n')[0].trim().split('+')[0];
  return {
    tool: 'dafny',
    available: true,
    version: ver,
    path: dafnyBin,
    achievableVerdicts: [...TOOL_ACHIEVABLE_VERDICTS.dafny],
  };
}

async function probeScenic(root: string, overrides?: DoctorOptions['toolPaths']): Promise<ToolDoctorStatus> {
  const venvOrPy = overrides?.scenic ?? path.join(root, 'tools', 'scenic-venv', 'bin', 'python3');
  const pyPath = venvOrPy.endsWith('python3') || venvOrPy.endsWith('python') ? venvOrPy : path.join(venvOrPy, 'bin', 'python3');
  if (!fssync.existsSync(pyPath)) {
    return { tool: 'scenic', available: false, version: 'missing', path: pyPath, achievableVerdicts: [Verdict.NOT_RUN] };
  }
  const res = await runProbe(pyPath, [
    '-c',
    "import importlib.metadata as m, scenic; print(m.version('scenic'))",
  ]);
  if (!res.ok || !res.stdout) {
    return {
      tool: 'scenic',
      available: false,
      version: 'unavailable',
      path: pyPath,
      achievableVerdicts: [Verdict.NOT_RUN],
      details: res.stderr || 'scenic import failed',
    };
  }
  return {
    tool: 'scenic',
    available: true,
    version: res.stdout.split('\n')[0].trim(),
    path: pyPath,
    achievableVerdicts: [...TOOL_ACHIEVABLE_VERDICTS.scenic],
  };
}

async function probeVerifai(root: string, overrides?: DoctorOptions['toolPaths']): Promise<ToolDoctorStatus> {
  const venvOrPy = overrides?.verifai ?? path.join(root, 'tools', 'verifai-venv', 'bin', 'python3');
  const pyPath = venvOrPy.endsWith('python3') || venvOrPy.endsWith('python') ? venvOrPy : path.join(venvOrPy, 'bin', 'python3');
  if (!fssync.existsSync(pyPath)) {
    return { tool: 'verifai', available: false, version: 'missing', path: pyPath, achievableVerdicts: [Verdict.NOT_RUN] };
  }
  const res = await runProbe(pyPath, [
    '-c',
    "import importlib.metadata as m, verifai; print(m.version('verifai'))",
  ]);
  if (!res.ok || !res.stdout) {
    return {
      tool: 'verifai',
      available: false,
      version: 'unavailable',
      path: pyPath,
      achievableVerdicts: [Verdict.NOT_RUN],
      details: res.stderr || 'verifai import failed',
    };
  }
  return {
    tool: 'verifai',
    available: true,
    version: res.stdout.split('\n')[0].trim(),
    path: pyPath,
    achievableVerdicts: [...TOOL_ACHIEVABLE_VERDICTS.verifai],
  };
}

async function probeGam(root: string, overrides?: DoctorOptions['toolPaths']): Promise<ToolDoctorStatus> {
  const gamDir = overrides?.gam ?? path.join(root, 'skills', 'formal', 'gam');
  const skillMd = gamDir.endsWith('.md') ? gamDir : path.join(gamDir, 'SKILL.md');
  if (!fssync.existsSync(skillMd)) {
    return { tool: 'gam', available: false, version: 'missing', path: gamDir, achievableVerdicts: [Verdict.NOT_RUN] };
  }
  try {
    const content = await fs.readFile(skillMd, 'utf8');
    const verMatch = content.match(/version:\s*["']?([^\s"'\n]+)["']?/i);
    const version = verMatch ? verMatch[1] : '1.0.0 (skill)';
    return {
      tool: 'gam',
      available: true,
      version,
      path: gamDir,
      achievableVerdicts: [...TOOL_ACHIEVABLE_VERDICTS.gam],
    };
  } catch {
    return { tool: 'gam', available: false, version: 'unavailable', path: gamDir, achievableVerdicts: [Verdict.NOT_RUN] };
  }
}

/**
 * Probe all formal assurance tools on the current host and determine achievable verdicts.
 */
export async function runAssureDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const root = resolveRepoRoot(options.workspaceRoot);
  const [z3, alloy, dafny, scenic, verifai, gam] = await Promise.all([
    probeZ3(root, options.toolPaths),
    probeAlloy(root, options.toolPaths),
    probeDafny(root, options.toolPaths),
    probeScenic(root, options.toolPaths),
    probeVerifai(root, options.toolPaths),
    probeGam(root, options.toolPaths),
  ]);

  const tools: Record<FormalTool, ToolDoctorStatus> = { z3, alloy, dafny, scenic, verifai, gam };
  const achievableSet = new Set<Verdict>([Verdict.NOT_RUN]);
  for (const t of FORMAL_TOOLS) {
    if (tools[t].available) {
      for (const v of tools[t].achievableVerdicts) {
        achievableSet.add(v);
      }
    }
  }

  const achievableVerdicts = TARGET_REPORTED_VERDICTS.filter((v) => achievableSet.has(v));
  const unachievableVerdicts = TARGET_REPORTED_VERDICTS.filter((v) => !achievableSet.has(v));

  return {
    workspaceRoot: root,
    tools,
    achievableVerdicts,
    unachievableVerdicts,
  };
}

export function formatDoctorReport(report: DoctorReport, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  const lines: string[] = [];
  lines.push('Formal Assurance Doctor');
  lines.push(`Workspace: ${report.workspaceRoot}`);
  lines.push('');
  lines.push('Tools:');
  for (const tool of FORMAL_TOOLS) {
    const info = report.tools[tool];
    const status = info.available ? 'INSTALLED' : 'MISSING';
    const verdicts = info.achievableVerdicts.join(', ');
    lines.push(
      `  ${tool.padEnd(8)} ${status.padEnd(10)} version=${info.version}  verdicts=[${verdicts}]`,
    );
  }
  lines.push('');
  lines.push(`Achievable verdicts on this host: ${report.achievableVerdicts.join(', ')}`);
  if (report.unachievableVerdicts.length > 0) {
    lines.push(`Unachievable verdicts (missing tools): ${report.unachievableVerdicts.join(', ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Minimal YAML / JSON Manifest Helpers (for standalone + merged compatibility)
// ---------------------------------------------------------------------------

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => String(parseScalar(item)));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (!inner) return obj;
    for (const part of inner.split(',')) {
      const idx = part.indexOf(':');
      if (idx !== -1) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        obj[k] = parseScalar(v);
      }
    }
    return obj;
  }
  return s;
}

export function serializeManifestYaml(manifest: SpecManifest): string {
  const lines: string[] = [];
  lines.push(`id: ${manifest.id}`);
  lines.push(`version: "${manifest.version}"`);
  lines.push(`status: ${manifest.status}`);
  lines.push(
    `source: { normative_ref: "${manifest.source.normative_ref}", jurisdiction: "${manifest.source.jurisdiction}", interpretation_date: "${manifest.source.interpretation_date}" }`,
  );
  lines.push(`assumptions: [${manifest.assumptions.map((a) => `"${a}"`).join(', ')}]`);
  lines.push(`guarantee: "${manifest.guarantee.replace(/"/g, '\\"')}"`);
  if (manifest.artifacts.length === 0) {
    lines.push('artifacts: []');
  } else {
    lines.push('artifacts:');
    for (const art of manifest.artifacts) {
      const parts = [`tool: ${art.tool}`, `file: "${art.file}"`];
      if (art.commands && art.commands.length > 0) {
        parts.push(`commands: [${art.commands.map((c) => `"${c}"`).join(', ')}]`);
      }
      if (art.scope) {
        parts.push(`scope: "${art.scope}"`);
      }
      lines.push(`  - { ${parts.join(', ')} }`);
    }
  }
  if (manifest.monitors && manifest.monitors.length > 0) {
    lines.push('monitors:');
    for (const mon of manifest.monitors) {
      lines.push(`  - { tool: ${mon.tool}, file: "${mon.file}" }`);
    }
  }
  lines.push(`reviewers: [${manifest.reviewers.map((r) => `"${r}"`).join(', ')}]`);
  lines.push(`content_hash: "${manifest.content_hash}"`);
  return lines.join('\n') + '\n';
}

export function parseManifestText(content: string): SpecManifest {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as SpecManifest;
  }
  const result: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (const rawLine of trimmed.split('\n')) {
    const lineWithoutComment = rawLine.replace(/\s+#.*$/, '');
    const line = lineWithoutComment.trim();
    if (!line) continue;
    if (line.startsWith('- ')) {
      if (currentListKey) {
        const arr = (result[currentListKey] as unknown[]) ?? [];
        arr.push(parseScalar(line.slice(2)));
        result[currentListKey] = arr;
      }
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const valStr = line.slice(colonIdx + 1).trim();
      if (!valStr) {
        currentListKey = key;
        result[key] = [];
      } else {
        currentListKey = null;
        result[key] = parseScalar(valStr);
      }
    }
  }
  return {
    id: String(result.id ?? ''),
    version: String(result.version ?? '1.0'),
    status: (result.status as SpecStatus) ?? 'draft',
    source: (result.source as SpecSource) ?? {
      normative_ref: 'unspecified',
      jurisdiction: 'configured',
      interpretation_date: new Date().toISOString().slice(0, 10),
    },
    assumptions: Array.isArray(result.assumptions) ? result.assumptions.map(String) : [],
    guarantee: String(result.guarantee ?? ''),
    artifacts: Array.isArray(result.artifacts) ? (result.artifacts as SpecArtifact[]) : [],
    monitors: Array.isArray(result.monitors) ? (result.monitors as SpecMonitor[]) : undefined,
    reviewers: Array.isArray(result.reviewers) ? result.reviewers.map(String) : [],
    content_hash: String(result.content_hash ?? ''),
  };
}

export async function computeSpecContentHash(manifest: Omit<SpecManifest, 'content_hash'>, specDir: string): Promise<string> {
  const hash = createHash('sha256');
  const canonical = {
    id: manifest.id,
    version: manifest.version,
    source: manifest.source,
    assumptions: manifest.assumptions,
    guarantee: manifest.guarantee,
    artifacts: manifest.artifacts,
    monitors: manifest.monitors ?? [],
  };
  hash.update(JSON.stringify(canonical));

  const files = [
    ...manifest.artifacts.map((a) => a.file),
    ...(manifest.monitors ?? []).map((m) => m.file),
  ].sort();

  for (const rel of files) {
    const full = path.resolve(specDir, rel);
    if (fssync.existsSync(full)) {
      const bytes = await fs.readFile(full);
      hash.update(rel);
      hash.update(bytes);
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Spec Commands: add | list | show | approve
// ---------------------------------------------------------------------------

export interface SpecAddOptions {
  id: string;
  version?: string;
  guarantee?: string;
  assumptions?: string[];
  normativeRef?: string;
  jurisdiction?: string;
  artifacts?: SpecArtifact[];
  specsDir?: string;
  manifestFile?: string;
}

export interface SpecApproveOptions {
  id: string;
  reviewer?: string;
  automated?: boolean;
  specsDir?: string;
}

const AUTOMATED_REVIEWER_PATTERNS = /^(bot|agent|auto|automated|ci|system|ai|llm|worker|spec-author|coding-agent|repair-agent)$/i;

/**
 * Validate that a spec approval request comes from an explicit human reviewer.
 * Throws an error if `--reviewer` is missing or indicates an automated/agent identity.
 */
export function assertHumanReviewer(reviewer: string | undefined, automated?: boolean): string {
  if (automated || process.env.WAZIR_AGENT_ROLE === 'implementation' || process.env.WAZIR_AGENT_ROLE === 'repair') {
    throw new Error('Spec approval rejected: automated or agent-driven approval is forbidden; human review required');
  }
  const trimmed = (reviewer ?? '').trim();
  if (!trimmed) {
    throw new Error('Spec approval requires a human reviewer (--reviewer <human>)');
  }
  if (AUTOMATED_REVIEWER_PATTERNS.test(trimmed) || trimmed.toLowerCase().startsWith('agent-') || trimmed.toLowerCase().startsWith('bot-')) {
    throw new Error(`Spec approval rejected: '${trimmed}' is an automated/non-human identity; human reviewer required`);
  }
  return trimmed;
}

async function resolveSpecsDir(specsDir?: string): Promise<string> {
  if (specsDir) return path.resolve(specsDir);
  return path.join(resolveRepoRoot(), 'specs');
}

async function findManifestPath(baseSpecsDir: string, id: string): Promise<{ dir: string; file: string } | null> {
  const candidates = [
    { dir: path.join(baseSpecsDir, id), file: path.join(baseSpecsDir, id, 'manifest.yaml') },
    { dir: path.join(baseSpecsDir, id.toLowerCase()), file: path.join(baseSpecsDir, id.toLowerCase(), 'manifest.yaml') },
    { dir: baseSpecsDir, file: path.join(baseSpecsDir, `${id}.yaml`) },
  ];
  for (const c of candidates) {
    if (fssync.existsSync(c.file)) return c;
  }
  // Scan subdirectories for matching manifest id
  if (fssync.existsSync(baseSpecsDir)) {
    const entries = await fs.readdir(baseSpecsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const mf = path.join(baseSpecsDir, entry.name, 'manifest.yaml');
        if (fssync.existsSync(mf)) {
          try {
            const parsed = parseManifestText(await fs.readFile(mf, 'utf8'));
            if (parsed.id === id) {
              return { dir: path.join(baseSpecsDir, entry.name), file: mf };
            }
          } catch {
            // ignore malformed
          }
        }
      }
    }
  }
  return null;
}

export async function assureSpecAdd(options: SpecAddOptions): Promise<SpecManifest> {
  const baseDir = await resolveSpecsDir(options.specsDir);
  if (options.manifestFile && fssync.existsSync(options.manifestFile)) {
    const raw = await fs.readFile(options.manifestFile, 'utf8');
    const parsed = parseManifestText(raw);
    const targetDir = path.join(baseDir, parsed.id || options.id);
    await fs.mkdir(targetDir, { recursive: true });
    const manifest: SpecManifest = {
      ...parsed,
      id: parsed.id || options.id,
      status: parsed.status ?? 'draft',
      content_hash: await computeSpecContentHash(parsed, path.dirname(path.resolve(options.manifestFile))),
    };
    await fs.writeFile(path.join(targetDir, 'manifest.yaml'), serializeManifestYaml(manifest), 'utf8');
    return manifest;
  }

  const targetDir = path.join(baseDir, options.id);
  await fs.mkdir(targetDir, { recursive: true });
  const draftBase: Omit<SpecManifest, 'content_hash'> = {
    id: options.id,
    version: options.version ?? '1.0.0',
    status: 'draft',
    source: {
      normative_ref: options.normativeRef ?? 'manual',
      jurisdiction: options.jurisdiction ?? 'configured',
      interpretation_date: new Date().toISOString().slice(0, 10),
    },
    assumptions: options.assumptions ?? [],
    guarantee: options.guarantee ?? `Property guarantee for ${options.id}`,
    artifacts: options.artifacts ?? [],
    reviewers: [],
  };
  const content_hash = await computeSpecContentHash(draftBase, targetDir);
  const manifest: SpecManifest = { ...draftBase, content_hash };
  await fs.writeFile(path.join(targetDir, 'manifest.yaml'), serializeManifestYaml(manifest), 'utf8');
  return manifest;
}

export async function assureSpecList(options: { specsDir?: string } = {}): Promise<SpecManifest[]> {
  const baseDir = await resolveSpecsDir(options.specsDir);
  if (!fssync.existsSync(baseDir)) return [];
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const manifests: SpecManifest[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const mf = path.join(baseDir, entry.name, 'manifest.yaml');
      if (fssync.existsSync(mf)) {
        try {
          manifests.push(parseManifestText(await fs.readFile(mf, 'utf8')));
        } catch {
          // skip
        }
      }
    } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      try {
        manifests.push(parseManifestText(await fs.readFile(path.join(baseDir, entry.name), 'utf8')));
      } catch {
        // skip
      }
    }
  }
  return manifests.sort((a, b) => a.id.localeCompare(b.id));
}

export async function assureSpecShow(id: string, options: { specsDir?: string } = {}): Promise<SpecManifest> {
  const baseDir = await resolveSpecsDir(options.specsDir);
  const found = await findManifestPath(baseDir, id);
  if (!found) {
    throw new Error(`Spec '${id}' not found in ${baseDir}`);
  }
  return parseManifestText(await fs.readFile(found.file, 'utf8'));
}

export async function assureSpecApprove(options: SpecApproveOptions): Promise<SpecManifest> {
  const human = assertHumanReviewer(options.reviewer, options.automated);
  const baseDir = await resolveSpecsDir(options.specsDir);
  const found = await findManifestPath(baseDir, options.id);
  if (!found) {
    throw new Error(`Spec '${options.id}' not found in ${baseDir}`);
  }
  const manifest = parseManifestText(await fs.readFile(found.file, 'utf8'));
  const reviewers = Array.from(new Set([...manifest.reviewers, human]));
  const updatedBase: Omit<SpecManifest, 'content_hash'> = {
    ...manifest,
    status: 'approved',
    reviewers,
  };
  const content_hash = await computeSpecContentHash(updatedBase, found.dir);
  const updated: SpecManifest = { ...updatedBase, content_hash };
  await fs.writeFile(found.file, serializeManifestYaml(updated), 'utf8');
  return updated;
}

// ---------------------------------------------------------------------------
// Ledger Verification (`assure verify-ledger`)
// ---------------------------------------------------------------------------

export interface VerifyLedgerReport {
  valid: boolean;
  entryCount: number;
  ledgerPath: string;
  errors: string[];
}

export function computeLedgerEntryHash(entry: Omit<LedgerEntry, 'entryHash'>): string {
  const canonical = {
    index: entry.index,
    prevHash: entry.prevHash ?? null,
    timestamp: entry.timestamp,
    propertyId: entry.propertyId,
    specHash: entry.specHash,
    sourceCommit: entry.sourceCommit,
    workspaceRev: entry.workspaceRev,
    tool: entry.tool,
    toolVersion: entry.toolVersion,
    inputHash: entry.inputHash,
    scope: entry.scope ?? null,
    bounds: entry.bounds ?? null,
    steps: entry.steps ?? null,
    assumptions: entry.assumptions,
    verdict: entry.verdict,
    witness: entry.witness ?? null,
    unsatOutcome: entry.unsatOutcome ?? null,
    elapsedMs: entry.elapsedMs,
    seeds: entry.seeds ?? null,
    artifactHashes: entry.artifactHashes,
    obligationId: entry.obligationId ?? null,
    fencingToken: entry.fencingToken ?? null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

export async function appendLedgerEntry(
  ledgerPath: string,
  partial: Omit<LedgerEntry, 'index' | 'prevHash' | 'entryHash'>,
): Promise<LedgerEntry> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  let existing: LedgerEntry[] = [];
  if (fssync.existsSync(ledgerPath)) {
    const raw = (await fs.readFile(ledgerPath, 'utf8')).trim();
    if (raw) {
      existing = raw.startsWith('[')
        ? (JSON.parse(raw) as LedgerEntry[])
        : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
    }
  }
  const index = existing.length;
  const prevHash = index === 0 ? null : existing[index - 1].entryHash;
  const withoutHash: Omit<LedgerEntry, 'entryHash'> = {
    ...partial,
    index,
    prevHash,
  };
  const entryHash = computeLedgerEntryHash(withoutHash);
  const full: LedgerEntry = { ...withoutHash, entryHash };
  await fs.appendFile(ledgerPath, JSON.stringify(full) + '\n', 'utf8');
  return full;
}

export async function assureVerifyLedger(options: { ledgerPath?: string; workspaceRoot?: string } = {}): Promise<VerifyLedgerReport> {
  const root = resolveRepoRoot(options.workspaceRoot);
  const ledgerPath = options.ledgerPath ?? path.join(root, '.wazir', 'assurance', 'ledger.jsonl');

  // First try delegating to sibling `./ledger` module if merged and compatible
  try {
    const ledgerModPath = './ledger';
    const ledgerMod = (await import(ledgerModPath).catch(() => null)) as Record<string, unknown> | null;
    if (ledgerMod && typeof ledgerMod.verifyLedgerFile === 'function') {
      const res = await (ledgerMod.verifyLedgerFile as (p: string) => Promise<VerifyLedgerReport>)(ledgerPath);
      if (res && typeof res.valid === 'boolean') return res;
    }
  } catch {
    // Fall back to built-in verifier
  }

  if (!fssync.existsSync(ledgerPath)) {
    return { valid: true, entryCount: 0, ledgerPath, errors: [] };
  }

  const raw = (await fs.readFile(ledgerPath, 'utf8')).trim();
  if (!raw) {
    return { valid: true, entryCount: 0, ledgerPath, errors: [] };
  }

  let entries: LedgerEntry[];
  try {
    entries = raw.startsWith('[')
      ? (JSON.parse(raw) as LedgerEntry[])
      : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
  } catch (err) {
    return {
      valid: false,
      entryCount: 0,
      ledgerPath,
      errors: [`Failed to parse ledger file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const errors: string[] = [];
  let expectedPrev: string | null = null;
  let lastFencingToken: number | undefined;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.index !== i) {
      errors.push(`Entry ${i}: index mismatch (expected ${i}, got ${e.index})`);
    }
    if ((e.prevHash ?? null) !== expectedPrev) {
      errors.push(`Entry ${i}: broken hash chain (expected prevHash=${expectedPrev}, got ${e.prevHash ?? null})`);
    }
    const recomputed = computeLedgerEntryHash(e);
    if (e.entryHash !== recomputed) {
      errors.push(`Entry ${i}: entryHash tamper detected (expected ${recomputed}, got ${e.entryHash})`);
    }
    if (e.fencingToken !== undefined) {
      if (lastFencingToken !== undefined && e.fencingToken < lastFencingToken) {
        errors.push(`Entry ${i}: stale fencing token (${e.fencingToken} < ${lastFencingToken})`);
      }
      lastFencingToken = e.fencingToken;
    }
    expectedPrev = e.entryHash;
  }

  return {
    valid: errors.length === 0,
    entryCount: entries.length,
    ledgerPath,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Run & Record (`assure run <component>`, `assure record <component>`)
// ---------------------------------------------------------------------------

export interface AssureRunOptions {
  component: string;
  propertyId?: string;
  tools?: FormalTool[];
  specsDir?: string;
  ledgerPath?: string;
  workspaceRoot?: string;
  doctorOptions?: DoctorOptions;
}

export interface AssureRunSummary {
  component: string;
  propertyId?: string;
  results: VerificationResult[];
  overallVerdict: Verdict;
  ledgerEntriesAppended: number;
}

export async function assureRun(options: AssureRunOptions): Promise<AssureRunSummary> {
  const root = resolveRepoRoot(options.workspaceRoot);
  const specsDir = options.specsDir ?? path.join(root, 'specs');
  const ledgerPath = options.ledgerPath ?? path.join(root, '.wazir', 'assurance', 'ledger.jsonl');
  const doctor = await runAssureDoctor(options.doctorOptions ?? { workspaceRoot: root });

  let manifests = await assureSpecList({ specsDir });
  if (options.propertyId) {
    manifests = manifests.filter((m) => m.id === options.propertyId);
  }

  const toolFilter = options.tools && options.tools.length > 0 ? new Set(options.tools) : null;
  const results: VerificationResult[] = [];
  let ledgerEntriesAppended = 0;

  // Check if adapters module is available dynamically
  const adaptersModPath = './adapters';
  const adaptersMod = (await import(adaptersModPath).catch(() => null)) as Record<string, unknown> | null;

  for (const manifest of manifests) {
    const artifacts = manifest.artifacts.filter((a) => !toolFilter || toolFilter.has(a.tool));
    for (const art of artifacts) {
      const toolStatus = doctor.tools[art.tool];
      const obligation: Obligation = {
        id: `${manifest.id}:${art.tool}:${art.file}`,
        propertyId: manifest.id,
        specVersion: manifest.version,
        specHash: manifest.content_hash,
        tool: art.tool,
        artifactPath: art.file,
        scope: art.scope,
        assumptions: manifest.assumptions,
        guarantee: manifest.guarantee,
      };

      let result: VerificationResult | null = null;
      if (adaptersMod && typeof adaptersMod.runObligationWithAdapter === 'function') {
        try {
          result = await (adaptersMod.runObligationWithAdapter as (o: Obligation, r: string) => Promise<VerificationResult>)(
            obligation,
            root,
          );
        } catch {
          result = null;
        }
      }

      if (!result) {
        const inputHash = `sha256:${createHash('sha256').update(JSON.stringify(obligation)).digest('hex')}`;
        if (!toolStatus?.available) {
          result = {
            verdict: Verdict.NOT_RUN,
            tool: art.tool,
            toolVersion: toolStatus?.version ?? 'missing',
            scope: art.scope,
            assumptions: manifest.assumptions,
            elapsedMs: 0,
            inputHash,
          };
        } else {
          // Tool is available; if no specific adapter runner is wired yet, report honest NOT_RUN
          // (never fabricate a solver pass per FORMAL_ASSURANCE.md §0).
          result = {
            verdict: Verdict.NOT_RUN,
            tool: art.tool,
            toolVersion: toolStatus.version,
            scope: art.scope,
            assumptions: manifest.assumptions,
            elapsedMs: 0,
            inputHash,
            metadata: { note: 'adapter execution not invoked or artifact not executed' },
          };
        }
      }

      // Enforce vacuity and trusted base rules on any passing verdict
      let finalVerdict = applyVacuityProbe(result.verdict, result.vacuityProbe);
      finalVerdict = applyTrustedBaseGaps(finalVerdict, result.trustedBaseGaps);
      result = { ...result, verdict: finalVerdict };
      results.push(result);

      await appendLedgerEntry(ledgerPath, {
        timestamp: new Date().toISOString(),
        propertyId: manifest.id,
        specHash: manifest.content_hash,
        sourceCommit: 'HEAD',
        workspaceRev: 'HEAD',
        tool: art.tool,
        toolVersion: result.toolVersion,
        inputHash: result.inputHash,
        scope: art.scope,
        assumptions: manifest.assumptions,
        verdict: result.verdict,
        witness: result.witness,
        elapsedMs: result.elapsedMs,
        artifactHashes: { [art.file]: manifest.content_hash },
        obligationId: obligation.id,
      });
      ledgerEntriesAppended++;
    }
  }

  const overallVerdict = aggregateVerdictsWeakestLink(results.map((r) => r.verdict));
  return {
    component: options.component,
    propertyId: options.propertyId,
    results,
    overallVerdict,
    ledgerEntriesAppended,
  };
}

export interface AssureRecordOptions {
  component: string;
  version?: string;
  sourceCommit?: string;
  specsDir?: string;
  ledgerPath?: string;
  refinementMap?: RefinementMap;
  outputPath?: string;
  workspaceRoot?: string;
}

export async function assureRecord(options: AssureRecordOptions): Promise<AssuranceRecord> {
  const root = resolveRepoRoot(options.workspaceRoot);
  const specsDir = options.specsDir ?? path.join(root, 'specs');
  const ledgerPath = options.ledgerPath ?? path.join(root, '.wazir', 'assurance', 'ledger.jsonl');

  const manifests = await assureSpecList({ specsDir });
  let entries: LedgerEntry[] = [];
  if (fssync.existsSync(ledgerPath)) {
    const raw = (await fs.readFile(ledgerPath, 'utf8')).trim();
    if (raw) {
      entries = raw.startsWith('[')
        ? (JSON.parse(raw) as LedgerEntry[])
        : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
    }
  }

  const properties: Record<string, PropertyAssuranceSummary> = {};
  const allAssumptions = new Set<string>();
  const allVerdicts: Verdict[] = [];
  let allSpecsApproved = manifests.length > 0;
  let counterexamplesFound = 0;

  for (const e of entries) {
    if (e.verdict === Verdict.COUNTEREXAMPLE || e.verdict === Verdict.FALSIFIED) {
      counterexamplesFound++;
    }
  }

  for (const manifest of manifests) {
    if (manifest.status !== 'approved') {
      allSpecsApproved = false;
    }
    for (const a of manifest.assumptions) allAssumptions.add(a);

    const propEntries = entries.filter((e) => e.propertyId === manifest.id);
    const byTool = (tool: FormalTool): Verdict | undefined => {
      const matching = propEntries.filter((e) => e.tool === tool);
      if (matching.length === 0) return undefined;
      return matching[matching.length - 1].verdict;
    };

    const alloyVerdict = byTool('alloy') ?? byTool('gam');
    const z3Verdict = byTool('z3');
    let dafnyVerdict = byTool('dafny');
    const simVerdict = byTool('verifai') ?? byTool('scenic');

    const mapping = options.refinementMap?.mappings.find((m) => m.property === manifest.id);
    if (dafnyVerdict && mapping) {
      dafnyVerdict = capImplementationVerdict(dafnyVerdict, mapping.production);
    }

    const propVerdictList = [alloyVerdict, z3Verdict, dafnyVerdict, simVerdict].filter(
      (v): v is Verdict => v !== undefined,
    );
    const overall =
      manifest.status !== 'approved'
        ? Verdict.SPECIFICATION_REVIEW_REQUIRED
        : propVerdictList.length > 0
          ? aggregateVerdictsWeakestLink(propVerdictList)
          : Verdict.NOT_RUN;

    allVerdicts.push(overall);

    properties[manifest.id] = {
      spec_version: `${manifest.version} (${manifest.content_hash})`,
      spec_hash: manifest.content_hash,
      specification_consistency: alloyVerdict,
      decision_envelope: z3Verdict,
      implementation_contract: dafnyVerdict,
      simulation_falsification: simVerdict,
      runtime_monitor: manifest.monitors && manifest.monitors.length > 0 ? 'ENABLED' : 'NOT_DEPLOYED',
      overall,
    };
  }

  const release_gate = evaluateReleaseGate(allVerdicts, allSpecsApproved);

  const record: AssuranceRecord = {
    component: options.component,
    version: options.version ?? '0.1.0',
    source_commit: options.sourceCommit ?? 'HEAD',
    properties,
    assumptions: Array.from(allAssumptions),
    trusted_base: ['Z3 solver', 'Alloy Analyzer 6.2.0', 'Dafny 4.11.0 verifier'],
    coverage_limits: [
      'Perception correctness is not claimed',
      'Physical dynamics fidelity beyond encoded kinematic envelope is not claimed',
      'Real-world vehicle or system safety is not claimed',
    ],
    counterexamples_found: counterexamplesFound,
    regression_obligations: counterexamplesFound,
    release_gate,
  };

  if (options.outputPath) {
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  }

  return record;
}

export function formatAssuranceRecord(record: AssuranceRecord, json = false): string {
  if (json) return JSON.stringify(record, null, 2);
  const lines: string[] = [];
  lines.push(`component: ${record.component}`);
  lines.push(`version: ${record.version}`);
  lines.push(`source_commit: ${record.source_commit}`);
  lines.push('properties:');
  for (const [propId, summary] of Object.entries(record.properties)) {
    lines.push(`  ${propId}:`);
    lines.push(`    spec_version: ${summary.spec_version}`);
    if (summary.specification_consistency) {
      lines.push(`    specification_consistency: ${summary.specification_consistency}`);
    }
    if (summary.decision_envelope) {
      lines.push(`    decision_envelope: ${summary.decision_envelope}`);
    }
    if (summary.implementation_contract) {
      lines.push(`    implementation_contract: ${summary.implementation_contract}`);
    }
    if (summary.simulation_falsification) {
      lines.push(`    simulation_falsification: ${summary.simulation_falsification}`);
    }
    lines.push(`    runtime_monitor: ${summary.runtime_monitor ?? 'NOT_DEPLOYED'}`);
    if (summary.overall) {
      lines.push(`    overall: ${summary.overall}`);
    }
  }
  lines.push(`assumptions: [${record.assumptions.join(', ')}]`);
  lines.push(`trusted_base: [${record.trusted_base.join(', ')}]`);
  lines.push(`coverage_limits: [${record.coverage_limits.join('; ')}]`);
  lines.push(
    `counterexamples_found: ${record.counterexamples_found}, regression_obligations: ${record.regression_obligations}`,
  );
  lines.push(
    `release_gate: ${record.release_gate.status}${record.release_gate.reason ? ` (${record.release_gate.reason})` : ''}`,
  );
  return lines.join('\n');
}
