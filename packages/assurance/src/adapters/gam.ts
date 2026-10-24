/**
 * GAM adapter (FORMAL_ASSURANCE.md §2.3 item 6): governance-domain obligations over GAL-JSON Φ_L / Φ_E.
 *
 * Runs either an external GAM CLI (when configured) or the built-in deterministic engine:
 *  - {@link ConsistencyChecker}: `Con` — permit/deny conflicts over closures (RR*, PP*, delegation).
 *  - {@link OntologyChecker}: structural duties (`ontologyRequirements`) and precedence (`scenarioRequirements`).
 *  - {@link emitAlloyTwin}: a self-contained Alloy 6 `.als` twin of the same facts and `pred Con`.
 *
 * `Con` passing ≠ compliant: the ontology check always runs too. `consistent && satisfied` → BOUNDED_PASS
 * (subject to the vacuity probe), any violation → COUNTEREXAMPLE with the witness paths.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  Obligation,
  SolverAdapter,
  ToolAvailability,
  VacuityProbeResult,
  VerificationResult,
  Verdict,
  VerifyOptions,
} from '../contracts';
import { applyVacuityProbe, mapNativeOutcomeToVerdict } from '../verdict';

// ---------------------------------------------------------------------------
// GAL-JSON shapes
// ---------------------------------------------------------------------------

export type GamSort = 'Process' | 'Activity' | 'Role' | 'User';
export type Origin = 'law' | 'enterprise' | 'both';

export interface GalEntity {
  id: string;
  type?: string;
  name?: string;
}

export interface GalRelation {
  type: string;
  source: string;
  target: string;
  parameters?: Record<string, unknown>;
}

export interface GalPolicy {
  type: string;
  source: string;
  target: string;
  modality?: 'Allow' | 'Deny';
  allow_deny?: 'Allow' | 'Deny';
  deontic_status?: string;
  parameters?: { activity_or_process?: string | null; [k: string]: unknown };
}

export interface OntologyRequirement {
  id?: string;
  process?: string;
  activity?: string;
  parentRole?: string;
  childRole?: string;
  parentProcess?: string;
  childProcess?: string;
  rationale?: string;
}

export interface ScenarioRequirement {
  id?: string;
  kind: 'precedence' | 'forbidden-precedence';
  from: string;
  to: string;
  rationale?: string;
}

export interface GalModel {
  model_type?: string;
  context?: string;
  entities?: GalEntity[];
  relations?: GalRelation[];
  policies?: GalPolicy[];
  ontologyRequirements?: OntologyRequirement[];
  scenarioRequirements?: ScenarioRequirement[];
  [k: string]: unknown;
}

/** A GAM obligation artifact: Φ_L and Φ_E side by side. */
export interface GalCase {
  law: GalModel;
  enterprise: GalModel;
  moduleName?: string;
}

export class GalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GalParseError';
  }
}

/** Parse GAL-JSON text (or an already-parsed object) into a {@link GalCase}. Throws {@link GalParseError}. */
export function parseGalJson(input: string | unknown): GalCase {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      throw new GalParseError(`invalid JSON: ${(err as Error).message}`);
    }
  }
  if (!isObject(raw)) throw new GalParseError('GAL-JSON case must be an object');
  const law = raw.law ?? raw.lawModel ?? raw.phiL;
  const enterprise = raw.enterprise ?? raw.enterpriseModel ?? raw.phiE;
  if (law === undefined || enterprise === undefined) {
    throw new GalParseError('GAL-JSON case must contain both `law` (Φ_L) and `enterprise` (Φ_E) models');
  }
  return {
    law: validateModel(law, 'law'),
    enterprise: validateModel(enterprise, 'enterprise'),
    moduleName: typeof raw.moduleName === 'string' ? raw.moduleName : undefined,
  };
}

function validateModel(m: unknown, label: string): GalModel {
  if (!isObject(m)) throw new GalParseError(`${label}: model must be an object`);
  for (const key of ['entities', 'relations', 'policies', 'ontologyRequirements', 'scenarioRequirements']) {
    if (m[key] !== undefined && !Array.isArray(m[key])) throw new GalParseError(`${label}.${key} must be an array`);
  }
  (m.entities as unknown[] | undefined)?.forEach((e, i) => {
    if (!isObject(e) || typeof e.id !== 'string') throw new GalParseError(`${label}.entities[${i}] needs a string id`);
  });
  for (const key of ['relations', 'policies'] as const) {
    (m[key] as unknown[] | undefined)?.forEach((r, i) => {
      if (!isObject(r) || typeof r.type !== 'string' || typeof r.source !== 'string' || typeof r.target !== 'string') {
        throw new GalParseError(`${label}.${key}[${i}] needs string type, source and target`);
      }
    });
  }
  (m.policies as GalPolicy[] | undefined)?.forEach((p, i) => {
    if (policyPolarity(p) === undefined) {
      throw new GalParseError(`${label}.policies[${i}] (${p.type}) has no polarity (modality / allow_deny / deontic_status)`);
    }
  });
  (m.scenarioRequirements as unknown[] | undefined)?.forEach((s, i) => {
    if (!isObject(s) || (s.kind !== 'precedence' && s.kind !== 'forbidden-precedence') || typeof s.from !== 'string' || typeof s.to !== 'string') {
      throw new GalParseError(`${label}.scenarioRequirements[${i}] needs kind precedence|forbidden-precedence, from, to`);
    }
  });
  return m as GalModel;
}

