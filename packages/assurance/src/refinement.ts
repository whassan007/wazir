import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RefinementMap, RefinementMappingEntry, VerificationResult, Verdict } from './contracts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Parse JSON or the schema's flat YAML mapping/list syntax; reject unsupported YAML. */
export function parseRefinementMap(source: string): RefinementMap {
  let value: unknown;
  if (/^\s*[{[]/.test(source)) value = JSON.parse(source);
  else {
    const root: Record<string, unknown> = {};
    const mappings: Record<string, unknown>[] = [];
    let current: Record<string, unknown> | undefined;
    let inMappings = false;
    const scalar = (text: string): string => {
      const trimmed = text.trim();
      if (trimmed.startsWith('"')) return JSON.parse(trimmed);
      if (/^'(?:[^']|'')*'$/.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'");
      if (!trimmed || /^[\[\]{}&*!|>]/.test(trimmed)) throw new Error('Unsupported YAML scalar');
      return trimmed;
    };
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, '').trimEnd();
      if (!line.trim() || line.trimStart().startsWith('#') || line === '---' || line === '...') continue;
      if (line === 'mappings:') { if (inMappings) throw new Error('Duplicate mappings'); inMappings = true; root.mappings = mappings; continue; }
      const match = /^( *)(- )?([a-z_]+):\s*(.+)$/.exec(line);
      if (!match) throw new Error(`Invalid refinement YAML: ${line}`);
      const [, indent, item, key, text] = match;
      let target = root;
      if (item) {
        if (!inMappings || indent.length !== 2) throw new Error('Invalid mapping indentation');
        current = {}; mappings.push(current); target = current;
      } else if (indent.length) {
        if (!current || indent.length !== 4) throw new Error('Invalid mapping indentation');
        target = current;
      } else if (inMappings) throw new Error('Unexpected field after mappings');
      if (Object.hasOwn(target, key)) throw new Error(`Duplicate field: ${key}`);
      target[key] = scalar(text);
    }
    value = root;
  }
  if (!record(value) || !requiredString(value.component) || !Array.isArray(value.mappings)) throw new Error('Invalid refinement map');
  const modes = ['compiled_from_dafny', 'refinement_proof', 'contract_tests', 'none'];
  for (const entry of value.mappings) {
    if (!record(entry) || !requiredString(entry.property) || !requiredString(entry.verified_artifact)
      || !modes.includes(String(entry.production))
      || (entry.production_path !== undefined && !requiredString(entry.production_path))) throw new Error('Invalid refinement mapping entry');
  }
  return value as unknown as RefinementMap;
}

export interface RefinementEvaluationOptions {
  sourceCommit?: string;
  workspaceRev?: string;
  workspaceDir?: string;
  /** Exact compiler version used to compile the verified source. */
  compilerVersion?: string;
  pinnedCompilerVersion?: string;
  /** Evidence for a proof linking this artifact to this production file/revision. */
  refinementProof?: VerificationResult;
  contractTestsRecorded?: boolean;
}
export interface RefinementEvaluation {
  modelVerdict: Verdict;
  implementationVerdict: Verdict;
  capped: boolean;
  reason?: string;
  contractTestsRecorded?: boolean;
}

/** Keep model evidence separate; only a revision-bound proof link can support production proof. */
export function evaluateRefinementLink(
  entry: RefinementMappingEntry,
  modelResult: VerificationResult,
  options: RefinementEvaluationOptions = {},
): RefinementEvaluation {
  const result: RefinementEvaluation = {
    modelVerdict: modelResult.verdict, implementationVerdict: modelResult.verdict, capped: false,
    contractTestsRecorded: entry.production === 'contract_tests' || options.contractTestsRecorded === true,
  };
  const failures = [Verdict.COUNTEREXAMPLE, Verdict.FALSIFIED, Verdict.INCONSISTENT_ASSUMPTIONS,
    Verdict.ERROR, Verdict.UNKNOWN, Verdict.NOT_RUN];
  if (failures.includes(modelResult.verdict)) return result;
  const cap = (reason: string): RefinementEvaluation => ({ ...result, implementationVerdict: Verdict.NOT_VERIFIED, capped: true, reason });
  if (!entry.production_path) return cap('Missing production file');
  try {
    const path = resolve(options.workspaceDir ?? process.cwd(), entry.production_path);
    if (!existsSync(path) || !statSync(path).isFile()) return cap('Missing production file');
  } catch { return cap('Production file is inaccessible'); }
  if (entry.production !== 'compiled_from_dafny' && entry.production !== 'refinement_proof') {
    return cap('Contract tests or hand translation do not establish a proof link');
  }
  if (!requiredString(options.sourceCommit) || options.sourceCommit !== options.workspaceRev) return cap('Missing or mismatched source revision');
  if (modelResult.metadata?.workspaceRev !== undefined && modelResult.metadata.workspaceRev !== options.workspaceRev) return cap('Model evidence belongs to another revision');
  if (modelResult.verdict !== Verdict.PROVED || !Array.isArray(modelResult.trustedBaseGaps) || modelResult.trustedBaseGaps.length) {
    return cap('Model is not proved with an explicitly empty trusted base');
  }
  if (entry.production === 'compiled_from_dafny') {
    if (modelResult.tool !== 'dafny') return cap('Compiled source requires Dafny verification');
    if (!requiredString(options.compilerVersion) || options.compilerVersion !== options.pinnedCompilerVersion) return cap('Missing, unpinned, or mismatched compiler');
  } else {
    const proof = options.refinementProof;
    if (proof?.verdict !== Verdict.PROVED || !Array.isArray(proof.trustedBaseGaps) || proof.trustedBaseGaps.length
      || proof.metadata?.workspaceRev !== options.workspaceRev) return cap('Missing verified refinement proof for this revision');
  }
  return result;
}
