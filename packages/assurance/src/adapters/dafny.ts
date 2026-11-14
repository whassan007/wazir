import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Obligation, SolverAdapter, ToolAvailability, VerificationResult, Verdict, VerifyOptions } from '../contracts';

/** Mask comments and strings while preserving offsets and line numbers. */
function mask(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    value => value.replace(/[^\n]/g, ' '));
}

/** Conservative lexical audit; unresolved imports and unusual declarations fail closed. */
export function scanDafnyTrustedBase(sourceText: string): string[] {
  const source = mask(sourceText);
  const gaps: string[] = [];
  const record = (offset: number, kind: string) => {
    const line = sourceText.slice(0, offset).split('\n').length;
    gaps.push(`${kind} at line ${line}: ${sourceText.split('\n')[line - 1].trim()}`);
  };
  for (const match of source.matchAll(/\bassume\b|\{:\s*(?:axiom|extern|verify\s+false|trusted|contradiction)\b[^}]*\}|\bopaque\b|\binclude\b/g)) {
    record(match.index!, 'trusted declaration');
  }
  // Track enclosing trait/abstract module scopes rather than exempting an entire file.
  const scopes: boolean[] = [];
  let pendingAbstract = false;
  const tokens = /\babstract\s+module\b|\btrait\b|\b(?:method|lemma|function|predicate)\b|\{:[^}]*\}|[{}]/g;
  for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
    const value = token[0];
    if (value.startsWith('{:')) continue;
    if (value === 'trait' || value.startsWith('abstract')) { pendingAbstract = true; continue; }
    if (value === '{') { scopes.push(pendingAbstract || scopes.includes(true)); pendingAbstract = false; continue; }
    if (value === '}') { scopes.pop(); continue; }
    if (scopes.includes(true)) continue;
    const tail = source.slice(tokens.lastIndex).replace(/\{:[^}]*\}/g, ' ');
    const boundary = tail.search(/\{|\}|\b(?:method|lemma|function|predicate|class|trait|module)\b/);
    if (boundary < 0 || tail[boundary] !== '{') record(token.index, 'bodyless declaration');
  }
  return gaps;
}

interface Run { code: number; stdout: string; stderr: string; timeout: boolean; missing: boolean }
function run(binary: string, args: string[], timeout: number, cwd?: string): Promise<Run> {
  return new Promise(resolveRun => execFile(binary, args, { timeout, cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    const err = error as NodeJS.ErrnoException & { killed?: boolean };
    resolveRun({ code: error ? Number(err.code) || 1 : 0, stdout, stderr, timeout: !!err?.killed, missing: err?.code === 'ENOENT' });
  }));
}

/** Prefer explicit configuration, then a repository installation, then PATH. */
export function resolveDafnyBinary(startDirectories = [__dirname, process.cwd()]): string {
  if (process.env.DAFNY_PATH) return process.env.DAFNY_PATH;
  if (process.env.WAZIR_TOOLS_DIR) return resolve(process.env.WAZIR_TOOLS_DIR, 'dafny', 'dafny');
  for (const start of startDirectories) {
    let directory = resolve(start);
    while (true) {
      const binary = resolve(directory, 'tools', 'dafny', 'dafny');
      if (existsSync(binary)) return binary;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return 'dafny';
}

export class DafnyAdapter implements SolverAdapter {
  readonly tool = 'dafny' as const;
  constructor(private readonly binary = resolveDafnyBinary()) {}

  async checkAvailability(): Promise<ToolAvailability> {
    const result = await run(this.binary, ['--version'], 5000);
    return { available: result.code === 0, version: result.stdout.trim() || 'unknown', path: this.binary };
  }

  async verify(obligation: Obligation, workspaceRev: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    const start = Date.now();
    const timeout = options.timeoutMs ?? obligation.timeoutMs ?? 60000;
    const result: VerificationResult = {
      verdict: Verdict.ERROR, tool: this.tool, toolVersion: 'unknown', assumptions: obligation.assumptions,
      scope: obligation.scope, seed: obligation.seed, elapsedMs: 0, inputHash: '', trustedBaseGaps: [],
      metadata: { workspaceRev },
    };
    const finish = (verdict: Verdict) => ({ ...result, verdict, elapsedMs: Date.now() - start });
    const availability = await this.checkAvailability();
    result.toolVersion = availability.version;
    if (!availability.available) return finish(Verdict.NOT_RUN);
    try {
      const path = resolve(options.workspaceDir ?? process.cwd(), obligation.artifactPath);
      const source = await readFile(path, 'utf8');
      result.inputHash = createHash('sha256').update(source).digest('hex');
      result.trustedBaseGaps = scanDafnyTrustedBase(source);
      const verified = await run(this.binary, ['verify', path, '--verify-included-files', '--warn-contradictory-assumptions', '--allow-warnings'], timeout, options.workspaceDir);
      result.stdout = verified.stdout;
      result.stderr = verified.stderr;
      const output = verified.stdout + '\n' + verified.stderr;
      if (verified.missing) return finish(Verdict.NOT_RUN);
      if (verified.timeout || /timed out|time limit|verification inconclusive/i.test(output)) return finish(Verdict.UNKNOWN);
      if (verified.code !== 0) {
        if (/assertion (?:might not hold|could not be proved)|postcondition (?:could not be proved|might not hold)|invariant (?:could not be proved|might not hold)|decreases|termination|precondition (?:could not be proved|might not hold)/i.test(output)) {
          result.witness = { artifactPath: path, diagnostic: output.trim() };
          return finish(Verdict.COUNTEREXAMPLE);
        }
        return finish(Verdict.ERROR);
      }
      if (!/\d+ verified, 0 errors/.test(output)) return finish(Verdict.UNKNOWN);
      const vacuous = /\brequires\s+\(*\s*false\b/.test(mask(source)) || /contradictory|vacuous|proved using contradictory/i.test(output);
      result.vacuityProbe = { passed: !vacuous, reason: vacuous ? 'Contradictory precondition or Dafny smoke warning' : 'Dafny contradictory-assumptions smoke check passed' };
      if (vacuous) return finish(Verdict.INCONSISTENT_ASSUMPTIONS);
      const help = await run(this.binary, ['audit', '--help'], Math.min(timeout, 5000));
      if (help.code === 0) {
        const audit = await run(this.binary, ['audit', path], timeout, options.workspaceDir);
        result.metadata = { ...result.metadata, auditStdout: audit.stdout, auditStderr: audit.stderr };
        if (audit.timeout) return finish(Verdict.UNKNOWN);
        if (audit.code !== 0 || /completed with [1-9]\d* findings/.test(audit.stdout) || /\bassum(?:e|ption)|\baxiom\b|\bextern\b|\btrusted\b/i.test(audit.stdout + audit.stderr)) {
          result.trustedBaseGaps.push(`Dafny audit: ${(audit.stdout + audit.stderr).trim()}`);
        }
      }
      return finish(result.trustedBaseGaps.length ? Verdict.SPECIFICATION_REVIEW_REQUIRED : Verdict.PROVED);
    } catch (error) {
      result.stderr = String(error);
      return finish(Verdict.ERROR);
    }
  }
}
