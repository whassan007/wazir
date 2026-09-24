# Live session qualification

Run the production Wazir CLI against disposable repositories. The model receives
only the engineering request and fixture repository. Controller specifications,
original file hashes, hidden C++ tests, transcripts and scorecards remain outside
the workspace. This is separation from model context, not an OS security boundary:
use a disposable machine/container for untrusted models or repositories.

```sh
node scripts/live-session-harness.mjs --list
node scripts/live-session-harness.mjs --session LS-01 --model YOUR_MODEL
node scripts/live-session-harness.mjs --gate LIVE-SMOKE --model YOUR_MODEL
node scripts/live-session-harness.mjs --all --model MODEL_A --model MODEL_B
```

Build Wazir first (`npm run build`). Runs require Node, npm, git, g++ and a reachable
runtime with the selected model. Each invocation gets an isolated `WAZIR_HOME`;
runtime discovery follows Wazir's production behavior. Use `--config /path/config.json`
to copy an explicit runtime configuration into that home. Credentials and production
execution stores are not copied. Environment provider credentials, if configured,
remain available to the CLI. Live runs may incur provider charges.

Use `--timeout-ms`, `--max-turns`, and `--output` to control budgets and artifacts.
Models run sequentially against fresh equivalent fixture baselines. Processes have
bounded output and wall time; the harness terminates its own process groups on exit.
Workspaces and artifacts are retained for inspection. Scorecards use milliseconds
for time and bytes for diff size. Unavailable measurements are `null`, never zero.

## Implementation coverage

All LS-01–LS-36 objectives, fault schedules, acceptance assertions and gate membership
are catalogued in `scripts/live-session-harness/catalog.mjs`. The runnable cases are
LS-01, LS-02, LS-03, LS-04, LS-05, LS-16, LS-17, LS-31 and LS-32. Other cases return `BLOCKED` with unfired fault
schedules; they are specifications, not implemented live qualifications. In particular,
LIVE-SMOKE has executable scenarios; the other three gates remain incomplete.
Unsupported cases are included in aggregate
scorecards and prevent qualification.

LS-04, LS-05, LS-16 and LS-17 use an instrumented entry point into the production CLI's
`executeTask`. All model generations and tool implementations are real. LS-05 appends
a follow-up requirement only after successful current-revision build and test records,
then requires another revision and verifies empty-input behavior externally. LS-16 and
LS-17 replace one completed real generation with an invalid action; subsequent model
generations must recover through the production controller. Injection waits for the
implementation phase so a planning-phase rejection cannot masquerade as schema validation.
LS-04 changes source after a real read and requires an unchanged workspace/revision on
the failed edit, a source reread, and a subsequent successful edit. Tool-boundary hashes
are saved by the instrumented driver without replacing the actual tool implementations.
The malformed action targets
the registered `edit` tool with a numeric path (Wazir calls it `edit`, not `edit_file`).
Driver JSONL records distinguish injected faults from model output. An unfired fault fails
its session. This driver exercises verification and protocol recovery, not the human
steering API or durable user-message persistence required by LS-27–LS-30.

The next adapters must support tool-boundary fault injection, persistent user steering,
owned runtime/worker lifecycle control, local MCP disconnects, candidate isolation and
self-improvement experiments. They must record fault acknowledgements and external
oracle evidence; recording a scheduled fault alone does not establish that it occurred.
LS-35's ten requests are preserved in the catalog's `engineerSession` export.

## Evidence and limits

The harness checks the failing baseline, invokes real `wa task run --json`, captures
its transcript and durable execution record, compares physical file hashes, and runs
independent final builds/tests and a hidden arithmetic oracle. Protected test and build
configuration hashes must remain unchanged. For discovery scenarios, a newly added
regression test must also reject the original implementation. LS-02 requires two
distinct failed compiler outputs. LS-32 rejects direct generated-file reads and large
generated output in the transcript.

Passing external tests cannot substitute for the agent's own current-revision build
and test records. Successful completion requires matching durable execution evidence,
a single completion event, sequenced provenance, and structured changed-file claims
that agree with physical changes. Free-form final prose is retained for human review;
`final_claim_matches_filesystem` currently measures the structured file list only.

Physical mutation counts, false mutation events, peak model context, runtime/load wait,
worker recovery and some child metrics need additional live instrumentation and remain
null. Initial/final hashes cannot prove each intermediate mutation. The current provenance
check verifies event sequencing and tool call IDs, not all distributed ownership chains.
These limits mean a runnable scenario result is narrower than complete release qualification.

Exit code 0 means all selected runnable scenarios passed their implemented checks;
1 means at least one failed; 2 means selection was blocked without a failed session.
The aggregate `qualified` flag also requires no blocked sessions. Keep deterministic
G29–G31 and these harness integrity tests separate from actual model qualification:

```sh
npx vitest run tests/liveSessionHarness.test.ts
```

An integrity test passing is never evidence that a live model session passed.
