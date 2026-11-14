// Alloy 6 Negative-Control Mutant: Q4 Ungoverned Self-Edited Harness (Raw Paper Gap)
// Defect modeled: Editor can rewrite guardrails/tools (`activeTools = requestedTools`) and
// access external rubric URLs without GovernanceFence rejection.

open util/boolean

abstract sig Capability {}
one sig ReadCap, EditCap, ShellCap, RawHostCap extends Capability {}

abstract sig ArtifactTarget {}
one sig PromptGuidance, PolicyGuardrail, FrozenSpec, ExternalRubricUrl extends ArtifactTarget {}

sig EditorProposal {
  requestedTools: set Capability,
  touchesTargets: set ArtifactTarget
}

one sig BaseHarness {
  ceilingTools: set Capability
}

fact BasePolicyCeiling {
  BaseHarness.ceilingTools = ReadCap + EditCap + ShellCap
}

abstract sig ComposeVerdict {}
one sig Pending, Verified extends ComposeVerdict {}

one sig ComposedState {
  var activeTools: set Capability,
  var mutatedTargets: set ArtifactTarget,
  var lastOraclePassed: one Bool,
  var verdict: one ComposeVerdict
}

pred init {
  ComposedState.activeTools = BaseHarness.ceilingTools
  no ComposedState.mutatedTargets
  ComposedState.lastOraclePassed = False
  ComposedState.verdict = Pending
}

// DEFECT: Self-edits harness without GovernanceFence AND marks contrastive winner Verified without oracle!
pred buggyApplyProposal[p: EditorProposal, physicalOraclePassed: Bool] {
  ComposedState.activeTools' = ComposedState.activeTools + p.requestedTools
  ComposedState.mutatedTargets' = ComposedState.mutatedTargets + p.touchesTargets
  ComposedState.lastOraclePassed' = physicalOraclePassed
  ComposedState.verdict' = Verified
}

pred stutter {
  ComposedState.activeTools' = ComposedState.activeTools
  ComposedState.mutatedTargets' = ComposedState.mutatedTargets
  ComposedState.lastOraclePassed' = ComposedState.lastOraclePassed
  ComposedState.verdict' = ComposedState.verdict
}

fact Trace {
  init
  always ((some p: EditorProposal, ok: Bool | buggyApplyProposal[p, ok]) or stutter)
}

assert MonotonicCapabilityContainment {
  always (ComposedState.activeTools in BaseHarness.ceilingTools)
}

assert GuardrailsSpecsAndOraclesNeverMutated {
  always (no (ComposedState.mutatedTargets & (PolicyGuardrail + FrozenSpec + ExternalRubricUrl)))
}

assert ContrastiveNeverMasqueradesAsVerifiedWithoutOracle {
  always (ComposedState.verdict = Verified implies ComposedState.lastOraclePassed = True)
}

run WitnessAnySelfEdit {
  eventually (some ComposedState.mutatedTargets)
} for 2 EditorProposal, 3 steps

check MonotonicCapabilityContainment for 2 EditorProposal, 3 steps
check GuardrailsSpecsAndOraclesNeverMutated for 2 EditorProposal, 3 steps
check ContrastiveNeverMasqueradesAsVerifiedWithoutOracle for 2 EditorProposal, 3 steps
