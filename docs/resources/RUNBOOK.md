# Resource Orchestration — Operational Runbook

## What it does

Every model request Wazir makes passes one gate: estimate tokens, reserve budget on the serving
account, dispatch, then reconcile actual usage. Delegated agents (Claude Code, Codex,
Antigravity, …) are admitted the same way before their vendor CLI starts. Routing chooses among
eligible models with a resource-aware score, and records why.

Files (in `$WAZIR_HOME`, default `~/.wazir`):

| File | Purpose |
|---|---|
| `resources.json` | accounts and policy (optional; without it every runtime/agent gets an implicit account) |
| `resources.db` | the ledger: SQLite in WAL mode, with reservations, usage, health, audit trail and calibration. `:memory:` when `WAZIR_IN_MEMORY=1` |

## Enforcement is off by default

`policy.enforce` defaults to **false**. Every request is still estimated, reserved, reconciled,
routed and shown on the dashboard, but nothing is refused for budget reasons. Quotas, spend
ceilings, concurrency queues, 429 cooldowns, auth/quota blocks and the paid-API gate are all
ignored. The **emergency stop** (`wa resources stop`) still applies: it is an operator switch,
not a limit. Set `"enforce": true` in `resources.json` to turn enforcement on.

## Production profile

Enforcement stays opt-in; nothing turns it on for you. Before relying on Wazir to hold a budget,
run `wa resources validate --profile production`. It exits non-zero unless:

- `policy.enforce` is `true`;
- every delegated agent and hosted runtime is served by an account **defined in
  `resources.json`** (implicit accounts have unknown limits);
- every non-local account has at least one limit. No limits means **unlimited**; a limit of
  `null` means **unknown**, and production rejects `unknownLimitPolicy: "allow"` on unknown
  limits because that is unlimited in practice;
- every paid API account has `pricing`, and when paid dispatch is authorised
  (`paidApiFallback` or `allowPaid`), a `dailySpendUsd` or `monthlySpendUsd` ceiling is set.

The default profile reports the same problems as warnings. Both list an admission preview for a
1-token request per account, so you can see what enforcement would do right now.

Limits are Wazir's own dispatch ceilings. Subscription usage is estimated from prompt and output
text (vendor CLIs report no token counts), so a configured subscription limit is a conservative
local budget, not the vendor's quota. With `unknownLimitPolicy: "deny"` an account with an
unknown limit is **blocked** (not deferred: waiting does not make the limit known).

**Rollback:** set `"enforce": false` (accounting continues, nothing is refused) or
`wa resources stop` to halt all cloud and subscription dispatch immediately.

## Commands

| Command | Use |
|---|---|
| `wa resources` | dashboard: accounts, limits, health, DGX Spark capacity, 24h economics |
| `wa resources --watch [s]` | live refresh (reads the ledger and local probes; never polls providers) |
| `wa resources --json` | machine-readable snapshot |
| `wa resources init [--force]` | write a starting `resources.json` from detected runtimes and agents |
| `wa resources validate [--profile production] [--json]` | check policy, account mappings, limits and pricing, and preview admission per account (reserves nothing); exit 1 on errors |
| `wa resources stop [reason]` | **emergency stop**: no new cloud/subscription dispatch; local inference continues |
| `wa resources resume` | lift the stop |
| `wa resources reset <account>` | clear an auth/quota/cooldown block after fixing the cause |
| `wa resources explain <task-id>` | routing decisions, admissions and usage for a task |
| `wa resources events [--kind k]` | tail the append-only audit trail |

## Configuration

```jsonc
{
  "version": 1,
  "policy": {
    "enforce": true,                   // default false: limits are recorded, not enforced
    "mode": "local-first",            // balanced | local-first | quality-first | budget-first
    "paidApiFallback": false,          // paid API accounts are never used unless true (or account.allowPaid)
    "estimateMargin": 0.25,            // +25% on every token estimate
    "leaseMs": 900000,                 // unreconciled reservations are recovered after 15 min
    "maxTaskTokens": 200000,           // per-task ceiling across all its requests (0 = none)
    "dailySpendUsd": 5, "monthlySpendUsd": 50,   // paid API ceilings (0 = none)
    "localQueueTimeoutMs": 120000,     // how long a local request waits for a GPU slot
    "localOnlyWorkloads": [],          // privacy: these workloads never leave this machine
    "weights": { "cost": 1.0 }         // optional overrides of the mode's routing weights
  },
  "accounts": [
    { "id": "dgx", "label": "DGX Spark", "provider": "lmstudio", "kind": "local",
      "integration": "local-endpoint", "runtimeIds": ["lmstudio"], "maxConcurrent": 2, "priority": 10,
      "contextLimits": { "qwen/qwen3.8-27b": 32768 } },

    { "id": "claude-work", "label": "Subscription A", "provider": "anthropic", "kind": "subscription",
      "integration": "vendor-cli", "agents": ["claude-code@work"],
      "env": { "CLAUDE_CONFIG_DIR": "/home/me/.claude-work" },
      "reserveFor": ["complex", "critical-review"], "priority": 5,
      "limits": [
        { "unit": "requests", "window": "5h", "limit": 40, "source": "configured", "note": "set from your plan" },
        { "unit": "requests", "window": "week", "limit": null, "source": "estimated" } ] },

    { "id": "codex-personal", "label": "Subscription B", "provider": "openai", "kind": "subscription",
      "integration": "vendor-cli", "agents": ["codex"], "reserveFor": ["complex", "critical-review", "routine"],
      "limits": [{ "unit": "requests", "window": "5h", "limit": 30, "source": "configured" }] },

    { "id": "openai-api", "provider": "openai", "kind": "api", "integration": "api-key", "runtimeIds": ["openai"],
      "allowPaid": false, "rpm": 60, "tpm": 200000,
      "pricing": { "gpt-*": { "inputPerMTok": 2.5, "outputPerMTok": 10, "cachedInputPerMTok": 1.25 } },
      "limits": [{ "unit": "cost_usd", "window": "month", "limit": 20, "source": "configured" }] }
  ]
}
```

