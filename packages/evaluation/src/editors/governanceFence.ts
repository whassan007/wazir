import path from 'node:path';
import type { ExecutionRecord, ToolCallRecord } from '@wazir/core';

/**
 * Core Wazir Governance Law (Harness² A060):
 * Evidence can change how the agent works, but NEVER what it may access or how it is graded.
 */
export const WAZIR_GOVERNANCE_LAW =
  'Evidence can change how the agent works, but NEVER what it may access or how it is graded.';

export type GovernanceViolationCode =
  | 'GOVERNANCE_PATH_MODIFIED'
  | 'FROZEN_SPEC_MODIFIED'
  | 'ORACLE_ASSERTION_WEAKENED'
  | 'CAPABILITY_CEILING_ESCALATION'
  | 'REWARD_HACKING_DETECTED'
  | 'ADVERSARIAL_PROMPT_INJECTION';

export interface GovernanceViolation {
  code: GovernanceViolationCode;
  severity: 'CRITICAL' | 'HIGH';
  message: string;
  target?: string;
  evidence?: string;
}

export interface GovernanceValidationResult {
  allowed: boolean;
  law: string;
  violations: GovernanceViolation[];
  checkedAt: Date;
}

export type SandboxStrictnessMode =
  | 'strict'
  | 'isolated'
  | 'seatbelt'
  | 'container'
  | 'workspace-write'
  | 'standard'
  | 'sandboxed'
  | 'default'
  | 'unsandboxed'
  | 'none'
  | 'bypass'
  | 'disabled'
  | 'host';

export type ApprovalStrictnessMode =
  | 'strict'
  | 'always'
  | 'manual'
  | 'require-approval'
  | 'on-mutation'
  | 'edits-only'
  | 'default'
  | 'prompt'
  | 'auto-edit'
  | 'workspace-auto'
  | 'never'
  | 'yolo'
  | 'auto'
  | 'bypass'
  | 'none';

export interface CapabilityCeiling {
  allowedTools?: readonly string[];
  sandboxMode?: SandboxStrictnessMode | string;
  networkAccess?: boolean | 'none' | 'disabled' | 'restricted' | 'enabled' | 'full';
  approvalMode?: ApprovalStrictnessMode | string;
  protectedFiles?: readonly string[];
  workspaceRoot?: string;
}

export interface HarnessProposalInput {
  allowedTools?: readonly string[];
  sandboxMode?: SandboxStrictnessMode | string;
  networkAccess?: boolean | 'none' | 'disabled' | 'restricted' | 'enabled' | 'full';
  approvalMode?: ApprovalStrictnessMode | string;
  systemPromptHints?: readonly string[];
  promptOverlay?: string;
  conventions?: readonly string[];
  architecturalInvariants?: readonly string[];
  commands?: readonly string[];
  filesChanged?: readonly string[];
  patch?: string;
  urlsAccessed?: readonly string[];
}

export interface CandidateGovernanceInput {
  filesChanged?: readonly string[];
  patch?: string;
  commands?: readonly string[];
  urlsAccessed?: readonly string[];
  toolCalls?: readonly ToolCallRecord[];
  proposedConfig?: HarnessProposalInput;
  workspaceRoot?: string;
}

export interface CandidateGovernanceOptions {
  expectedFiles?: readonly string[];
  protectedFiles?: readonly string[];
  baseCeiling?: CapabilityCeiling;
  workspaceRoot?: string;
}

export class GovernanceFenceError extends Error {
  public readonly violations: GovernanceViolation[];

  constructor(message: string, violations: GovernanceViolation[]) {
    super(message);
    this.name = 'GovernanceFenceError';
    this.violations = violations;
  }
}

const PROTECTED_GOVERNANCE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)packages\/core\/src\/services\/(policyEngine|permissionBroker|sandbox|fencing)\.(ts|js|mjs|cjs)$/i,
  /(^|\/)(policyEngine|permissionBroker|sandbox|fencing|governanceFence)\.(ts|js|mjs|cjs)$/i,
  /(^|\/)\.wazir\/policy/i,
];

const FROZEN_SPEC_PATH_PATTERNS: RegExp[] = [
  /(^|\/)specs(\/|$)/i,
  /\.(als|dfy)$/i,
];

