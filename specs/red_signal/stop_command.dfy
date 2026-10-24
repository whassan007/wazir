// RED_SIGNAL_COMPLIANCE v2.1 — Dafny decision kernel.
// TOY educational model (TOY-TRAFFIC-SIGNAL-001); not a certified road-rule or AV safety model.
// `mustStop` is an already legally resolved stop obligation; `stopFeasible` is an externally
// validated feasibility judgment (discharged by stopping_envelope.py). No assumptions or axioms.

predicate ValidInputs(red: bool, mustStop: bool, stopFeasible: bool)
{
  // A stop obligation from the signal only arises when the signal is red.
  mustStop ==> red
}

method DecideStop(red: bool, mustStop: bool, stopFeasible: bool) returns (cmdStop: bool)
  requires ValidInputs(red, mustStop, stopFeasible)
  ensures (red && mustStop && stopFeasible) ==> cmdStop
  ensures !mustStop ==> !cmdStop
{
  cmdStop := red && mustStop && stopFeasible;
}

// Non-vacuity witness: the precondition is satisfiable with the obligation active,
// and the guarantee is exercised.
method DecideStopWitness()
{
  assert ValidInputs(true, true, true);
  var c := DecideStop(true, true, true);
  assert c;
  var g := DecideStop(false, false, true);
  assert !g;
}
