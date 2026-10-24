import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_VERDICTS,
  AssuranceRecord as ContractAssuranceRecord,
  FormalTool,
  LedgerEntry as ContractLedgerEntry,
  PropertyAssuranceSummary,
  RefinementMap,
  RefinementMappingEntry,
  RefinementProductionMode,
  ReleaseGateResult,
  RuntimeMonitorStatus,
  SpecManifest,
  Verdict,
} from './contracts';
import type { LedgerEntry } from './ledger';
import {
  aggregateVerdictsWeakestLink,
  applyTrustedBaseGaps,
  capImplementationVerdict,
  evaluateReleaseGate,
  isPassingVerdict,
  preventNotFalsifiedPromotion,
} from './verdict';

export const DEFAULT_NON_CLAIMS = [
  'perception_correctness',
  'physical_dynamics_fidelity',
  'real_world_safety',
  'unbounded_temporal_liveness',
] as const;

export type DefaultNonClaim = (typeof DEFAULT_NON_CLAIMS)[number];

export interface AssuranceRecord extends ContractAssuranceRecord {
  /** Explicit non-claims required by FORMAL_ASSURANCE.md §2.7. */
  non_claims: string[];
  /** Alias for `non_claims` ("what is not claimed"). */
  not_claimed: string[];
}

export interface PortableEvidence {
  evidence_id: string;
  skill: 'z3' | 'dafny' | 'scenic' | 'verifai';
  requirement_id: string;
  property_id: string;
  specification_revision: string;
  specification_approval?: 'REVIEWED' | 'PENDING' | 'REJECTED';
  jurisdiction?: string | null;
  normative_sources?: string[];
  workspace_id: string;
  workspace_revision: number | string;
  source_commit: string;
  tool_version: string;
  simulator_version?: string | null;
  status: Verdict | `${Verdict}`;
  scope: string;
  assumptions: string[];
  limitations?: string[];
  command: string;
  exit_code?: number | null;
  elapsed_ms?: number | null;
  counterexample?: Record<string, unknown> | null;
  seed?: number | null;
  sample_counts?: Record<string, number>;
  artifacts: Array<{ path: string; sha256: string }>;
}

export type AnyLedgerEntry = ContractLedgerEntry | LedgerEntry;

export interface GenerateAssuranceRecordInput {
  component: string;
  version?: string;
  sourceCommit: string;
  ledgerEntries: readonly AnyLedgerEntry[];
  specs?: readonly SpecManifest[];
  refinement?: RefinementMap | readonly RefinementMappingEntry[];
  regressionObligations?: number | Record<string, number>;
  counterexamplesFound?: number;
  runtimeMonitors?: Record<string, RuntimeMonitorStatus> | RuntimeMonitorStatus;
  assumptions?: readonly string[];
  trustedBase?: readonly string[];
  coverageLimits?: readonly string[];
  nonClaims?: readonly string[];
  notClaimed?: readonly string[];
  /**
   * Optional explicit level overrides per property, guarded by preventNotFalsifiedPromotion
   * so NOT_FALSIFIED can never be promoted to PROVED or BOUNDED_PASS.
   */
  levelOverrides?: Record<
    string,
    Partial<
      Pick<
        PropertyAssuranceSummary,
        'specification_consistency' | 'decision_envelope' | 'implementation_contract' | 'simulation_falsification'
      >
    >
  >;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  target?: 'evidence' | 'record';
}

function uniqueStrings(items: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

function resolveRefinementEntries(
  component: string,
  refinement?: RefinementMap | readonly RefinementMappingEntry[],
): RefinementMappingEntry[] {
  if (!refinement) return [];
  if (Array.isArray(refinement)) return [...refinement];
  const map = refinement as RefinementMap;
  if (map.component && map.component !== component) return [];
  return [...(map.mappings ?? [])];
}

function resolveRegressionCount(regressionObligations?: number | Record<string, number>): number {
  if (typeof regressionObligations === 'number') {
    return Number.isInteger(regressionObligations) && regressionObligations >= 0 ? regressionObligations : 0;
  }
  if (regressionObligations && typeof regressionObligations === 'object') {
    return Object.values(regressionObligations).reduce(
      (sum, v) => sum + (Number.isInteger(v) && v > 0 ? v : 0),
      0,
    );
  }
  return 0;
}

function isSimulationTool(tool: FormalTool): boolean {
  return tool === 'verifai' || tool === 'scenic';
}

/**
 * Guard any verdict coming from simulation tools or transitions so NOT_FALSIFIED
 * is never promoted to PROVED or BOUNDED_PASS (§2.1 / §2.7).
 */
function guardSimulationVerdict(tool: FormalTool, verdict: Verdict): Verdict {
  if (isSimulationTool(tool) && isPassingVerdict(verdict)) {
    return preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, verdict);
  }
  return verdict;
}