function policyPolarity(p: GalPolicy): 'Allow' | 'Deny' | undefined {
  const m = p.modality ?? p.allow_deny;
  if (m === 'Allow' || m === 'Deny') return m;
  if (p.deontic_status === 'Prohibited') return 'Deny';
  if (p.deontic_status === 'Permitted' || p.deontic_status === 'Obligatory') return 'Allow';
  return undefined;
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Model: one vocabulary, polarity split, provenance
// ---------------------------------------------------------------------------

type Edge = { target: string; origin: Origin; label: string };
type Rel = Map<string, Edge[]>;

const RELATION_KEYS = ['PP', 'PA', 'RR', 'S', 'X', 'RAp', 'RAm', 'RUp', 'RUm', 'UPp', 'UPm', 'RPp', 'RPm'] as const;
type RelKey = (typeof RELATION_KEYS)[number];

interface Delegation {
  from: string;
  to: string;
  object?: string;
  polarity: 'Allow' | 'Deny';
  origin: Origin;
}

/** Combined Φ = ⟨P, A, R, U ; PP, PA, RR, S, X, RA±, RU±, UP±, RP±, D±⟩ built from Φ_L ∪ Φ_E. */
export class GamModel {
  readonly sorts = new Map<string, GamSort>();
  readonly rel: Record<RelKey, Rel> = Object.fromEntries(RELATION_KEYS.map((k) => [k, new Map()])) as Record<RelKey, Rel>;
  readonly delegations: Delegation[] = [];

  constructor(models: Array<{ model: GalModel; origin: Origin }>) {
    for (const { model } of models) {
      for (const e of model.entities ?? []) {
        if (isSort(e.type)) this.sorts.set(e.id, e.type);
      }
    }
    for (const { model, origin } of models) this.ingest(model, origin);
  }

  get users(): string[] {
    // RU⁺ is stored user-major, so its keys are exactly the analysed users.
    return [...this.rel.RUp.keys()].sort();
  }

  edges(key: RelKey, src: string): Edge[] {
    return this.rel[key].get(src) ?? [];
  }

  has(key: RelKey, src: string, tgt: string): boolean {
    return this.edges(key, src).some((e) => e.target === tgt);
  }

  private add(key: RelKey, src: string, tgt: string, origin: Origin, label: string, srcSort?: GamSort, tgtSort?: GamSort): void {
    if (srcSort && !this.sorts.has(src)) this.sorts.set(src, srcSort);
    if (tgtSort && !this.sorts.has(tgt)) this.sorts.set(tgt, tgtSort);
    const list = this.rel[key].get(src) ?? [];
    const existing = list.find((e) => e.target === tgt);
    if (existing) {
      if (existing.origin !== origin) existing.origin = 'both';
      return;
    }
    list.push({ target: tgt, origin, label });
    this.rel[key].set(src, list);
  }

  private ingest(model: GalModel, origin: Origin): void {
    for (const r of model.relations ?? []) {
      const lbl = `${r.type} ${r.source}→${r.target}`;
      switch (r.type) {
        case 'ComposedOf': this.add('PP', r.source, r.target, origin, lbl, 'Process', 'Process'); break;
        case 'Contains': this.add('PA', r.source, r.target, origin, lbl, 'Process', 'Activity'); break;
        case 'Includes': this.add('RR', r.source, r.target, origin, lbl, 'Role', 'Role'); break;
        case 'Next': this.add('S', r.source, r.target, origin, lbl, 'Activity', 'Activity'); break;
        case 'Separate': this.add('X', r.source, r.target, origin, lbl, 'Process', 'Process'); break;
        // Acts is Role → User; stored user-major.
        case 'Acts': this.add('RUp', r.target, r.source, origin, lbl, 'User', 'Role'); break;
        case 'Assumes': this.add('UPp', r.source, r.target, origin, lbl, 'User', 'Process'); break;
        case 'AssignedTo': this.add('RAp', r.source, r.target, origin, lbl, 'Role', 'Activity'); break;
        case 'Reaches': this.add('RPp', r.source, r.target, origin, lbl, 'Role', 'Process'); break;
        default: break; // unknown relation types are ignored by the checker, as in GAM
      }
    }
    for (const p of model.policies ?? []) {
      const pol = policyPolarity(p)!;
      const lbl = `${p.type}(${pol}) ${p.source}→${p.target}`;
      const plus = pol === 'Allow';
      switch (p.type) {
        // CanAssignTo is Activity → Role (reverse of AssignedTo).
        case 'CanAssignTo': this.add(plus ? 'RAp' : 'RAm', p.target, p.source, origin, lbl, 'Role', 'Activity'); break;
        // CanAct is User → Role (reverse of Acts).
        case 'CanAct': this.add(plus ? 'RUp' : 'RUm', p.source, p.target, origin, lbl, 'User', 'Role'); break;
        case 'CanAssume': this.add(plus ? 'UPp' : 'UPm', p.source, p.target, origin, lbl, 'User', 'Process'); break;
        case 'CanReach': this.add(plus ? 'RPp' : 'RPm', p.source, p.target, origin, lbl, 'Role', 'Process'); break;
        case 'CanDelegate': {
          this.sorts.has(p.source) || this.sorts.set(p.source, 'Role');
          this.sorts.has(p.target) || this.sorts.set(p.target, 'Role');
          const obj = p.parameters?.activity_or_process ?? undefined;
          this.delegations.push({ from: p.source, to: p.target, object: obj ?? undefined, polarity: pol, origin });
          break;
        }
        default: break;
      }
    }
  }
}

function isSort(t: unknown): t is GamSort {
  return t === 'Process' || t === 'Activity' || t === 'Role' || t === 'User';
}

// ---------------------------------------------------------------------------
// Closures with derivation paths
// ---------------------------------------------------------------------------

type NodeKind = 'U' | 'R' | 'P' | 'A';
interface Reach {
  /** node key `K:id` → derivation path (edge labels from the start node). */
  paths: Map<string, string[]>;
}

function bfs(start: string, next: (node: string) => Array<{ node: string; label: string }>): Reach {
  const paths = new Map<string, string[]>([[start, []]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const { node, label } of next(cur)) {
      if (paths.has(node)) continue;
      paths.set(node, [...paths.get(cur)!, label]);
      queue.push(node);
    }
  }
  return { paths };
}

function nodesOf(reach: Reach, kind: NodeKind): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, p] of reach.paths) if (k.startsWith(`${kind}:`)) out.set(k.slice(2), p);
  return out;
}

