# Alloy 6 temporal / behavioral modeling reference

## 1. State vs structure

Alloy 6 describes an **infinite execution trace** represented for bounded analysis by a finite **lasso** (finite states with a loop back to an earlier state). A signature or field is **static** by default; add `var` to mark it mutable.

```alloy
sig Client {}
one sig Lock { var holder: lone Client }
```

`Lock` and `Client` are static; `holder` can differ by state. The declaration guarantees no more than one holder at every state, but says nothing about how ownership changes.

`holder'` is the field's **next-state relation**, not a derivative or punctuation. A primed expression is meaningful only when a mutable state interpretation exists. Prime is **not** an imperative assignment: `holder' = ...` is a constraint on adjacent states.

## 2. Initial states, actions, frame conditions

```alloy
pred init { no Lock.holder }

pred acquire[c: Client] {
  no Lock.holder
  Lock.holder' = c
}

pred release[c: Client] {
  Lock.holder = c
  no Lock.holder'
}

pred stutter {
  Lock.holder' = Lock.holder
}

fact Behavior {
  init
  always (
    (some c: Client | acquire[c] or release[c])
    or stutter
  )
}
```

**Read carefully**: a top-level `init` fact constrains only state zero. The enclosing `always` requires each transition along the infinite trace to be an allowed action or stutter. The action predicates provide guards and next-state effects. If you add other mutable fields, every action must constrain unaffected fields as well; otherwise those fields may change arbitrarily at the same time.

`stutter` is intentional nonprogress. A model that permits stuttering forever does **not** establish progress; liveness requires additional justified assumptions (e.g. fairness), and checking such claims without them should often produce a counterexample.

## 3. Temporal operators

| Formula | Meaning at current state |
|---|---|
| `after P` | `P` holds at the immediately next state |
| `always P` | `P` holds now and at every later state |
| `eventually P` | `P` holds at some state now or later |
| `P until Q` | `Q` eventually holds; `P` holds before it |
| `P releases Q` | `Q` holds through first `P` occurrence, or forever if `P` never holds |
| `P ; Q` | `P and after Q`, right-associative |
| `before P` | `P` held at previous state (false at first state) |
| `historically P` | `P` held now and in all preceding states |
| `once P` | `P` held now or at some previous state |
| `P since Q` | `Q` occurred in the past, `P` has held since then |
| `P triggered Q` | Past dual of `releases` |

Temporal operators are interpreted at a state of the trace. A check or run is evaluated beginning at the **first state** unless shifted using a temporal connective. `always` / `eventually` include the current state, so distinguish `eventually P` from `after eventually P`.

## 4. Safety, liveness, and fairness

Safety example:

```alloy
assert NeverTwoHolders {
  always lone Lock.holder
}
check NeverTwoHolders for 3 but 6 steps
```

This particular safety property follows directly from the field's declared `lone` multiplicity; it is a type-level sanity check. Nontrivial properties should test interactions between multiple fields and actions.

Liveness example:

```alloy
assert EveryRequestIsEventuallyGranted {
  always (some Request.pending implies eventually some Request.granted)
}
```

This *illustrative formula* needs `Request.pending` and `Request.granted` declarations; it is **not** a stand-alone compilable model. Whether it holds depends on transition constraints and fairness; an infinite stutter trace may refute it. Use `always (P implies eventually Q)` for per-state response properties; `P implies eventually Q` from initial state alone only covers `P` at the beginning.

Fairness assumptions should be **documented and justified**, not introduced to rescue a failed check. Prefer weak/strong fairness formulas only with a clear environmental scheduling model.

## 5. Temporal scopes and caveats

- `run { eventually some Lock.holder } for 3 but 6 steps`: explore up to six temporal steps.
- `check NeverTwoHolders for 3 but 8 steps`: search for counterexamples on bounded lasso traces.
- `for 1.. steps`: complete/unbounded temporal model checking mode, requiring a supported solver such as nuXmv or NuSMV; may be costly.
- No explicit time scope ⇒ equivalent to `for 10 steps` in Alloy 6.
- Lasso loops mean “next state” also exists at the last visualized state by jumping back to the loop target.
- Only signatures and fields marked `var` can change over time; when a **top-level signature** is mutable, `univ` and `iden` can change accordingly.
- Beware formulas that unintentionally hold only at initial state or only when a zero-length set makes their premises false.

## 6. Behavioral review checklist

1. Are every mutable relation and its meaning explicit?
2. Is the initial condition separately defined?
3. Does each action state a guard and *all* next-state effects, including frames?
4. Does a global temporal fact limit every transition?
5. Is stuttering included (or its exclusion justified)?
6. Is the model satisfiable and does it admit a nontrivial multi-step trace?
7. Are safety and liveness separately checked?
8. Is any fairness assumption stated independently and defensibly?
9. Are state scopes, bitwidth, and `steps` specified in reported checks?
10. Can a deliberately faulty implementation produce the predicted counterexample?

## Sources

- https://alloytools.org/alloy6.html
- https://alloytools.org/spec.html
- https://practicalalloy.github.io/chapters/behavioral-modeling/index.html
- https://practicalalloy.github.io/chapters/behavioral-topics/topics/temporal-logic/index.html
- https://practicalalloy.github.io/chapters/behavioral-topics/topics/fairness/index.html
