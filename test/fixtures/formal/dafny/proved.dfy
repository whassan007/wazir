method ClampNonNegative(x: int) returns (y: int)
  ensures y >= 0
{
  if x < 0 { y := 0; } else { y := x; }
}
