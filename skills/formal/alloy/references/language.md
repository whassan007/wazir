# Alloy 6 language — reliable working reference

## 1. Relations, signatures, and types

Alloy formulas constrain **relations over atoms**. Unary relations are sets; binary relations are sets of ordered pairs; n-ary relations are sets of n-tuples. There is no assignment statement and no imperative iteration. `run` and `check` invoke a solver over finite bounds.

```alloy
abstract sig Entity {}
sig User extends Entity {}
sig Group extends Entity { members: set User }
one sig Superuser extends User {}
sig Document { owner: one User, reviewers: set User }
```

- Top-level signatures denote sets that are mutually disjoint from other top-level signatures (except special built-ins and inheritance/subsetting).
- `extends` means an extension subset; sibling extensions are disjoint. `abstract` parents have no atoms outside their direct/indirect extension descendants.
- `sig A in B {}` is a subset signature, possibly overlapping with other subset signatures; it does not create a new disjoint partition.
- `one sig Name`, `lone sig Name`, `some sig Name` constrain signature cardinality. An unqualified signature can be empty.
- A declared `f: one T` makes each source atom have exactly one `T` target; `f: lone T` means zero or one; `f: some T` means one or more; `f: set T` means any number.
- **Field multiplicity is not about global tuple count.** In `sig User { manager: lone User }`, every user has at most one manager. The relation as a whole may contain many pairs.
- Top-level field relations are syntactic declarations associated with their owner signatures, and can be used globally as `User.manager` or from a specific user as `u.manager`.

### `extends` vs `in` — a high-value distinction

```alloy
sig Person {}
sig Student in Person {}
sig Employee in Person {}
```

Here a person may be both a student and an employee. Change to `extends Person` if categories must be disjoint, and consider an abstract parent if they must cover all `Person` atoms.

### Relation product and join

```alloy
sig User {}
sig Document { owner: one User, allowed: set User }

pred canRead[u: User, d: Document] {
  u = d.owner or u in d.allowed
}
```

- `d.owner`: relational join, yielding the owner set (one atom because of the declaration).
- `Document.owner`: all document-to-owner pairs.
- `User -> Document`: all possible user-document pairs.
- `d -> u`: the singleton pair `(d,u)`.
- `~(Document.owner)`: relation with owner first, documents second.
- `r ++ s`: override tuples of `r` whose **first column** appears in `s` with tuples from `s`; prefer domain restriction expressions to make intent explicit on n-ary relations.

### Basic relational algebra

| Operator | Notes |
|---|---|
| `a + b` | Union (same arity). `+` is not integer addition. |
| `a - b` | Difference (same arity). Not numeric subtraction. |
| `a & b` | Intersection (same arity). |
| `a.b` | Join; joins the last column of `a` with the first of `b`. |
| `r[s]` | Relation join in bracket notation; equivalent to `s.r` in relational expressions. |
| `a -> b` | Product; arities add. |
| `~r` | Transpose (requires binary relation). |
| `^r` | One-or-more step transitive closure of binary `r`. |
| `*r` | Zero-or-more step reflexive-transitive closure. |
| `A <: r` | Keep tuples of `r` whose first element is in `A`. |
| `r :> B` | Keep tuples of `r` whose last element is in `B`. |
| `r ++ s` | Override based on first-column keys. |
| `none`, `univ`, `iden` | Empty unary relation, universe, identity binary relation. |
| `#e` | Cardinality; depends on bounded integer encoding. |

Closure example:

```alloy
sig Node { edge: set Node }
assert NoDirectedCycle {
  no n: Node | n in n.^edge
}
check NoDirectedCycle for 5
```

The **check is expected to find a counterexample**, because nothing forbids a directed cycle. This is a pedagogical negative control, not a verified invariant. `^edge` means reachability through one or more edges; `*edge` permits zero edges and includes identity.

## 2. Logic and quantifiers

- `P and Q` / `P or Q` / `not P` / `P implies Q` / `P iff Q`.
- `P implies Q else R` models a conditional (not an imperative branch).
- `some e`, `no e`, `one e`, `lone e` test cardinalities of expressions.
- `all x: S | P`, `some x: S | P`, `no x: S | P`, `one x: S | P`, `lone x: S | P` quantify over **individual atoms**, unless a `set` qualifier intentionally requests sets.
- `all disj x,y: S | ...` quantifies over distinct choices.
- `let x = e | P` aliases an expression locally without changing state.
- `A in B` checks **subset inclusion**. For a singleton `a`, it also reads as membership. It is not a Boolean identity test; use `=` for equality.
- `A = B` is relational equality; `not A = B` means inequality.

