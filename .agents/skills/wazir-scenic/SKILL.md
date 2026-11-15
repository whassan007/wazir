---
name: wazir-scenic-scenario-generation
description: Use Scenic to define constrained, reproducible geometric and dynamic scenario families for autonomous vehicles or robots. Invoke for intersection interactions, road-user variation, sensor occlusion, obstacle placement, and simulator scenario creation.
version: 1.0.0
priority: P0
---

# Scenic Scenario Generation

## Purpose and activation

Use this skill when Wazir needs **structured families of test situations**, not isolated hand-written simulation cases. Scenic is a probabilistic scenario language: its sampled scenes and simulation traces provide test inputs, **not formal proof that all possible scenarios satisfy a rule**.

**Typical request:** "Generate diverse red-signal intersection approaches varying speed, road-user position, visibility, and reaction time within a specified operating domain."

## Inputs required

- Scenario-family ID, road-rule/property ID, normative reference, reviewed assumptions, operating design domain (ODD), and scenario coverage goals.
- Map/road geometry, coordinate frame, units, actor models, parameter domains, required legal exceptions, and forbidden or mandatory initial-state conditions.
- Chosen Scenic version, simulator adapter, simulation time horizon, seeded sampling budget, and reproducibility requirements.

Do not infer statutory obligations from synthetic scenes. Associate each scenario with separately reviewed formal properties and monitor definitions.

## Autonomous workflow

1. **Investigate.** Identify a minimal scenario matrix derived from the property and ODD: nominal cases, boundaries, near-violations, uncertainty, and adversarial-but-physically-plausible cases.
2. **Model.** Choose `scenic.domains.driving` or a simulator-specific model only where supported. Define actors, geometry, probabilistic ranges, `require` constraints, and optional dynamic behaviors/temporal records. Prefer native Scenic constructs over bespoke scene generators.
3. **Check satisfiability empirically.** Generate samples. Report rejection counts and generation time. An inability to sample may indicate inconsistent constraints; do not silently relax hard requirements.
4. **Sample reproducibly.** Pin Scenic and adapter versions, map assets, seeds, scenario files, parameters, and sampling budgets. Save canonical scene serializations when supported.
5. **Execute where applicable.** Bind to approved simulator, record actual trajectory/state, and run independent property monitors. Track scenarios that fail due to simulator defects separately from behavioral failures.
6. **Prioritize coverage gaps.** Enumerate legal exception cases, ODD boundaries, rare conditions, and combinations omitted by the sampling distribution; hand difficult regions to VerifAI for falsification.
7. **Verify and package.** Keep source, seeds, scenes, simulation traces, code revision, and statistical results bound to the current Wazir workspace revision.

Work autonomously within current policy limits. Do not claim proof based on N passing simulations, and do not run untrusted simulator plugins outside the approved sandbox.

## Headless starter example

[examples/approach_scene.scenic](examples/approach_scene.scenic) describes a *toy* static two-actor approach, not a map-aware intersection or physically accurate driving model. [examples/sample_scenes.py](examples/sample_scenes.py) uses Scenic's documented Python API to sample without opening a GUI.

```bash
# Run from this skill's directory (e.g. skills/formal/scenic/ or .Codex/skills/wazir-scenic/).
python -m pip install scenic
python examples/sample_scenes.py \
  examples/approach_scene.scenic --count 5 --seed 42
```

For simulator-backed dynamics, use a compatible Scenic simulator model and verify the adapter with a small pinned scenario before attempting bulk sampling. `scenic --simulate` requires a scenario backed by a supported simulator.

## Coverage and evidence requirements

Emit `scenario_id`, requirement/property IDs, Scenic and simulator versions, asset checksums, seed and sampling distribution, ODD, number attempted/generated/rejected, per-scene state, monitor verdict, replay pointer, and failure details. Use `NOT_FALSIFIED` only for actual monitored executions and **never** translate it to `PROVED`.

Acceptance: the scenario compiles and generates within the configured budget; sampled scenes satisfy *scenario constraints*; replay is supported or limitations are clearly stated; invalid and rejected samples are counted; runs target the exact tested code revision.

## Failure modes

- Sampling an irrelevant subset of the ODD and claiming general coverage.
- Automatically excluding dangerous scenes through an over-constrained `require` clause.
- Unrecorded random seeds or changing map/simulator versions.
- Mismatched coordinate frames, world models, or Scenic 2/3 syntax.
- Treating a scene's syntactic constraints as traffic-law compliance of the tested vehicle.

## References

- [Scenic](https://scenic-lang.org/)
- [Current Scenic documentation](https://docs.scenic-lang.org/en/latest/)
- [Scenic CLI](https://docs.scenic-lang.org/en/latest/options.html)
- [Scenic Python API](https://docs.scenic-lang.org/en/latest/api.html)
