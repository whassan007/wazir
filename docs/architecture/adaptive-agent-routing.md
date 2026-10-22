# Adaptive agent routing

The implementation extends `Scheduler.rankCompetitiveConfigurations()` and `ModelIntelligenceService.rankCompetitiveConfigurations()`. `Scheduler.plan()` still owns capability, context, placement, provider-policy and availability eligibility. ResourceRouter and governed runtime adapters still own provider admission, quotas and limits. Competitive routing cannot bring an ineligible model back into consideration.

## Evidence and task segmentation

TaskCapabilityClassifier derives capability category and language. History uses schema-v1 race records in the existing KV store. Only records with the same policy hash, category, language and heuristic complexity can contribute. Agent, model, provider and declared agent/model/runtime versions must match. Attempts need independent checks or a controller-observed policy violation and a VERIFIED or FAILED outcome; infrastructure failures without verification do not masquerade as model-quality observations. Replays are excluded. A success means current eligibility under every mandatory gate, not model-reported completion. The history is not a training dataset and is never sent to a provider.

For n observed attempts and s verified successes, the ranking estimate is the Beta(1,1) posterior mean `(s+1)/(n+2)`. An explicit conservative score is `max(0, mean - 2*sqrt(mean*(1-mean)/(n+3)))`. This is an approximate uncertainty measure, not a calibrated success probability or confidence guarantee. No learned weights or extra inference calls are required.

## Modes and cold start

- `auto`: deterministic forced exploration of least-observed configurations until each has three independent observations; then descending conservative quality score.
- `highest-quality`: descending conservative quality score with stable scheduler-order ties.
- `cheapest`: price-bound ordering only when both configurations have at least three observations, conservative quality at least 0.5 and usable price bounds; otherwise conservative quality order.

With no matching evidence, preserve scheduler order and explicitly report cold start. New configurations are not assumed inferior in auto mode. Evidence is not pooled across changed policies or known version changes. Hosted rolling aliases with no stable revision remain a limitation. Critical-task policies, repository/context/tool feature models and calibrated probabilities remain incomplete. This policy scans history on demand; it is suitable for an initial modest history, not a large indexed warehouse.

## Budgets and progressive racing

Race policy bounds participant count, concurrency, total timeout, generation calls, tool calls and per-call input/output. Input is bounded by serialized bytes rather than assumed token counts. Output has a runtime max-token limit. Aggregate request ceilings are conservative (maxTurns × per-call ceiling). The runtime's provider-account governor continues to enforce account limits, quota reservations, concurrency and failure accounting for each actual request.

For metered providers, configured prices produce a worst-case input/output reservation before an attempt starts. Aggregate reservations cannot exceed `maxCostUsd`; skipped attempts record BUDGET_EXCEEDED. Reservations are conservatively retained for the race duration, including failed or missing-usage attempts. A metered candidate under a dollar cap needs real runtime usage to qualify, and measured estimated cost must stay within the reservation. Provider-side billing and ambiguous retries cannot be guaranteed by an internal estimate.

Local inference has no invented dollar charge. Subscription/unknown-price configurations cannot be admitted under a dollar-only budget. Without that flag, provider request quotas remain separate from optional monetary telemetry. Existing provider terms and subscription integrations remain unchanged.

`--progressive` limits dispatch to one at a time and stops at the first independently verified result. It does not claim statistical confidence from a single pass. A failed provider/agent permits the next eligible candidate within the reservation and deadline. An uncertainty-driven value-of-additional-execution estimator and configurable confidence/escalation thresholds are not implemented.

## Explainability and measurements

Race records capture routing rationale, sample counts, estimated posterior success, uncertainty-derived scores, candidate order, actual verification results, optional usage, reservations, failures and winner rationale. `wa explain`, inspection and export expose this evidence. Counterfactual results are reported only after replay actually executes. Observed routing regret is emitted by the benchmark only when alternatives were actually run and checked.

This integration does not yet feed StrategyLearningService's structural strategy extraction or its existing general execution profiles. Race ordering consumes the independently verified race records directly through ModelIntelligenceService. That distinction prevents a partial agent run from becoming verified historical evidence before the independent verifier finishes.