function extractEntryTrustedGaps(entry: AnyLedgerEntry): string[] {
  const metaGaps = entry.metadata?.trustedBaseGaps;
  if (Array.isArray(metaGaps)) {
    return metaGaps.filter((g): g is string => typeof g === 'string' && g.trim().length > 0);
  }
  return [];
}

function formatSpecVersion(spec?: SpecManifest, fallbackEntry?: AnyLedgerEntry): string {
  const version =
    spec?.version ??
    (fallbackEntry && 'specVersion' in fallbackEntry && typeof fallbackEntry.specVersion === 'string'
      ? fallbackEntry.specVersion
      : 'unknown');
  const hash = spec?.content_hash ?? fallbackEntry?.specHash;
  return hash ? `${version} (${hash})` : version;
}

/**
 * Generate a machine-readable AssuranceRecord for a component and sourceCommit (§2.7).
 */
export function generateAssuranceRecord(input: GenerateAssuranceRecordInput): AssuranceRecord {
  const component = input.component.trim();
  const version = (input.version ?? '0.1.0').trim();
  const sourceCommit = input.sourceCommit.trim();
  if (!component) throw new Error('AssuranceRecord requires a non-empty component name');
  if (!sourceCommit) throw new Error('AssuranceRecord requires a non-empty sourceCommit');

  const specsById = new Map<string, SpecManifest>();
  for (const spec of input.specs ?? []) {
    specsById.set(spec.id, spec);
  }

  const mappings = resolveRefinementEntries(component, input.refinement);
  const mappingByProp = new Map<string, RefinementMappingEntry>();
  for (const m of mappings) {
    mappingByProp.set(m.property, m);
  }

  // All entries matching this sourceCommit (for current verdicts), plus all entries for counterexample history.
  const commitEntries = input.ledgerEntries.filter((e) => e.sourceCommit === sourceCommit);

  const propertyIds = new Set<string>();
  for (const spec of specsById.values()) propertyIds.add(spec.id);
  for (const m of mappings) propertyIds.add(m.property);
  for (const e of commitEntries) propertyIds.add(e.propertyId);

  const collectedAssumptions: string[] = [...(input.assumptions ?? [])];
  const collectedTrustedBase: string[] = [
    'z3_solver',
    'alloy_analyzer',
    'dafny_verifier',
    ...(input.trustedBase ?? []),
  ];
  const collectedCoverageLimits: string[] = [...(input.coverageLimits ?? [])];

  const properties: Record<string, PropertyAssuranceSummary> = {};
  const gateVerdicts: Verdict[] = [];
  let allSpecsApproved = propertyIds.size > 0;

  for (const propId of [...propertyIds].sort()) {
    const spec = specsById.get(propId);
    const propEntries = commitEntries.filter((e) => e.propertyId === propId);
    const mapping = mappingByProp.get(propId);

    if (spec) {
      collectedAssumptions.push(...spec.assumptions);
      if (spec.status !== 'approved' || (spec.reviewers?.length ?? 0) === 0) {
        allSpecsApproved = false;
      }
      for (const art of spec.artifacts) {
        if (art.scope) {
          collectedCoverageLimits.push(`${propId}:${art.tool}:scope=${art.scope}`);
        }
      }
    } else {
      // If no spec manifest was provided, inspect entries; if no entry exists either, spec is not approved.
      if (propEntries.length === 0) {
        allSpecsApproved = false;
      }
    }

    for (const e of propEntries) {
      collectedAssumptions.push(...(e.assumptions ?? []));
      if (e.scope) {
        collectedCoverageLimits.push(`${propId}:${e.tool}:scope=${e.scope}`);
      }
      if (e.bounds) {
        collectedCoverageLimits.push(`${propId}:${e.tool}:bounds=${e.bounds}`);
      }
      if (typeof e.steps === 'number') {
        collectedCoverageLimits.push(`${propId}:${e.tool}:steps=${e.steps}`);
      }
      for (const gap of extractEntryTrustedGaps(e)) {
        collectedTrustedBase.push(`${propId}:${e.tool}:${gap}`);
      }
    }

    // Group entries by assurance level
    const specConsistencyEntries = propEntries.filter((e) => e.tool === 'alloy' || e.tool === 'gam');
    const decisionEnvelopeEntries = propEntries.filter((e) => e.tool === 'z3');
    const implContractEntries = propEntries.filter((e) => e.tool === 'dafny');
    const simFalsificationEntries = propEntries.filter((e) => e.tool === 'verifai' || e.tool === 'scenic');

    const notes: string[] = [];

    // 1. specification_consistency (Alloy / GAM)
    let specificationConsistency: Verdict | undefined;
    if (specConsistencyEntries.length > 0) {
      const verdicts = specConsistencyEntries.map((e) => {
        // Alloy check is always bounded; never promote to PROVED unless GAM or explicit bounded pass
        if (e.tool === 'alloy' && e.verdict === Verdict.PROVED) {
          return Verdict.BOUNDED_PASS;
        }
        return e.verdict;
      });
      specificationConsistency = aggregateVerdictsWeakestLink(verdicts);
      for (const e of specConsistencyEntries) {
        if (e.scope) notes.push(`${e.tool}: scope ${e.scope}`);
      }
    } else if (spec?.artifacts.some((a) => a.tool === 'alloy' || a.tool === 'gam')) {
      specificationConsistency = Verdict.NOT_RUN;
    }

    // 2. decision_envelope (Z3)
    let decisionEnvelope: Verdict | undefined;
    if (decisionEnvelopeEntries.length > 0) {
      decisionEnvelope = aggregateVerdictsWeakestLink(decisionEnvelopeEntries.map((e) => e.verdict));
    } else if (spec?.artifacts.some((a) => a.tool === 'z3')) {
      decisionEnvelope = Verdict.NOT_RUN;
    }

    // 3. implementation_contract (Dafny + refinement mapping)
    let implementationContract: Verdict | undefined;
    const productionMode: RefinementProductionMode | undefined = mapping?.production;
    if (implContractEntries.length > 0) {
      const rawVerdicts = implContractEntries.map((e) => {
        const gaps = extractEntryTrustedGaps(e);
        return applyTrustedBaseGaps(e.verdict, gaps);
      });
      const modelVerdict = aggregateVerdictsWeakestLink(rawVerdicts);
      implementationContract =
        productionMode !== undefined ? capImplementationVerdict(modelVerdict, productionMode) : modelVerdict;
      if (productionMode) {
        notes.push(`dafny: ${productionMode}`);
      }
    } else if (mapping) {
      implementationContract =
        productionMode === 'contract_tests' || productionMode === 'none' ? Verdict.NOT_VERIFIED : Verdict.NOT_RUN;
    } else if (spec?.artifacts.some((a) => a.tool === 'dafny')) {
      implementationContract = Verdict.NOT_RUN;
    }

    // 4. simulation_falsification (VerifAI / Scenic) — NEVER promoted to PROVED or BOUNDED_PASS
    let simulationFalsification: Verdict | undefined;
    if (simFalsificationEntries.length > 0) {
      const simVerdicts = simFalsificationEntries.map((e) => guardSimulationVerdict(e.tool, e.verdict));
      simulationFalsification = aggregateVerdictsWeakestLink(simVerdicts);
      if (isPassingVerdict(simulationFalsification)) {
        // Double lock: simulation falsification can never be PROVED or BOUNDED_PASS
        preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, simulationFalsification);
      }
      collectedCoverageLimits.push(`${propId}:simulation_falsification_is_bounded_sampling_not_proof`);
      for (const e of simFalsificationEntries) {
        const seeds = e.seeds ?? ('seed' in e && typeof e.seed === 'number' ? [e.seed] : []);
        if (seeds.length > 0) {
          notes.push(`${e.tool}: seeds=${seeds.join(',')}`);
        }
      }
    } else if (
      spec?.monitors?.some((m) => m.tool === 'verifai' || m.tool === 'scenic') ||
      spec?.artifacts.some((a) => a.tool === 'verifai' || a.tool === 'scenic')
    ) {
      simulationFalsification = Verdict.NOT_RUN;
    }

    // Apply optional level overrides while enforcing preventNotFalsifiedPromotion
    const overrides = input.levelOverrides?.[propId];
    if (overrides) {
      if (overrides.specification_consistency !== undefined) {
        if (specificationConsistency === Verdict.NOT_FALSIFIED) {
          preventNotFalsifiedPromotion(specificationConsistency, overrides.specification_consistency);
        }
        specificationConsistency = overrides.specification_consistency;
      }
      if (overrides.decision_envelope !== undefined) {
        if (decisionEnvelope === Verdict.NOT_FALSIFIED) {
          preventNotFalsifiedPromotion(decisionEnvelope, overrides.decision_envelope);
        }
        decisionEnvelope = overrides.decision_envelope;
      }
      if (overrides.implementation_contract !== undefined) {
        if (implementationContract === Verdict.NOT_FALSIFIED) {
          preventNotFalsifiedPromotion(implementationContract, overrides.implementation_contract);
        }
        implementationContract = overrides.implementation_contract;
      }
      if (overrides.simulation_falsification !== undefined) {
        const currentSim = simulationFalsification ?? Verdict.NOT_FALSIFIED;
        preventNotFalsifiedPromotion(currentSim, overrides.simulation_falsification);
        if (isPassingVerdict(overrides.simulation_falsification)) {
          preventNotFalsifiedPromotion(Verdict.NOT_FALSIFIED, overrides.simulation_falsification);
        }
        simulationFalsification = overrides.simulation_falsification;
      }
    }

    // Collect level verdicts for this property
    const levelVerdicts: Verdict[] = [];
    if (specificationConsistency !== undefined) levelVerdicts.push(specificationConsistency);
    if (decisionEnvelope !== undefined) levelVerdicts.push(decisionEnvelope);
    if (implementationContract !== undefined) levelVerdicts.push(implementationContract);
    if (simulationFalsification !== undefined) levelVerdicts.push(simulationFalsification);

    // Also include any other tools/entries for this property not covered above
    for (const e of propEntries) {
      const v = guardSimulationVerdict(e.tool, e.verdict);
      if (!levelVerdicts.includes(v)) {
        levelVerdicts.push(v);
      }
    }

    if (spec && (spec.status !== 'approved' || (spec.reviewers?.length ?? 0) === 0)) {
      levelVerdicts.push(Verdict.SPECIFICATION_REVIEW_REQUIRED);
    }

    const overall = aggregateVerdictsWeakestLink(levelVerdicts);
    if (levelVerdicts.length === 0) {
      gateVerdicts.push(Verdict.NOT_RUN);
    } else {
      gateVerdicts.push(...levelVerdicts);
    }

    const runtimeMonitor: RuntimeMonitorStatus =
      typeof input.runtimeMonitors === 'string'
        ? input.runtimeMonitors
        : (input.runtimeMonitors?.[propId] ?? (spec?.monitors && spec.monitors.length > 0 ? 'ENABLED' : 'NOT_DEPLOYED'));

    const summary: PropertyAssuranceSummary = {
      spec_version: formatSpecVersion(spec, propEntries[0]),
      runtime_monitor: runtimeMonitor,
      overall,
    };
    const specHash = spec?.content_hash ?? propEntries[0]?.specHash;
    if (specHash) summary.spec_hash = specHash;
    if (specificationConsistency !== undefined) summary.specification_consistency = specificationConsistency;
    if (decisionEnvelope !== undefined) summary.decision_envelope = decisionEnvelope;
    if (implementationContract !== undefined) summary.implementation_contract = implementationContract;
    if (simulationFalsification !== undefined) summary.simulation_falsification = simulationFalsification;
    if (notes.length > 0) summary.notes = uniqueStrings(notes);

    properties[propId] = summary;
  }

  // Count counterexamples across all provided ledger entries (including prior repair iterations) if not overridden
  const counterexamplesFound =
    typeof input.counterexamplesFound === 'number' &&
    Number.isInteger(input.counterexamplesFound) &&
    input.counterexamplesFound >= 0
      ? input.counterexamplesFound
      : input.ledgerEntries.filter(
          (e) => e.verdict === Verdict.COUNTEREXAMPLE || e.verdict === Verdict.FALSIFIED,
        ).length;

  const regressionObligations = resolveRegressionCount(input.regressionObligations);

  const nonClaims = uniqueStrings([
    ...DEFAULT_NON_CLAIMS,
    ...(input.nonClaims ?? []),
    ...(input.notClaimed ?? []),
  ]);

  const releaseGate: ReleaseGateResult = evaluateReleaseGate(gateVerdicts, allSpecsApproved);

  return {
    component,
    version,
    source_commit: sourceCommit,
    properties,
    assumptions: uniqueStrings(collectedAssumptions),
    trusted_base: uniqueStrings(collectedTrustedBase),
    coverage_limits: uniqueStrings(collectedCoverageLimits),
    non_claims: nonClaims,
    not_claimed: [...nonClaims],
    counterexamples_found: counterexamplesFound,
    regression_obligations: regressionObligations,
    release_gate: releaseGate,
  };
}

