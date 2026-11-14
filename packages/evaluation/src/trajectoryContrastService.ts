import { evidencePassed, latestEvidenceAtRevision } from '@wazir/core';
import type { ExecutionRecord, ToolCallRecord } from '@wazir/core';

export type ContrastiveVerdictTag = 'VERIFIED' | 'UNVERIFIED_CONTRASTIVE';

export interface TrajectoryEditLocality {
  filesChanged: string[];
  filesChangedCount: number;
  diffSize: number;
  directorySpread: number;
  directories: string[];
  focusScore: number;
}

export interface TrajectoryLoopTelemetry {
  repeatedIdenticalToolCalls: number;
  maxConsecutiveIdenticalCalls: number;
  malformedActions: number;
  failedToolCalls: number;
  repairCycles: number;
  loopDetected: boolean;
}

export interface TrajectoryPhysicalVerification {
  oracleRan: boolean;
  finalRevisionVerified: boolean;
  physicalVerificationPassed: boolean;
  workspaceRevision: number;
  checksPassedCount: number;
  checksTotalCount: number;
  satisfiedOracles: string[];
  failedOracles: string[];
}

export interface TrajectoryEfficiency {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  wallTimeMs: number;
  modelCalls: number;
  tokensPerFileChanged: number;
}

export interface TrajectoryBehavioralProfile {
  executionId: string;
  toolSequence: string[];
  uniqueTools: string[];
  readBeforeEditScore: number;
  readBeforeEditDisciplined: boolean;
  uninspectedEdits: string[];
  editLocality: TrajectoryEditLocality;
  loopTelemetry: TrajectoryLoopTelemetry;
  physicalVerification: TrajectoryPhysicalVerification;
  efficiency: TrajectoryEfficiency;
  verdictTag: ContrastiveVerdictTag;
}

export interface PairwiseTrajectoryDivergence {
  executionA: string;
  executionB: string;
  toolJaccardSimilarity: number;
  toolJaccardDistance: number;
  toolSequenceEditDistance: number;
  normalizedSequenceDistance: number;
  sharedFiles: string[];
  fileJaccardDistance: number;
}

export interface TrajectoryBehavioralDeltas {
  highLoopExecutionIds: string[];
  blindEditExecutionIds: string[];
  sprawlingEditExecutionIds: string[];
  unverifiedMutationExecutionIds: string[];
  efficientReferenceExecutionIds: string[];
  commonSuccessfulTools: string[];
  noisyFailedTools: string[];
  meanReadBeforeEditScore: number;
  meanDiffSize: number;
  meanTotalTokens: number;
}

export interface TrajectoryVerificationDelta {
  anyOracleRan: boolean;
  anyVerified: boolean;
  allVerified: boolean;
  verifiedExecutionIds: string[];
  unverifiedExecutionIds: string[];
  oraclePassRates: Record<string, number>;
}

export interface TrajectoryContrastReport {
  candidateCount: number;
  profiles: TrajectoryBehavioralProfile[];
  pairwiseDivergence: PairwiseTrajectoryDivergence[];
  verificationDelta: TrajectoryVerificationDelta;
  behavioralDeltas: TrajectoryBehavioralDeltas;
}

export interface ContrastiveRankedCandidate {
  executionId: string;
  rank: number;
  contrastiveScore: number;
  verdictTag: ContrastiveVerdictTag;
  profile: TrajectoryBehavioralProfile;
  rationale: string[];
}

export interface ContrastiveRankingResult {
  verdictTag: ContrastiveVerdictTag;
  winner?: ContrastiveRankedCandidate;
  rankings: ContrastiveRankedCandidate[];
  contrastReport: TrajectoryContrastReport;
}

const INSPECTION_TOOLS = new Set([
  'read_file',
  'read_many_files',
  'view_file',
  'grep',
  'glob',
  'search_code',
  'script_search',
  'script_grep',
  'script_read',
  'find_callers',
  'ast_query',
  'inspect',
  'list_dir',
  'ls',
]);

const MUTATION_TOOLS = new Set([
  'edit',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace',
  'replace_file_content',
  'multi_edit',
  'patch',
  'apply_patch',
]);

