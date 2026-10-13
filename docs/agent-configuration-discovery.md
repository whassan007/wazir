# Agent configuration discovery and connection

Wazir discovers installed Codex, Claude Code and Antigravity CLI installations without
copying credentials. Configuration discovery is passive. Connection and check commands
perform real, bounded tasks using existing adapters and native vendor logins.

## Commands

```sh
wa agents discover --json
wa agents inspect codex --json
wa agents inspect claude-code --trust-project --json
wa agents explain antigravity --json
wa agents list --json
wa agents connect codex --timeout 45 --json
wa agents check codex claude-code antigravity --fresh --timeout 45 --json
wa agents refresh --json
```

`--trust-project` authorizes reading project settings for inspection only. It does not
persist vendor workspace trust or authorize hooks, commands, MCP servers, or execution.
Instruction file paths are reported; their contents are not copied. Discovery and inspect
commands do not create an engine or launch agents. Refresh additionally invalidates Wazir's
preflight cache. Explicit agent task selection in `runTaskCommand` triggers lazy preflight;
startup does not launch every paid agent session.

Model values are configuration **declarations**, not a reimplementation of native effective
configuration. Native CLIs retain responsibility for managed settings, profile selection,
permissions, hooks, instructions and model availability. `CONFIGURED` does not mean a model
is available. Unconfirmed models and Antigravity schemas remain `UNKNOWN`.

## Implementation and reuse

- `packages/agents/src/configurationDiscovery.ts`: executable candidate resolution,
  bounded configuration parsing, provenance, repository-root detection, and fingerprints.
- `apps/cli/src/agentConnectionManager.ts`: projects existing registry, account mappings and
  preflight results into connection information. It is not another adapter registry.
- `apps/cli/src/agentPreflight.ts`: private cache, configuration invalidation, version
  inspection, and admission/accounting through the existing resource budget and ledger.
- Existing `AgentRegistry`, `AcpAgentAdapter`, `ExternalAgentAdapter`, `AccountRegistry`,
  `ResourceLedger`, resource routing, process-tree cleanup and preflight are reused.
- Codex now uses installed `codex exec` through `ExternalAgentAdapter`. The prior pinned ACP
  bridge rejected this installation's configured model. Native execution enforces a read-only
  sandbox and denies approval requests. This mode supports analysis; it cannot edit a project.
- Claude Code retains its existing ACP adapter. Antigravity retains the existing `agy`
  headless adapter; no ACP support is assumed.
- Explicit Codex/Claude account instances retain the existing `resources.json` IDs and
  per-account environment selection. Multiple installation paths do not create subscriptions.

Probes reserve one request plus an estimated 4,096 input and 32 output tokens through existing
governance. These are accounting estimates, not provider-reported usage or subscription limits.
Agent output must contain the requested `OK` response for these three vendors; a successful
process exit or stderr output alone cannot establish readiness.

## Sources

Codex candidates: `$CODEX_HOME/config.toml` or `~/.codex/config.toml`, user `AGENTS.md`,
repository-to-working-directory `.codex/config.toml`, `AGENTS.md`, `AGENTS.override.md`, and
system managed/requirements candidate paths. Claude candidates: `$CLAUDE_CONFIG_DIR/settings.json`
or `~/.claude/settings.json`, user `CLAUDE.md`, project `.claude/settings.json`,
`.claude/settings.local.json`, `CLAUDE.md`, `.claude/CLAUDE.md`, and `.mcp.json`.

Antigravity candidates: `~/.gemini/settings.json`,
`~/.gemini/antigravity-cli/settings.json`, platform application configuration under
`Antigravity/User/settings.json`, and workspace `.vscode/settings.json`. These are explicitly
candidate paths, not a promise that a particular version supports their schema.

