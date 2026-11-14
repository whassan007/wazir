// Alloy 6 Formal Hardening Model: Q4 Governed Harness^2 Propose-Probe-Compose & Capability Ceiling
// Subsystem: packages/evaluation/src/editors/governanceFence.ts & packages/core/src/services/harnessAssembler.ts
// Verifies Wazir's Governance Law:
//   "Evidence can change how the agent works, NEVER what it may access or how it is graded."
//   1. Monotonic capability subsetting: effectiveTools is always a subset of BaseCeilingTools,
//      and networkAllowed never escalates from False to True.
//   2. Guardrail/Spec/Oracle Immutability: proposals touching PolicyEngine, specs/, or external
//      rubric URLs are deterministically rejected by GovernanceFence.
//   3. Contrastive Verdict Separation: rubric-sparse contrastive selection without physical oracle
//      pass is tagged UnverifiedContrastive, NEVER Verified.

open util/boolean

abstract sig Capability {}
one sig ReadCap, EditCap, ShellCap, RawHostCap extends Capability {}

abstract sig ArtifactTarget {}
one sig PromptGuidance, DomainRecipe, PolicyGuardrail, FrozenSpec, ProtectedOracle, ExternalRubricUrl extends ArtifactTarget {}

abstract sig ComposeVerdict {}
one sig Pending, Verified, UnverifiedContrastive, RejectedGovernance extends ComposeVerdict {}

sig EditorProposal {
  requestedTools: set Capability,
  requestsNetwork: one Bool,
  touchesTargets: set ArtifactTarget,
  verifiedCount: one Int
}

one sig BaseHarness {
  ceilingTools: set Capability,
  ceilingNetwork: one Bool
}

fact BasePolicyCeiling {
  BaseHarness.ceilingTools = ReadCap + EditCap + ShellCap
  BaseHarness.ceilingNetwork = False
}

one sig ComposedState {
  var activeTools: set Capability,
  var activeNetwork: one Bool,
  var mutatedTargets: set ArtifactTarget,
  var lastOraclePassed: one Bool,
  var verdict: one ComposeVerdict
}

pred governanceFenceAllows[p: EditorProposal] {
  // 1. Capability ceiling: monotonic subset only
  p.requestedTools in BaseHarness.ceilingTools
  (p.requestsNetwork = True implies BaseHarness.ceilingNetwork = True)
  // 2. Forbidden governance, spec, oracle, and rubric targets
  no (p.touchesTargets & (PolicyGuardrail + FrozenSpec + ProtectedOracle + ExternalRubricUrl))
  // 3. Cross-task clean-base assembly requires >= 3 verified evidence runs for learned recipes
  (DomainRecipe in p.touchesTargets implies p.verifiedCount >= 3)
}

pred init {
  ComposedState.activeTools = BaseHarness.ceilingTools
  ComposedState.activeNetwork = BaseHarness.ceilingNetwork
  no ComposedState.mutatedTargets
  ComposedState.lastOraclePassed = False
  ComposedState.verdict = Pending
}

pred applyGovernedProposal[p: EditorProposal, physicalOraclePassed: Bool] {
  ComposedState.verdict = Pending
  ComposedState.lastOraclePassed' = physicalOraclePassed
  governanceFenceAllows[p] implies {
    ComposedState.activeTools' = ComposedState.activeTools & p.requestedTools
    ComposedState.activeNetwork' = ComposedState.activeNetwork
    ComposedState.mutatedTargets' = ComposedState.mutatedTargets + p.touchesTargets
    (physicalOraclePassed = True implies
      ComposedState.verdict' = Verified
    else
      ComposedState.verdict' = UnverifiedContrastive)
  } else {
    ComposedState.activeTools' = ComposedState.activeTools
    ComposedState.activeNetwork' = ComposedState.activeNetwork
    ComposedState.mutatedTargets' = ComposedState.mutatedTargets
    ComposedState.verdict' = RejectedGovernance
  }
}

pred stutter {
  ComposedState.activeTools' = ComposedState.activeTools
  ComposedState.activeNetwork' = ComposedState.activeNetwork
  ComposedState.mutatedTargets' = ComposedState.mutatedTargets
  ComposedState.lastOraclePassed' = ComposedState.lastOraclePassed
  ComposedState.verdict' = ComposedState.verdict
}

fact Trace {
  init
  always (
    (some p: EditorProposal, ok: Bool | applyGovernedProposal[p, ok]) or
    stutter
  )
}

assert MonotonicCapabilityContainment {
  always (
    ComposedState.activeTools in BaseHarness.ceilingTools and
    (ComposedState.activeNetwork = True implies BaseHarness.ceilingNetwork = True) and
    RawHostCap not in ComposedState.activeTools
  )
}

assert GuardrailsSpecsAndOraclesNeverMutated {
  always (
    no (ComposedState.mutatedTargets & (PolicyGuardrail + FrozenSpec + ProtectedOracle + ExternalRubricUrl))
  )
}

assert ContrastiveNeverMasqueradesAsVerifiedWithoutOracle {
  always (
    (ComposedState.verdict = Verified implies ComposedState.lastOraclePassed = True) and
    ((ComposedState.verdict != Pending and ComposedState.verdict != RejectedGovernance and ComposedState.lastOraclePassed = False) implies
      ComposedState.verdict = UnverifiedContrastive)
  )
}

run WitnessValidToolSubsettingAndRecipe {
  eventually (
    ComposedState.activeTools = (ReadCap + EditCap) and
    DomainRecipe in ComposedState.mutatedTargets and
    ComposedState.verdict = Verified
  )
} for 3 EditorProposal, 4 Int, 4 steps

run WitnessGovernanceBlocksRewardHack {
  some p: EditorProposal |
    ExternalRubricUrl in p.touchesTargets and
    eventually (ComposedState.verdict = RejectedGovernance)
} for 3 EditorProposal, 4 Int, 4 steps

check MonotonicCapabilityContainment for 3 EditorProposal, 4 Int, 5 steps
check GuardrailsSpecsAndOraclesNeverMutated for 3 EditorProposal, 4 Int, 5 steps
check ContrastiveNeverMasqueradesAsVerifiedWithoutOracle for 3 EditorProposal, 4 Int, 5 steps
