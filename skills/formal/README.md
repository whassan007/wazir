# Wazir formal-assurance skills

Vendored from `docs/formal-assurance/SKILLS_INSTALL.md` (28 files, 6 skills; extracted with the §1 script and checked against the bundle's SHA-256 inventory). Skill bodies are verbatim except for the path rewrites listed below.

| Skill (frontmatter `name`) | Path | Claude Code | Use |
|---|---|---|---|
| `alloy-formal-modeling` | [`alloy/`](alloy/SKILL.md) | `.claude/skills/alloy-formal-modeling/` | relational + temporal models, bounded checks, state machines, right-of-way logic |
| `wazir-z3-constraint-verification` | [`z3/`](z3/SKILL.md) | `.claude/skills/wazir-z3/` | arithmetic/Boolean obligations, braking envelopes, bounded decisions |
| `wazir-dafny-program-verification` | [`dafny/`](dafny/SKILL.md) | `.claude/skills/wazir-dafny/` | verified decision kernels, contracts, invariants, termination |
| `wazir-scenic-scenario-generation` | [`scenic/`](scenic/SKILL.md) | `.claude/skills/wazir-scenic/` | reproducible scenario families |
| `wazir-verifai-falsification` | [`verifai/`](verifai/SKILL.md) | `.claude/skills/wazir-verifai/` | counterexample search against monitors |
| `gam` | [`gam/`](gam/SKILL.md) | `.claude/skills/gam/` | legal/policy compliance (GAL-JSON → Con, ontology, scenario checks, Alloy emission) |

Shared: [`evidence.schema.json`](evidence.schema.json) (the bundle's "Wazir Formal Assurance Result" schema — extend it, don't fork it), [`scripts/validate_skills.py`](scripts/validate_skills.py), [`manifest.json`](manifest.json) and [`index.mjs`](index.mjs) (task-type → skill loader for Wazir workers).

## Layouts

`skills/formal/<short>/` holds the real files. Both upstream conventions also resolve, via relative symlinks:

```text
skills/formal/alloy-formal-modeling                     -> alloy
skills/formal/wazir-formal-assurance-skills/README.md      (upstream bundle README, verbatim)
skills/formal/wazir-formal-assurance-skills/evidence.schema.json -> ../evidence.schema.json
skills/formal/wazir-formal-assurance-skills/scripts/validate_skills.py -> ../../scripts/validate_skills.py
skills/formal/wazir-formal-assurance-skills/skills/{z3,dafny,scenic,verifai} -> ../../{z3,dafny,scenic,verifai}
```

`.claude/skills/` holds plain copies (Claude Code needs `SKILL.md` directly under each skill folder). `.claude/` is gitignored, so new files there need `git add -f`. After editing anything under `skills/formal/`, re-sync and check for drift:

```bash
F=skills/formal C=.claude/skills
rm -rf $C/{alloy-formal-modeling,gam,wazir-z3,wazir-dafny,wazir-scenic,wazir-verifai}
cp -R $F/alloy $C/alloy-formal-modeling; cp -R $F/gam $C/gam
for s in z3 dafny scenic verifai; do cp -R $F/$s $C/wazir-$s; done
cp $F/evidence.schema.json $C/
python3 skills/formal/scripts/validate_skills.py --check-mirror .claude/skills
```

## Path rewrites relative to the bundle

- `z3`, `dafny`, `scenic`, `verifai` `SKILL.md`: example commands were relative to the bundle root (`python skills/z3/examples/...`). They are now relative to the skill directory (`python examples/...`), with a comment saying so, so they work from `skills/formal/<short>/`, the bundle layout and `.claude/skills/wazir-<short>/`.
- `z3/SKILL.md`: the evidence schema reference `../../evidence.schema.json` is now `../evidence.schema.json`, which resolves to `skills/formal/evidence.schema.json` and `.claude/skills/evidence.schema.json`.
- `scripts/validate_skills.py`: looks up each skill as `<root>/<name>`, `<root>/skills/<name>` or `<root>/wazir-<name>`; takes `--root` (any layout) and `--check-mirror` (byte-compare `.claude/skills` against `skills/formal`).
- `alloy` and `gam` needed no changes; their paths were already skill-root relative. The `npm run alloy:*` and `src/core` references in `gam/SKILL.md` point at the upstream GAM project, not at Wazir.

## Checks

```bash
python3 skills/formal/scripts/validate_skills.py                                    # skills/formal layout
python3 skills/formal/scripts/validate_skills.py --root skills/formal/wazir-formal-assurance-skills
python3 skills/formal/scripts/validate_skills.py --root .claude/skills --check-mirror .claude/skills
(cd skills/formal/z3 && python3 examples/check_stopping_rule.py --candidate buggy)   # needs z3-solver
(cd skills/formal/dafny && dafny verify examples/stop_command.dfy)                  # needs Dafny
bash skills/formal/alloy/scripts/run-examples.sh /path/to/org.alloytools.alloy.dist.jar
node skills/formal/index.mjs --check                                                 # manifest vs disk
npx vitest run skills/formal/                                                       # loader tests
```

These files don't add `wa` subcommands or solver adapters by themselves. See [`wazir-formal-assurance-skills/README.md`](wazir-formal-assurance-skills/README.md) for the bundle's orchestration notes and how to read results (Z3 UNSAT scope, falsification ≠ proof, fail-closed tool errors).
