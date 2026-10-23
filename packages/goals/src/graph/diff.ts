import type { GoalGraphDefinition, GoalGraphRevisionRecord, GraphRevision, TargetId } from '../contracts.js';
import { canonicalJson } from './canonical.js';

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface GoalGraphDiff {
  fromRevision?: GraphRevision;
  toRevision?: GraphRevision;
  fromDigest?: string;
  toDigest?: string;
  identical: boolean;
  /** name, schemaVersion, purpose. */
  metadata: FieldChange[];
  constitution: FieldChange[];
  targets: {
    added: TargetId[];
    removed: TargetId[];
    changed: Array<{ targetId: TargetId; changes: FieldChange[] }>;
  };
  executionGraph: {
    entry?: FieldChange;
    addedNodes: string[];
    removedNodes: string[];
    changedNodes: Array<{ nodeId: string; changes: FieldChange[] }>;
  };
}

type Side = GoalGraphDefinition | GoalGraphRevisionRecord;
const isRecord = (s: Side): s is GoalGraphRevisionRecord => (s as GoalGraphRevisionRecord).definition !== undefined && (s as GoalGraphRevisionRecord).revision !== undefined;

/** Structural diff between two revisions (or bare definitions), `from` -> `to`. Pure. */
export function diffRevisions(from: Side, to: Side): GoalGraphDiff {
  const a = isRecord(from) ? from.definition : from;
  const b = isRecord(to) ? to.definition : to;
  const metadata: FieldChange[] = [];
  for (const key of ['name', 'schemaVersion', 'purpose'] as const) pushIfChanged(metadata, key, a[key], b[key]);

  const constitution: FieldChange[] = [];
  deepFieldDiff('constitution', a.constitution, b.constitution, constitution);

  const aTargets = new Map(a.targets.map((t) => [t.id, t]));
  const bTargets = new Map(b.targets.map((t) => [t.id, t]));
  const added = b.targets.filter((t) => !aTargets.has(t.id)).map((t) => t.id);
  const removed = a.targets.filter((t) => !bTargets.has(t.id)).map((t) => t.id);
  const changed: GoalGraphDiff['targets']['changed'] = [];
  for (const t of b.targets) {
    const before = aTargets.get(t.id);
    if (!before) continue;
    const changes: FieldChange[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(t)]);
    for (const key of [...keys].sort()) pushIfChanged(changes, key, (before as unknown as Record<string, unknown>)[key], (t as unknown as Record<string, unknown>)[key]);
    if (changes.length) changed.push({ targetId: t.id, changes });
  }

  const aNodes = new Map(a.executionGraph.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.executionGraph.nodes.map((n) => [n.id, n]));
  const changedNodes: GoalGraphDiff['executionGraph']['changedNodes'] = [];
  for (const n of b.executionGraph.nodes) {
    const before = aNodes.get(n.id);
    if (!before) continue;
    const changes: FieldChange[] = [];
    pushIfChanged(changes, 'next', before.next, n.next);
    pushIfChanged(changes, 'promptId', before.promptId, n.promptId);
    if (changes.length) changedNodes.push({ nodeId: n.id, changes });
  }
  const entryChanges: FieldChange[] = [];
  pushIfChanged(entryChanges, 'entry', a.executionGraph.entry, b.executionGraph.entry);

  const diff: GoalGraphDiff = {
    fromRevision: isRecord(from) ? from.revision : undefined,
    toRevision: isRecord(to) ? to.revision : undefined,
    fromDigest: isRecord(from) ? from.digest : undefined,
    toDigest: isRecord(to) ? to.digest : undefined,
    identical: false,
    metadata,
    constitution,
    targets: { added, removed, changed },
    executionGraph: {
      entry: entryChanges[0],
      addedNodes: b.executionGraph.nodes.filter((n) => !aNodes.has(n.id)).map((n) => n.id),
      removedNodes: a.executionGraph.nodes.filter((n) => !bNodes.has(n.id)).map((n) => n.id),
      changedNodes,
    },
  };
  diff.identical = canonicalJson(a) === canonicalJson(b);
  return diff;
}

function pushIfChanged(out: FieldChange[], path: string, before: unknown, after: unknown): void {
  if (canonicalJson(before ?? null) !== canonicalJson(after ?? null)) out.push({ path, before, after });
}

/** Recurses through plain objects; arrays and scalars compare as whole values. */
function deepFieldDiff(path: string, a: unknown, b: unknown, out: FieldChange[]): void {
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (plain(a) && plain(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) deepFieldDiff(`${path}.${key}`, a[key], b[key], out);
    return;
  }
  pushIfChanged(out, path, a, b);
}