/**
 * Convert a LedgerEntry (and optional SpecManifest) into a portable evidence object
 * conforming to `skills/formal/evidence.schema.json`.
 */
export function ledgerEntryToPortableEvidence(
  entry: AnyLedgerEntry,
  options: {
    evidenceId?: string;
    requirementId?: string;
    workspaceId?: string;
    command?: string;
    spec?: SpecManifest;
    limitations?: string[];
  } = {},
): PortableEvidence {
  const skillMap: Record<FormalTool, PortableEvidence['skill']> = {
    z3: 'z3',
    dafny: 'dafny',
    scenic: 'scenic',
    verifai: 'verifai',
    alloy: 'z3',
    gam: 'z3',
  };
  const skill = skillMap[entry.tool] ?? 'z3';
  const verdict = guardSimulationVerdict(entry.tool, entry.verdict);
  const specRevision =
    options.spec?.version ??
    ('specVersion' in entry && typeof entry.specVersion === 'string' ? entry.specVersion : entry.specHash || '1.0');

  const artifacts = Object.entries(entry.artifactHashes ?? {}).map(([path, sha256]) => ({
    path,
    sha256: /^[a-f0-9]{64}$/.test(sha256) ? sha256 : '0'.repeat(64),
  }));

  const portable: PortableEvidence = {
    evidence_id: options.evidenceId ?? `${entry.propertyId}-${entry.tool}-${entry.index}`,
    skill,
    requirement_id: options.requirementId ?? entry.propertyId,
    property_id: entry.propertyId,
    specification_revision: specRevision,
    workspace_id: options.workspaceId ?? 'wazir-default',
    workspace_revision: entry.workspaceRev || '0',
    source_commit: entry.sourceCommit,
    tool_version: entry.toolVersion,
    status: verdict,
    scope: entry.scope ?? 'default',
    assumptions: [...(entry.assumptions ?? [])],
    command: options.command ?? `${entry.tool} verify`,
    artifacts,
  };

  if (options.spec) {
    portable.specification_approval =
      options.spec.status === 'approved' || options.spec.status === 'reviewed' ? 'REVIEWED' : 'PENDING';
    portable.jurisdiction = options.spec.source?.jurisdiction ?? null;
    if (options.spec.source?.normative_ref) {
      portable.normative_sources = [options.spec.source.normative_ref];
    }
  }
  if (options.limitations) {
    portable.limitations = [...options.limitations];
  }
  if (typeof entry.elapsedMs === 'number' && entry.elapsedMs >= 0) {
    portable.elapsed_ms = entry.elapsedMs;
  }
  const seed = 'seed' in entry && typeof entry.seed === 'number' ? entry.seed : entry.seeds?.[0];
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    portable.seed = seed;
  }
  if (entry.witness && typeof entry.witness === 'object' && !Array.isArray(entry.witness)) {
    portable.counterexample = entry.witness as Record<string, unknown>;
  }
  return portable;
}

