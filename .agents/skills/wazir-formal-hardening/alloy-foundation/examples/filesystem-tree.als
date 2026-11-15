// Alloy 6 — Static finite rooted filesystem hierarchy.
// Every nonroot node has one parent; there are no containment cycles.
// Intended outcomes: nontrivial hierarchy SAT, AllReachable has no
// counterexample within scope.

abstract sig Object {}
sig File extends Object {}
sig Directory extends Object {
  children: set Object
}
one sig Root extends Directory {}

fact IsTree {
  no Root.~children
  all o: Object - Root | one d: Directory | o in d.children
  no d: Directory | d in d.^children
}

assert AllReachable {
  Object in Root.*children
}

run { some File and some Directory - Root } for 6
check AllReachable for 6