/** Roles the user occupies: RU⁺ then RR* (senior inherits junior). */
function occupiedRoles(m: GamModel, user: string): Map<string, string[]> {
  return nodesOf(
    bfs(`U:${user}`, (n) => {
      const [k, id] = [n[0], n.slice(2)];
      if (k === 'U') return m.edges('RUp', id).map((e) => ({ node: `R:${e.target}`, label: e.label }));
      if (k === 'R') return m.edges('RR', id).map((e) => ({ node: `R:${e.target}`, label: e.label }));
      return [];
    }),
    'R',
  );
}

/** Everything a user effectively reaches: roles (incl. delegated), processes (PP*), activities (effAct). */
function effectiveReach(m: GamModel, user: string): Reach {
  const delegatedTo = new Map<string, Delegation[]>();
  for (const d of m.delegations) {
    if (d.polarity !== 'Allow') continue;
    delegatedTo.set(d.to, [...(delegatedTo.get(d.to) ?? []), d]);
  }
  return bfs(`U:${user}`, (n) => {
    const [k, id] = [n[0], n.slice(2)];
    const out: Array<{ node: string; label: string }> = [];
    const push = (key: RelKey, kind: NodeKind) => m.edges(key, id).forEach((e) => out.push({ node: `${kind}:${e.target}`, label: e.label }));
    if (k === 'U') { push('RUp', 'R'); push('UPp', 'P'); }
    if (k === 'R') {
      push('RR', 'R'); push('RPp', 'P'); push('RAp', 'A');
      for (const d of delegatedTo.get(id) ?? []) {
        const label = `CanDelegate(Allow) ${d.from}→${d.to}${d.object ? ` [${d.object}]` : ' [⊤]'}`;
        if (!d.object) out.push({ node: `R:${d.from}`, label });
        else out.push({ node: `${m.sorts.get(d.object) === 'Process' ? 'P' : 'A'}:${d.object}`, label });
      }
    }
    if (k === 'P') { push('PP', 'P'); push('PA', 'A'); }
    return out;
  });
}

function closure(m: GamModel, key: RelKey, start: string, reflexive: boolean): Map<string, string[]> {
  const r = bfs(start, (n) => m.edges(key, n).map((e) => ({ node: e.target, label: e.label })));
  if (!reflexive) {
    // Keep start only if reachable via a non-empty path (cycle).
    const cyclic = m.edges(key, start).length > 0 && [...r.paths.keys()].some((n) => m.has(key, n, start));
    if (!cyclic) r.paths.delete(start);
  }
  return r.paths;
}

/** Activities of a role's RA* (inclusion + reached processes), used for ⊤ delegation laundering. */
function roleActivities(m: GamModel, role: string): Set<string> {
  const reach = bfs(`R:${role}`, (n) => {
    const [k, id] = [n[0], n.slice(2)];
    const out: Array<{ node: string; label: string }> = [];
    const push = (key: RelKey, kind: NodeKind) => m.edges(key, id).forEach((e) => out.push({ node: `${kind}:${e.target}`, label: e.label }));
    if (k === 'R') { push('RR', 'R'); push('RPp', 'P'); push('RAp', 'A'); }
    if (k === 'P') { push('PP', 'P'); push('PA', 'A'); }
    return out;
  });
  return new Set(nodesOf(reach, 'A').keys());
}