Quantifier vacuity: `all x: Empty | P[x]` is true. Always test that relevant signatures and premise conditions can be inhabited.

## 3. Predicates, functions, facts, and assertions

```alloy
sig User {}
sig Document { owner: one User, readers: set User }

fact OwnersCountAsReaders {
  all d: Document | d.owner in d.readers
}

pred directlyReadable[u: User, d: Document] {
  u in d.readers
}

fun ownedBy[u: User]: set Document {
  u.~(Document.owner)
}

assert OwnersCanRead {
  all d: Document | directlyReadable[d.owner, d]
}

run { some Document and some User } for 4
check OwnersCanRead for 4
```

- A `fact` constrains **all** instances; do not use facts to conceal a design flaw.
- A `pred` is a reusable Boolean formula; it does not update mutable state by itself.
- A `fun` returns an Alloy expression, usually a relation; it is not a state-mutating procedure.
- An `assert` is a **claim** to challenge; `check` searches for a counterexample while satisfying facts.
- Function/predicate invocations use brackets, not ordinary function-call parentheses: `directlyReadable[u, d]`.
- Reuse a predicate in multiple assertions without copying its body.

## 4. Scopes

```alloy
run { some Document } for 5 but exactly 2 User
check OwnersCanRead for 5 but exactly 2 User
```

The overall number bounds **each top-level signature**. `exactly N T` forces that number for a scoped top-level/extension signature. An unbounded `run {}` can succeed on empty models and say little.

**Alloy 6 behavioral commands** can also bound the trace horizon:

```alloy
check Property for 4 but 8 steps
run { eventually some Snapshot } for 4 but 6 steps
```

Only use the second snippet if `Snapshot` and `Property` are defined in the same model. `steps` is a special command-scope keyword, not a signature. For true unbounded temporal model checking the syntax is `for 1.. steps`; use an appropriate solver and warn of performance/memory risk.

If a named top-level scope is unusually small, the result may exclude meaningful cases. Increase scopes incrementally and keep a table of exactly what was explored. Satisfiability of `run` proves only the existence of **some** instance within the bound.

## 5. Modules, ordering, integers, and identifiers

- `open util/ordering[State]` supplies a total order on `State`; it makes that ordered signature **exactly** the command-specified scope. Use for static ordered sequences, not as a substitute for Alloy 6 native temporal state in a new behavioral model.
- Module/import declarations come first; names can be qualified with module aliases.
- `Int` is finite in the Analyzer: arithmetic, sums, and `#` depend on bitwidth. Avoid silently equating Alloy's bounded integer encoding with mathematical unbounded integers.
- Integer arithmetic uses functions such as `add[a,b]`, `sub[a,b]`, `mul[a,b]` (see official standard modules); `+`/`-` on sets are set union/difference, not an alternative arithmetic syntax.
- Scope syntax can set bitwidth, e.g. `for 5 but 5 Int` (check Analyzer/version for actual semantics and representable range). Increasing bitwidth increases SAT complexity.
- Use ordinary ASCII punctuation; Alloy 6 reserves `var`, `always`, `eventually`, `after`, `before`, `steps`, and other temporal words. Avoid using new keywords as legacy identifiers.
- `//` and `--` start line comments; `/* ... */` delimits block comments.

## 6. Test expectations and common interpretation errors

`run {}` SAT ⇒ there is **at least one** model instance conforming to facts. The instance may be trivial or empty. `run { some Document }` UNSAT ⇒ no model instance with a document was found **in that scope**, potentially due to inconsistent assumptions.

`check P` finds a counterexample ⇒ `P` is **not entailed** by the facts in that scope. `check P` finds none ⇒ no violation found under analyzed bounds and semantics; not a full general proof. The analyzer shows counterexample valuations; explain the concrete atoms, relation tuples, and (for temporal models) the state and transition.

## Sources

- https://alloytools.org/spec.html
- https://practicalalloy.github.io/chapters/structural-modeling/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/relational-logic/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/commands/index.html
- https://practicalalloy.github.io/chapters/structural-topics/topics/integers/index.html
