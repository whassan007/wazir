---
name: gam
description: Model, check, and explain legal/policy compliance with GAM (Governance Analysis Model). Use when writing or reviewing GAL-JSON law or enterprise models, running the consistency/ontology/scenario checkers, interpreting violations, emitting Alloy (.als) from GAL-JSON, or changing the engine in src/core. Covers the Φ formalism, polarity split, closure semantics, edge-direction conventions, and the pitfalls that silently produce wrong verdicts.
---

# GAM — Governance Analysis Model

GAM decides whether an **enterprise configuration** (Φ_E) is consistent with a **law or written policy** (Φ_L). Both are expressed in GAL-JSON over one shared vocabulary, merged into a single model, and checked over the **closure** of their relations — never over the declared relations alone.

It implements W. A. Hassan, *Validating Legal Compliance — Governance Analysis Method* (Ph.D., Ottawa, 2009), with the formal corrections in `docs/CORRECTIONS.md`. Formerly named *Regentic*; the deployed UI and README still say *GAT* in places — same project.

## The three ideas you must not get wrong

1. **One vocabulary.** Law and enterprise facts land in the *same* relations. Origin (`law` / `enterprise` / `both`) is kept only for provenance in reports. Never namespace identifiers by origin (`law:CPO` vs `enterprise:CPO`) — two formulas over disjoint variables are always jointly satisfiable, so no cross-model conflict can ever be found. This was the 1.x defect.
2. **Polarity.** Every policy relation has a permitted (+) and prohibited (−) part: `RA±, RU±, UP±, RP±, D±`. `Deny` is a fact, distinct from silence.
3. **Closure.** Conflicts are computed over *effective* access — role inheritance (`RR*`), process composition (`PP*`), and delegation. The interesting conflicts exist only there.

The canonical example (thesis Ch.7 Ex.2, `test/thesis-cases.test.js`): the law forbids `PrivDiv` from `AccessPI`; the enterprise grants it to `FinAdminAssistants`; one user acts in both roles. No role holds both permit and deny, so a per-relation diff finds nothing. `Con` fails with `ACTIVITY_CONFLICT` for `AdminAssistant1`.

## Formalism

```
Φ = ⟨P, A, R, U ; PP, PA, RR, S, X, RA±, RU±, UP±, RP±, D±⟩
```

| Symbol | Meaning | GAL-JSON |
|---|---|---|
| P, A, R, U | sorts: Process (trust zone), Activity (capability), Role (identity), User (principal) | `entities[].type` |
| PP | process composition, parent → child | `ComposedOf` |
| PA | process contains activity | `Contains` |
| RR | role inclusion, senior → junior (senior inherits junior) | `Includes` |
| S | activity succession | `Next` |
| X | separation of concerns, symmetric | `Separate` |
| RA± | role may / must not perform activity | `AssignedTo` (+) or policy `CanAssignTo` |
| RU± | user may / must not act in role | `Acts` (+) or policy `CanAct` |
| UP± | user may / must not enter process | `Assumes` (+) or policy `CanAssume` |
| RP± | role may / must not reach process | `Reaches` (+) or policy `CanReach` |
| D± | role may / must not delegate (activity, process, or ⊤) | policy `CanDelegate` |

`Con` is the conjunction of five checks (mirrors `pred Con` in `alloy/gam_core.als`):

| # | Condition | Violation type |
|---|---|---|
| 1 | RA* ∩ RA⁻ = ∅ | `ACTIVITY_CONFLICT` |
| 2 | RU⁺ ∩ RU⁻ = ∅ | `ROLE_OCCUPANCY_CONFLICT` |
| 3 | UP* ∩ UP⁻ = ∅ | `PROCESS_ACCESS_CONFLICT` |
| 4 | no user effectively reaches both sides of an X pair | `SEPARATION_VIOLATION` |
| 5 | no D⁺/D⁻ clash; delegation doesn't confer a prohibited activity | `DELEGATION_CONFLICT`, `DELEGATION_LAUNDERS_PROHIBITION` |

A user's effective activities `effAct(u)` = activities of every role in the downward closure of the roles they act in, plus activities delegated to those roles, plus activities inside every process they reach (via `Assumes`, `Reaches`, or delegation) at any composition depth.

## Three techniques — not interchangeable

| Technique | Module | Finds | Cannot find |
|---|---|---|---|
| Consistency `Con` | `src/core/consistency-checker.js` | permit/deny conflicts, separation breaches, unsound delegation | missing structure |
| Ontology check | `src/core/ontology-checker.js` | required activity/sub-role/sub-process absent at any depth (`ONTOLOGY_GAP`) | contradictions |
| Scenario check | `src/core/ontology-checker.js` | required or forbidden precedence over `Next⁺` (`SCENARIO_VIOLATION`) | structural gaps |

**Consistency is necessary, not sufficient, for compliance.** An absent safety step contradicts nothing — `Con` holds and only the ontology check reports it (Appendix B finding B2, thesis Ex.1b). Never claim "compliant" from a passing `Con` alone. Scope stance: consistency is validated; completeness is defined but not validated.

