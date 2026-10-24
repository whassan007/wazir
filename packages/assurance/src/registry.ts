import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAL_TOOLS, SPEC_STATUSES, SpecManifest, SpecStatus, Verdict } from './contracts';
export type { SpecManifest, SpecStatus } from './contracts';

export class SpecificationReviewRequired extends Error {
  readonly code = Verdict.SPECIFICATION_REVIEW_REQUIRED;
  constructor(message = 'Explicit human specification review required') { super(`${Verdict.SPECIFICATION_REVIEW_REQUIRED}: ${message}`); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Non-JSON spec content');
  return result;
}
export function computeSpecHash(manifest: Omit<SpecManifest, 'content_hash'> | SpecManifest): string {
  const { content_hash: _, ...content } = manifest as SpecManifest;
  return 'sha256:' + createHash('sha256').update(canonical(content)).digest('hex');
}
export function verifySpecHash(manifest: SpecManifest): boolean {
  try { return /^sha256:[a-f0-9]{64}$/.test(manifest.content_hash) && computeSpecHash(manifest) === manifest.content_hash; } catch { return false; }
}

// Deliberately restricted YAML: mappings, sequences, quoted/plain scalars and flow
// collections. Reject unsupported syntax instead of silently changing its meaning.
function parseYaml(text: string): unknown {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#') && l.trim() !== '---');
  let pos = 0;
  function split(s: string, delimiter: string): string[] {
    const parts: string[] = []; let start = 0, depth = 0, quote = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) { if (c === quote && s[i - 1] !== '\\') quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if ('[{'.includes(c)) depth++;
      else if (']}'.includes(c)) depth--;
      else if (c === delimiter && !depth) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    if (quote || depth) throw new Error('Malformed YAML flow collection');
    parts.push(s.slice(start)); return parts;
  }
  function scalar(raw: string): any {
    const s = raw.trim();
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1,-1).trim() ? split(s.slice(1,-1), ',').map(scalar) : [];
    if (s.startsWith('{') && s.endsWith('}')) return Object.fromEntries(split(s.slice(1,-1), ',').filter(x => x.trim()).map(pair));
    if (s.startsWith('"')) return JSON.parse(s);
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1,-1).replace(/''/g, "'");
    if (/^[&*!>|%@`]/.test(s) || s.includes(' #')) throw new Error('Unsupported YAML syntax; use JSON or quoted scalars');
    if (s === 'null' || s === '~') return null;
    if (s === 'true' || s === 'false') return s === 'true';
    return s; // Preserve version numbers and dates as strings.
  }
  function pair(s: string): [string, any] {
    const m = /^([^:]+):(?:\s+|$)(.*)$/.exec(s.trim());
    if (!m) throw new Error('Invalid YAML mapping');
    return [m[1].trim(), scalar(m[2])];
  }
  function block(indent: number): any {
    const sequence = lines[pos].trim().startsWith('- '); const result: any = sequence ? [] : {};
    while (pos < lines.length) {
      const line = lines[pos]; const n = line.search(/\S/);
      if (n < indent) break;
      if (n !== indent || line.includes('\t')) throw new Error('Invalid YAML indentation');
      const s = line.trim(); pos++;
      if (sequence) {
        if (!s.startsWith('- ')) throw new Error('Mixed YAML collection');
        const rest = s.slice(2);
        if (/^[^{}[\]]+:\s/.test(rest)) {
          const [k,v] = pair(rest); const item = { [k]: v };
          if (pos < lines.length && lines[pos].search(/\S/) > indent) Object.assign(item, block(lines[pos].search(/\S/)));
          result.push(item);
        } else result.push(scalar(rest));
      } else {
        const [k,v] = pair(s);
        if (Object.hasOwn(result, k) || ['__proto__','constructor','prototype'].includes(k)) throw new Error('Duplicate or unsafe YAML key');
        result[k] = v === '' && pos < lines.length && lines[pos].search(/\S/) > indent ? block(lines[pos].search(/\S/)) : v;
      }
    }
    return result;
  }
  if (!lines.length) throw new Error('Empty manifest');
  return block(lines[0].search(/\S/));
}

export function validateSpecManifest(value: unknown): asserts value is SpecManifest {
  const m = value as SpecManifest;
  const str = (x: unknown) => typeof x === 'string' && x.trim().length > 0;
  const strings = (x: unknown) => Array.isArray(x) && x.every(str);
  if (!m || typeof m !== 'object' || !str(m.id) || !str(m.version) || !SPEC_STATUSES.includes(m.status)
    || !m.source || !str(m.source.normative_ref) || !str(m.source.jurisdiction) || !str(m.source.interpretation_date)
    || !strings(m.assumptions) || !str(m.guarantee) || !strings(m.reviewers)
    || !Array.isArray(m.artifacts) || !m.artifacts.every(a => a && FORMAL_TOOLS.includes(a.tool) && str(a.file) && (a.commands === undefined || strings(a.commands)) && (a.scope === undefined || str(a.scope)))
    || (m.monitors !== undefined && (!Array.isArray(m.monitors) || !m.monitors.every(a => a && FORMAL_TOOLS.includes(a.tool) && str(a.file))))
    || !/^sha256:[a-f0-9]{64}$/.test(m.content_hash)) throw new Error('Invalid SpecManifest');
  if (m.status === 'approved' && !m.reviewers.length) throw new SpecificationReviewRequired();
}
export function parseSpecManifest(text: string): SpecManifest {
  const value = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  validateSpecManifest(value);
  if (!verifySpecHash(value)) throw new SpecificationReviewRequired('Spec hash mismatch');
  return value;
}
export interface ReleaseEligibility { eligible: boolean; verdict?: Verdict; reason?: string }
export function checkReleaseEligibility(manifest: SpecManifest): ReleaseEligibility {
  try { validateSpecManifest(manifest); } catch { return { eligible: false, verdict: Verdict.SPECIFICATION_REVIEW_REQUIRED, reason: 'Invalid manifest or missing reviewer' }; }
  return manifest.status === 'approved' && verifySpecHash(manifest)
    ? { eligible: true }
    : { eligible: false, verdict: Verdict.SPECIFICATION_REVIEW_REQUIRED, reason: 'Spec must be approved with an intact content hash' };
}
export function canGateRelease(manifest: SpecManifest): boolean { return checkReleaseEligibility(manifest).eligible; }
export interface HumanApprovalProof { actor: string; human: true; token: string }
export class SpecRegistry {
  private readonly specs = new Map<string, SpecManifest>();
  constructor(readonly directory = 'specs') {
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && /\.(json|ya?ml)$/i.test(entry.name)) {
          const m = parseSpecManifest(readFileSync(path, 'utf8')); const key = this.key(m.id,m.version);
          if (this.specs.has(key)) throw new Error(`Duplicate spec revision: ${key}`);
          this.specs.set(key,m);
        }
      }
    };
    if (existsSync(directory)) visit(directory);
  }
  private key(id: string, version: string) { return JSON.stringify([id,version]); }
  addSpec(input: Omit<SpecManifest, 'content_hash'> & { content_hash?: string }): SpecManifest {
    if (input.status !== 'draft' || input.reviewers.length) throw new SpecificationReviewRequired('New specs must be drafts without reviewers');
    const m = structuredClone({ ...input, content_hash: input.content_hash ?? computeSpecHash(input as SpecManifest) });
    validateSpecManifest(m);
    if (!verifySpecHash(m)) throw new SpecificationReviewRequired('Spec hash mismatch');
    const key = this.key(m.id,m.version);
    if (this.specs.has(key)) throw new Error('Duplicate spec revision');
    this.specs.set(key,m); return structuredClone(m);
  }
  getSpec(id: string, version?: string): SpecManifest | undefined {
    const m = version === undefined ? [...this.specs.values()].filter(m => m.id === id).at(-1) : this.specs.get(this.key(id,version));
    return m && structuredClone(m);
  }
  listSpecs(): SpecManifest[] { return [...this.specs.values()].map(m => structuredClone(m)); }
  verifySpecHash(manifest: SpecManifest): boolean { return verifySpecHash(manifest); }
  promoteSpec(id: string, status: SpecStatus, version?: string): SpecManifest {
    if (status === 'approved') throw new SpecificationReviewRequired();
    const m = this.getSpec(id,version);
    if (!m) throw new Error(`Unknown spec: ${id}`);
    if (!((m.status === 'draft' && status === 'reviewed') || (m.status === 'approved' && status === 'retired') || (m.status === 'reviewed' && status === 'retired') || (m.status === 'draft' && status === 'retired'))) throw new Error('Invalid spec status transition');
    m.status = status; m.content_hash = computeSpecHash(m); this.specs.set(this.key(m.id,m.version),m); return structuredClone(m);
  }
  /** The caller must validate the human token using Wazir's approval gate. */
  approveSpec(id: string, reviewer: string, approvalProof: string | HumanApprovalProof, version?: string): SpecManifest {
    if (!reviewer?.trim() || !(typeof approvalProof === 'string' ? approvalProof.trim() : approvalProof?.human === true && approvalProof.actor === reviewer && approvalProof.token?.trim())) throw new SpecificationReviewRequired();
    const m = this.getSpec(id,version);
    if (!m) throw new Error(`Unknown spec: ${id}`);
    if (m.status !== 'reviewed') throw new Error('Only reviewed specs can be approved');
    m.reviewers = [...new Set([...m.reviewers, reviewer])]; m.status = 'approved'; m.content_hash = computeSpecHash(m);
    this.specs.set(this.key(m.id,m.version),m); return structuredClone(m);
  }
  checkReleaseEligibility(manifest: SpecManifest | string): ReleaseEligibility {
    const m = typeof manifest === 'string' ? this.getSpec(manifest) : manifest;
    return m ? checkReleaseEligibility(m) : { eligible: false, verdict: Verdict.SPECIFICATION_REVIEW_REQUIRED, reason: 'Unknown spec' };
  }
}