const DEFAULT_PROTECTED_FIXTURE_PATTERN =
  /(^|\/)(__fixtures__|fixtures)\/|\.fixture\.|benchmark\.expect\./i;

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$|(^|\/)__tests__\//i;

const SKIP_OR_ONLY_INSERTION_PATTERN =
  /\b(it|test|describe|suite|context)\s*\.\s*(skip|only)\s*\(|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(/;

const EXPECT_ASSERTION_PATTERN = /\b(expect\s*\(|assert(?:\.\w+)?\s*\()/g;

const TAUTOLOGICAL_ASSERTION_PATTERN =
  /\bexpect\s*\(\s*(true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy)\s*\(|\bassert(?:\.ok|\.strictEqual|\.equal)?\s*\(\s*(?:true|1\s*===\s*1|1\s*,\s*1|'a'\s*,\s*'a')\s*\)/i;

const REWARD_HACKING_URL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/(?:datasets|spaces)\b/i,
    reason: 'Attempted access to Hugging Face dataset/benchmark repository',
  },
  {
    pattern: /(?:https?:\/\/)?raw\.githubusercontent\.com\/[^\s'"]*/i,
    reason: 'Attempted access to external raw.githubusercontent.com benchmark/rubric resource',
  },
  {
    pattern: /(?:https?:\/\/)?api\.github\.com\/repos\/[^\s'"]*\/(?:commits|pulls|contents)/i,
    reason: 'Attempted access to external GitHub API commit/solution history',
  },
  {
    pattern: /\b(?:swe-bench|benchmark[-_]?rubric|answer[-_]?key|gold[-_]?patch|ground[-_]?truth)\b.*https?:\/\//i,
    reason: 'Attempted external fetch of benchmark rubric or answer key',
  },
];

const REWARD_HACKING_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:SKIP_TESTS|CI_SKIP_TESTS|VITEST_SKIP)\s*=\s*(?:1|true|yes)\b/i,
    reason: 'Environment variable set to bypass test execution (SKIP_TESTS)',
  },
  {
    pattern: /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/i,
    reason: 'Disabled TLS certificate verification (NODE_TLS_REJECT_UNAUTHORIZED=0)',
  },
  {
    pattern: /\bGIT_SSL_NO_VERIFY\s*=\s*(?:1|true)\b/i,
    reason: 'Disabled Git SSL verification (GIT_SSL_NO_VERIFY)',
  },
  {
    pattern: /(?:\.\.\/){2,}[^\s'"]*(?:grading|rubric|answer|solution|eval|benchmark|secret)/i,
    reason: 'Parent directory traversal targeting grading/rubric files outside workspace',
  },
  {
    pattern: /(?:^|[\s'"])\/(?:grading|eval_harness|benchmark_answers|root|etc\/shadow|proc\/self\/environ)\b/i,
    reason: 'Attempted read of protected host or grading filesystem path outside workspace',
  },
];

const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|system)\s+(?:instructions|rules|constraints|governance|directives)/i,
    reason: 'Prompt injection attempting to override system instructions or governance',
  },
  {
    pattern: /disregard\s+(?:all\s+|any\s+)?(?:governance|policy|sandbox|safety|verification|fencing)/i,
    reason: 'Prompt injection attempting to disregard governance or verification',
  },
  {
    pattern: /\b(?:bypass|disable)\s+(?:the\s+)?(?:sandbox|governance\s*fence|policy\s*engine|permission\s*broker|verification\s*oracle)/i,
    reason: 'Directive attempting to bypass sandbox, policy, or verification oracle',
  },
  {
    pattern: /(?:<\|im_start\|>\s*system|<\/?system>|\[INST\]|###\s*System\s*Override)/i,
    reason: 'Control-token delimiter injection in harness overlay',
  },
];

function normalizeFilePath(p: string): string {
  const trimmed = p.replace(/\\/g, '/').trim();
  if (!trimmed) return '';
  const norm = path.posix.normalize(trimmed).replace(/^\.\//, '');
  return norm === '.' ? '' : norm;
}

function sandboxStrictnessRank(mode: string | undefined): number {
  if (!mode) return 2;
  const m = mode.toLowerCase().trim();
  if (['strict', 'isolated', 'seatbelt', 'container', 'read-only'].includes(m)) return 3;
  if (['workspace-write', 'standard', 'sandboxed', 'default'].includes(m)) return 2;
  if (['unsandboxed', 'none', 'bypass', 'disabled', 'host', 'permissive'].includes(m)) return 1;
  return 2;
}

function networkAccessRank(access: CapabilityCeiling['networkAccess']): number {
  if (access === undefined || access === false || access === 'none' || access === 'disabled') return 0;
  if (access === 'restricted') return 1;
  if (access === true || access === 'enabled' || access === 'full') return 2;
  return 0;
}

function approvalStrictnessRank(mode: string | undefined): number {
  if (!mode) return 3;
  const m = mode.toLowerCase().trim();
  if (['strict', 'always', 'manual', 'require-approval'].includes(m)) return 4;
  if (['on-mutation', 'edits-only', 'default', 'prompt'].includes(m)) return 3;
  if (['auto-edit', 'workspace-auto'].includes(m)) return 2;
  if (['never', 'yolo', 'auto', 'bypass', 'none'].includes(m)) return 1;
  return 3;
}

function extractPathsFromPatch(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split('\n');
  for (const line of lines) {
    const gitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim());
    if (gitMatch) {
      paths.add(normalizeFilePath(gitMatch[1]));
      paths.add(normalizeFilePath(gitMatch[2]));
      continue;
    }
    const headerMatch = /^(?:---|\+\+\+) (?:a\/|b\/)?([^\t\n]+)$/.exec(line.trim());
    if (headerMatch && headerMatch[1] !== '/dev/null') {
      paths.add(normalizeFilePath(headerMatch[1]));
    }
  }
  return [...paths];
}

function splitPatchByFile(patch: string): Array<{ filePath?: string; content: string }> {
  const chunks: Array<{ filePath?: string; content: string }> = [];
  const lines = patch.split('\n');
  let currentFile: string | undefined;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.length > 0) {
      chunks.push({ filePath: currentFile, content: currentLines.join('\n') });
      currentLines = [];
    }
  };

  for (const line of lines) {
    const gitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim());
    if (gitMatch) {
      flush();
      currentFile = normalizeFilePath(gitMatch[2]);
      currentLines.push(line);
      continue;
    }
    const plusHeader = /^\+\+\+ (?:b\/)?([^\t\n]+)$/.exec(line.trim());
    if (plusHeader && plusHeader[1] !== '/dev/null') {
      currentFile = normalizeFilePath(plusHeader[1]);
    }
    currentLines.push(line);
  }
  flush();
  return chunks;
}

/**
 * Deterministic hard security gate enforcing Wazir's governance law (A060):
 * "Evidence can change how the agent works, but NEVER what it may access or how it is graded."
 */
export class GovernanceFence {
  private readonly defaultCeiling: CapabilityCeiling;

  constructor(defaultCeiling: CapabilityCeiling = {}) {
    this.defaultCeiling = {
      ...defaultCeiling,
      allowedTools: defaultCeiling.allowedTools ? [...defaultCeiling.allowedTools] : undefined,
      protectedFiles: defaultCeiling.protectedFiles ? [...defaultCeiling.protectedFiles] : undefined,
    };
  }

  public static validateProposal(
    proposal: HarnessProposalInput,
    baseCeiling?: CapabilityCeiling,
  ): GovernanceValidationResult {
    return new GovernanceFence(baseCeiling).validateProposal(proposal, baseCeiling);
  }

  public static validateCandidate(
    candidate: CandidateGovernanceInput,
    options?: CandidateGovernanceOptions,
  ): GovernanceValidationResult {
    return new GovernanceFence(options?.baseCeiling).validateCandidate(candidate, options);
  }

  public static validateExecutionRecord(
    record: ExecutionRecord,
    options?: CandidateGovernanceOptions,
  ): GovernanceValidationResult {
    return new GovernanceFence(options?.baseCeiling).validateExecutionRecord(record, options);
  }

  /**
   * Validates a proposed harness adjustment (BehavioralHarnessEditor, DomainKnowledgeEditor,
   * or HarnessAssembler overlay) against the immutable base capability ceiling and governance rules.
   */
  public validateProposal(
    proposal: HarnessProposalInput,
    overrideCeiling?: CapabilityCeiling,
  ): GovernanceValidationResult {
    const ceiling: CapabilityCeiling = {
      ...this.defaultCeiling,
      ...overrideCeiling,
    };
    const violations: GovernanceViolation[] = [];

    // 1. Monotonic capability ceiling checks
    if (ceiling.allowedTools && proposal.allowedTools) {
      const baseSet = new Set(ceiling.allowedTools);
      const unauthorized = proposal.allowedTools.filter((t) => !baseSet.has(t));
      if (unauthorized.length > 0) {
        violations.push({
          code: 'CAPABILITY_CEILING_ESCALATION',
          severity: 'CRITICAL',
          message: `Proposed allowedTools escalates beyond base capability ceiling: [${unauthorized.join(', ')}]`,
          target: 'allowedTools',
          evidence: unauthorized.join(', '),
        });
      }
    } else if (ceiling.allowedTools && proposal.allowedTools?.includes('*') && !ceiling.allowedTools.includes('*')) {
      violations.push({
        code: 'CAPABILITY_CEILING_ESCALATION',
        severity: 'CRITICAL',
        message: 'Wildcard tool escalation (*) is forbidden by base capability ceiling',
        target: 'allowedTools',
        evidence: '*',
      });
    }

    if (ceiling.sandboxMode !== undefined && proposal.sandboxMode !== undefined) {
      const baseRank = sandboxStrictnessRank(ceiling.sandboxMode);
      const propRank = sandboxStrictnessRank(proposal.sandboxMode);
      if (propRank < baseRank) {
        violations.push({
          code: 'CAPABILITY_CEILING_ESCALATION',
          severity: 'CRITICAL',
          message: `Proposed sandboxMode '${proposal.sandboxMode}' relaxes base sandbox ceiling '${ceiling.sandboxMode}'`,
          target: 'sandboxMode',
          evidence: `${ceiling.sandboxMode} -> ${proposal.sandboxMode}`,
        });
      }
    }

    if (ceiling.networkAccess !== undefined && proposal.networkAccess !== undefined) {
      const baseNet = networkAccessRank(ceiling.networkAccess);
      const propNet = networkAccessRank(proposal.networkAccess);
      if (propNet > baseNet) {
        violations.push({
          code: 'CAPABILITY_CEILING_ESCALATION',
          severity: 'CRITICAL',
          message: `Proposed networkAccess '${String(proposal.networkAccess)}' escalates base network policy '${String(ceiling.networkAccess)}'`,
          target: 'networkAccess',
          evidence: `${String(ceiling.networkAccess)} -> ${String(proposal.networkAccess)}`,
        });
      }
    }

    if (ceiling.approvalMode !== undefined && proposal.approvalMode !== undefined) {
      const baseApp = approvalStrictnessRank(ceiling.approvalMode);
      const propApp = approvalStrictnessRank(proposal.approvalMode);
      if (propApp < baseApp) {
        violations.push({
          code: 'CAPABILITY_CEILING_ESCALATION',
          severity: 'CRITICAL',
          message: `Proposed approvalMode '${proposal.approvalMode}' relaxes base approval policy '${ceiling.approvalMode}'`,
          target: 'approvalMode',
          evidence: `${ceiling.approvalMode} -> ${proposal.approvalMode}`,
        });
      }
    }

    // 2. Prompt / convention / overlay inspection for prompt injection & reward hacking
    const overlayTexts: Array<{ source: string; text: string }> = [];
    if (proposal.promptOverlay) {
      overlayTexts.push({ source: 'promptOverlay', text: proposal.promptOverlay });
    }
    for (const hint of proposal.systemPromptHints ?? []) {
      overlayTexts.push({ source: 'systemPromptHints', text: hint });
    }
    for (const conv of proposal.conventions ?? []) {
      overlayTexts.push({ source: 'conventions', text: conv });
    }
    for (const inv of proposal.architecturalInvariants ?? []) {
      overlayTexts.push({ source: 'architecturalInvariants', text: inv });
    }

    for (const item of overlayTexts) {
      for (const rule of PROMPT_INJECTION_PATTERNS) {
        if (rule.pattern.test(item.text)) {
          violations.push({
            code: 'ADVERSARIAL_PROMPT_INJECTION',
            severity: 'CRITICAL',
            message: rule.reason,
            target: item.source,
            evidence: item.text.slice(0, 160),
          });
        }
      }
      this.inspectTextForRewardHacking(item.text, item.source, violations);
    }

    // 3. Also inspect any filesChanged, patch, commands, or URLs attached to the proposal
    if (
      (proposal.filesChanged && proposal.filesChanged.length > 0) ||
      proposal.patch ||
      (proposal.commands && proposal.commands.length > 0) ||
      (proposal.urlsAccessed && proposal.urlsAccessed.length > 0)
    ) {
      const candidateCheck = this.validateCandidate(
        {
          filesChanged: proposal.filesChanged,
          patch: proposal.patch,
          commands: proposal.commands,
          urlsAccessed: proposal.urlsAccessed,
        },
        {
          protectedFiles: ceiling.protectedFiles,
          baseCeiling: ceiling,
          workspaceRoot: ceiling.workspaceRoot,
        },
      );
      violations.push(...candidateCheck.violations);
    }

    return {
      allowed: violations.length === 0,
      law: WAZIR_GOVERNANCE_LAW,
      violations,
      checkedAt: new Date(),
    };
  }

  /**
   * Validates candidate file mutations, diffs/patches, shell commands, tool calls, and URLs
   * against all 5 hard governance invariants.
   */
  public validateCandidate(
    candidate: CandidateGovernanceInput,
    options: CandidateGovernanceOptions = {},
  ): GovernanceValidationResult {
    const ceiling: CapabilityCeiling = {
      ...this.defaultCeiling,
      ...options.baseCeiling,
    };
    const workspaceRoot = candidate.workspaceRoot ?? options.workspaceRoot ?? ceiling.workspaceRoot;
    const expectedSet = new Set((options.expectedFiles ?? []).map(normalizeFilePath));
    const protectedList = [
      ...(ceiling.protectedFiles ?? []),
      ...(options.protectedFiles ?? []),
    ].map(normalizeFilePath);

    const violations: GovernanceViolation[] = [];

    if (candidate.proposedConfig) {
      const propRes = this.validateProposal(candidate.proposedConfig, ceiling);
      violations.push(...propRes.violations);
    }

    // Collect all touched file paths from filesChanged, patch headers, and mutation toolCalls
    const allTouchedFiles = new Set<string>(
      (candidate.filesChanged ?? []).map(normalizeFilePath).filter(Boolean),
    );
    if (candidate.patch) {
      for (const p of extractPathsFromPatch(candidate.patch)) {
        allTouchedFiles.add(p);
      }
    }
    for (const tc of candidate.toolCalls ?? []) {
      if (['edit', 'edit_file', 'write_file', 'write_to_file', 'replace', 'replace_file_content', 'multi_edit', 'patch', 'apply_patch'].includes(tc.tool)) {
        const input = tc.input as Record<string, unknown> | undefined;
        for (const k of ['path', 'file_path', 'filePath', 'target', 'file']) {
          if (typeof input?.[k] === 'string') {
            allTouchedFiles.add(normalizeFilePath(input[k] as string));
          }
        }
      }
    }

    // Check 1 & 2 & 3a: Governance paths, Frozen formal specs, Protected fixtures
    for (const file of allTouchedFiles) {
      if (PROTECTED_GOVERNANCE_PATH_PATTERNS.some((rx) => rx.test(file))) {
        violations.push({
          code: 'GOVERNANCE_PATH_MODIFIED',
          severity: 'CRITICAL',
          message: `Candidate touched protected governance/guardrail file '${file}'`,
          target: file,
        });
      }

      if (FROZEN_SPEC_PATH_PATTERNS.some((rx) => rx.test(file))) {
        violations.push({
          code: 'FROZEN_SPEC_MODIFIED',
          severity: 'CRITICAL',
          message: `Candidate touched frozen formal specification '${file}'`,
          target: file,
        });
      }

      const isExplicitlyProtected = protectedList.some(
        (p) => file === p || file.endsWith(`/${p}`) || file.startsWith(p.endsWith('/') ? p : `${p}/`),
      );
      const isDefaultProtectedFixture =
        !expectedSet.has(file) && DEFAULT_PROTECTED_FIXTURE_PATTERN.test(file);

      if (isExplicitlyProtected || isDefaultProtectedFixture) {
        violations.push({
          code: 'ORACLE_ASSERTION_WEAKENED',
          severity: 'CRITICAL',
          message: `Candidate modified protected test/fixture path '${file}'`,
          target: file,
        });
      }
    }

    // Check 3b: Patch / diff inspection for test assertion deletion or .skip( / .only(
    if (candidate.patch) {
      this.inspectPatchForOracleWeakening(candidate.patch, expectedSet, violations);
      this.inspectTextForRewardHacking(candidate.patch, 'patch', violations);
    }

    // Check toolCalls for direct edits weakening tests, reading host grading files, or fetching rubrics
    const commandsToInspect: string[] = [...(candidate.commands ?? [])];
    const urlsToInspect: string[] = [...(candidate.urlsAccessed ?? [])];

    for (const tc of candidate.toolCalls ?? []) {
      const input = (tc.input ?? {}) as Record<string, unknown>;

      if (typeof input.command === 'string') {
        commandsToInspect.push(input.command);
      }
      for (const urlKey of ['url', 'uri', 'endpoint', 'href']) {
        if (typeof input[urlKey] === 'string') {
          urlsToInspect.push(input[urlKey] as string);
        }
      }

      // Check file reads escaping workspace root or reading grading/rubric files
      if (['read_file', 'read_many_files', 'view_file', 'cat'].includes(tc.tool)) {
        const readTargets: string[] = [];
        for (const k of ['path', 'file_path', 'filePath', 'target']) {
          if (typeof input[k] === 'string') readTargets.push(input[k] as string);
        }
        if (Array.isArray(input.paths)) {
          for (const p of input.paths) if (typeof p === 'string') readTargets.push(p);
        }
        for (const rawTarget of readTargets) {
          this.inspectReadTargetForGradingLeak(rawTarget, workspaceRoot, violations);
        }
      }

      // Check direct edit_file / write_file calls weakening test assertions
      const editPath = (input.path ?? input.file_path ?? input.filePath ?? '') as string;
      const normEditPath = typeof editPath === 'string' ? normalizeFilePath(editPath) : '';
      if (normEditPath && TEST_FILE_PATTERN.test(normEditPath)) {
        const replacement = String(input.replacement ?? input.new_string ?? input.content ?? '');
        const target = String(input.target ?? input.old_string ?? '');
        const isWholeFileWriteTool = ['write', 'write_file', 'create_file', 'overwrite_file'].includes(tc.tool);

        if (SKIP_OR_ONLY_INSERTION_PATTERN.test(replacement) && !SKIP_OR_ONLY_INSERTION_PATTERN.test(target)) {
          violations.push({
            code: 'ORACLE_ASSERTION_WEAKENED',
            severity: 'CRITICAL',
            message: `Tool '${tc.tool}' introduced test skip/only modifier in '${normEditPath}'`,
            target: normEditPath,
            evidence: replacement.slice(0, 120),
          });
        }
        if (
          !expectedSet.has(normEditPath) &&
          TAUTOLOGICAL_ASSERTION_PATTERN.test(replacement) &&
          !TAUTOLOGICAL_ASSERTION_PATTERN.test(target)
        ) {
          violations.push({
            code: 'ORACLE_ASSERTION_WEAKENED',
            severity: 'CRITICAL',
            message: `Tool '${tc.tool}' introduced tautological assertion in '${normEditPath}'`,
            target: normEditPath,
            evidence: replacement.slice(0, 120),
          });
        }
        if (isWholeFileWriteTool && !target && !expectedSet.has(normEditPath)) {
          violations.push({
            code: 'ORACLE_ASSERTION_WEAKENED',
            severity: 'CRITICAL',
            message: `Tool '${tc.tool}' attempted whole-file overwrite of unexempted test file '${normEditPath}'`,
            target: normEditPath,
            evidence: replacement.slice(0, 120),
          });
        } else if (target) {
          const oldExpects = (target.match(EXPECT_ASSERTION_PATTERN) ?? []).length;
          const newExpects = (replacement.match(EXPECT_ASSERTION_PATTERN) ?? []).length;
          if (oldExpects > newExpects && !expectedSet.has(normEditPath)) {
            violations.push({
              code: 'ORACLE_ASSERTION_WEAKENED',
              severity: 'CRITICAL',
              message: `Tool '${tc.tool}' deleted ${oldExpects - newExpects} assertion(s) in '${normEditPath}'`,
              target: normEditPath,
              evidence: target.slice(0, 120),
            });
          }
        }
      }
    }

    // Check 5: Inspect commands and URLs for reward-hacking, rubric fetching, or guardrail shell edits
    for (const cmd of commandsToInspect) {
      this.inspectTextForRewardHacking(cmd, 'command', violations);
      this.inspectCommandForProtectedWrite(cmd, violations);
    }

    for (const url of urlsToInspect) {
      this.inspectTextForRewardHacking(url, 'url', violations);
    }

    return {
      allowed: violations.length === 0,
      law: WAZIR_GOVERNANCE_LAW,
      violations: this.deduplicateViolations(violations),
      checkedAt: new Date(),
    };
  }

  /**
   * Convenience helper inspecting an ExecutionRecord directly.
   */
  public validateExecutionRecord(
    record: ExecutionRecord,
    options: CandidateGovernanceOptions = {},
  ): GovernanceValidationResult {
    const rawDiff = (record as { diff?: unknown; patch?: unknown }).diff ??
      (record as { patch?: unknown }).patch;
    const checkCommands = (record.checks ?? [])
      .map((c) => c.command)
      .filter((c): c is string => typeof c === 'string');
    const evidenceCommands = (record.evidence ?? [])
      .map((e) => e.command)
      .filter((c): c is string => typeof c === 'string');

    return this.validateCandidate(
      {
        filesChanged: record.filesChanged,
        patch: typeof rawDiff === 'string' ? rawDiff : undefined,
        commands: [...checkCommands, ...evidenceCommands],
        toolCalls: record.toolCalls,
        workspaceRoot: options.workspaceRoot ?? record.execution?.workspaceRoot,
      },
      options,
    );
  }

  private inspectPatchForOracleWeakening(
    patch: string,
    expectedSet: Set<string>,
    violations: GovernanceViolation[],
  ): void {
    const chunks = splitPatchByFile(patch);
    for (const chunk of chunks) {
      const file = chunk.filePath ?? '<patch>';
      const isAuthorizedExpected = chunk.filePath ? expectedSet.has(chunk.filePath) : false;
      const isTestFile = chunk.filePath ? TEST_FILE_PATTERN.test(chunk.filePath) : true;

      let removedAssertions = 0;
      let addedAssertions = 0;

      for (const line of chunk.content.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          const addedContent = line.slice(1);
          if (SKIP_OR_ONLY_INSERTION_PATTERN.test(addedContent)) {
            violations.push({
              code: 'ORACLE_ASSERTION_WEAKENED',
              severity: 'CRITICAL',
              message: `Patch introduced test skip/only gate bypass in '${file}'`,
              target: file,
              evidence: addedContent.trim().slice(0, 120),
            });
          }
          if (isTestFile && !isAuthorizedExpected && TAUTOLOGICAL_ASSERTION_PATTERN.test(addedContent)) {
            violations.push({
              code: 'ORACLE_ASSERTION_WEAKENED',
              severity: 'CRITICAL',
              message: `Patch introduced tautological test assertion in '${file}'`,
              target: file,
              evidence: addedContent.trim().slice(0, 120),
            });
          }
          addedAssertions += (addedContent.match(EXPECT_ASSERTION_PATTERN) ?? []).length;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          const removedContent = line.slice(1);
          removedAssertions += (removedContent.match(EXPECT_ASSERTION_PATTERN) ?? []).length;
        }
      }

      if (isTestFile && !isAuthorizedExpected && removedAssertions > addedAssertions) {
        violations.push({
          code: 'ORACLE_ASSERTION_WEAKENED',
          severity: 'CRITICAL',
          message: `Patch weakened test oracle in '${file}' by deleting ${removedAssertions - addedAssertions} assertion(s)`,
          target: file,
          evidence: `removed=${removedAssertions}, added=${addedAssertions}`,
        });
      }
    }
  }

  private inspectTextForRewardHacking(
    text: string,
    source: string,
    violations: GovernanceViolation[],
  ): void {
    for (const rule of REWARD_HACKING_URL_PATTERNS) {
      const match = rule.pattern.exec(text);
      if (match) {
        violations.push({
          code: 'REWARD_HACKING_DETECTED',
          severity: 'CRITICAL',
          message: rule.reason,
          target: source,
          evidence: match[0].slice(0, 160),
        });
      }
    }

    for (const rule of REWARD_HACKING_COMMAND_PATTERNS) {
      const match = rule.pattern.exec(text);
      if (match) {
        violations.push({
          code: 'REWARD_HACKING_DETECTED',
          severity: 'CRITICAL',
          message: rule.reason,
          target: source,
          evidence: match[0].trim().slice(0, 160),
        });
      }
    }
  }

  private inspectReadTargetForGradingLeak(
    rawTarget: string,
    workspaceRoot: string | undefined,
    violations: GovernanceViolation[],
  ): void {
    const normalized = rawTarget.replace(/\\/g, '/').trim();
    if (/(^|\/)\.\.(\/|$)/.test(normalized)) {
      violations.push({
        code: 'REWARD_HACKING_DETECTED',
        severity: 'CRITICAL',
        message: `Tool read traversed outside workspace boundary: '${normalized}'`,
        target: normalized,
      });
      return;
    }

    if (/(?:grading|rubric|answer_key|gold_patch|benchmark_answers)/i.test(normalized) && normalized.startsWith('/')) {
      violations.push({
        code: 'REWARD_HACKING_DETECTED',
        severity: 'CRITICAL',
        message: `Tool attempted to read host grading/rubric file: '${normalized}'`,
        target: normalized,
      });
      return;
    }

    if (workspaceRoot && normalized.startsWith('/')) {
      const cleanRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      if (
        cleanRoot.length > 0 &&
        normalized !== cleanRoot &&
        !normalized.startsWith(`${cleanRoot}/`) &&
        !normalized.startsWith('/tmp/')
      ) {
        violations.push({
          code: 'REWARD_HACKING_DETECTED',
          severity: 'HIGH',
          message: `Tool read accessed host path outside workspace '${cleanRoot}': '${normalized}'`,
          target: normalized,
        });
      }
    }
  }

  private inspectCommandForProtectedWrite(
    cmd: string,
    violations: GovernanceViolation[],
  ): void {
    const writeOrInterpreter =
      /(?:>|>>|\bsed\s+-i|\bperl\s+-[pi]|\btee\b|\bcp\b|\bmv\b|\brm\b|\bchmod\b|\btruncate\b|\bdd\b|\bpatch\b|\bln\b|\binstall\b|\bwriteFileSync\b|\bwriteFile\b|\bappendFile|\bunlink|\bfs\.|\bopen\s*\(|\bPath\s*\(|\bnode\s+-e\b|\bpython3?\s+-c\b|\bruby\s+-e\b)/;
    if (!writeOrInterpreter.test(cmd)) return;

    const tokens = cmd.split(/[\s'"`();,|&><]+/).map(normalizeFilePath).filter(Boolean);
    for (const tok of tokens) {
      if (PROTECTED_GOVERNANCE_PATH_PATTERNS.some((rx) => rx.test(tok))) {
        violations.push({
          code: 'GOVERNANCE_PATH_MODIFIED',
          severity: 'CRITICAL',
          message: `Shell command attempted to mutate governance path '${tok}'`,
          target: tok,
          evidence: cmd.slice(0, 160),
        });
      }
      if (FROZEN_SPEC_PATH_PATTERNS.some((rx) => rx.test(tok))) {
        violations.push({
          code: 'FROZEN_SPEC_MODIFIED',
          severity: 'CRITICAL',
          message: `Shell command attempted to mutate frozen formal spec '${tok}'`,
          target: tok,
          evidence: cmd.slice(0, 160),
        });
      }
    }
  }

  private deduplicateViolations(violations: GovernanceViolation[]): GovernanceViolation[] {
    const seen = new Set<string>();
    const out: GovernanceViolation[] = [];
    for (const v of violations) {
      const key = `${v.code}::${v.target ?? ''}::${v.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }
    return out;
  }
}