## Edge directions — the most common source of wrong models

Relations and policies do **not** use the same argument order. `src/core/model.js` `_ingest` is authoritative.

**Relations** (`relations[]`, all positive facts):

| type | source → target |
|---|---|
| `ComposedOf` | parent Process → child Process |
| `Contains` | Process → Activity |
| `Includes` | senior Role → junior Role |
| `Next` | Activity → following Activity |
| `Separate` | Process ↔ Process (order irrelevant) |
| `Acts` | **Role → User** |
| `Assumes` | User → Process |
| `AssignedTo` | Role → Activity |
| `Reaches` | Role → Process |

**Policies** (`policies[]`, carry polarity in `modality` or `allow_deny`: `"Allow"` | `"Deny"`):

| type | source | target | extra |
|---|---|---|---|
| `CanAssignTo` | **Activity** | **Role** | — |
| `CanAct` | **User** | **Role** | — |
| `CanAssume` | User | Process | — |
| `CanReach` | Role | Process | — |
| `CanDelegate` | from Role | to Role | `parameters.activity_or_process` (omit = unrestricted ⊤) |

So "role `PrivDiv` must not access PI" is
`{ "type": "CanAssignTo", "modality": "Deny", "source": "AccessPI", "target": "PrivDiv" }`
while "role `FinAdmin` may access PI" as a relation is
`{ "type": "AssignedTo", "source": "FinAdmin", "target": "AccessPI" }`.

## Minimal model

```js
import { ConsistencyChecker } from './src/core/consistency-checker.js';
import { OntologyChecker } from './src/core/ontology-checker.js';

const law = {                                    // Φ_L
  entities: [{ id: 'AccessPI', type: 'Activity' }, { id: 'PrivDiv', type: 'Role' }],
  policies: [{ type: 'CanAssignTo', modality: 'Deny', source: 'AccessPI', target: 'PrivDiv' }],
  ontologyRequirements: [                        // structural duties, read by OntologyChecker only
    { id: '4.1.2', process: 'Privacy', activity: 'ProvideCPOIdentity', rationale: '…' },
  ],
  scenarioRequirements: [                        // kind: 'precedence' | 'forbidden-precedence'
    { id: 'S1', kind: 'precedence', from: 'Collect', to: 'Notify', rationale: '…' },
  ],
};

const enterprise = {                             // Φ_E
  entities: [/* … */],
  relations: [
    { type: 'Includes',   source: 'FinDiv', target: 'FinAdmin' },
    { type: 'AssignedTo', source: 'FinAdmin', target: 'AccessPI' },
    { type: 'Acts',       source: 'PrivDiv',  target: 'Alice' },
    { type: 'Acts',       source: 'FinAdmin', target: 'Alice' },
  ],
  policies: [],
};

const r = new ConsistencyChecker().check(law, enterprise);
// r.consistent, r.violations[], r.minimalConflict (MUS labels), r.stats, r.model (GamModel)
const o = new OntologyChecker().check(law, enterprise);
// o.satisfied, o.violations[]
```

Each consistency violation carries a **witness**: `user`, the object (`activity` / `process` / `process1`+`process2` / `role`), and derivation paths (`grantedVia`, `prohibitedVia`, `reachedVia`) with provenance. When reporting a finding, cite the path, not just the verdict.

Ontology requirement shapes: `{process, activity}`, `{parentRole, childRole}`, `{parentProcess, childProcess}`.

For the full enum lists (entity/relation/policy types, Hohfeldian modalities, check types) and the larger worked case study, read `references/gal-json.md`.

## Pitfalls that silently give the wrong answer

- **A user is only analysed if they `Acts` in at least one role.** `GamModel.users` is drawn from RU⁺. A principal with only `Assumes` edges is never checked. Give every principal a role.
- **Reversed policy arguments.** `CanAssignTo` is Activity→Role and `CanAct` is User→Role — the opposite of `AssignedTo`/`Acts`. A reversed edge doesn't error; it just never matches.
- **Use engine sort names** `Process | Activity | Role | User` for anything the checker or Alloy emitter must see. `schema.js` also lists richer types (`DepartmentRole`, `DataObject`, `Vehicle`, …) for the extraction pipeline; the emitter infers sorts from relations when the entity type isn't one of the four, but be explicit.
- **`CanReach` and `Reaches` exist in `model.js` but not in `schema.js`'s `PolicyTypes`/`RelationTypes` lists.** `validateModel` will reject `CanReach`; the checker accepts it. Don't "fix" a model by removing them.
- **Unknown relation types are ignored by the checker**, not rejected. Run `validateModel` (`src/core/schema.js`) when you need errors.
- **Hierarchies must be acyclic** (`ComposedOf`, `Includes`). Alloy's `WellFormed` fact forbids cycles; a cyclic GAL-JSON model will be vacuous in Alloy.
- **`ENGINE_DISAGREEMENT` is a bug, not a finding.** The SAT layer (`sat-solver.js`, DPLL + deletion-based MUS) is a cross-check over the same propositions. If it disagrees with closure analysis, fix the engine.
- **Trace operators aren't propositional.** `Activity-Trace` / `Activity-Process-Trace` need transitive closure; they live in the closure engine and in Alloy (`^next`), never in the SAT encoding.
- **Defeasibility order is LexSuperior → LexSpecialis → LexPosterior → ValuePreference → JurisdictionalPrimacy** (`DEFAULT_RESOLUTION_ORDER`, overridable via `context.resolutionOrder`). A specific lower norm must not defeat a higher one.
- **Factual corrections to keep.** MI 52-111 was never adopted (CSA Notice 52-313, 2006) — illustration only. SOX §404 mandates ICFR assessment, not segregation of duties (SOD is a COSO practice applied under §404). "Privacy Act" ≠ PIPEDA. PHIPA, not PHIPPA.