Native behavior was checked against installed CLI help and official documentation:
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic),
[Claude settings](https://code.claude.com/docs/en/settings), and
[Antigravity CLI setup](https://antigravity.google/docs/getting-started?tab=cli).

## Security boundaries

- No authentication-store file is opened, copied, or exported. Credential existence never
  establishes authentication. Connection success requires an actual vendor task.
- Only selected scalar settings and restriction/MCP counts are emitted. Hooks, tool command
  bodies, MCP environments, instruction contents and parser error excerpts are withheld.
- Project settings are unread until explicitly authorized for inspection. Escaping project
  symlinks are rejected. Configuration files over 1 MiB and non-regular files are not parsed.
- No arbitrary repository commands, interactive login, endpoint HTTP probes, or automatic
  account rotation run during discovery. Vendor failure details are replaced with controlled
  diagnostic hints before caching. Raw output is excluded from the live report.
- PATH lookup ignores empty and relative entries. Windows PATH/PATHEXT construction handles
  mixed-case environment keys, spaces and Unicode. `cross-spawn` handles Windows wrappers;
  process-tree termination uses existing platform helpers.
- Cache identity includes project location, trust scope, executable metadata, configuration
  metadata/content hashes, and relevant environment hashes. Secret environment values are
  not persisted. Operator refresh invalidates cached results.

## Verification report — 2026-10-13 UTC

Starting commit and initially fetched main: `cd010dcc2e6bec66ddd305f8ef382c43b2c42545`.
Report-time HEAD: `f255fba9b5011a9f850deed93a43078cdf25f3b1`.
Other active work committed and merged this shared checkout during implementation, including
some overlapping changes. These revisions are workspace snapshots, not an isolated commit
containing only this feature. No commit or publication was performed by this implementation run.

Actual host: **Linux ARM64**, Node 22.22.3.

| Agent | Installed version | Connection | Separate bounded arithmetic task |
| --- | --- | --- | --- |
| Codex | 0.162.1 | READY | PASS, returned 323 |
| Claude Code | 2.1.296 | READY | PASS, returned 323 |
| Antigravity CLI | 1.3.3 | READY | PASS, returned 323 |

All three reused existing vendor sessions. The Codex pinned-bridge failure was reproduced
before switching to the installed CLI. The final live harness tested each registered adapter
in an empty temporary workspace with read permissions and resource admission. It performed
a distinct `17 × 19` task after the connection probe. These are real provider responses,
not test doubles. Reproduce after building:

```sh
node scripts/verify-agent-discovery.mjs --live
```

The harness saves a private report at `/tmp/wazir-agent-discovery-live.json` on this host and
removes its temporary workspace. It deliberately does not test repository edits.

Discovered on this host:

- `/home/wael/.local/bin/codex`, `/home/wael/.codex/config.toml`; declared model `gpt-6-astra`.
- `/home/wael/.local/bin/claude`, `/home/wael/.claude/settings.json`; declared model `opus`.
- `/home/wael/Code/Wazir/.claude/settings.local.json`; discovered as untrusted project data.
- `/home/wael/.local/bin/agy`, `/home/wael/.gemini/settings.json`,
  `/home/wael/.gemini/antigravity-cli/settings.json`; model unknown.

TypeScript compilation passed. The full regression run had 2,082 passed, 18 skipped and four
failed tests. After fixing the strict-probe fixture, rerunning all agent tests and the four
failing suites produced 228 passed and one remaining failure: the real-PTY Ctrl+P quick-actions
palette assertion in `apps/cli/tests/sessionEof.test.ts`. The full suite is therefore **not green**.

| Scenario | Result and evidence |
| --- | --- |
| Three installed/authenticated agents | PASS — live probes and separate tasks |
| Missing executable | PASS — regression fixture |
| Invalid configuration, conflicting model declarations | PASS — regression fixtures |
| Trusted project model declaration, untrusted isolation | PASS — regression fixtures; native project execution NOT_RUN |
| Config/environment changes and secret withholding | PASS — regression fixtures |
| Crash, cancellation, timeout, nested Claude session | PASS — adapter/preflight regression fixtures |
| Unavailable model | PASS — detected live Codex bridge incompatibility; native path subsequently passed |
| Actual expired login, unauthenticated account, exhausted subscription | NOT_RUN — no credential mutation or deliberate quota exhaustion |
| Executable upgrade during this run | NOT_RUN — metadata invalidation implemented |
| Linux ARM64 | PASS — native live execution |
| Windows paths/PATHEXT, macOS path construction | Regression fixtures only; not native-platform certification |
| macOS ARM64/x64, Windows ARM64/x64, Linux x64 | NOT_RUN — no corresponding execution host available |

## Remaining limitations

This is not full acceptance of every requested scenario. Native cross-platform execution and
the remaining terminal regression block full acceptance. Effective model catalogs, provider
endpoint metadata, managed-policy/profile resolution, Antigravity profile/schema support,
desktop-only Antigravity discovery, and project-scoped model verification are not fully
implemented. `agy models` is advertised by the installed CLI, but no catalog parser is wired
into discovery yet. No context limits or provider subscription balances are invented.

Passive inspect/explain currently covers base agents; configured account instances appear
through the engine-backed list/connection manager. Native CLIs determine execution-time
project trust; Wazir's inspection trust flag is not a persistent execution authorization store.
Lazy preflight is attached to explicit `runTaskCommand` selection, not every dispatch entry.
No persistent discovery cache beyond preflight fingerprints is implemented. Codex's conservative
read-only fallback intentionally does not claim write-task compatibility.

## Rollback

Because concurrent work committed overlapping files, do not reset or blindly revert the
report-time HEAD. Save the working diff, then review and reverse only this feature's hunks in
the agent package, `agentPreflight.ts`, `agentConnectionManager.ts`, CLI agent commands,
`runTaskCommand`, startup registration and dependency manifests. Remove the discovery service,
its dedicated tests, and the live harness only if they have no subsequent dependent changes.
Restore the prior Codex ACP registration if desired, understanding that its model compatibility
failure will return. Rebuild and run the agent regression suite. Vendor authentication and
configuration need no restoration because this implementation did not modify them.