const SHELL_INSPECT_PATTERN = /^\s*(cat|head|tail|sed\s+-n|rg|grep|find|ls|git\s+(diff|show|status|log))\b/i;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function extractTargetPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const rec = input as Record<string, unknown>;
  const paths: string[] = [];

  for (const key of ['path', 'file_path', 'filePath', 'target', 'file']) {
    if (typeof rec[key] === 'string' && rec[key].trim()) {
      paths.push(normalizePath(rec[key] as string));
    }
  }
  for (const listKey of ['paths', 'files', 'targets']) {
    if (Array.isArray(rec[listKey])) {
      for (const item of rec[listKey] as unknown[]) {
        if (typeof item === 'string' && item.trim()) {
          paths.push(normalizePath(item));
        }
      }
    }
  }
  return paths;
}

function isInspectionCall(call: ToolCallRecord): boolean {
  if (INSPECTION_TOOLS.has(call.tool)) return true;
  if (call.tool === 'shell') {
    const cmd = (call.input as { command?: unknown } | undefined)?.command;
    if (typeof cmd === 'string' && SHELL_INSPECT_PATTERN.test(cmd)) {
      return true;
    }
  }
  return false;
}

function isMutationCall(call: ToolCallRecord): boolean {
  return MUTATION_TOOLS.has(call.tool);
}

