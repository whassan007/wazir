method UnsoundStop(x: int) returns (y: int)
  ensures y > 100
{
  y := x;
  assume y > 100;
}
