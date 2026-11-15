# Finding evidence standard

## Severity
- **P0**: plausible loss of authorization/isolation, destructive duplicate side effect, stale-worker commit corrupting live state, false verified completion, or unsafe published update. Requires a real code path and reproducible evidence; otherwise remain HYPOTHESIS.
- **P1**: material reliability/integrity issue causing workflow loss, unbounded retries, provider policy violations, resource overcommit, or false user-visible progress.
- **P2**: bounded, recoverable UX or telemetry defects without demonstrated integrity/security impact.

## Evidence levels
- HYPOTHESIS: source reading suggests failure scenario, no executable reproducer.
- ABSTRACT COUNTEREXAMPLE: Alloy generates trace, implementation mapping incomplete; NOT proof of bug.
- CONFIRMED: deterministic failing test/reproducer against unpatched exact commit + minimal code evidence.
- FIXED: previously failing reproducer passes after minimal patch, neighboring and required checks pass, no weakened assertions.
- BLOCKED: tooling/access missing; clearly state outstanding checks.
- ALREADY COVERED / FALSE POSITIVE: evidence of effective guard or erroneous abstraction.

## Repro record
`ID | priority | subsystem | exact_sha | invariant | preconditions | sequence | file:line | alloy_model | scope | alloy_verdict | failing_test | observed | expected | patch | post_fix_tests | status | remaining_risk`

Before reporting a 'critical' defect, independently question: (a) did the model permit impossible states? (b) is the guard in a different module? (c) was the test using a non-production adapter? (d) is the transition intentionally permitted? (e) is there a reachable real-world entry point?

Success criteria: confirmed issues found and prevented by tests, *or* well-supported bounded negative findings with explicit coverage limits. A count of model checks alone is not progress.