function computeSequenceEditDistance(seqA: string[], seqB: string[]): number {
  const m = seqA.length;
  const n = seqB.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = seqA[i - 1] === seqB[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function computeJaccard(setA: Set<string>, setB: Set<string>): { similarity: number; distance: number; shared: string[] } {
  if (setA.size === 0 && setB.size === 0) {
    return { similarity: 1, distance: 0, shared: [] };
  }
  const shared = [...setA].filter((x) => setB.has(x)).sort();
  const unionSize = new Set([...setA, ...setB]).size;
  const similarity = unionSize > 0 ? Number((shared.length / unionSize).toFixed(4)) : 0;
  const distance = Number((1 - similarity).toFixed(4));
  return { similarity, distance, shared };
}

/**
 * Deterministic behavioral diff & rubric-free contrastive trajectory analyzer (Harness² A057).
 * Compares k >= 2 ExecutionRecords across tool sequence divergence, read-before-edit discipline,
 * edit locality, loop/stall telemetry, physical verification status, and resource efficiency.
 */
export class TrajectoryContrastService {
  /**
   * Computes a structured behavioral profile for a single ExecutionRecord.
   */
  public buildProfile(record: ExecutionRecord): TrajectoryBehavioralProfile {
    const toolCalls = record.toolCalls ?? [];
    const toolSequence = toolCalls.map((tc) => tc.tool);
    const uniqueTools = Array.from(new Set(toolSequence));

    // 1. Read-before-edit discipline
    const inspectedPaths = new Set<string>();
    const inspectedDirs = new Set<string>();
    let anyInspectionOccurred = false;
    let totalEdits = 0;
    let disciplinedEdits = 0;
    const uninspectedEdits: string[] = [];

    for (const call of toolCalls) {
      if (isInspectionCall(call)) {
        anyInspectionOccurred = true;
        for (const p of extractTargetPaths(call.input)) {
          inspectedPaths.add(p);
          const slashIdx = p.lastIndexOf('/');
          if (slashIdx > 0) inspectedDirs.add(p.slice(0, slashIdx));
        }
        if (call.tool === 'grep' || call.tool === 'search_code' || call.tool === 'glob' || call.tool === 'read_many_files') {
          const dir = (call.input as { dir?: unknown; directory?: unknown } | undefined)?.dir ??
            (call.input as { directory?: unknown } | undefined)?.directory;
          if (typeof dir === 'string' && dir.trim()) {
            inspectedDirs.add(normalizePath(dir));
          }
        }
      } else if (isMutationCall(call)) {
        const targets = extractTargetPaths(call.input);
        if (targets.length === 0) {
          totalEdits += 1;
          if (anyInspectionOccurred) {
            disciplinedEdits += 1;
          } else {
            uninspectedEdits.push('<unspecified-target>');
          }
        } else {
          for (const target of targets) {
            totalEdits += 1;
            const slashIdx = target.lastIndexOf('/');
            const parentDir = slashIdx > 0 ? target.slice(0, slashIdx) : '';
            const wasInspected =
              inspectedPaths.has(target) ||
              [...inspectedPaths].some((ip) => ip.endsWith(`/${target}`) || target.endsWith(`/${ip}`)) ||
              (parentDir.length > 0 && inspectedDirs.has(parentDir));

            if (wasInspected) {
              disciplinedEdits += 1;
            } else {
              uninspectedEdits.push(target);
            }
          }
        }
      }
    }

    const filesChanged = (record.filesChanged ?? []).map(normalizePath).filter(Boolean);
    let readBeforeEditScore = 1.0;
    if (totalEdits > 0) {
      readBeforeEditScore = Number((disciplinedEdits / totalEdits).toFixed(4));
    } else if (filesChanged.length > 0 && !anyInspectionOccurred) {
      readBeforeEditScore = 0.0;
      uninspectedEdits.push(...filesChanged);
    }
    const readBeforeEditDisciplined = readBeforeEditScore >= 0.8 && uninspectedEdits.length === 0;

    // 2. Edit locality & change-surface focus
    const rawDiff = (record as { diff?: unknown }).diff;
    const diffSize = typeof rawDiff === 'string'
      ? rawDiff.split('\n').filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))).length || rawDiff.length
      : filesChanged.length * 50;
    const directories = Array.from(
      new Set(
        filesChanged.map((f) => {
          const idx = f.lastIndexOf('/');
          return idx > 0 ? f.slice(0, idx) : '.';
        }),
      ),
    ).sort();
    const directorySpread = directories.length;
    const focusScore = filesChanged.length === 0
      ? 1.0
      : Number((1 / (1 + Math.max(0, filesChanged.length - 1) * 0.2 + Math.max(0, directorySpread - 1) * 0.25)).toFixed(4));

    // 3. Loop & stall telemetry
    const seenSignatures = new Map<string, number>();
    let repeatedIdenticalToolCalls = 0;
    let maxConsecutiveIdenticalCalls = 0;
    let currentConsecutive = 0;
    let prevSig: string | undefined;

    for (const call of toolCalls) {
      let serializedInput = '';
      try {
        serializedInput = JSON.stringify(call.input ?? {});
      } catch {
        serializedInput = String(call.input);
      }
      const sig = `${call.tool}::${serializedInput}`;
      const count = (seenSignatures.get(sig) ?? 0) + 1;
      seenSignatures.set(sig, count);
      if (count > 1) {
        repeatedIdenticalToolCalls += 1;
      }
      if (sig === prevSig) {
        currentConsecutive += 1;
      } else {
        currentConsecutive = 1;
        prevSig = sig;
      }
      if (currentConsecutive > maxConsecutiveIdenticalCalls) {
        maxConsecutiveIdenticalCalls = currentConsecutive;
      }
    }

    const failedToolCalls = toolCalls.filter((tc) => tc.ok === false).length;
    const malformedActions = this.extractMalformedActions(record);
    const repairCycles = this.extractRepairCycles(record);
    const loopDetected =
      maxConsecutiveIdenticalCalls >= 3 ||
      repeatedIdenticalToolCalls >= 3 ||
      malformedActions >= 2;

    // 4. Physical verification status at final revision
    const physicalVerification = this.computePhysicalVerification(record, filesChanged);

    // 5. Token & latency efficiency
    const efficiency = this.extractEfficiency(record, filesChanged.length);

    // Rubric-free ranking rule: MUST tag UNVERIFIED_CONTRASTIVE whenever physical verification oracles did not run/pass
    const verdictTag: ContrastiveVerdictTag = physicalVerification.physicalVerificationPassed
      ? 'VERIFIED'
      : 'UNVERIFIED_CONTRASTIVE';

    return {
      executionId: record.execution.id,
      toolSequence,
      uniqueTools,
      readBeforeEditScore,
      readBeforeEditDisciplined,
      uninspectedEdits,
      editLocality: {
        filesChanged,
        filesChangedCount: filesChanged.length,
        diffSize,
        directorySpread,
        directories,
        focusScore,
      },
      loopTelemetry: {
        repeatedIdenticalToolCalls,
        maxConsecutiveIdenticalCalls,
        malformedActions,
        failedToolCalls,
        repairCycles,
        loopDetected,
      },
      physicalVerification,
      efficiency,
      verdictTag,
    };
  }

  /**
   * Contrasts candidate ExecutionRecords deterministically across behavioral, verification,
   * locality, loop, and efficiency dimensions without requiring an external answer key.
   */
  public contrast(records: ExecutionRecord[]): TrajectoryContrastReport {
    if (records.length === 0) {
      throw new Error('TrajectoryContrastService.contrast requires at least one ExecutionRecord');
    }

    const profiles = records.map((r) => this.buildProfile(r));
    const pairwiseDivergence: PairwiseTrajectoryDivergence[] = [];

    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i];
        const b = profiles[j];
        const toolJaccard = computeJaccard(new Set(a.uniqueTools), new Set(b.uniqueTools));
        const editDist = computeSequenceEditDistance(a.toolSequence, b.toolSequence);
        const maxSeqLen = Math.max(a.toolSequence.length, b.toolSequence.length);
        const normalizedSequenceDistance = maxSeqLen > 0
          ? Number((editDist / maxSeqLen).toFixed(4))
          : 0;
        const fileJaccard = computeJaccard(
          new Set(a.editLocality.filesChanged),
          new Set(b.editLocality.filesChanged),
        );

        pairwiseDivergence.push({
          executionA: a.executionId,
          executionB: b.executionId,
          toolJaccardSimilarity: toolJaccard.similarity,
          toolJaccardDistance: toolJaccard.distance,
          toolSequenceEditDistance: editDist,
          normalizedSequenceDistance,
          sharedFiles: fileJaccard.shared,
          fileJaccardDistance: fileJaccard.distance,
        });
      }
    }

    // Verification delta summary
    const verifiedExecutionIds = profiles
      .filter((p) => p.physicalVerification.physicalVerificationPassed)
      .map((p) => p.executionId);
    const unverifiedExecutionIds = profiles
      .filter((p) => !p.physicalVerification.physicalVerificationPassed)
      .map((p) => p.executionId);
    const anyOracleRan = profiles.some((p) => p.physicalVerification.oracleRan);

    const oraclePassCounts = new Map<string, { passed: number; total: number }>();
    for (const p of profiles) {
      for (const oracle of p.physicalVerification.satisfiedOracles) {
        const cur = oraclePassCounts.get(oracle) ?? { passed: 0, total: 0 };
        cur.passed += 1;
        cur.total += 1;
        oraclePassCounts.set(oracle, cur);
      }
      for (const oracle of p.physicalVerification.failedOracles) {
        const cur = oraclePassCounts.get(oracle) ?? { passed: 0, total: 0 };
        cur.total += 1;
        oraclePassCounts.set(oracle, cur);
      }
    }
    const oraclePassRates: Record<string, number> = {};
    for (const [oracle, stats] of oraclePassCounts.entries()) {
      oraclePassRates[oracle] = stats.total > 0 ? Number((stats.passed / stats.total).toFixed(4)) : 0;
    }

    // Behavioral delta signals for Harness² editors
    const highLoopExecutionIds = profiles
      .filter((p) => p.loopTelemetry.loopDetected)
      .map((p) => p.executionId);
    const blindEditExecutionIds = profiles
      .filter((p) => !p.readBeforeEditDisciplined)
      .map((p) => p.executionId);
    const meanDiffSize = Number(
      (profiles.reduce((sum, p) => sum + p.editLocality.diffSize, 0) / profiles.length).toFixed(2),
    );
    const sprawlingEditExecutionIds = profiles
      .filter((p) => p.editLocality.filesChangedCount > 5 || (meanDiffSize > 0 && p.editLocality.diffSize > meanDiffSize * 1.75 && p.editLocality.filesChangedCount > 2))
      .map((p) => p.executionId);
    const unverifiedMutationExecutionIds = profiles
      .filter((p) => p.editLocality.filesChangedCount > 0 && !p.physicalVerification.physicalVerificationPassed)
      .map((p) => p.executionId);

    const meanTotalTokens = Number(
      (profiles.reduce((sum, p) => sum + p.efficiency.totalTokens, 0) / profiles.length).toFixed(2),
    );
    const meanReadBeforeEditScore = Number(
      (profiles.reduce((sum, p) => sum + p.readBeforeEditScore, 0) / profiles.length).toFixed(4),
    );

    const efficientReferenceExecutionIds = profiles
      .filter(
        (p) =>
          p.readBeforeEditDisciplined &&
          !p.loopTelemetry.loopDetected &&
          p.efficiency.totalTokens <= (meanTotalTokens > 0 ? meanTotalTokens * 1.15 : Infinity),
      )
      .map((p) => p.executionId);

    // Tool success vs failure aggregation across records
    const toolStats = new Map<string, { ok: number; fail: number }>();
    for (const r of records) {
      for (const tc of r.toolCalls ?? []) {
        const cur = toolStats.get(tc.tool) ?? { ok: 0, fail: 0 };
        if (tc.ok === false) {
          cur.fail += 1;
        } else {
          cur.ok += 1;
        }
        toolStats.set(tc.tool, cur);
      }
    }
    const commonSuccessfulTools = [...toolStats.entries()]
      .filter(([, s]) => s.ok > 0 && s.ok >= s.fail)
      .sort((a, b) => b[1].ok - a[1].ok || a[0].localeCompare(b[0]))
      .map(([tool]) => tool);

    const noisyFailedTools = [...toolStats.entries()]
      .filter(([, s]) => s.fail >= 2 && s.fail > s.ok)
      .sort((a, b) => b[1].fail - a[1].fail || a[0].localeCompare(b[0]))
      .map(([tool]) => tool);

    return {
      candidateCount: profiles.length,
      profiles,
      pairwiseDivergence,
      verificationDelta: {
        anyOracleRan,
        anyVerified: verifiedExecutionIds.length > 0,
        allVerified: verifiedExecutionIds.length === profiles.length,
        verifiedExecutionIds,
        unverifiedExecutionIds,
        oraclePassRates,
      },
      behavioralDeltas: {
        highLoopExecutionIds,
        blindEditExecutionIds,
        sprawlingEditExecutionIds,
        unverifiedMutationExecutionIds,
        efficientReferenceExecutionIds,
        commonSuccessfulTools,
        noisyFailedTools,
        meanReadBeforeEditScore,
        meanDiffSize,
        meanTotalTokens,
      },
    };
  }

  /**
   * Ranks candidate ExecutionRecords contrastively.
   * Explicitly tags rankings and any winner with `verdictTag: 'UNVERIFIED_CONTRASTIVE'`
   * whenever physical verification oracles did not run or did not pass at the final revision.
   */
  public rankContrastively(records: ExecutionRecord[]): ContrastiveRankingResult {
    const contrastReport = this.contrast(records);
    const maxTokens = Math.max(1, ...contrastReport.profiles.map((p) => p.efficiency.totalTokens));
    const maxWall = Math.max(1, ...contrastReport.profiles.map((p) => p.efficiency.wallTimeMs));

    const scored = contrastReport.profiles.map((profile) => {
      const rationale: string[] = [];

      // Component 1: Physical verification (0.45 weight)
      let verificationComponent = 0;
      if (profile.physicalVerification.physicalVerificationPassed) {
        verificationComponent = 1.0;
        rationale.push('Physical verification oracles ran and passed at final revision');
      } else if (profile.physicalVerification.oracleRan && profile.physicalVerification.checksTotalCount > 0) {
        verificationComponent = 0.35 * (profile.physicalVerification.checksPassedCount / profile.physicalVerification.checksTotalCount);
        rationale.push(
          `Partial oracle pass (${profile.physicalVerification.checksPassedCount}/${profile.physicalVerification.checksTotalCount}); marked UNVERIFIED_CONTRASTIVE`,
        );
      } else {
        verificationComponent = 0;
        rationale.push('No physical verification oracle ran/passed; marked UNVERIFIED_CONTRASTIVE');
      }

      // Component 2: Read-before-edit discipline (0.20 weight)
      const disciplineComponent = profile.readBeforeEditScore;
      if (profile.readBeforeEditDisciplined) {
        rationale.push('Maintained read-before-edit discipline');
      } else if (profile.uninspectedEdits.length > 0) {
        rationale.push(`Performed ${profile.uninspectedEdits.length} uninspected edit(s)`);
      }

      // Component 3: Anti-loop / low-stall stability (0.15 weight)
      const loopPenalty = Math.min(
        1,
        profile.loopTelemetry.repeatedIdenticalToolCalls * 0.15 +
          profile.loopTelemetry.malformedActions * 0.25 +
          profile.loopTelemetry.failedToolCalls * 0.1 +
          profile.loopTelemetry.repairCycles * 0.12 +
          (profile.loopTelemetry.loopDetected ? 0.35 : 0),
      );
      const stabilityComponent = 1 - loopPenalty;
      if (profile.loopTelemetry.loopDetected) {
        rationale.push('Loop or repeated malformed action stall detected');
      }

      // Component 4: Edit locality focus (0.10 weight)
      const localityComponent = profile.editLocality.focusScore;

      // Component 5: Token & latency efficiency (0.10 weight)
      const tokenEff = 1 - Math.min(1, profile.efficiency.totalTokens / (maxTokens * 1.25));
      const wallEff = 1 - Math.min(1, profile.efficiency.wallTimeMs / (maxWall * 1.25));
      const efficiencyComponent = 0.6 * tokenEff + 0.4 * wallEff;

      const contrastiveScore = Number(
        (
          0.45 * verificationComponent +
          0.20 * disciplineComponent +
          0.15 * stabilityComponent +
          0.10 * localityComponent +
          0.10 * efficiencyComponent
        ).toFixed(4),
      );

      return {
        executionId: profile.executionId,
        contrastiveScore,
        verdictTag: profile.verdictTag,
        profile,
        rationale,
      };
    });

    // Strict deterministic sort:
    // 1. VERIFIED always beats UNVERIFIED_CONTRASTIVE
    // 2. Higher contrastiveScore
    // 3. Fewer loop repetitions
    // 4. Higher readBeforeEditScore
    // 5. Fewer total tokens
    // 6. Lexicographical executionId tie-breaker
    scored.sort((a, b) => {
      if (a.verdictTag !== b.verdictTag) {
        return a.verdictTag === 'VERIFIED' ? -1 : 1;
      }
      if (b.contrastiveScore !== a.contrastiveScore) {
        return b.contrastiveScore - a.contrastiveScore;
      }
      if (a.profile.loopTelemetry.repeatedIdenticalToolCalls !== b.profile.loopTelemetry.repeatedIdenticalToolCalls) {
        return a.profile.loopTelemetry.repeatedIdenticalToolCalls - b.profile.loopTelemetry.repeatedIdenticalToolCalls;
      }
      if (b.profile.readBeforeEditScore !== a.profile.readBeforeEditScore) {
        return b.profile.readBeforeEditScore - a.profile.readBeforeEditScore;
      }
      if (a.profile.efficiency.totalTokens !== b.profile.efficiency.totalTokens) {
        return a.profile.efficiency.totalTokens - b.profile.efficiency.totalTokens;
      }
      return a.executionId.localeCompare(b.executionId);
    });

    const rankings: ContrastiveRankedCandidate[] = scored.map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
    }));

    const winner = rankings[0];
    const verdictTag: ContrastiveVerdictTag =
      winner && winner.verdictTag === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED_CONTRASTIVE';

    return {
      verdictTag,
      winner,
      rankings,
      contrastReport,
    };
  }

  private computePhysicalVerification(
    record: ExecutionRecord,
    filesChanged: string[],
  ): TrajectoryPhysicalVerification {
    const checks = record.checks ?? [];
    const evidence = record.evidence ?? [];
    const events = record.events ?? [];

    let eventRevision = 0;
    let lastMutationTime = -Infinity;
    let lastCheckTime = -Infinity;
    for (const ev of events) {
      const type = ev.eventType ?? ev.type;
      const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : 0;
      if (type === 'files.changed') {
        eventRevision += 1;
        if (ts > lastMutationTime) lastMutationTime = ts;
      } else if (type === 'check.completed') {
        if (ts > lastCheckTime) lastCheckTime = ts;
      }
    }

    const workspaceRevision =
      record.workspaceState?.revision ??
      (eventRevision > 0 ? eventRevision : filesChanged.length > 0 ? 1 : 0);

    const oracleRan = checks.length > 0 || evidence.length > 0;
    const checksPassedCount = checks.filter((c) => c.ok).length;
    const checksTotalCount = checks.length;

    const satisfiedOracles = new Set<string>();
    const failedOracles = new Set<string>();

    for (const c of checks) {
      if (c.ok) {
        satisfiedOracles.add(c.name);
      } else {
        failedOracles.add(c.name);
      }
    }

    const currentEvidence = evidence.length > 0
      ? latestEvidenceAtRevision(evidence, workspaceRevision)
      : [];

    for (const ev of currentEvidence) {
      const label = String(ev.oracle ?? ev.type);
      if (evidencePassed(ev)) {
        satisfiedOracles.add(label);
      } else {
        failedOracles.add(label);
      }
    }

    const hasNoExecutionFailure =
      record.execution?.status !== 'failed' &&
      record.execution?.status !== 'cancelled' &&
      (record.errors?.length ?? 0) === 0;

    let finalRevisionVerified = false;
    if (oracleRan && hasNoExecutionFailure) {
      if (evidence.length > 0) {
        finalRevisionVerified =
          currentEvidence.length > 0 &&
          currentEvidence.every(evidencePassed) &&
          checks.every((c) => c.ok);
      } else if (checks.length > 0) {
        const checksStaleAfterMutation =
          lastMutationTime > -Infinity && lastCheckTime > -Infinity && lastCheckTime < lastMutationTime;
        finalRevisionVerified = !checksStaleAfterMutation && checks.every((c) => c.ok);
      }
    }

    return {
      oracleRan,
      finalRevisionVerified,
      physicalVerificationPassed: oracleRan && finalRevisionVerified,
      workspaceRevision,
      checksPassedCount,
      checksTotalCount,
      satisfiedOracles: [...satisfiedOracles].sort(),
      failedOracles: [...failedOracles].sort(),
    };
  }

  private extractMalformedActions(record: ExecutionRecord): number {
    const events = record.events ?? [];
    const termination = [...events].reverse().find((e) => (e.eventType ?? e.type) === 'termination.completed');
    const count = (termination?.data as { protocolMetrics?: { malformedActions?: number } } | undefined)
      ?.protocolMetrics?.malformedActions;
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      return count;
    }
    return events.filter((e) => String(e.eventType ?? e.type ?? '') === 'protocol.malformed_action').length;
  }

  private extractRepairCycles(record: ExecutionRecord): number {
    const meta = (record as { metadata?: { repairCycles?: number; repair_cycles?: number } }).metadata;
    if (typeof meta?.repairCycles === 'number') return meta.repairCycles;
    if (typeof meta?.repair_cycles === 'number') return meta.repair_cycles;

    let cycles = 0;
    for (const ev of record.events ?? []) {
      const type = ev.eventType ?? ev.type;
      if (type === 'retry.scheduled') {
        cycles += 1;
      } else if (type === 'turn.started') {
        const turn = (ev.data as { turn?: number } | undefined)?.turn;
        if (typeof turn === 'number' && turn > 1) {
          cycles += 1;
        }
      }
    }
    const failedChecks = (record.checks ?? []).filter((c) => !c.ok).length;
    if (cycles === 0 && failedChecks > 0) {
      cycles = failedChecks;
    }
    return cycles;
  }

  private extractEfficiency(record: ExecutionRecord, filesChangedCount: number): TrajectoryEfficiency {
    const usage = record.usage as unknown as Record<string, unknown> | undefined;
    const inputTokens = typeof usage?.input === 'number'
      ? usage.input
      : typeof usage?.inputTokens === 'number'
        ? (usage.inputTokens as number)
        : 0;
    const outputTokens = typeof usage?.output === 'number'
      ? usage.output
      : typeof usage?.outputTokens === 'number'
        ? (usage.outputTokens as number)
        : 0;
    const totalTokens = typeof usage?.total === 'number'
      ? usage.total
      : inputTokens + outputTokens;

    const explicitCalls = (record as { totalModelCalls?: number; modelCalls?: number }).totalModelCalls ??
      (record as { modelCalls?: number }).modelCalls;
    const modelCalls = typeof explicitCalls === 'number' && explicitCalls >= 0
      ? explicitCalls
      : Math.max(
          1,
          (record.events ?? []).filter((e) => {
            const t = e.eventType ?? e.type;
            return t === 'generation.completed' || t === 'model.response.completed';
          }).length,
        );

    let wallTimeMs = 0;
    const recAny = record as { durationMs?: number };
    if (typeof recAny.durationMs === 'number' && recAny.durationMs > 0) {
      wallTimeMs = recAny.durationMs;
    } else if (record.execution?.startedAt && record.execution?.completedAt) {
      wallTimeMs = Math.max(
        0,
        new Date(record.execution.completedAt).getTime() - new Date(record.execution.startedAt).getTime(),
      );
    } else {
      wallTimeMs = (record.toolCalls ?? []).reduce((s, tc) => s + (tc.durationMs ?? 0), 0);
    }

    const tokensPerFileChanged = filesChangedCount > 0
      ? Math.round(totalTokens / filesChangedCount)
      : totalTokens;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      wallTimeMs,
      modelCalls,
      tokensPerFileChanged,
    };
  }
}
