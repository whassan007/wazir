import { existsSync } from 'node:fs';
import path from 'node:path';
import { keepEnds, type AgentRunRequest, type AgentRuntime, type GroundedResult } from '@wazir/core';
import { resolveVerificationScope } from '../verificationScope.js';

const PURE_DOC_FILE_RE = /\.(?:md|markdown|txt|rst|adoc)$/i;

const EXPLICIT_MUTATION_TASK_RE =
  /(?<!\bhow\s+to\s+)(?<!\bhow\s+(?:do|can|should)\s+(?:i|we)\s+)\b(?:fix|repair|resolve|patch|implement|update|modify|edit|refactor|rewrite|add|create|remove|delete|rename|wire|integrate|restore|thread|propagate|include|pass|forward|convert|extract|inline|wrap|unwrap|split|merge|move|support|handle|enforce|enable|disable|sanitize|normalize|escape|decode|encode|sort|dedupe|guard|validate|ensure|preserve|export|import|expose|register|attach|set|change|replace|swap)\s+(?:the\s+|a\s+|an\s+|our\s+|this\s+|my\s+|all\s+)?(?:[\w./+#-]+\s+){0,5}(?:files?|bugs?|issues?|defects?|errors?|regressions?|functions?|methods?|class(?:es)?|components?|endpoints?|routes?|services?|adapters?|controllers?|modules?|configs?|scripts?|tests?|code|implementations?|features?|cli|tui|api|parameters?|args?|arguments?|fields?|metadata|headers?|options?|helpers?|handlers?|validators?|\S+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|json|ya?ml|toml|sql|sh))\b/i;

const WORKSPACE_FILE_REF_RE =
  /(?:\b[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|json|ya?ml|toml|sql|sh)\b|(?:^|[\s`'"])(?:src|packages|apps|tests?|lib|scripts)\/[\w./-]+)/i;

const QUESTION_OR_INSPECTION_ONLY_RE =
  /^\s*(?:what|why|how|when|where|who|which|explain|describe|summarize|list|show|find|count|tell\s+me|can\s+you\s+(?:explain|tell|show|list|summarize)|does\s+|is\s+|are\s+)/i;

const SNIPPET_PROMPT_RE =
  /\b(?:in\s+this\s+(?:code|function|snippet|python|javascript|typescript)|the\s+following\s+(?:code|function|snippet))\b/i;

/**
 * Returns true when a prompt references concrete workspace files/paths or requires
 * workspace mutation, so a 0-tool-call plain-text answer on turn 1 should be nudged
 * to inspect/edit the actual files first.
 */
export function requiresWorkspaceGrounding(request: AgentRunRequest): boolean {
  if (request.taskType === 'chat' || request.mutationRequired === false) {
    return false;
  }
  const desc = request.taskDescription.trim();
  if (SNIPPET_PROMPT_RE.test(desc)) {
    return false;
  }
  if (inferMutationRequired(request)) {
    return true;
  }
  return WORKSPACE_FILE_REF_RE.test(desc);
}

/**
 * Infers whether zero file modifications should fail verification when `request.mutationRequired`
 * was not explicitly specified by the caller:
 *  - Explicit `request.mutationRequired` always wins.
 *  - Non-empty `expectedArtifacts` implies mutation is required.
 *  - `chat` and `research` task types do not require file mutations.
 *  - Questions, explanations, inspections, and pasted-snippet prompts do NOT fail just because
 *    `wa run` defaulted `taskType` to `'coding'`.
 */
export function inferMutationRequired(request: AgentRunRequest): boolean {
  if (typeof request.mutationRequired === 'boolean') {
    return request.mutationRequired;
  }
  if (request.expectedArtifacts && request.expectedArtifacts.length > 0) {
    return true;
  }
  if (request.taskType === 'chat' || request.taskType === 'research' || request.taskType === 'review') {
    return false;
  }
  const desc = request.taskDescription.trim();
  if (SNIPPET_PROMPT_RE.test(desc)) {
    return false;
  }
  if (QUESTION_OR_INSPECTION_ONLY_RE.test(desc) && !EXPLICIT_MUTATION_TASK_RE.test(desc)) {
    return false;
  }
  return EXPLICIT_MUTATION_TASK_RE.test(desc);
}

export function areAllFilesPureDocs(filesChanged: Iterable<string>): boolean {
  let count = 0;
  for (const file of filesChanged) {
    count += 1;
    if (!PURE_DOC_FILE_RE.test(file.trim())) {
      return false;
    }
  }
  return count > 0;
}

export interface ProportionalVerifyInput {
  request: AgentRunRequest;
  runtime: AgentRuntime;
  filesChanged: ReadonlySet<string>;
  checksPassedSinceLastMutation: ReadonlySet<string>;
  webEvidence: ReadonlyMap<string, GroundedResult>;
  hasWebFetchCapability: boolean;
  modelSummary: string;
}

export interface ProportionalVerifyResult {
  ok: boolean;
  failures: string[];
  scopeMessage?: string;
}

/**
 * Runs Wazir's deterministic host-side verification proportionally to what actually changed:
 *  - Zero files changed: skips `build`/`test`/`lint`/`typecheck` (checks `mutationRequired`, `expectedArtifacts`, `webEvidence` only).
 *  - Doc-only changes (`*.md`, `*.txt`, `*.rst`): skips `build`/`test`/`lint`/`typecheck` unless `--full-verify` or `expectedEvidence` requires checks (Decision #1).
 *  - Code changes: scopes checks to touched monorepo workspace(s) via `resolveVerificationScope` and skips checks already green at the current workspace mutation state.
 */
export async function runProportionalVerification(
  input: ProportionalVerifyInput,
): Promise<ProportionalVerifyResult> {
  const {
    request,
    runtime,
    filesChanged,
    checksPassedSinceLastMutation,
    webEvidence,
    hasWebFetchCapability,
    modelSummary,
  } = input;

  const failures: string[] = [];

  const groundedResearch = request.taskType === 'research' && hasWebFetchCapability;
  const mutationRequired = inferMutationRequired(request);

  if (mutationRequired && filesChanged.size === 0) {
    failures.push('Agent declared completion but produced no code modifications.');
  }

  if (request.expectedArtifacts && request.expectedArtifacts.length > 0) {
    for (const artifact of request.expectedArtifacts) {
      const fullPath = path.resolve(request.projectRoot, artifact);
      if (existsSync(fullPath)) continue;
      const basename = path.basename(artifact);
      const matched = [...filesChanged].some((changed) => path.basename(changed) === basename);
      if (!matched) {
        failures.push(`Expected artifact '${artifact}' was not created.`);
      }
    }
  }

  if (groundedResearch && filesChanged.size === 0) {
    const documents = [...webEvidence.values()].filter(
      (e): e is import('@wazir/core').GroundedDocument => e.kind === 'web_document',
    );
    const cited = documents.some(
      (d) =>
        modelSummary.includes(d.citation.citationId) ||
        modelSummary.includes(d.url) ||
        modelSummary.includes(d.finalUrl),
    );
    if (!cited) {
      failures.push(
        'WEB_EVIDENCE_REQUIRED: research completion requires a successfully fetched document cited in the answer.',
      );
    }
  }

  if (filesChanged.size === 0) {
    return { ok: failures.length === 0, failures };
  }

  // Decision #1: Skip build/test/lint/typecheck for pure documentation edits unless explicitly requested
  if (
    areAllFilesPureDocs(filesChanged) &&
    !request.fullVerification &&
    (!request.expectedEvidence || request.expectedEvidence.length === 0)
  ) {
    return {
      ok: failures.length === 0,
      failures,
      scopeMessage: `verification.scope: skipped (documentation-only changes: ${[...filesChanged].join(', ')})`,
    };
  }

  const availableToolNames = new Set(runtime.tools.map((t) => t.name));
  const candidateChecks = (['build', 'test', 'lint', 'typecheck'] as const).filter(
    (c) => availableToolNames.size === 0 || availableToolNames.has(c),
  );

  // If the runtime exposes tools and none of the check tools exist, nothing to run
  if (runtime.tools.length > 0 && candidateChecks.length === 0) {
    return { ok: failures.length === 0, failures };
  }

  const checksToRun = candidateChecks.length > 0 ? candidateChecks : (['build', 'test', 'lint', 'typecheck'] as const);

  const scope = request.fullVerification
    ? undefined
    : resolveVerificationScope(request.projectRoot, filesChanged);
  const useFullScope = !scope || scope.fullScopeRequired || scope.workspaces.length === 0;

  const scopeMessage = request.fullVerification
    ? 'verification.scope: full (explicitly requested via --full-verify)'
    : useFullScope
      ? `verification.scope: full (${scope?.fullScopeRequired ? 'a changed file is outside every known workspace package' : 'no workspace package could be resolved for the changed files'})`
      : `verification.scope: ${scope!.workspaces.join(', ')} (changed files: ${[...filesChanged].join(', ')})`;

  for (const check of checksToRun) {
    if (request.isCancelled?.()) break;
    // Skip re-running a check that already passed after the most recent file mutation (unless --full-verify)
    if (!request.fullVerification && !useFullScope && checksPassedSinceLastMutation.has(check)) {
      continue;
    }
    const result = await runtime.executeTool(check, useFullScope ? {} : { workspaces: scope!.workspaces });
    const output = result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n');
    if (output && /missing script|no such file|not found|unknown tool/i.test(output) && !result.ok) {
      continue;
    }
    if (!result.ok) {
      failures.push(`${check}: ${keepEnds(output, 4000)}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    scopeMessage,
  };
}
