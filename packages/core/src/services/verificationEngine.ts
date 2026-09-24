import crypto from 'node:crypto';
import path from 'node:path';
import type {
  CompletionEvaluation,
  OracleType,
  PhysicalMutationInput,
  PhysicalMutationOutcome,
  VerificationEvidence,
  VerificationRequirements,
  VerificationSet,
  VerificationStatus,
} from '../types/verification.js';
import { detectOracleWeakening } from './verificationIntegrity.js';

export interface VerificationOracle {
  readonly type: OracleType;
  verify(params: {
    command?: string;
    target?: string;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    exitCode: number;
    output?: string;
    status?: VerificationStatus;
    artifacts?: string[];
    reasons?: string[];
  }>;
}

export interface VerificationEngineOptions {
  projectRoot?: string;
  initialRevision?: number;
  oracles?: Map<OracleType, VerificationOracle>;
  protectedFiles?: string[];
}

export class VerificationEngine {
  private currentRevision: number;
  private readonly projectRoot: string;
  private readonly oracles = new Map<OracleType, VerificationOracle>();
  private readonly evidenceHistory: VerificationEvidence[] = [];
  private readonly filesChanged = new Set<string>();
  private readonly weakeningViolations: string[] = [];
  private readonly protectedFiles: string[];

  constructor(options: VerificationEngineOptions = {}) {
    this.currentRevision = options.initialRevision ?? 0;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.protectedFiles = options.protectedFiles ?? [];
    if (options.oracles) {
      for (const [type, oracle] of options.oracles.entries()) {
        this.registerOracle(oracle);
      }
    }
  }

  getRevision(): number {
    return this.currentRevision;
  }

  getFilesChanged(): string[] {
    return Array.from(this.filesChanged);
  }

  registerOracle(oracle: VerificationOracle): void {
    this.oracles.set(oracle.type, oracle);
  }

  getOracle(type: OracleType): VerificationOracle | undefined {
    return this.oracles.get(type);
  }

  /**
   * Tracks a physical file mutation.
   * Advances workspace revision R -> R+1 if and only if physical bytes actually changed.
   * If bytes are identical (no-op edit or failed write), revision remains R.
   * Any successful mutation invalidates previous completion evidence.
   */
  trackPhysicalMutation(input: PhysicalMutationInput): PhysicalMutationOutcome {
    const prevRev = this.currentRevision;
    const normBefore = input.beforeContent !== null && input.beforeContent !== undefined
      ? (Buffer.isBuffer(input.beforeContent) ? input.beforeContent.toString('utf8') : String(input.beforeContent))
      : null;
    const normAfter = input.afterContent !== null && input.afterContent !== undefined
      ? (Buffer.isBuffer(input.afterContent) ? input.afterContent.toString('utf8') : String(input.afterContent))
      : null;

    const hashBefore = normBefore !== null
      ? crypto.createHash('sha256').update(normBefore).digest('hex')
      : null;
    const hashAfter = normAfter !== null
      ? crypto.createHash('sha256').update(normAfter).digest('hex')
      : null;

    // Physical state is authoritative: no-op edit or identical bytes = no mutation
    if (hashBefore === hashAfter) {
      return {
        mutated: false,
        filePath: input.filePath,
        previousRevision: prevRev,
        newRevision: prevRev,
        invalidatedEvidenceCount: 0,
      };
    }

    // Physical bytes changed: advance revision R -> R+1
    this.currentRevision += 1;
    this.filesChanged.add(input.filePath);

    // Anti-test-theater check: detect unpermitted test skipping, trivial assertions, or fixture tampering
    const relPath = path.isAbsolute(input.filePath)
      ? path.relative(this.projectRoot, input.filePath)
      : input.filePath;

    const weakeningFindings = detectOracleWeakening(relPath, normBefore, normAfter);
    const weakeningReasons = weakeningFindings.map((f) => (f as any).explanation ?? f.detail);

    if (weakeningFindings.length > 0) {
      this.weakeningViolations.push(...weakeningReasons);
    }

    // Check protected file policy
    const isProtected = this.protectedFiles.some(
      (pf) => relPath === pf || relPath.endsWith(`/${pf}`),
    );
    if (isProtected) {
      const reason = `PROTECTED_FIXTURE_MODIFIED: agent modified protected file: ${relPath}`;
      this.weakeningViolations.push(reason);
      weakeningReasons.push(reason);
    }

    const invalidatedCount = this.evidenceHistory.filter(
      (e) => e.workspaceRevision < this.currentRevision,
    ).length;

    return {
      mutated: true,
      filePath: input.filePath,
      previousRevision: prevRev,
      newRevision: this.currentRevision,
      invalidatedEvidenceCount: invalidatedCount,
      weakeningDetected: weakeningReasons.length > 0,
      weakeningReasons: weakeningReasons.length > 0 ? weakeningReasons : undefined,
    };
  }

