---
name: wazir-verifai-falsification
description: Use VerifAI with defined input spaces, simulator bridges, and property monitors to search for counterexamples to desired autonomous-system behavior. Invoke for robustness-guided scenario exploration, temporal-specification falsification, and regression counterexample campaigns.
version: 1.0.0
priority: P0
---

# VerifAI Property Falsification

## Purpose and activation

Use this skill to **find executions that violate a specified property**, particularly when system behavior depends on environment uncertainty, learned perception, and simulation. Unlike exhaustive formal model checking, VerifAI's sampling and falsification workflows do not prove correctness when they fail to find a counterexample.

**Typical request:** "Find intersection scenarios that cause the tested planner to cross the stop line while a reviewed stop obligation is in force."

## Inputs required

- Independently reviewed property, monitor semantics and threshold; requirement/source/jurisdiction if traffic law is implicated.
- Search space, variable units and ranges, available Scenic scenario or feature-space model, simulator bridge and execution command.
- Objective direction, robustness metric semantics, search method, iteration/time budget, stopping criteria and deterministic seed(s).
- Tested system's version, binaries/configuration, ODD, simulator version and resource constraints.

Separate a negative robustness score (a violated specification) from a good outcome. Document tolerance and boundary conventions. Monitor failures, missing sensor signals, and simulator crashes are not passing tests.

## Autonomous workflow

1. **Investigate.** Locate an approved property and a reproducible simulator/test target. Determine whether the monitor can actually observe a violation.
2. **Define space.** Model actor behavior, velocity, visibility, road geometry, policy inputs, and constraint domains via Scenic or VerifAI feature APIs. Specify legal exemptions independently.
3. **Implement the monitor.** Encode the rule as a custom `specification_monitor` or appropriate temporal logic expression. Unit-test it on known passing and failing traces **before** starting the expensive search.
4. **Select sampling.** Begin with a reproducible random/Halton baseline, then consider cross-entropy, simulated annealing, or other VerifAI samplers appropriate to the monitor and API version.
5. **Run.** Launch `generic_falsifier` or `mtl_falsifier` with an approved simulator bridge, bounded budget, and saved error table. For dynamic Scenic scenarios, use VerifAI's `ScenicServer` where supported by the pinned stack.
6. **Minimize and replay.** Capture every violating seed, input assignment, simulator trace, monitor value, and target binary revision. Re-run witnesses independently; minimize parameters without losing the violation.
7. **Repair and regress.** Send reproducible counterexamples to Wazir's implementation agent. Re-run the same witnesses and an independent holdout campaign on the revised program; do not alter the approved monitor to manufacture a pass.
8. **Deliver.** Report discovered violations, explored coverage, search budget, untested regions, tool/runtime failures, and replay/evidence links tied to the current source revision.

Autonomously investigate, execute, reproduce and verify within authorized tool and workspace bounds. Never treat search exhaustion as formal proof.

## Reference integration pattern

See [examples/falsify_with_scenic.py](examples/falsify_with_scenic.py), adapted from VerifAI's documented `ScenicSampler` + `ScenicServer` + `specification_monitor` workflow. This is an **integration template**; run it only after verifying Scenic/VerifAI API compatibility and installed simulator dependencies. Do not assume it is portable across unpinned versions.

```bash
# Run from this skill's directory (e.g. skills/formal/verifai/ or .Codex/skills/wazir-verifai/).
python -m pip install verifai
# Validate API compatibility in your isolated environment:
python -c 'import verifai, scenic; print("imports ok")'
# Only after binding to the selected tested-system/simulator combination:
python examples/falsify_with_scenic.py
```

Use a dedicated sandbox or virtual environment and dependency lock file. Keep optional simulator services out of release startup paths.

## Verdicts and evidence

- `FALSIFIED`: a reproducible simulation trace violates the property, with concrete witness and monitored output.
- `NOT_FALSIFIED`: completed campaign found no violation **within searched budget and distribution**. Not a proof.
- `UNKNOWN`: monitoring unavailable, incomplete campaign, solver/search uncertainty, or unsupported result.
- `ERROR`: tool, simulator, bridge, or trace-processing failure. Fail closed.

Capture coverage profile, search strategy, sampler hyperparameters, random seeds, sample counts, robustness distribution, all error-table entries, replay results, simulator/model versions, and hashes of source and configuration. Store findings in Wazir's existing evidence ledger. Any code mutation invalidates prior proof/compliance claims about the current revision, but preserve historical counterexamples as regression tests.

## Failure modes

- No actual integration to the tested vehicle controller, only a simulator model.
- Incorrect monitor polarity (treating a violation as a pass).
- A monitor reading the desired command instead of the vehicle's actual motion.
- Misreported coverage from one sampler, or data leakage from tuning on the same scenarios used for acceptance.
- Python/Scenic/VerifAI version skew; long-running socket-based falsifiers with no attached simulator.

## References

- [VerifAI repository](https://github.com/BerkeleyLearnVerify/VerifAI)
- [VerifAI documentation](https://verifai.readthedocs.io/)
- [VerifAI basic usage](https://verifai.readthedocs.io/en/latest/basic_usage.html)
- [Scenic external samplers](https://docs.scenic-lang.org/en/latest/modules/scenic.core.external_params.html)