### Accounts

- **local:** a runtime on this machine (LM Studio, Ollama, or vLLM through the OpenAI-compatible adapter). `maxConcurrent` is the GPU concurrency; extra requests queue up to `localQueueTimeoutMs`.
- **api:** a provider API key, billed per token. It is used only when `policy.paidApiFallback` or `allowPaid` is true. Set `pricing` so costs and spend ceilings work.
- **subscription:** a consumer plan, used **only** through its vendor CLI (`integration: vendor-cli`), via a delegated agent. A second login of the same CLI is a separate agent instance, such as `claude-code@work`, whose `env` points the CLI at its own config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Wazir never extracts sessions, never rotates accounts to evade limits, and never stores keys in `resources.json` (validation rejects key-like env values).

### Limits and thresholds

Each limit has a `unit` (`tokens`, `input_tokens`, `output_tokens`, `requests`, `cost_usd`), a
`window` (rolling `5h`/`1m`/`24h`/`7d`, or calendar UTC `day`/`week`/`month`), a value (`null` =
unknown), and a `source`:

| source | meaning |
|---|---|
| `provider-reported` | read from the provider (rate-limit headers) |
| `provider-documented` | from the provider's published documentation |
| `configured` | your own budget |
| `estimated` | a guess; shown as such everywhere |

Utilization drives the budget mode. Defaults are below; set `thresholds` per limit to change them.

| Utilization | Mode | Admitted workloads |
|---|---|---|
| < 70% | normal | all permitted |
| ≥ 70% | advisory | all (flagged) |
| ≥ 85% | conserve | `reserveFor` (default complex, critical-review) |
| ≥ 95% | critical | `criticalOnly` (default critical-review) |
| would exceed 100% (hard) | exhausted | none: **deferred** until the window resets |

When a limit is unknown, `unknownLimitPolicy` decides: `allow` (admit, accounting only),
`conserve` (treat as conservation mode; the default for configured accounts), or `deny`.

### Workloads

`deterministic`, `summarization`, `bulk`, `routine`, `complex` and `critical-review` are derived
from the task's type, priority, capability category and prompt complexity:

- architecture, or complex repair: `complex`
- high or critical priority review: `critical-review`
- documents and summaries: `summarization`
- benchmarks and evaluation: `bulk`
- everything else: `routine`

## Routing

For the models the scheduler already finds capable, **hard constraints come first**. A dry-run
admission rejects a candidate whose account would refuse the request (privacy, auth, emergency
stop, paid not authorised, exhausted or conserving) and records the reason. For complex and
critical work, a candidate below half the best capability is rejected rather than substituted.
The rest are scored:

```
score = q·quality + r·reliability + c·capacity − k·cost − l·latency − u·quotaRisk
```

| Factor | How it is measured |
|---|---|
| quality | capability/evidence score, normalised |
| reliability | the model's success ratio on this account over 7 days, from the ledger |
| capacity | free GPU slots × residency for local (a loaded model with enough context = 1, needs reload = 0.3, not loaded = 0.2); 1 − utilization for others |
| cost | estimated $, normalised |
| latency | measured ms per output token |
| quotaRisk | from the budget mode |

Mode weights are in `DEFAULT_WEIGHTS` (`packages/core/src/resources/router.ts`). Every decision
and its factors go to the audit trail (`wa resources explain <task>`).

## Failure handling

| Failure | Behaviour |
|---|---|
| HTTP 401/403 | account **auth_blocked**; never retried; `wa resources reset <id>` after re-authenticating |
| quota exhausted (402, or 429 with quota wording) | **quota_blocked** until `Retry-After` or the window reset |
| HTTP 429 | **cooldown** for `Retry-After` (30 s default); admission defers until then |
| rate-limit headers showing 0 remaining | cooldown until the provider's reset time |
| context overflow (400) | classified `MODEL_CONTEXT_OVERFLOW`; not retried |
| refused or failed before any output | reservation **released** (nothing charged) |
| failed after output started, or a timeout with no status | **conservatively charged** at max(estimate, observed): the provider may have billed it |
| process died mid-request | lease expires; reservation charged conservatively once (idempotent) on the next start |
| duplicate callback/retry | idempotent per request id; second settlement ignored and audited |

Connect-phase retries stay in the adapters (bounded, with backoff). Auth and quota failures are
excluded from retries.

## What the numbers mean

- **Enforced:** dispatch budgets, inside Wazir. New requests cannot be admitted past a hard limit, because check-and-reserve is one SQLite write-locked transaction across processes.
- **Not guaranteed:** provider billing. Provider-side accounting can lag, and usage outside Wazir (the same account used elsewhere) is invisible to it.
- **Subscription usage is always an estimate:** vendor CLIs report no token counts. Set limits in requests, from your plan.
- **API cost** is computed as usage × configured prices. It is not a bill.

## Common operations

- **Keep paid APIs off entirely:** `"paidApiFallback": false` and no `allowPaid` (the default).
- **Stop everything that costs money now:** `wa resources stop "investigating spend"`.
- **An account shows auth_blocked:** sign in again with the vendor CLI (or `wa auth login`), then `wa resources reset <id>`.
- **Local requests time out queueing:** raise `maxConcurrent` if the GPU has headroom (see the dashboard throughput and memory), or raise `localQueueTimeoutMs`.
- **The ledger grows:** it is append-only by design. Archive `resources.db` and start fresh if needed (budgets restart from zero).
