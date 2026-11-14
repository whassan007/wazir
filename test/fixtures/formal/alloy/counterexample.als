sig Node { next: lone Node }
run Witness { some Node } for 3
assert NoSelfLoop { no n: Node | n.next = n }
check NoSelfLoop for 3
