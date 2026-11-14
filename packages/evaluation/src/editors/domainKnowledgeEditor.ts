import { createHash } from 'node:crypto';
import type { ExecutionRecord } from '@wazir/core';
import type { TrajectoryContrastReport } from '../trajectoryContrastService.js';
import {
  GovernanceFence,
  GovernanceFenceError,
  type CapabilityCeiling,
  type GovernanceValidationResult,
} from './governanceFence.js';

export type ProceduralRecipeKind =
  | 'build_command'
  | 'test_command'
  | 'static_check'
  | 'localization_convention'
  | 'architectural_invariant';

export interface ProceduralRecipe {
  id: string;
  repositorySignature: string;
  name: string;
  kind: ProceduralRecipeKind;
  command?: string;
  steps: string[];
  applicableDirectories: string[];
  verifiedByExecutionIds: string[];
}

export interface DomainKnowledgeOverlay {
  editorKind: 'domain_knowledge';
  repositorySignature: string;
  buildCommands: string[];
  testCommands: string[];
  staticCheckCommands: string[];
  conventions: string[];
  architecturalInvariants: string[];
  recipes: ProceduralRecipe[];
  promptOverlay: string;
  sourceExecutionIds: string[];
  skippedUnverifiedExecutionIds: string[];
  blockedInjections: string[];
  redactedSecretsCount: number;
  governanceValidation: GovernanceValidationResult;
}

export interface DomainKnowledgeEditorOptions {
  repositorySignature?: string;
  workspaceRoot?: string;
  candidateConventions?: readonly string[];
  candidateInvariants?: readonly string[];
  baseCeiling?: CapabilityCeiling;
}

const SECRET_TOKEN_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{8,}['"]?/gi,
];