## Alloy

`alloy/gam_core.als` is the metamodel: sorts, ± fields, closures (`act`, `proc`, `effAct`, …), `pred Con`. Chapter models (`ch07_*`, `ch08*`, `appendixB_*`) open it. `ch08a/b` are reconstructions (thesis pp. 226–234 missing).

```js
import { emitAlloy, containsAssertion, traceAssertion } from './src/core/alloy-emitter.js';
const als = emitAlloy(law, enterprise, {
  moduleName: 'my_case', scope: 30,
  assertions: [
    containsAssertion('SafetyStepPresent', 'EvalHarness', 'SafetyClassification'),
    { name: 'NoEgress', expr: 'PublicNetworkEgress not in effAct[EvalAgent]', comment: '…' },
  ],
});
```

```bash
npm run alloy:emit    # Appendix B GAL-JSON → alloy/generated/*.als
npm run alloy:check   # fetch Alloy 6.2.0, compile tools/RunAlloy.java, check every model (needs a JDK)
```

When you add a GAL-JSON case study with an Alloy twin, add a test asserting they agree (see `test/appendixB.test.js`).

## Natural-language pipeline

`readLawToGAM(text, jurisdiction, options)` (`src/functions/read-law.js`) runs:
1. `phase1-extractor.js` — keyword pattern extraction; `detectPolarity` and `splitClauses` so `shall not disclose` ≠ `shall disclose`.
2. `phase2-translator.js` — patterns → GAL operators (`GALOperators`, `PolicyOperators`).
3. `phase3-validator.js` — generates `validation_checks`.

`readPolicyToGAM` does the same for enterprise text. The extractor is heuristic: **treat its output as a draft and review every polarity and edge direction** before running checks. For anything that matters, hand-write GAL-JSON.

`validateCompliance(law, enterprise)` (`src/functions/validate-compliance.js`) produces one report with sections `consistency`, `ontology`, `scenario`, `potestative`, `defeasibility`, `completeness`. Its ontology section is an entity-coverage audit over `validation_checks`, **not** `OntologyChecker` — `ontologyRequirements` are only enforced by `OntologyChecker` (and by `/api/models/validate`, which runs it). Also: `generateComplianceMatrix`, `compareJurisdictions`, `deprecateRule`.

## HTTP API (`server.js`, port 3001)

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/health` | — | status |
| `GET /api/libraries/laws` / `/policies` | — | built-in libraries (incl. Appendix B configs) |
| `POST /api/models/validate` | `{lawModel, enterpriseModel}` | consistency + ontology results, explanations |
| `POST /api/models/alloy` | `{lawModel, enterpriseModel, moduleName}` | `{alloyCode}` |
| `POST /api/models/explain` | `{violation}` | plain-language explanation |
| `POST /api/models/matrix` | `{enterpriseModel, selectedLaws[]}` | cross-jurisdiction matrix |

## Repository map

```
alloy/            gam_core.als + verified chapter/case models; generated/ from emitter
src/core/         model.js (closures) · consistency-checker · ontology-checker · sat-solver
                  defeasibility · alloy-emitter · schema (GAL-JSON enums/validators) · ontology
src/pipeline/     phase1 extract → phase2 translate → phase3 validate
src/functions/    read-law · read-policy · validate-compliance · compliance-matrix · …
src/data/         legal-library · policy-library · agent-intrusion (Appendix B)
src/components/   React 19 + Vite UI
test/             vitest: thesis-cases · appendixB · engine · case-studies · api · lkrl-compliance
docs/             APPENDIX_B.md · CORRECTIONS.md · DEPLOYMENT.md
thesis/           revised dissertation chapters (markdown)
```

## Working on the engine

- `npm test` (vitest) must stay green; every engine defect fix gets a regression test named for the case it reproduces.
- Keep `model.js` closures and `gam_core.als` in lock-step. A change to one without the other is a bug.
- Detect conflicts only by derivation from closures. Never compare policy keys as strings, and never inject synthetic clauses to force UNSAT.
- Appendix B (`src/data/agent-intrusion.js`) is governance-layer only — zones, capabilities, identities. Keep it that way; don't add exploit detail.