// ---------------------------------------------------------------------------
// Schema validation against skills/formal/evidence.schema.json & AssuranceRecord
// ---------------------------------------------------------------------------

interface JsonSchemaProperty {
  type?: string | string[];
  minLength?: number;
  minimum?: number;
  enum?: string[];
  pattern?: string;
  items?: JsonSchemaProperty;
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean | JsonSchemaProperty;
}

interface JsonSchema extends JsonSchemaProperty {
  $schema?: string;
  $id?: string;
  title?: string;
}

function findDefaultEvidenceSchemaPath(): string | undefined {
  const candidates: string[] = [
    resolve(process.cwd(), 'skills/formal/evidence.schema.json'),
    resolve(__dirname, '../../../skills/formal/evidence.schema.json'),
    resolve(__dirname, '../../../../skills/formal/evidence.schema.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function matchesJsonType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

function validateNodeAgainstSchema(
  value: unknown,
  schema: JsonSchemaProperty,
  path: string,
  errors: string[],
): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesJsonType(value, t))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${value === null ? 'null' : typeof value}`);
      return;
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value as string)) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: string does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: number ${value} < minimum ${schema.minimum}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validateNodeAgainstSchema(value[i], schema.items, `${path}[${i}]`, errors);
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const reqKey of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(obj, reqKey) || obj[reqKey] === undefined) {
          errors.push(`${path}: missing required property '${reqKey}'`);
        }
      }
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateNodeAgainstSchema(v, props[k], `${path}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected additional property '${k}'`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNodeAgainstSchema(v, schema.additionalProperties, `${path}.${k}`, errors);
      }
    }
  }
}

function isAssuranceRecordCandidate(value: Record<string, unknown>): boolean {
  return (
    'component' in value &&
    'properties' in value &&
    'release_gate' in value &&
    !('evidence_id' in value)
  );
}

function validateAssuranceRecordShape(
  record: Record<string, unknown>,
  allowedVerdicts: readonly string[],
): SchemaValidationResult {
  const errors: string[] = [];
  const nonEmptyString = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const stringArray = (v: unknown) => Array.isArray(v) && v.every((item) => typeof item === 'string' && item.trim().length > 0);

  if (!nonEmptyString(record.component)) {
    errors.push('$.component: must be a non-empty string');
  }
  if (!nonEmptyString(record.version)) {
    errors.push('$.version: must be a non-empty string');
  }
  if (!nonEmptyString(record.source_commit)) {
    errors.push('$.source_commit: must be a non-empty string');
  }
  if (!Array.isArray(record.assumptions) || !record.assumptions.every((x) => typeof x === 'string')) {
    errors.push('$.assumptions: must be an array of strings');
  }
  if (!Array.isArray(record.trusted_base) || !record.trusted_base.every((x) => typeof x === 'string')) {
    errors.push('$.trusted_base: must be an array of strings');
  }
  if (!Array.isArray(record.coverage_limits) || !record.coverage_limits.every((x) => typeof x === 'string')) {
    errors.push('$.coverage_limits: must be an array of strings');
  }

  // Validate explicit non-claims (§2.7)
  const nonClaims = record.non_claims ?? record.not_claimed;
  if (!stringArray(nonClaims)) {
    errors.push('$.non_claims: must be a non-empty array of strings stating what is not claimed');
  } else {
    for (const requiredNonClaim of DEFAULT_NON_CLAIMS) {
      if (!(nonClaims as string[]).includes(requiredNonClaim)) {
        errors.push(`$.non_claims: missing required default non-claim '${requiredNonClaim}'`);
      }
    }
  }
  if (record.non_claims !== undefined && !stringArray(record.non_claims)) {
    errors.push('$.non_claims: must be an array of non-empty strings');
  }
  if (record.not_claimed !== undefined && !stringArray(record.not_claimed)) {
    errors.push('$.not_claimed: must be an array of non-empty strings');
  }

  if (typeof record.counterexamples_found !== 'number' || !Number.isInteger(record.counterexamples_found) || record.counterexamples_found < 0) {
    errors.push('$.counterexamples_found: must be a non-negative integer');
  }
  if (typeof record.regression_obligations !== 'number' || !Number.isInteger(record.regression_obligations) || record.regression_obligations < 0) {
    errors.push('$.regression_obligations: must be a non-negative integer');
  }

  // Validate properties
  const allLevelVerdicts: Verdict[] = [];
  if (!record.properties || typeof record.properties !== 'object' || Array.isArray(record.properties)) {
    errors.push('$.properties: must be an object mapping property IDs to summaries');
  } else {
    const props = record.properties as Record<string, unknown>;
    for (const [propId, rawSummary] of Object.entries(props)) {
      if (!rawSummary || typeof rawSummary !== 'object' || Array.isArray(rawSummary)) {
        errors.push(`$.properties.${propId}: must be an object`);
        continue;
      }
      const summary = rawSummary as Record<string, unknown>;
      if (!nonEmptyString(summary.spec_version)) {
        errors.push(`$.properties.${propId}.spec_version: must be a non-empty string`);
      }
      const levelFields = [
        'specification_consistency',
        'decision_envelope',
        'implementation_contract',
        'simulation_falsification',
        'overall',
      ] as const;
      for (const field of levelFields) {
        const val = summary[field];
        if (val !== undefined) {
          if (typeof val !== 'string' || !allowedVerdicts.includes(val)) {
            errors.push(`$.properties.${propId}.${field}: invalid verdict ${JSON.stringify(val)}`);
          } else if (field !== 'overall') {
            allLevelVerdicts.push(val as Verdict);
          }
        }
      }
      // Hard rule: simulation_falsification can NEVER be PROVED or BOUNDED_PASS
      if (
        summary.simulation_falsification === Verdict.PROVED ||
        summary.simulation_falsification === Verdict.BOUNDED_PASS
      ) {
        errors.push(
          `$.properties.${propId}.simulation_falsification: NOT_FALSIFIED/simulation cannot be promoted to ${summary.simulation_falsification}`,
        );
      }
      // Hard rule: specification_consistency (Alloy) cannot be PROVED if overall is weaker
      if (
        summary.overall !== undefined &&
        typeof summary.overall === 'string' &&
        allowedVerdicts.includes(summary.overall)
      ) {
        const presentLevels = (
          ['specification_consistency', 'decision_envelope', 'implementation_contract', 'simulation_falsification'] as const
        )
          .map((f) => summary[f])
          .filter((v): v is Verdict => typeof v === 'string' && allowedVerdicts.includes(v));
        if (
          presentLevels.includes(Verdict.NOT_FALSIFIED) &&
          presentLevels.length === 1 &&
          isPassingVerdict(summary.overall as Verdict)
        ) {
          errors.push(
            `$.properties.${propId}.overall: NOT_FALSIFIED cannot be promoted to ${summary.overall}`,
          );
        }
      }
      if (
        summary.runtime_monitor !== undefined &&
        summary.runtime_monitor !== 'ENABLED' &&
        summary.runtime_monitor !== 'NOT_DEPLOYED'
      ) {
        errors.push(
          `$.properties.${propId}.runtime_monitor: expected 'ENABLED' | 'NOT_DEPLOYED', got ${JSON.stringify(summary.runtime_monitor)}`,
        );
      }
    }
  }

  // Validate release_gate
  if (!record.release_gate || typeof record.release_gate !== 'object' || Array.isArray(record.release_gate)) {
    errors.push('$.release_gate: must be an object with status PASS | FAIL');
  } else {
    const gate = record.release_gate as Record<string, unknown>;
    if (gate.status !== 'PASS' && gate.status !== 'FAIL') {
      errors.push(`$.release_gate.status: expected 'PASS' | 'FAIL', got ${JSON.stringify(gate.status)}`);
    }
    if (gate.reason !== undefined && typeof gate.reason !== 'string') {
      errors.push('$.release_gate.reason: must be a string when present');
    }
    // Hard rule: if only NOT_FALSIFIED verdicts exist (no PROVED or BOUNDED_PASS), release_gate cannot be PASS
    if (gate.status === 'PASS') {
      if (allLevelVerdicts.length === 0 || !allLevelVerdicts.some(isPassingVerdict)) {
        errors.push('$.release_gate.status: cannot be PASS without PROVED or BOUNDED_PASS formal evidence (NOT_FALSIFIED is not a proof)');
      }
    }
  }

  return { valid: errors.length === 0, errors, target: 'record' };
}

/**
 * Validate a portable evidence object or an AssuranceRecord against `skills/formal/evidence.schema.json`
 * and the required AssuranceRecord invariants (§2.7).
 */
export function validateAgainstEvidenceSchema(
  evidenceOrRecord: unknown,
  schemaPath?: string,
): SchemaValidationResult {
  if (!evidenceOrRecord || typeof evidenceOrRecord !== 'object' || Array.isArray(evidenceOrRecord)) {
    return { valid: false, errors: ['$: expected a non-null object'] };
  }

  const resolvedPath = schemaPath ?? findDefaultEvidenceSchemaPath();
  let schema: JsonSchema | undefined;
  if (resolvedPath) {
    if (!existsSync(resolvedPath)) {
      return { valid: false, errors: [`$: schema file not found at ${resolvedPath}`] };
    }
    try {
      schema = JSON.parse(readFileSync(resolvedPath, 'utf8')) as JsonSchema;
    } catch (err) {
      return { valid: false, errors: [`$: failed to parse schema file: ${(err as Error).message}`] };
    }
  }

  const allowedVerdicts: readonly string[] =
    schema?.properties?.status?.enum ?? (ALL_VERDICTS as readonly string[]);

  const obj = evidenceOrRecord as Record<string, unknown>;
  if (isAssuranceRecordCandidate(obj)) {
    return validateAssuranceRecordShape(obj, allowedVerdicts);
  }

  const errors: string[] = [];
  if (schema) {
    validateNodeAgainstSchema(obj, schema, '$', errors);
  } else {
    // Fallback structural check if schema file was not located
    const required = [
      'evidence_id',
      'skill',
      'requirement_id',
      'property_id',
      'specification_revision',
      'workspace_id',
      'workspace_revision',
      'source_commit',
      'tool_version',
      'status',
      'scope',
      'assumptions',
      'command',
      'artifacts',
    ];
    for (const k of required) {
      if (!(k in obj)) errors.push(`$: missing required property '${k}'`);
    }
  }

  // Enforce NOT_FALSIFIED non-promotion on simulation skills (scenic, verifai)
  if ((obj.skill === 'scenic' || obj.skill === 'verifai') && (obj.status === Verdict.PROVED || obj.status === Verdict.BOUNDED_PASS)) {
    errors.push(`$.status: simulation skill '${obj.skill}' cannot claim '${obj.status}' (NOT_FALSIFIED cannot be promoted)`);
  }

  return { valid: errors.length === 0, errors, target: 'evidence' };
}

// ---------------------------------------------------------------------------
// YAML and JSON Serialization / Parsing
// ---------------------------------------------------------------------------

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (
      value === '' ||
      value === 'null' ||
      value === 'true' ||
      value === 'false' ||
      value === '~' ||
      /^\d+(\.\d+)?$/.test(value) ||
      /[:#[\]{},&*!|>'"%@`\r\n]/.test(value) ||
      value.startsWith(' ') ||
      value.endsWith(' ') ||
      value.startsWith('-')
    ) {
      return JSON.stringify(value);
    }
    return value;
  }
  return JSON.stringify(value);
}

