# Distributed hierarchical MCTS

`DistributedSearchCoordinator` is the authoritative control plane for
hierarchical engineering search. It owns the tree, `treeRevision`, UCT
selection and virtual loss, expansion reservations, checkpoint lineage,
controller-derived reward, transposition, backpropagation, promotion, and
completion. Workers receive immutable branch requests and return execution
evidence; they never receive or mutate the search tree and they cannot assign
reward.

Branch requests carry the parent checkpoint, workspace snapshot identity,
source tree revision, phase, strategy, model/tool requirements, budgets, lease,
and attempt identity. Results carry the resulting checkpoint, workspace hash,
mutations, build/test/verification evidence, usage, artifacts, and status.
The coordinator rejects mismatched revisions, expired or superseded leases,
duplicate result digests, and duplicate attempts. Accepted evidence is
backpropagated once. `UNKNOWN` is retained as an explicit outcome and can be
requeued safely.

Checkpoint transport is content addressed. `CheckpointService` can compute a
snapshot digest and materialize a checkpoint on a target worker while checking
the expected digest and revision. Promotion requires branch verification,
parent application, and a fresh parent verification; branch verification is
never reused as parent verification.

Leases expose queued, leased, running, pending, completed, failed, unknown,
expired, and superseded states. Heartbeats renew leases. Worker selection uses
phase/model/runtime/capability constraints and rotates unconstrained branches
across available workers. Global and per-branch budgets are reserved by the
coordinator. Distributed events include search, node, worker, attempt, lease,
checkpoint, and tree-revision identities. The TUI renders worker and lease
ownership as observational metadata.

## Gate evidence

The repository acceptance suite maps the requested gates to executable tests:

| Requested gate | Repository test | Evidence |
| --- | --- | --- |
| G83 | G91 | Three real child worker processes, depth-three tree, isolated workspaces, controller reward and promotion path |
| G84 | G92 | Worker loss produces `UNKNOWN`, lease expiry preserves the tree, and requeue creates a fresh attempt |
| G85 | G94 | Persisted tree, leases, accepted evidence, and budgets restore after coordinator restart |
| G86 | G95 | Equivalent workspace state converges centrally and redundant expansion is suppressed |
| G87 | G96 | Local/distributed benchmark records solution, cost, node, duplicate-state, utilization, and recovery metrics without assuming speedup |

Validation run:

```text
npx tsc --build packages/core apps/cli --pretty false       PASS
npx vitest run packages/core/tests/distributedSearchCoordinator.test.ts \
  tests/acceptance/distributedMctsGate.test.ts              9 tests PASS
```

## Real-model live session

`scripts/distributed-mcts-live.mjs` runs production `wa task run` processes in
three physical worker workspaces and feeds only durable execution evidence to
the coordinator. The measured run used model
`gemma-4-26b-a4b-it-qat` and produced:

```text
workers                 DGX-01, MAC-01, PC-01
worker processes         3
tree revision            3
branches                 3 concurrent
completed / failed       2 / 1
controller rewards      3 (0, .1333, .2277)
model calls              85
tokens                   521,006
accepted nodes           3
worker-supplied rewards  none
```

Artifacts are written under `/tmp/wazir-distributed-live-*/report.json`.
The live fixture intentionally stops after the first expansion layer; the
depth-three and recovery requirements are covered by G91–G96, so this run is a
real-model protocol smoke test rather than a claim of distributed speedup.

Known limitation: a production deployment still needs a network transport
adapter for remote checkpoint/object transfer and worker heartbeats. The
coordinator contracts, fencing, persistence, and acceptance gates are ready
for that adapter; no distributed performance claim is made until G87 is run
against a representative corpus.
