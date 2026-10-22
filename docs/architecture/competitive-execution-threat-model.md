# Competitive execution threat model

Assets: primary/peer workspaces, shared Git refs/indexes, acceptance criteria, host credentials, external services, provider budgets and durable evidence. Trust boundary: controller, supplied verification policy, baseline repository and installed toolchains are trusted; model output and proposed patches are untrusted. This is an opt-in local native-agent feature, not a hostile multitenant compute platform.

| Threat | Implemented boundary | Limitations |
|---|---|---|
| Agent overwrites primary or another attempt | Independent baseline worktrees; only read/write/edit/glob; existing canonical filesystem checks plus source ownership; no agent Git/shell/MCP/delegation/network tools | Core callback API is trusted and can bypass these constraints if embedded incorrectly |
| Symlink escape/alias to hidden data | Canonical path checked against actual root and race policy; symlink/submodule candidate changes rejected | Baseline secrets already embedded in ordinary allowed source cannot be inferred/redacted reliably |
| Test/policy weakening | Protected test/fixture/config/package/lock/script paths; exact custom protection; independent baseline + patch; read-only verifier workspace, except generated outputs that cannot overlap tracked inputs | Trusted policy must declare enough checks; no universal proof against an implementation tailored to tests |
| Malicious code executed by verification | Mandatory real sandbox; deny network; minimal environment; per-verifier HOME/TMP; system/toolchains read-only; private writable workspace; no shared Git write access | macOS sandbox is not a full container; /opt and system tool installations are trusted; Linux strict profile needs Linux CI validation |
| Credential exfiltration | No inherited provider credentials in verifier; native tools deny dot metadata; provider calls occur in controller-owned adapters | Task text and source can contain sensitive data; caller remains responsible for hosted-provider policy |
| Shared database/service side effects | No agent processes or network tools; verifier has no network; runtime sockets absent on Linux and network denied on macOS | Projects requiring services/dependency installation need an isolated provisioned environment, not production endpoints |
| Spend explosion | Hard 8-participant ceiling, per-race concurrency/call/input/output/time limits; conservative monetary reservations; existing provider quota governor | Unknown costs stay unknown; provider billing/retries can differ from configured estimates |
| Duplicate work after restart | Atomic durable claim, dead-owner recovery fencing, no implicit replay | No distributed lease/fencing protocol; PID reuse and manual orphan inspection remain concerns |
| Cancellation while child still runs | Existing process-tree termination, abort settlement boundary; uncooperative agent becomes RECOVERY_REQUIRED and cannot be cleaned | Verification callback contract must settle only after processes stop; hard OS failures require operator fencing |
| Stale winner merged after target changes | Existing VerifiedIntegrationCoordinator performs clean integration and fresh checks, conflict and target-drift checks | No automatic target update, approval application, post-merge monitoring or automatic revert |
| Evaluation contamination | Independent mode only; replay excluded from routing; no patch/strategy exchange | Benchmark records deliberately written into a production store could still contaminate routing; benchmark harness uses isolated stores |
| Evidence forgery | No model-supplied measurements or judges; patch hashes, command exit codes/output digests; immutable verifier source | Host/controller/store administrators are trusted; no signed remote attestation |

## Operational requirements

Policy and state must live outside agent-writable ownership. The native CLI boundary enforces this by withholding code execution and canonicalizing all file tools. A missing OS sandbox refuses execution; it never falls back to the host. Production adapters must honor abort and cease I/O before returning. No shared production database URL, credential or writable dependency directory is passed to verifier subprocesses. Repositories under globally exposed system/toolchain roots must not be used as a hostile-isolation boundary.

Strict macOS verification allows filesystem-root directory reads required by dyld ignition, plus read-only system/toolchain paths; it does not grant general host reads. Protected tracked files remain immutable. The real macOS tests cover successful verification, attempted test overwrite and parent-directory rename, reading a sibling/primary workspace and inherited credential access. Strict Linux arguments are unit tested; actual bubblewrap execution is unverified in this environment.

ACP/vendor processes currently cannot be admitted safely: existing adapters own independent tools and network access, while the available sandbox offers no provider-only egress filter. Race mode explicitly rejects them. Supporting them requires a validated sandbox/egress contract, lifecycle cancellation and credential isolation; simply passing a worktree path would be insufficient.

## Recovery and rollback

On interrupted execution, inspect the durable race and tool events, fence the old coordinator/children, preserve patches and branches, and create a new explicit replay if desired. `recover` marks dead-owner uncertain work RECOVERY_REQUIRED without duplicating side effects. It does not approve cleanup automatically. Completed/cancelled/timed-out determinate races support explicit cleanup. Promotion leaves the target unchanged and records its SHA. Failed fresh verification blocks readiness. If a human subsequently merges outside this system, rollback is the normal reviewed Git revert workflow; automated post-merge rollback is outside this release.
