sig Node { next: lone Node }
fact Acyclic { no n: Node | n in n.^next }
run Witness { some n: Node | some n.next } for 3
assert NoSelfLoop { no n: Node | n.next = n }
check NoSelfLoop for 3
