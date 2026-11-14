/**
 * `wa assure` CLI commands (FORMAL_ASSURANCE.md §2.8):
 *  - `wa assure spec add|list|show|approve` (approve requires a human)
 *  - `wa assure run <component> [--property ID] [--tools ...]`
 *  - `wa assure record <component>`
 *  - `wa assure verify-ledger`
 *  - `wa assure doctor`
 */
import { Command } from 'commander';
import { color } from '../colors.js';
import { table } from './formatters.js';

export interface AssureCommandResult {
  code: number;
  output: string;
}

async function loadAssuranceCli() {
  // Resolve @wazir/assurance or direct relative module seamlessly before/after workspace link
  const pkgName = '@wazir/assurance';
  try {
    const mod = await import(pkgName);
    if (mod && typeof mod.runAssureDoctor === 'function') {
      return mod as typeof import('../../../../packages/assurance/src/cli.js');
    }
  } catch {
    // Fallback to direct source/dist resolution in monorepo
  }
  return await import('../../../../packages/assurance/src/cli.js');
}

export async function assureDoctorCommand(options: {
  json?: boolean;
  workspaceRoot?: string;
} = {}): Promise<AssureCommandResult> {
  const cli = await loadAssuranceCli();
  const report = await cli.runAssureDoctor({ workspaceRoot: options.workspaceRoot });
  return {
    code: 0,
    output: cli.formatDoctorReport(report, Boolean(options.json)),
  };
}

export async function assureSpecAddCommand(
  id: string,
  options: {
    version?: string;
    guarantee?: string;
    assumption?: string[];
    normativeRef?: string;
    jurisdiction?: string;
    manifest?: string;
    specsDir?: string;
    json?: boolean;
  } = {},
): Promise<AssureCommandResult> {
  try {
    const cli = await loadAssuranceCli();
    const manifest = await cli.assureSpecAdd({
      id,
      version: options.version,
      guarantee: options.guarantee,
      assumptions: options.assumption,
      normativeRef: options.normativeRef,
      jurisdiction: options.jurisdiction,
      manifestFile: options.manifest,
      specsDir: options.specsDir,
    });
    if (options.json) {
      return { code: 0, output: JSON.stringify(manifest, null, 2) };
    }
    return {
      code: 0,
      output: color.green(`Added spec '${manifest.id}' v${manifest.version} [${manifest.status}] (${manifest.content_hash})`),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 1, output: options.json ? JSON.stringify({ error: msg }) : color.red(msg) };
  }
}

export async function assureSpecListCommand(options: {
  specsDir?: string;
  json?: boolean;
} = {}): Promise<AssureCommandResult> {
  const cli = await loadAssuranceCli();
  const specs = await cli.assureSpecList({ specsDir: options.specsDir });
  if (options.json) {
    return { code: 0, output: JSON.stringify(specs, null, 2) };
  }
  if (specs.length === 0) {
    return { code: 0, output: color.yellow('no specifications registered') };
  }
  const rows = specs.map((s) => [
    s.id,
    s.version,
    s.status,
    s.artifacts.map((a) => a.tool).join(',') || '-',
    s.reviewers.join(',') || '-',
    s.content_hash.slice(0, 19),
  ]);
  return {
    code: 0,
    output: table(['id', 'version', 'status', 'tools', 'reviewers', 'hash'], rows),
  };
}

export async function assureSpecShowCommand(
  id: string,
  options: { specsDir?: string; json?: boolean } = {},
): Promise<AssureCommandResult> {
  try {
    const cli = await loadAssuranceCli();
    const manifest = await cli.assureSpecShow(id, { specsDir: options.specsDir });
    if (options.json) {
      return { code: 0, output: JSON.stringify(manifest, null, 2) };
    }
    return { code: 0, output: cli.serializeManifestYaml(manifest).trimEnd() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 1, output: options.json ? JSON.stringify({ error: msg }) : color.red(msg) };
  }
}

export async function assureSpecApproveCommand(
  id: string,
  options: { reviewer?: string; automated?: boolean; specsDir?: string; json?: boolean } = {},
): Promise<AssureCommandResult> {
  try {
    const cli = await loadAssuranceCli();
    const updated = await cli.assureSpecApprove({
      id,
      reviewer: options.reviewer,
      automated: options.automated,
      specsDir: options.specsDir,
    });
    if (options.json) {
      return { code: 0, output: JSON.stringify(updated, null, 2) };
    }
    return {
      code: 0,
      output: color.green(
        `Approved spec '${updated.id}' v${updated.version} by [${updated.reviewers.join(', ')}] (${updated.content_hash})`,
      ),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 1, output: options.json ? JSON.stringify({ error: msg }) : color.red(msg) };
  }
}

export async function assureVerifyLedgerCommand(options: {
  ledger?: string;
  workspaceRoot?: string;
  json?: boolean;
} = {}): Promise<AssureCommandResult> {
  const cli = await loadAssuranceCli();
  const report = await cli.assureVerifyLedger({
    ledgerPath: options.ledger,
    workspaceRoot: options.workspaceRoot,
  });
  if (options.json) {
    return { code: report.valid ? 0 : 1, output: JSON.stringify(report, null, 2) };
  }
  if (!report.valid) {
    return {
      code: 1,
      output: [
        color.red(`Ledger verification FAILED (${report.entryCount} entries):`),
        ...report.errors.map((e) => `  - ${e}`),
      ].join('\n'),
    };
  }
  return {
    code: 0,
    output: color.green(`Ledger verified: ${report.entryCount} entries intact (${report.ledgerPath})`),
  };
}

