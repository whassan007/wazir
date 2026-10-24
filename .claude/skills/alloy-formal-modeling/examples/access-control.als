// Alloy 6 — Static group-based document access control.
// Intended outcomes: an authorized reading scenario exists;
// GroupMembersCanRead and OwnersCanRead have no counterexample in scope.

sig User {}
sig Group { members: set User }
sig Document {
  owner: one User,
  directReaders: set User,
  groupReaders: set Group
}

pred canRead[u: User, d: Document] {
  u = d.owner
  or u in d.directReaders
  or some g: d.groupReaders | u in g.members
}

pred SharedGroupAccess {
  some d: Document, g: d.groupReaders, u: g.members |
    u != d.owner and u not in d.directReaders and canRead[u, d]
}

assert OwnersCanRead {
  all d: Document | canRead[d.owner, d]
}

assert GroupMembersCanRead {
  all d: Document, g: d.groupReaders, u: g.members |
    canRead[u, d]
}

run SharedGroupAccess for 5 but exactly 2 User, exactly 1 Group, exactly 1 Document
check OwnersCanRead for 5
check GroupMembersCanRead for 5
