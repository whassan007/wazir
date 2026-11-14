// Illustrative contract, not a complete road-rule or AV safety model.
method SelectStopCommand(mustStop: bool, stopFeasible: bool) returns (stop: bool)
  ensures mustStop && stopFeasible ==> stop
  ensures !mustStop ==> !stop
{
  stop := mustStop && stopFeasible;
}

method ContractCaller()
{
  var result := SelectStopCommand(true, true);
  assert result;
}