  /**
   * Run an oracle and record its evidence bound to current workspace revision R.
   */
  async runOracle(
    type: OracleType,
    params: { command?: string; target?: string; cwd?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<VerificationEvidence> {
    const oracle = this.oracles.get(type);
    if (!oracle) {
      throw new Error(`Oracle '${type}' is not registered with VerificationEngine`);
    }

    const startedAt = new Date();
    const result = await oracle.verify(params);
    const completedAt = new Date();
    const status: VerificationStatus = result.status ?? (result.exitCode === 0 ? 'PASS' : 'FAIL');

    return this.recordEvidence({
      oracle: type,
      command: params.command,
      exitCode: result.exitCode,
      output: result.output,
      status,
      artifacts: result.artifacts,
      reasons: result.reasons,
      startedAt,
      completedAt,
      metadata: params.metadata,
    });
  }

  /**
   * Record external or controller-produced verification evidence bound strictly to current revision R.
   * Model narration or prose CANNOT call this.
   */
  recordEvidence(params: {
    oracle: OracleType;
    command?: string;
    exitCode: number;
    output?: string;
    status?: VerificationStatus;
    artifacts?: string[];
    reasons?: string[];
    startedAt?: Date;
    completedAt?: Date;
    metadata?: Record<string, unknown>;
    executionId?: string;
  }): VerificationEvidence {
    const rev = this.currentRevision;
    const status = params.status ?? (params.exitCode === 0 ? 'PASS' : 'FAIL');
    const started = params.startedAt ?? new Date();
    const completed = params.completedAt ?? new Date();

    const rawPayload = `${params.oracle}:${params.command ?? ''}:${params.exitCode}:${rev}:${params.output ?? ''}`;
    const evidenceHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
    const id = `evd-${params.oracle.toLowerCase()}-${rev}-${crypto.randomBytes(4).toString('hex')}`;

    const evidence: VerificationEvidence = {
      id,
      executionId: params.executionId,
      workspaceRevision: rev,
      revision: rev,
      oracle: params.oracle,
      type: params.oracle,
      command: params.command,
      exitCode: params.exitCode,
      startedAt: started,
      completedAt: completed,
      durationMs: completed.getTime() - started.getTime(),
      status,
      evidenceHash,
      artifacts: params.artifacts,
      output: params.output,
      reasons: params.reasons,
      metadata: params.metadata,
    };

    this.evidenceHistory.push(evidence);
    return evidence;
  }

  /**
   * Retrieves the current active VerificationSet bound to current workspace revision R.
   */
  getActiveVerificationSet(): VerificationSet {
    const rev = this.currentRevision;
    const currentEvidence = this.evidenceHistory.filter(
      (e) => e.workspaceRevision === rev,
    );
    return {
      workspaceRevision: rev,
      evidence: currentEvidence,
      collectedAt: new Date(),
    };
  }

  /**
   * All historical evidence across all revisions.
   */
  getAllEvidence(): VerificationEvidence[] {
    return [...this.evidenceHistory];
  }

  /**
   * Authoritative Completion Evaluator:
   * COMPLETE(R) iff:
   * - workspace.currentRevision == R
   * - requiredBuild(R) == PASS
   * - requiredTests(R) == PASS
   * - requiredStaticChecks(R) == PASS
   * - requiredAcceptanceChecks(R) == PASS
   * - No anti-test-theater violations
   * - If mutationRequired: R > 0 and filesChanged.length > 0
   */
  verifyCompletion(requirements: VerificationRequirements = {}): CompletionEvaluation {
    const currentRev = this.currentRevision;
    const reasons: string[] = [];
    let complete = true;

    // 1. Anti-test-theater check
    if (this.weakeningViolations.length > 0) {
      complete = false;
      for (const violation of this.weakeningViolations) {
        reasons.push(`ANTI_TEST_THEATER_DETECTED: ${violation}`);
      }
    }

    // 2. Mutation required check
    if (requirements.mutationRequired && (currentRev === 0 || this.filesChanged.size === 0)) {
      complete = false;
      reasons.push('MUTATION_REQUIRED: Task requires physical code modification but no files changed');
    }

    // 3. Expected files check
    if (requirements.expectedFiles && requirements.expectedFiles.length > 0) {
      for (const expected of requirements.expectedFiles) {
        const norm = expected.replace(/\\/g, '/');
        const changed = Array.from(this.filesChanged).map((f) => f.replace(/\\/g, '/'));
        const found = changed.some((c) => c === norm || c.endsWith(`/${norm}`));
        if (!found) {
          complete = false;
          reasons.push(`EXPECTED_FILE_NOT_CHANGED: Expected mutation in '${expected}' was not observed`);
        }
      }
    }

    // Normalize required oracles
    const requiredOracles: OracleType[] = [];
    if (requirements.requiredOracles) {
      requiredOracles.push(...requirements.requiredOracles);
    }
    if (requirements.requiredEvidence) {
      for (const req of requirements.requiredEvidence) {
        if (req === 'STATIC_CHECK') {
          if (!requiredOracles.includes('TYPECHECK') && !requiredOracles.includes('STATIC_ANALYSIS')) {
            requiredOracles.push('TYPECHECK');
          }
        } else if (!requiredOracles.includes(req)) {
          requiredOracles.push(req);
        }
      }
    }

    const currentEvidence = this.evidenceHistory.filter((e) => e.workspaceRevision === currentRev);
    const staleEvidence = this.evidenceHistory.filter((e) => e.workspaceRevision < currentRev);

    const satisfiedOracles: OracleType[] = [];
    const missingOracles: OracleType[] = [];

    for (const oracle of requiredOracles) {
      const evidenceAtCurrent = currentEvidence.find(
        (e) => (e.oracle === oracle || e.type === oracle) && e.status === 'PASS' && e.exitCode === 0,
      );

      if (evidenceAtCurrent) {
        satisfiedOracles.push(oracle);
      } else {
        missingOracles.push(oracle);
        complete = false;

        // Check if there was stale evidence from an earlier revision
        const earlierSuccess = staleEvidence
          .filter((e) => (e.oracle === oracle || e.type === oracle) && e.status === 'PASS' && e.exitCode === 0)
          .sort((a, b) => b.workspaceRevision - a.workspaceRevision)[0];

        if (earlierSuccess) {
          reasons.push(
            `${oracle}_EVIDENCE_STALE: ${oracle} evidence is stale for revision ${currentRev} (latest successful run was revision ${earlierSuccess.workspaceRevision})`,
          );
        } else {
          const failedAtCurrent = currentEvidence.find(
            (e) => (e.oracle === oracle || e.type === oracle) && (e.status !== 'PASS' || e.exitCode !== 0),
          );
          if (failedAtCurrent) {
            reasons.push(`${oracle}_FAILED: ${oracle} check failed for revision ${currentRev} with exit code ${failedAtCurrent.exitCode}`);
          } else {
            reasons.push(`NO_${oracle}_EVIDENCE: No ${oracle} evidence exists for current workspace revision ${currentRev}`);
          }
        }
      }
    }

    if (complete) {
      reasons.push(`VERIFICATION_COMPLETE: Workspace revision ${currentRev} satisfies all required verification oracles`);
    }

    return {
      complete,
      workspaceRevision: currentRev,
      reasons,
      satisfiedOracles,
      missingOracles,
      staleEvidence,
    };
  }
}