function serializeYamlNode(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const nested = serializeYamlNode(item, indent + 2).trimStart();
          return `${pad}- ${nested}`;
        }
        return `${pad}- ${formatYamlScalar(item)}`;
      })
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const lines: string[] = [];
    for (const [key, val] of entries) {
      const safeKey = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
      if (Array.isArray(val)) {
        if (val.length === 0) {
          lines.push(`${pad}${safeKey}: []`);
        } else {
          lines.push(`${pad}${safeKey}:`);
          lines.push(serializeYamlNode(val, indent + 2));
        }
      } else if (val && typeof val === 'object') {
        const subEntries = Object.entries(val as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (subEntries.length === 0) {
          lines.push(`${pad}${safeKey}: {}`);
        } else {
          lines.push(`${pad}${safeKey}:`);
          lines.push(serializeYamlNode(val, indent + 2));
        }
      } else {
        lines.push(`${pad}${safeKey}: ${formatYamlScalar(val)}`);
      }
    }
    return lines.join('\n');
  }
  return `${pad}${formatYamlScalar(value)}`;
}

/** Serialize an AssuranceRecord to canonical JSON. */
export function serializeAssuranceRecordToJson(record: AssuranceRecord, pretty = true): string {
  return JSON.stringify(record, null, pretty ? 2 : undefined);
}