export async function assureRunCommand(
  component: string,
  options: {
    property?: string;
    tools?: string;
    specsDir?: string;
    ledger?: string;
    workspaceRoot?: string;
    json?: boolean;
  } = {},
): Promise<AssureCommandResult> {
  const cli = await loadAssuranceCli();
  const parsedTools = options.tools
    ? (options.tools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean) as import('../../../../packages/assurance/src/contracts.js').FormalTool[])
    : undefined;

  const summary = await cli.assureRun({
    component,
    propertyId: options.property,
    tools: parsedTools,
    specsDir: options.specsDir,
    ledgerPath: options.ledger,
    workspaceRoot: options.workspaceRoot,
  });

  if (options.json) {
    return { code: 0, output: JSON.stringify(summary, null, 2) };
  }

  const lines = [
    color.bold(`Assurance run for component '${summary.component}'`),
    `  obligations run: ${summary.results.length}`,
    `  overall verdict: ${summary.overallVerdict}`,
    `  ledger appended: ${summary.ledgerEntriesAppended}`,
  ];
  for (const r of summary.results) {
    lines.push(`    - [${r.tool}] ${r.verdict} (${r.toolVersion})`);
  }
  return { code: 0, output: lines.join('\n') };
}

export async function assureRecordCommand(
  component: string,
  options: {
    version?: string;
    commit?: string;
    specsDir?: string;
    ledger?: string;
    output?: string;
    workspaceRoot?: string;
    json?: boolean;
  } = {},
): Promise<AssureCommandResult> {
  const cli = await loadAssuranceCli();
  const record = await cli.assureRecord({
    component,
    version: options.version,
    sourceCommit: options.commit,
    specsDir: options.specsDir,
    ledgerPath: options.ledger,
    outputPath: options.output,
    workspaceRoot: options.workspaceRoot,
  });

  const code = record.release_gate.status === 'PASS' ? 0 : 1;
  return {
    code,
    output: cli.formatAssuranceRecord(record, Boolean(options.json)),
  };
}

/**
 * Create the `wa assure` Commander command tree.
 */
export function createAssureCommand(): Command {
  const assure = new Command('assure').description(
    'Wazir Formal Assurance (WFA) — specifications, verification obligations, evidence ledger, and assurance records',
  );

  const spec = assure
    .command('spec')
    .description('Manage formal property specifications (add, list, show, approve)');

  spec
    .command('add <id>')
    .description('Add a draft formal specification manifest')
    .option('--version <semver>', 'Spec version', '1.0.0')
    .option('--guarantee <text>', 'Formal guarantee statement (P)')
    .option('--assumption <item...>', 'Assumptions (A)')
    .option('--normative-ref <ref>', 'Normative source reference')
    .option('--jurisdiction <name>', 'Jurisdiction', 'configured')
    .option('--manifest <file>', 'Import from an existing YAML/JSON manifest file')
    .option('--specs-dir <dir>', 'Custom specs directory')
    .option('-j, --json', 'Output JSON')
    .action(async (id, options) => {
      const res = await assureSpecAddCommand(id, options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  spec
    .command('list')
    .description('List registered formal specifications')
    .option('--specs-dir <dir>', 'Custom specs directory')
    .option('-j, --json', 'Output JSON')
    .action(async (options) => {
      const res = await assureSpecListCommand(options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  spec
    .command('show <id>')
    .description('Show a formal specification manifest')
    .option('--specs-dir <dir>', 'Custom specs directory')
    .option('-j, --json', 'Output JSON')
    .action(async (id, options) => {
      const res = await assureSpecShowCommand(id, options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  spec
    .command('approve <id>')
    .description('Approve a formal specification (requires a human reviewer)')
    .option('--reviewer <human>', 'Human reviewer identity')
    .option('--automated', 'Automated caller flag (always rejected)')
    .option('--specs-dir <dir>', 'Custom specs directory')
    .option('-j, --json', 'Output JSON')
    .action(async (id, options) => {
      const res = await assureSpecApproveCommand(id, options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  assure
    .command('run <component>')
    .description('Run formal verification obligations for a component')
    .option('--property <id>', 'Filter to a single property ID')
    .option('--tools <tools>', 'Comma-separated list of tools (z3,alloy,dafny,scenic,verifai,gam)')
    .option('--specs-dir <dir>', 'Custom specs directory')
    .option('--ledger <path>', 'Custom evidence ledger path')
    .option('-j, --json', 'Output JSON')
    .action(async (component, options) => {
      const res = await assureRunCommand(component, options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  assure
    .command('record <component>')
    .description('Generate and print/write the assurance record for a component')
    .option('--version <semver>', 'Component version', '0.1.0')
    .option('--commit <sha>', 'Source commit SHA', 'HEAD')
    .option('--specs-dir <dir>', 'Custom specs directory')
    .option('--ledger <path>', 'Custom evidence ledger path')
    .option('-o, --output <path>', 'Write assurance record JSON to file')
    .option('-j, --json', 'Output JSON')
    .action(async (component, options) => {
      const res = await assureRecordCommand(component, options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  assure
    .command('verify-ledger')
    .description('Recompute hash chain of the evidence ledger and fail on tampering')
    .option('--ledger <path>', 'Custom evidence ledger path')
    .option('-j, --json', 'Output JSON')
    .action(async (options) => {
      const res = await assureVerifyLedgerCommand(options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  assure
    .command('doctor')
    .description('Report installed formal tools, versions, and achievable verdicts on this host')
    .option('-j, --json', 'Output JSON')
    .action(async (options) => {
      const res = await assureDoctorCommand(options);
      console.log(res.output);
      if (res.code !== 0) process.exitCode = res.code;
    });

  return assure;
}

export function registerAssureCommands(program: Command): void {
  program.addCommand(createAssureCommand());
}