/** Find a cycle in an acyclic-by-contract hierarchy (ComposedOf / Includes). */
function findCycle(m: GamModel, key: RelKey): string[] | undefined {
  for (const start of m.rel[key].keys()) {
    const paths = closure(m, key, start, true);
    for (const n of paths.keys()) if (n !== start && m.has(key, n, start)) return [start, n];
    if (m.has(key, start, start)) return [start];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ConsistencyChecker — Con
// ---------------------------------------------------------------------------

export type ConsistencyViolationType =
  | 'ACTIVITY_CONFLICT'
  | 'ROLE_OCCUPANCY_CONFLICT'
  | 'PROCESS_ACCESS_CONFLICT'
  | 'SEPARATION_VIOLATION'
  | 'DELEGATION_CONFLICT'
  | 'DELEGATION_LAUNDERS_PROHIBITION';

export interface ConsistencyViolation {
  type: ConsistencyViolationType;
  user?: string;
  role?: string;
  activity?: string;
  process?: string;
  process1?: string;
  process2?: string;
  grantedVia?: string[];
  prohibitedVia?: string[];
  reachedVia?: string[][];
  message: string;
}

export interface ConsistencyResult {
  consistent: boolean;
  violations: ConsistencyViolation[];
  stats: { users: number; roles: number; processes: number; activities: number; separations: number };
  model: GamModel;
}

export class ConsistencyChecker {
  check(law: GalModel, enterprise: GalModel): ConsistencyResult {
    return this.checkModel(new GamModel([{ model: law, origin: 'law' }, { model: enterprise, origin: 'enterprise' }]));
  }

  checkModel(m: GamModel): ConsistencyResult {
    const violations: ConsistencyViolation[] = [];
    const separations = uniquePairs(m);

    for (const user of m.users) {
      const occupied = occupiedRoles(m, user);
      const reach = effectiveReach(m, user);
      const acts = nodesOf(reach, 'A');
      const procs = nodesOf(reach, 'P');

      // 1. RA* ∩ RA⁻ = ∅
      for (const [role, rolePath] of occupied) {
        for (const deny of m.edges('RAm', role)) {
          const granted = acts.get(deny.target);
          if (!granted) continue;
          violations.push({
            type: 'ACTIVITY_CONFLICT', user, role, activity: deny.target,
            grantedVia: granted, prohibitedVia: [...rolePath, `${deny.label} [${deny.origin}]`],
            message: `${user} effectively performs ${deny.target}, which is prohibited for role ${role}`,
          });
        }
      }
      // 2. RU⁺ ∩ RU⁻ = ∅
      for (const deny of m.edges('RUm', user)) {
        const via = occupied.get(deny.target);
        if (!via) continue;
        violations.push({
          type: 'ROLE_OCCUPANCY_CONFLICT', user, role: deny.target, grantedVia: via, prohibitedVia: [`${deny.label} [${deny.origin}]`],
          message: `${user} acts in role ${deny.target}, which they must not occupy`,
        });
      }
      // 3. UP* ∩ UP⁻ = ∅ (and RP⁻ for occupied roles)
      for (const deny of m.edges('UPm', user)) {
        const via = procs.get(deny.target);
        if (!via) continue;
        violations.push({
          type: 'PROCESS_ACCESS_CONFLICT', user, process: deny.target, grantedVia: via, prohibitedVia: [`${deny.label} [${deny.origin}]`],
          message: `${user} effectively enters ${deny.target}, which they must not assume`,
        });
      }
      for (const [role, rolePath] of occupied) {
        for (const deny of m.edges('RPm', role)) {
          const via = procs.get(deny.target);
          if (!via) continue;
          violations.push({
            type: 'PROCESS_ACCESS_CONFLICT', user, role, process: deny.target, grantedVia: via,
            prohibitedVia: [...rolePath, `${deny.label} [${deny.origin}]`],
            message: `${user} effectively reaches ${deny.target}, which role ${role} must not reach`,
          });
        }
      }
      // 4. Separation of concerns
      for (const [p, q] of separations) {
        const vp = procs.get(p);
        const vq = procs.get(q);
        if (!vp || !vq) continue;
        violations.push({
          type: 'SEPARATION_VIOLATION', user, process1: p, process2: q, reachedVia: [vp, vq],
          message: `${user} effectively reaches both ${p} and ${q}, which must be separate`,
        });
      }
    }

    // 5. Delegation
    for (const d of m.delegations) {
      if (d.polarity !== 'Allow') continue;
      const clash = m.delegations.find(
        (o) => o.polarity === 'Deny' && o.from === d.from && o.to === d.to && (o.object === undefined || o.object === d.object),
      );
      if (clash) {
        violations.push({
          type: 'DELEGATION_CONFLICT', role: d.from, activity: d.object,
          grantedVia: [`CanDelegate(Allow) ${d.from}→${d.to} [${d.origin}]`], prohibitedVia: [`CanDelegate(Deny) ${clash.from}→${clash.to} [${clash.origin}]`],
          message: `delegation ${d.from}→${d.to}${d.object ? ` of ${d.object}` : ''} is both permitted and prohibited`,
        });
      }
      const conferred = d.object
        ? m.sorts.get(d.object) === 'Process' ? roleActivitiesOfProcess(m, d.object) : new Set([d.object])
        : roleActivities(m, d.from);
      for (const deny of m.edges('RAm', d.to)) {
        if (!conferred.has(deny.target)) continue;
        violations.push({
          type: 'DELEGATION_LAUNDERS_PROHIBITION', role: d.to, activity: deny.target,
          grantedVia: [`CanDelegate(Allow) ${d.from}→${d.to}${d.object ? ` [${d.object}]` : ' [⊤]'} [${d.origin}]`],
          prohibitedVia: [`${deny.label} [${deny.origin}]`],
          message: `delegation from ${d.from} confers ${deny.target} on ${d.to}, which is prohibited for it`,
        });
      }
    }

    const count = (s: GamSort) => [...m.sorts.values()].filter((v) => v === s).length;
    return {
      consistent: violations.length === 0,
      violations,
      stats: { users: m.users.length, roles: count('Role'), processes: count('Process'), activities: count('Activity'), separations: separations.length },
      model: m,
    };
  }
}

function roleActivitiesOfProcess(m: GamModel, proc: string): Set<string> {
  const out = new Set<string>();
  for (const p of closure(m, 'PP', proc, true).keys()) for (const e of m.edges('PA', p)) out.add(e.target);
  return out;
}

function uniquePairs(m: GamModel): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const [p, edges] of m.rel.X) {
    for (const e of edges) {
      const key = [p, e.target].sort().join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([p, e.target]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OntologyChecker — structural duties and scenario precedence
// ---------------------------------------------------------------------------

export interface OntologyViolation {
  type: 'ONTOLOGY_GAP' | 'SCENARIO_VIOLATION';
  requirementId?: string;
  requirement: OntologyRequirement | ScenarioRequirement;
  message: string;
  /** For forbidden precedence: the Next⁺ path that realises it. */
  path?: string[];
}

export interface OntologyResult {
  satisfied: boolean;
  violations: OntologyViolation[];
  checked: number;
}

export class OntologyChecker {
  check(law: GalModel, enterprise: GalModel): OntologyResult {
    const m = new GamModel([{ model: law, origin: 'law' }, { model: enterprise, origin: 'enterprise' }]);
    return this.checkModel(m, law.ontologyRequirements ?? [], law.scenarioRequirements ?? []);
  }

  checkModel(m: GamModel, ontology: OntologyRequirement[], scenarios: ScenarioRequirement[]): OntologyResult {
    const violations: OntologyViolation[] = [];
    for (const req of ontology) {
      let ok: boolean;
      let what: string;
      if (req.process !== undefined && req.activity !== undefined) {
        ok = roleActivitiesOfProcess(m, req.process).has(req.activity);
        what = `process ${req.process} contains no ${req.activity} at any depth`;
      } else if (req.parentRole !== undefined && req.childRole !== undefined) {
        ok = closure(m, 'RR', req.parentRole, true).has(req.childRole);
        what = `role ${req.parentRole} does not include ${req.childRole}`;
      } else if (req.parentProcess !== undefined && req.childProcess !== undefined) {
        ok = closure(m, 'PP', req.parentProcess, true).has(req.childProcess);
        what = `process ${req.parentProcess} is not composed of ${req.childProcess}`;
      } else {
        ok = false;
        what = 'malformed ontology requirement (expected {process, activity} | {parentRole, childRole} | {parentProcess, childProcess})';
      }
      if (!ok) violations.push({ type: 'ONTOLOGY_GAP', requirementId: req.id, requirement: req, message: what });
    }
    for (const req of scenarios) {
      const path = closure(m, 'S', req.from, false).get(req.to);
      if (req.kind === 'precedence' && !path) {
        violations.push({ type: 'SCENARIO_VIOLATION', requirementId: req.id, requirement: req, message: `${req.to} is not preceded by ${req.from} (Next⁺)` });
      }
      if (req.kind === 'forbidden-precedence' && path) {
        violations.push({ type: 'SCENARIO_VIOLATION', requirementId: req.id, requirement: req, path, message: `${req.from} must not precede ${req.to}` });
      }
    }
    return { satisfied: violations.length === 0, violations, checked: ontology.length + scenarios.length };
  }
}

// ---------------------------------------------------------------------------
// Alloy twin emitter
// ---------------------------------------------------------------------------

export interface AlloyTwinOptions {
  moduleName?: string;
  scope?: number;
}

const ALLOY_SORT_PREFIX: Record<GamSort, string> = { Process: 'P_', Activity: 'A_', Role: 'R_', User: 'U_' };

function alloyId(sort: GamSort, id: string): string {
  return ALLOY_SORT_PREFIX[sort] + id.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Emit a self-contained Alloy 6 twin of a GAL-JSON case: sorts, Φ fields, closure functions, `pred Con`,
 * a `check Consistent` command and one `check` per ontology / scenario requirement. Delegation (D±) is
 * built-in-engine only and is noted in a comment.
 */
export function emitAlloyTwin(galJson: string | unknown, options: AlloyTwinOptions = {}): string {
  const gal = parseGalJson(galJson);
  const m = new GamModel([{ model: gal.law, origin: 'law' }, { model: gal.enterprise, origin: 'enterprise' }]);
  const moduleName = (options.moduleName ?? gal.moduleName ?? 'gam_case').replace(/[^A-Za-z0-9_/]/g, '_');
  const scope = options.scope ?? Math.max(5, m.sorts.size);
  const sortOf = (id: string): GamSort => m.sorts.get(id) ?? 'Activity';
  const ref = (id: string) => alloyId(sortOf(id), id);

  const lines: string[] = [
    `module ${moduleName}`,
    '',
    '// Generated by @wazir/assurance GAM adapter (emitAlloyTwin). Do not edit by hand.',
    '// Delegation (D±) is checked by the built-in engine only.',
    '',
    'abstract sig Process {}',
    'abstract sig Activity {}',
    'abstract sig Role {}',
    'abstract sig User {}',
    '',
  ];
  const bySort = new Map<GamSort, string[]>();
  for (const [id, sort] of [...m.sorts].sort((a, b) => a[0].localeCompare(b[0]))) bySort.set(sort, [...(bySort.get(sort) ?? []), alloyId(sort, id)]);
  for (const sort of ['Process', 'Activity', 'Role', 'User'] as GamSort[]) {
    const ids = bySort.get(sort);
    if (ids?.length) lines.push(`one sig ${ids.join(', ')} extends ${sort} {}`);
  }
  const fields: Array<[RelKey, string]> = [
    ['PP', 'Process -> Process'], ['PA', 'Process -> Activity'], ['RR', 'Role -> Role'], ['S', 'Activity -> Activity'],
    ['X', 'Process -> Process'], ['RAp', 'Role -> Activity'], ['RAm', 'Role -> Activity'], ['RUp', 'User -> Role'],
    ['RUm', 'User -> Role'], ['UPp', 'User -> Process'], ['UPm', 'User -> Process'], ['RPp', 'Role -> Process'], ['RPm', 'Role -> Process'],
  ];
  lines.push('', 'one sig Phi {');
  lines.push(fields.map(([k, t]) => `  ${k}: ${t}`).join(',\n'));
  lines.push('}', '', 'fact Facts {');
  for (const [k, t] of fields) {
    const tuples: string[] = [];
    for (const [src, edges] of [...m.rel[k]].sort((a, b) => a[0].localeCompare(b[0]))) for (const e of edges) tuples.push(`${ref(src)}->${ref(e.target)}`);
    const empty = t.split(' -> ').map(() => 'none').join('->');
    lines.push(`  Phi.${k} = ${tuples.length ? tuples.join(' + ') : empty}`);
  }
  lines.push(
    '}',
    '',
    'fact WellFormed { no iden & ^(Phi.PP) and no iden & ^(Phi.RR) }',
    '',
    'fun roles[u: User]: set Role { u.(Phi.RUp).*(Phi.RR) }',
    'fun procs[u: User]: set Process { (u.(Phi.UPp) + roles[u].(Phi.RPp)).*(Phi.PP) }',
    'fun effAct[u: User]: set Activity { roles[u].(Phi.RAp) + procs[u].(Phi.PA) }',
    '',
    'pred Con {',
    '  all u: User {',
    '    no effAct[u] & roles[u].(Phi.RAm)',
    '    no u.(Phi.RUp) & u.(Phi.RUm)',
    '    no procs[u] & (u.(Phi.UPm) + roles[u].(Phi.RPm))',
    '    all p, q: Process | p->q in Phi.X implies not (p in procs[u] and q in procs[u])',
    '  }',
    '}',
    '',
    'assert Consistent { Con }',
    `check Consistent for ${scope}`,
  );
  (gal.law.ontologyRequirements ?? []).forEach((req, i) => {
    const name = `Ontology_${(req.id ?? String(i)).replace(/[^A-Za-z0-9_]/g, '_')}`;
    let expr: string | undefined;
    if (req.process && req.activity) expr = `${ref(req.activity)} in ${ref(req.process)}.*(Phi.PP).(Phi.PA)`;
    else if (req.parentRole && req.childRole) expr = `${ref(req.childRole)} in ${ref(req.parentRole)}.*(Phi.RR)`;
    else if (req.parentProcess && req.childProcess) expr = `${ref(req.childProcess)} in ${ref(req.parentProcess)}.*(Phi.PP)`;
    if (expr) lines.push('', `assert ${name} { ${expr} }`, `check ${name} for ${scope}`);
  });
  (gal.law.scenarioRequirements ?? []).forEach((req, i) => {
    const name = `Scenario_${(req.id ?? String(i)).replace(/[^A-Za-z0-9_]/g, '_')}`;
    const rel = `${ref(req.from)}->${ref(req.to)} in ^(Phi.S)`;
    lines.push('', `assert ${name} { ${req.kind === 'precedence' ? rel : `not (${rel})`} }`, `check ${name} for ${scope}`);
  });
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Vacuity / assumption probe
// ---------------------------------------------------------------------------

export interface AssumptionCheck {
  inconsistent: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

/** Φ_L must be non-empty, acyclic and satisfy `Con` on its own; otherwise any pass is vacuous. */
export function checkLawAssumptions(gal: GalCase): AssumptionCheck {
  const law = gal.law;
  const constraints =
    (law.policies?.length ?? 0) +
    (law.relations ?? []).filter((r) => r.type === 'Separate').length +
    (law.ontologyRequirements?.length ?? 0) +
    (law.scenarioRequirements?.length ?? 0);
  if (constraints === 0) {
    return { inconsistent: true, reason: 'Φ_L is empty: no prohibitions, separations or requirements to check against' };
  }
  const m = new GamModel([{ model: law, origin: 'law' }]);
  const lawCon = new ConsistencyChecker().checkModel(m);
  if (!lawCon.consistent) {
    return { inconsistent: true, reason: 'Φ_L is self-contradictory (Con fails on Φ_L alone)', details: { violations: lawCon.violations } };
  }
  for (const key of ['PP', 'RR'] as const) {
    const cycle = findCycle(m, key);
    if (cycle) return { inconsistent: true, reason: `Φ_L hierarchy ${key} is cyclic (WellFormed unsatisfiable)`, details: { cycle } };
  }
  // Φ_L has no users of its own, so also check role-level polarity over closures: a role whose RA*
  // includes an activity Φ_L also denies it (or a ± clash on RU / UP / RP) makes Φ_L unsatisfiable.
  const clashes: string[] = [];
  for (const role of new Set([...m.rel.RAm.keys(), ...m.rel.RAp.keys(), ...m.rel.RR.keys()])) {
    const granted = roleActivities(m, role);
    for (const deny of closure(m, 'RR', role, true).keys()) {
      for (const e of m.edges('RAm', deny)) if (granted.has(e.target)) clashes.push(`RA± ${role}/${e.target}`);
    }
  }
  for (const [plus, minus] of [['RUp', 'RUm'], ['UPp', 'UPm'], ['RPp', 'RPm']] as const) {
    for (const [src, edges] of m.rel[minus]) for (const e of edges) if (m.has(plus, src, e.target)) clashes.push(`${plus.slice(0, 2)}± ${src}/${e.target}`);
  }
  if (clashes.length > 0) {
    return { inconsistent: true, reason: 'Φ_L both permits and prohibits the same fact', details: { clashes } };
  }
  return { inconsistent: false };
}

/** Both Φ_L and Φ_E must be inhabited and at least one user must be analysed (RU⁺ non-empty). */
export function vacuityProbe(gal: GalCase, m: GamModel): VacuityProbeResult {
  const lawInhabited = (gal.law.policies?.length ?? 0) + (gal.law.relations?.length ?? 0) + (gal.law.ontologyRequirements?.length ?? 0) + (gal.law.scenarioRequirements?.length ?? 0) > 0;
  const entInhabited = (gal.enterprise.entities?.length ?? 0) + (gal.enterprise.relations?.length ?? 0) + (gal.enterprise.policies?.length ?? 0) > 0;
  const users = m.users.length;
  for (const key of ['PP', 'RR'] as const) {
    const cycle = findCycle(m, key);
    if (cycle) return { passed: false, reason: `${key} hierarchy is cyclic; the Alloy twin would be vacuous`, details: { cycle } };
  }
  if (!lawInhabited) return { passed: false, reason: 'Φ_L is not inhabited' };
  if (!entInhabited) return { passed: false, reason: 'Φ_E is not inhabited' };
  if (users === 0 && (gal.law.ontologyRequirements?.length ?? 0) + (gal.law.scenarioRequirements?.length ?? 0) === 0) {
    return { passed: false, reason: 'no user Acts in any role, so Con holds vacuously' };
  }
  return { passed: true, details: { users, lawInhabited, entInhabited } };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Spawn failure (e.g. ENOENT). */
  spawnError?: string;
}

export type CommandRunner = (command: string, args: string[], opts: { timeoutMs?: number; cwd?: string }) => Promise<CommandResult>;

export interface GamAdapterOptions {
  /** External GAM CLI. Defaults to `$GAM_CLI` when set. Called as `<cli> check --json <artifact>`. */
  cliPath?: string;
  /** Fail with NOT_RUN instead of falling back to the built-in engine when the CLI is unavailable. */
  requireCli?: boolean;
  /** Build the CLI arguments; default `['check', '--json', artifactPath]`. */
  cliArgs?: (artifactPath: string, obligation: Obligation) => string[];
  runCommand?: CommandRunner;
}

export const GAM_BUILTIN_VERSION = 'wazir-gam-builtin/1.0.0';

const defaultRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown }) | null;
      if (e && typeof e.code === 'string') {
        resolve({ exitCode: null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), spawnError: e.code });
        return;
      }
      resolve({
        exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: Boolean(e?.killed && e.signal === 'SIGTERM'),
      });
    });
  });

