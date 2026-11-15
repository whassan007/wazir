// Relational permission boundary, deliberately without dispatch enforcement.
// The check is EXPECTED to find an unauthorized dispatch in the abstraction.
// It is NOT evidence of a Wazir vulnerability without mapping and reproduction.
sig Agent {}
sig Tool {}
sig Resource {}
sig Request {
  actor: one Agent,
  tool: one Tool,
  target: one Resource
}
sig Grant {
  principal: one Agent,
  tool: one Tool,
  target: one Resource
}
one sig State {
  grants: set Grant,
  dispatched: set Request
}
pred authorized[r: Request] {
  some g: State.grants |
    g.principal = r.actor and g.tool = r.tool and g.target = r.target
}
assert NoUnauthorizedDispatch {
  all r: State.dispatched | authorized[r]
}
run { some State.dispatched } for 3
check NoUnauthorizedDispatch for 3

// Repair the abstract specification with:
// fact DispatchGate { all r: State.dispatched | authorized[r] }
// Then repeat witnesses and checks; validate that production tool execution
// actually enforces the same condition atomically or near dispatch.
