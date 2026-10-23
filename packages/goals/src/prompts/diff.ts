import { canonicalJson } from './canonical.js';
import type { DiffLine, PromptDiff, SchemaChange, PromptVersionRecord } from './types.js';

const MAX_LCS_CELLS = 4_000_000;

/** Line diff (LCS). Falls back to a whole-block replace if the inputs are too large for an O(n·m) table. */
export function diffLines(a: string, b: string): DiffLine[] {
  const left = a.split('\n');
  const right = b.split('\n');
  // Trim common prefix/suffix first: prompt edits are usually local.
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let endA = left.length;
  let endB = right.length;
  while (endA > start && endB > start && left[endA - 1] === right[endB - 1]) { endA--; endB--; }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ op: 'equal', text: left[i], aLine: i + 1, bLine: i + 1 });

  const midA = left.slice(start, endA);
  const midB = right.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_LCS_CELLS) {
    midA.forEach((text, i) => out.push({ op: 'remove', text, aLine: start + i + 1 }));
    midB.forEach((text, j) => out.push({ op: 'add', text, bLine: start + j + 1 }));
  } else {
    // table[i][j] = LCS length of midA[i..] and midB[j..]
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ op: 'equal', text: midA[i], aLine: start + i + 1, bLine: start + j + 1 });
        i++; j++;
      } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
        out.push({ op: 'remove', text: midA[i], aLine: start + i + 1 });
        i++;
      } else {
        out.push({ op: 'add', text: midB[j], bLine: start + j + 1 });
        j++;
      }
    }
  }

  for (let k = 0; k < left.length - endA; k++) {
    out.push({ op: 'equal', text: left[endA + k], aLine: endA + k + 1, bLine: endB + k + 1 });
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural diff of two JSON values, reported as JSON-pointer-like paths. Arrays compare as whole values. */
export function diffJson(a: unknown, b: unknown, path = ''): SchemaChange[] {
  if (canonicalJson(a) === canonicalJson(b)) return [];
  if (a === undefined) return [{ path: path || '/', kind: 'added', to: b }];
  if (b === undefined) return [{ path: path || '/', kind: 'removed', from: a }];
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) => diffJson(a[key], b[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [{ path: path || '/', kind: 'changed', from: a, to: b }];
}

export function diffPromptVersions(a: PromptVersionRecord, b: PromptVersionRecord): PromptDiff {
  const lines = diffLines(a.template, b.template);
  const capsA = new Set(a.requiredCapabilities);
  const capsB = new Set(b.requiredCapabilities);
  return {
    promptId: a.id,
    a: a.version,
    b: b.version,
    digest: { a: a.digest, b: b.digest },
    identical: a.digest === b.digest,
    template: {
      lines,
      added: lines.filter((line) => line.op === 'add').length,
      removed: lines.filter((line) => line.op === 'remove').length,
    },
    role: a.role === b.role ? undefined : { from: a.role, to: b.role },
    requiredCapabilities: {
      added: [...capsB].filter((cap) => !capsA.has(cap)),
      removed: [...capsA].filter((cap) => !capsB.has(cap)),
    },
    inputSchema: diffJson(a.inputSchema, b.inputSchema),
    outputSchema: diffJson(a.outputSchema, b.outputSchema),
  };
}