/** Serialize an AssuranceRecord to YAML (§2.7). */
export function serializeAssuranceRecordToYaml(record: AssuranceRecord): string {
  return serializeYamlNode(record, 0) + '\n';
}

/** Serialize an AssuranceRecord to either 'json' or 'yaml'. */
export function serializeAssuranceRecord(record: AssuranceRecord, format: 'json' | 'yaml' = 'yaml'): string {
  return format === 'json' ? serializeAssuranceRecordToJson(record) : serializeAssuranceRecordToYaml(record);
}

function parseSimpleYamlScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  return s;
}

/** Parse an AssuranceRecord from JSON or YAML text. */
export function parseAssuranceRecord(text: string): AssuranceRecord {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as AssuranceRecord;
  }
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith('#') && l.trim() !== '---');
  let pos = 0;

  function parseBlock(indent: number): unknown {
    const isSeq = lines[pos].trim().startsWith('- ');
    if (isSeq) {
      const arr: unknown[] = [];
      while (pos < lines.length) {
        const line = lines[pos];
        const lineIndent = line.search(/\S/);
        if (lineIndent < indent) break;
        if (lineIndent !== indent) throw new Error(`Invalid YAML indentation at line: ${line}`);
        const content = line.trim();
        if (!content.startsWith('- ')) break;
        pos++;
        const rest = content.slice(2).trim();
        arr.push(parseSimpleYamlScalar(rest));
      }
      return arr;
    }

    const obj: Record<string, unknown> = {};
    while (pos < lines.length) {
      const line = lines[pos];
      const lineIndent = line.search(/\S/);
      if (lineIndent < indent) break;
      if (lineIndent !== indent) throw new Error(`Invalid YAML indentation at line: ${line}`);
      const content = line.trim();
      const match = /^([^:]+):(?:\s+(.*))?$/.exec(content);
      if (!match) throw new Error(`Invalid YAML mapping line: ${line}`);
      pos++;
      const rawKey = match[1].trim();
      const key = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey;
      const valPart = match[2]?.trim() ?? '';
      if (valPart === '') {
        if (pos < lines.length && lines[pos].search(/\S/) > indent) {
          obj[key] = parseBlock(lines[pos].search(/\S/));
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseSimpleYamlScalar(valPart);
      }
    }
    return obj;
  }

  if (lines.length === 0) throw new Error('Empty YAML input');
  return parseBlock(lines[0].search(/\S/)) as AssuranceRecord;
}