export class GamAdapter implements SolverAdapter {
  readonly tool = 'gam' as const;
  private readonly cliPath?: string;
  private readonly requireCli: boolean;
  private readonly runCommand: CommandRunner;
  private readonly cliArgs: (artifactPath: string, obligation: Obligation) => string[];

  constructor(options: GamAdapterOptions = {}) {
    this.cliPath = options.cliPath ?? process.env.GAM_CLI ?? undefined;
    this.requireCli = options.requireCli ?? false;
    this.runCommand = options.runCommand ?? defaultRunner;
    this.cliArgs = options.cliArgs ?? ((p) => ['check', '--json', p]);
  }

  async checkAvailability(): Promise<ToolAvailability> {
    if (this.cliPath) {
      const r = await this.runCommand(this.cliPath, ['--version'], { timeoutMs: 10_000 });
      if (!r.spawnError && r.exitCode === 0) return { available: true, version: r.stdout.trim() || 'unknown', path: this.cliPath };
      if (this.requireCli) return { available: false, version: 'unknown', path: this.cliPath };
    } else if (this.requireCli) {
      return { available: false, version: 'unknown' };
    }
    return { available: true, version: GAM_BUILTIN_VERSION };
  }

  async verify(obligation: Obligation, workspaceRev: string, options: VerifyOptions = {}): Promise<VerificationResult> {
    const started = Date.now();
    const base = (verdict: Verdict, extra: Partial<VerificationResult> = {}): VerificationResult => ({
      verdict,
      tool: this.tool,
      toolVersion: GAM_BUILTIN_VERSION,
      scope: obligation.scope,
      assumptions: obligation.assumptions,
      elapsedMs: Date.now() - started,
      inputHash: sha256(`${obligation.specHash}\u0000${workspaceRev}\u0000`),
      ...extra,
      metadata: { workspaceRev, ...extra.metadata },
    });

    // 1. Artifact
    const inline = obligation.metadata?.galJson;
    let text: string;
    let artifactPath: string | undefined;
    if (inline !== undefined) {
      text = typeof inline === 'string' ? inline : JSON.stringify(inline);
    } else {
      if (!obligation.artifactPath) return base(Verdict.NOT_RUN, { metadata: { reason: 'no GAL-JSON artifact' } });
      artifactPath = path.resolve(options.workspaceDir ?? process.cwd(), obligation.artifactPath);
      try {
        text = await readFile(artifactPath, 'utf8');
      } catch (err) {
        return base(Verdict.NOT_RUN, { metadata: { reason: `artifact not readable: ${(err as Error).message}`, artifactPath } });
      }
    }
    const inputHash = sha256(`${obligation.specHash}\u0000${workspaceRev}\u0000${text}`);

    // 2. Parse
    let gal: GalCase;
    try {
      gal = parseGalJson(text);
    } catch (err) {
      return base(Verdict.ERROR, { inputHash, stderr: (err as Error).message, metadata: { reason: 'GAL-JSON parse error' } });
    }

    // 3. Assumptions Φ_L alone
    const assumptions = checkLawAssumptions(gal);
    if (assumptions.inconsistent) {
      return base(Verdict.INCONSISTENT_ASSUMPTIONS, {
        inputHash,
        vacuityProbe: { passed: false, reason: assumptions.reason, details: assumptions.details },
        metadata: { reason: assumptions.reason },
      });
    }

    const model = new GamModel([{ model: gal.law, origin: 'law' }, { model: gal.enterprise, origin: 'enterprise' }]);
    const probe = vacuityProbe(gal, model);
    let alloyTwin: string | undefined;
    try {
      alloyTwin = emitAlloyTwin(gal, { moduleName: gal.moduleName ?? obligation.id });
    } catch {
      alloyTwin = undefined;
    }

    // 4. External CLI
    const useCli = Boolean(this.cliPath) && (this.requireCli || obligation.metadata?.useCli !== false);
    if (this.requireCli && !this.cliPath) {
      return base(Verdict.NOT_RUN, { inputHash, metadata: { reason: 'GAM CLI required but not configured' } });
    }
    if (useCli) {
      const cliResult = await this.runCli(obligation, gal, text, artifactPath, options);
      if (cliResult) {
        return base(cliResult.verdict === Verdict.BOUNDED_PASS ? applyVacuityProbe(cliResult.verdict, probe) : cliResult.verdict, {
          inputHash, vacuityProbe: probe, ...cliResult.extra,
          metadata: { ...cliResult.extra.metadata, engine: 'cli', alloyTwin },
        });
      }
      if (this.requireCli) return base(Verdict.NOT_RUN, { inputHash, metadata: { reason: `GAM CLI unavailable at ${this.cliPath}` } });
    }

    // 5. Built-in engine
    const con = new ConsistencyChecker().checkModel(model);
    const onto = new OntologyChecker().checkModel(model, gal.law.ontologyRequirements ?? [], gal.law.scenarioRequirements ?? []);
    const raw = mapNativeOutcomeToVerdict({ tool: 'gam', consistent: con.consistent, satisfied: onto.satisfied });
    const verdict = applyVacuityProbe(raw, probe);
    const witness =
      raw === Verdict.COUNTEREXAMPLE ? { consistencyViolations: con.violations, ontologyViolations: onto.violations } : undefined;
    return base(verdict, {
      inputHash,
      witness,
      vacuityProbe: probe,
      metadata: {
        engine: 'builtin',
        consistent: con.consistent,
        satisfied: onto.satisfied,
        stats: con.stats,
        ontologyChecked: onto.checked,
        alloyTwin,
      },
    });
  }