const SHELL_ESCAPE_OR_CHAIN_PATTERN = /(?:;|&&|\|\||\||`|\$\(|\$\{|>|<|\n|\r)/;

const SAFE_BUILD_TEST_EXECUTABLE_PATTERN =
  /^(?:npm|pnpm|yarn|bun|npx|node|tsc|vitest|jest|mocha|pytest|python3?|cargo|go|make|cmake|gradle|mvn)\b/i;

const PROMPT_INJECTION_OR_BYPASS_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|system)\s+(?:instructions|rules|constraints|governance|directives)/i,
  /disregard\s+(?:all\s+|any\s+)?(?:governance|policy|sandbox|safety|verification|fencing)/i,
  /\b(?:bypass|disable)\s+(?:the\s+)?(?:sandbox|governance|policy|permission|verification)/i,
  /(?:<\|im_start\|>|<\/?system>|\[INST\]|###\s*System\s*Override)/i,
  /(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/(?:datasets|spaces)\b/i,
  /(?:https?:\/\/)?raw\.githubusercontent\.com\b/i,
  /\b(?:SKIP_TESTS|CI_SKIP_TESTS|NODE_TLS_REJECT_UNAUTHORIZED)\s*=/i,
  /\b(?:curl|wget)\s+/i,
];

function deriveRepositorySignature(
  explicitSig: string | undefined,
  workspaceRoot: string | undefined,
  records: ExecutionRecord[],
): string {
  if (explicitSig && explicitSig.trim()) {
    return explicitSig.trim();
  }
  const root = workspaceRoot ?? records.find((r) => r.execution?.workspaceRoot)?.execution.workspaceRoot;
  if (root) {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
    const base = root.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'repo';
    return `repo:${base}:${hash}`;
  }
  const topDirs = Array.from(
    new Set(
      records
        .flatMap((r) => r.filesChanged ?? [])
        .map((f) => f.replace(/\\/g, '/').split('/')[0])
        .filter(Boolean),
    ),
  ).sort();
  const digest = createHash('sha256').update(topDirs.join(',') || 'default').digest('hex').slice(0, 12);
  return `repo:inferred:${digest}`;
}

/**
 * Harness² Editor 2: Task/Repo Domain Knowledge (`A059`).
 * Distills concrete repository conventions, verified build/test commands, and architectural
 * invariants from `TrajectoryContrastReport` + verified `ExecutionRecord`s into typed
 * `DomainKnowledgeOverlay` / `ProceduralRecipe` objects scoped to `repositorySignature`.
 * Strips prompt-injection patterns, shell escapes, and secret-like tokens, and validates
 * through `GovernanceFence` before returning.
 */
export class DomainKnowledgeEditor {
  private readonly governanceFence: GovernanceFence;

  constructor(governanceFence: GovernanceFence = new GovernanceFence()) {
    this.governanceFence = governanceFence;
  }

  public distill(
    contrastReport: TrajectoryContrastReport,
    records: ExecutionRecord[],
    options: DomainKnowledgeEditorOptions = {},
  ): DomainKnowledgeOverlay {
    const repositorySignature = deriveRepositorySignature(
      options.repositorySignature,
      options.workspaceRoot,
      records,
    );

    const blockedInjections: string[] = [];
    let redactedSecretsCount = 0;

    const sanitizeText = (raw: string): string | null => {
      let text = raw.trim();
      if (!text) return null;

      // Redact secret-like tokens first
      for (const secretRx of SECRET_TOKEN_PATTERNS) {
        secretRx.lastIndex = 0;
        const matches = text.match(secretRx);
        if (matches) {
          redactedSecretsCount += matches.length;
          text = text.replace(secretRx, '[REDACTED_SECRET]');
        }
      }

      // Block prompt injections or reward-hacking directives
      if (PROMPT_INJECTION_OR_BYPASS_PATTERNS.some((rx) => rx.test(text))) {
        blockedInjections.push(raw.trim().slice(0, 160));
        return null;
      }

      // Strip inline shell escapes (`...`, $(...), ${...}) from prose notes
      if (/(?:`[^`]*`|\$\([^)]*\)|\$\{[^}]*\})/.test(text)) {
        blockedInjections.push(raw.trim().slice(0, 160));
        text = text
          .replace(/\$\([^)]*\)/g, '')
          .replace(/\$\{[^}]*\}/g, '')
          .replace(/`[^`]*`/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      return text.length > 0 ? text.slice(0, 280) : null;
    };

    const validateAndSanitizeCommand = (rawCmd: string): string | null => {
      const cmd = rawCmd.trim();
      if (!cmd) return null;

      for (const secretRx of SECRET_TOKEN_PATTERNS) {
        secretRx.lastIndex = 0;
        if (secretRx.test(cmd)) {
          redactedSecretsCount += 1;
          blockedInjections.push(cmd.slice(0, 160));
          return null;
        }
      }

      if (
        SHELL_ESCAPE_OR_CHAIN_PATTERN.test(cmd) ||
        PROMPT_INJECTION_OR_BYPASS_PATTERNS.some((rx) => rx.test(cmd)) ||
        !SAFE_BUILD_TEST_EXECUTABLE_PATTERN.test(cmd)
      ) {
        blockedInjections.push(cmd.slice(0, 160));
        return null;
      }

      return cmd;
    };

    // Filter strictly to physically verified AND governance-clean ExecutionRecords
    const verifiedSet = new Set(contrastReport.verificationDelta.verifiedExecutionIds);
    const verifiedRecords: ExecutionRecord[] = [];
    const skippedUnverifiedExecutionIds: string[] = [];

    for (const record of records) {
      const execId = record.execution.id;
      const govCheck = this.governanceFence.validateExecutionRecord(record, {
        baseCeiling: options.baseCeiling,
        workspaceRoot: options.workspaceRoot,
      });
      if (!govCheck.allowed) {
        skippedUnverifiedExecutionIds.push(execId);
        for (const v of govCheck.violations) {
          blockedInjections.push(`${v.code}: ${v.evidence ?? v.target ?? v.message}`.slice(0, 160));
        }
        continue;
      }

      const hasPassingOracle =
        verifiedSet.has(execId) ||
        this.isRecordPhysicallyVerified(record);

      if (hasPassingOracle) {
        verifiedRecords.push(record);
      } else {
        skippedUnverifiedExecutionIds.push(execId);
      }
    }

    const buildCommands = new Set<string>();
    const testCommands = new Set<string>();
    const staticCheckCommands = new Set<string>();
    const touchedDirectories = new Set<string>();
    const conventions = new Set<string>();
    const architecturalInvariants = new Set<string>();

    let usesTypeScript = false;
    let usesPackagesMonorepo = false;
    let pairsSrcAndTests = false;

    for (const rec of verifiedRecords) {
      // Inspect check commands
      for (const chk of rec.checks ?? []) {
        if (!chk.ok || !chk.command) continue;
        const cleanCmd = validateAndSanitizeCommand(chk.command);
        if (!cleanCmd) continue;

        const lowerName = chk.name.toLowerCase();
        if (lowerName.includes('build') || lowerName.includes('compile')) {
          buildCommands.add(cleanCmd);
        } else if (lowerName.includes('test') || lowerName.includes('spec')) {
          testCommands.add(cleanCmd);
        } else if (lowerName.includes('lint') || lowerName.includes('typecheck') || lowerName.includes('static')) {
          staticCheckCommands.add(cleanCmd);
        }
      }

      // Inspect verification evidence commands
      for (const ev of rec.evidence ?? []) {
        if ((ev.exitCode !== 0 && ev.status !== 'PASS') || !ev.command) continue;
        const cleanCmd = validateAndSanitizeCommand(ev.command);
        if (!cleanCmd) continue;

        const kind = String(ev.oracle ?? ev.type).toUpperCase();
        if (kind === 'BUILD') buildCommands.add(cleanCmd);
        else if (kind === 'TEST') testCommands.add(cleanCmd);
        else if (kind === 'STATIC_CHECK') staticCheckCommands.add(cleanCmd);
      }

      // Inspect changed files for structural conventions (never scanning untrusted raw outputs verbatim)
      const changed = (rec.filesChanged ?? []).map((f) => f.replace(/\\/g, '/'));
      if (changed.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
        usesTypeScript = true;
      }
      if (changed.some((f) => f.startsWith('packages/') || f.startsWith('apps/'))) {
        usesPackagesMonorepo = true;
      }
      if (
        changed.some((f) => f.includes('/src/')) &&
        changed.some((f) => f.includes('/tests/') || f.endsWith('.test.ts'))
      ) {
        pairsSrcAndTests = true;
      }

      for (const f of changed) {
        const idx = f.lastIndexOf('/');
        if (idx > 0) touchedDirectories.add(f.slice(0, idx));
      }

      // Inspect any record errors/notes to catch embedded injections in untrusted logs if present
      for (const err of rec.errors ?? []) {
        sanitizeText(err);
      }
    }

    if (usesTypeScript) {
      conventions.add('Preserve TypeScript strict typing and ESM module import specifiers.');
    }
    if (usesPackagesMonorepo) {
      conventions.add('Respect workspace package boundaries under packages/* and apps/*.');
      architecturalInvariants.add('Cross-package imports must flow through public package entrypoints without circular dependencies.');
    }
    if (pairsSrcAndTests) {
      conventions.add('Pair implementation edits in src/ with corresponding unit/regression coverage in tests/.');
    }
    if (verifiedRecords.length > 0) {
      architecturalInvariants.add('All workspace mutations require passing physical verification evidence at the final workspace revision.');
    }

    // Process optional candidate conventions & invariants through strict sanitizer
    for (const rawConv of options.candidateConventions ?? []) {
      const clean = sanitizeText(rawConv);
      if (clean) conventions.add(clean);
    }
    for (const rawInv of options.candidateInvariants ?? []) {
      const clean = sanitizeText(rawInv);
      if (clean) architecturalInvariants.add(clean);
    }

    const applicableDirs = [...touchedDirectories].sort();
    const sourceExecutionIds = verifiedRecords.map((r) => r.execution.id);
    const recipes: ProceduralRecipe[] = [];

    const makeRecipeId = (kind: string, key: string) =>
      `recipe-${createHash('sha256').update(`${repositorySignature}:${kind}:${key}`).digest('hex').slice(0, 10)}`;

    for (const cmd of buildCommands) {
      recipes.push({
        id: makeRecipeId('build', cmd),
        repositorySignature,
        name: `Verified Build: ${cmd}`,
        kind: 'build_command',
        command: cmd,
        steps: [`Run '${cmd}' and confirm exit code 0 on current workspace revision.`],
        applicableDirectories: applicableDirs,
        verifiedByExecutionIds: sourceExecutionIds,
      });
    }

    for (const cmd of testCommands) {
      recipes.push({
        id: makeRecipeId('test', cmd),
        repositorySignature,
        name: `Verified Test Suite: ${cmd}`,
        kind: 'test_command',
        command: cmd,
        steps: [`Run '${cmd}' after edits and verify all test assertions pass.`],
        applicableDirectories: applicableDirs,
        verifiedByExecutionIds: sourceExecutionIds,
      });
    }

    for (const cmd of staticCheckCommands) {
      recipes.push({
        id: makeRecipeId('static', cmd),
        repositorySignature,
        name: `Verified Static Check: ${cmd}`,
        kind: 'static_check',
        command: cmd,
        steps: [`Run '${cmd}' to validate static types and lint rules.`],
        applicableDirectories: applicableDirs,
        verifiedByExecutionIds: sourceExecutionIds,
      });
    }

    for (const inv of architecturalInvariants) {
      recipes.push({
        id: makeRecipeId('invariant', inv),
        repositorySignature,
        name: 'Repository Architectural Invariant',
        kind: 'architectural_invariant',
        steps: [inv],
        applicableDirectories: applicableDirs,
        verifiedByExecutionIds: sourceExecutionIds,
      });
    }

    const buildList = [...buildCommands];
    const testList = [...testCommands];
    const staticList = [...staticCheckCommands];
    const convList = [...conventions];
    const invList = [...architecturalInvariants];

    const overlayLines: string[] = [
      `=== REPOSITORY DOMAIN KNOWLEDGE (${repositorySignature}) ===`,
    ];
    if (buildList.length > 0) overlayLines.push(`Build Commands: ${buildList.join(' | ')}`);
    if (testList.length > 0) overlayLines.push(`Test Commands: ${testList.join(' | ')}`);
    if (staticList.length > 0) overlayLines.push(`Static Checks: ${staticList.join(' | ')}`);
    for (const c of convList) overlayLines.push(`Convention: ${c}`);
    for (const inv of invList) overlayLines.push(`Invariant: ${inv}`);
    const promptOverlay = overlayLines.join('\n');

    // Mandatory GovernanceFence validation before returning
    const governanceValidation = this.governanceFence.validateProposal(
      {
        promptOverlay,
        conventions: convList,
        architecturalInvariants: invList,
        commands: [...buildList, ...testList, ...staticList],
      },
      options.baseCeiling,
    );

    if (!governanceValidation.allowed) {
      throw new GovernanceFenceError(
        `DomainKnowledgeEditor overlay rejected by GovernanceFence: ${governanceValidation.violations.map((v) => v.message).join('; ')}`,
        governanceValidation.violations,
      );
    }

    return {
      editorKind: 'domain_knowledge',
      repositorySignature,
      buildCommands: buildList,
      testCommands: testList,
      staticCheckCommands: staticList,
      conventions: convList,
      architecturalInvariants: invList,
      recipes,
      promptOverlay,
      sourceExecutionIds,
      skippedUnverifiedExecutionIds,
      blockedInjections,
      redactedSecretsCount,
      governanceValidation,
    };
  }

  private isRecordPhysicallyVerified(record: ExecutionRecord): boolean {
    if (record.execution?.status === 'failed' || record.execution?.status === 'cancelled') {
      return false;
    }
    if ((record.errors?.length ?? 0) > 0) {
      return false;
    }
    const checks = record.checks ?? [];
    const evidence = record.evidence ?? [];
    if (checks.length === 0 && evidence.length === 0) {
      return false;
    }
    const currentRevision =
      record.workspaceState?.revision ?? ((record.filesChanged?.length ?? 0) > 0 ? 1 : 0);
    if (evidence.length > 0) {
      const atCurrent = evidence.filter(
        (e) => (e.workspaceRevision ?? e.revision) === currentRevision,
      );
      if (atCurrent.length === 0) return false;
      if (!atCurrent.every((e) => e.exitCode === 0 || e.status === 'PASS')) return false;
    }
    return checks.every((c) => c.ok);
  }
}