  private async runCli(
    obligation: Obligation,
    gal: GalCase,
    text: string,
    artifactPath: string | undefined,
    options: VerifyOptions,
  ): Promise<{ verdict: Verdict; extra: Partial<VerificationResult> } | undefined> {
    const target = artifactPath ?? '-';
    const r = await this.runCommand(this.cliPath!, this.cliArgs(target, obligation), {
      timeoutMs: options.timeoutMs ?? obligation.timeoutMs,
      cwd: options.workspaceDir,
    });
    if (r.spawnError) return undefined;
    const io = { stdout: r.stdout, stderr: r.stderr };
    if (r.timedOut) return { verdict: Verdict.UNKNOWN, extra: { ...io, metadata: { reason: 'GAM CLI timeout' } } };
    let out: any;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      return { verdict: Verdict.ERROR, extra: { ...io, metadata: { reason: `GAM CLI produced non-JSON output (exit ${r.exitCode})` } } };
    }
    const consistent: boolean | undefined = out?.consistency?.consistent ?? out?.consistent;
    const satisfied: boolean | undefined = out?.ontology?.satisfied ?? out?.satisfied;
    if (typeof consistent !== 'boolean') {
      return { verdict: Verdict.ERROR, extra: { ...io, metadata: { reason: 'GAM CLI output lacks `consistent`' } } };
    }
    const verdict = mapNativeOutcomeToVerdict({ tool: 'gam', consistent, satisfied: typeof satisfied === 'boolean' ? satisfied : undefined });
    const witness =
      verdict === Verdict.COUNTEREXAMPLE
        ? {
            consistencyViolations: out?.consistency?.violations ?? out?.violations ?? [],
            ontologyViolations: out?.ontology?.violations ?? out?.ontologyViolations ?? [],
          }
        : undefined;
    return { verdict, extra: { ...io, witness, toolVersion: String(out?.version ?? 'gam-cli'), metadata: { consistent, satisfied } } };
  }
}

function sha256(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex')}`;
}
