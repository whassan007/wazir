# NVIDIA Native Hosted Provider Architecture & Operations

Wazir integrates the **NVIDIA API Catalog (`https://integrate.api.nvidia.com/v1`)** as a first-class, policy-governed hosted inference provider (`provider: "nvidia"`, `runtimeKind: "hosted"`, `resourceType: "HOSTED_API_INFERENCE"`).

---

## 1. Architectural Overview

1. **Hosted Provider Identity (No Fake Local Node)**:
   - NVIDIA API Catalog is registered as a hosted runtime (`id: "nvidia"`, `runtimeKind: "hosted"`) and never creates a synthetic `Computer` or local worker node.
   - Local GPU execution on an NVIDIA DGX or workstation uses `placementKind: "local"`, `resourceType: "LOCAL_GPU_INFERENCE"`, and a concrete `computerId` (e.g., `dgx-spark-01`).
   - Hosted NVIDIA API execution uses `placementKind: "hosted"`, `resourceType: "HOSTED_API_INFERENCE"`, `runtimeId: "nvidia"`, and `computerId: undefined`.

2. **Authentication & Secret Redaction**:
   - Credential resolution checks `SecretBroker` (`wa auth login nvidia` stored under `provider:nvidia:credential`) and falls back to `NVIDIA_API_KEY` (or custom `providers.nvidia.apiKeyEnv`).
   - `redactProviderSecrets()` scrubs `nvapi-*`, `sk-*`, `Bearer <token>`, and resolved secret values from all HTTP errors, telemetry events, and CLI outputs (`wa auth status`, `wa providers list/inspect/test`, `wa doctor`).

3. **Model Discovery & Curated Metadata**:
   - Default initial target model: `nvidia/nemotron-3.5-super-vl-120b-a12b` (131,072 context window, 16,384 max output tokens, native tool calling, parallel tool calls, structured JSON schema output, vision/multimodal input, and reasoning via `extra_body.chat_template_kwargs.enable_thinking`).
   - Queries `GET /v1/models` on startup (configurable via `capabilities.discoverOnStartup`) and merges discovered models with explicitly configured `providers.nvidia.models` and `CURATED_NVIDIA_MODELS`, ensuring non-enumerable or preview endpoints remain usable.

4. **Streaming, Multimodal, Structured Output, & Tool Calling**:
   - Full SSE streaming (`stream: true`, `stream_options: { include_usage: true }`) separating `delta.reasoning_content` (`reasoning` events) from `delta.content` (`token` events) and reassembling streamed `delta.tool_calls` across index slots.
   - Automatic parameter fallback: if a model endpoint returns HTTP 400 rejecting `extra_body`, `parallel_tool_calls`, `stream_options`, or `seed`, `NvidiaAdapter` records the unsupported field for that model and retries cleanly without it.
   - Multimodal image inputs (`ChatMessage.images`) serialize to OpenAI-compatible `image_url` content parts and are gated by model capability metadata (`vision: true`).

5. **Retry Classification, Rate Limits, & Cancellation**:
   - Classifies HTTP 401/403 as `AUTH_FAILED` (no retry), HTTP 400 `context_length_exceeded` as `MODEL_CONTEXT_OVERFLOW` (no retry), HTTP 429 as `RATE_LIMIT` (honoring `Retry-After` and `x-ratelimit-*` headers), HTTP 5xx as `PROVIDER_TRANSIENT` (bounded exponential backoff), per-attempt timeouts as `TIMEOUT`, and `AbortSignal` / `adapter.cancel(requestId)` as `CANCELLED`.

6. **Policy Governance & No Unauthorized Fallback**:
   - Hosted NVIDIA inference is gated by `PolicyEngine.checkHostedEligibility()`.
   - When `localOnly: true`, `routingMode: "LOCAL_ONLY"`, or `dataClassification` is `sensitive`/`restricted`, NVIDIA hosted execution is strictly rejected.
   - If a local model is unavailable and policy does not permit hosted inference (`allowHostedProviders: false` and no `--allow-hosted` flag or `provider_only` policy), Wazir fails closed and never silently sends prompts to NVIDIA.

7. **Resource Accounting & Budget Admission**:
   - Tracked under account `api:nvidia` in `ResourceLedger` and `BudgetManager`.
   - Records `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, latency, and retry events.
   - When `providers.nvidia.pricing` (`inputPerMTok`, `outputPerMTok`) is configured, `costKnown: true` (`costStatus: "ACTUAL"`) is recorded in USD; otherwise `costKnown: false` (`costStatus: "UNKNOWN"`) is explicitly reported instead of fabricating a `$0.00` bill.

---

## 2. Configuration (`~/.wazir/config.json`)

```json
{
  "providers": {
    "allowHostedProviders": true,
    "nvidia": {
      "enabled": true,
      "type": "openai_compatible",
      "baseUrl": "https://integrate.api.nvidia.com/v1",
      "apiKeyEnv": "NVIDIA_API_KEY",
      "defaultModel": "nvidia/nemotron-3.5-super-vl-120b-a12b",
      "models": [
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "nvidia/llama-3.3-nemotron-super-49b-v1"
      ],
      "pricing": {
        "inputPerMTok": 1.2,
        "outputPerMTok": 2.4
      },
      "limits": {
        "window": "day",
        "maxTokens": 500000,
        "maxRequests": 1000,
        "maxOutputTokens": 16384,
        "maxRetries": 2
      }
    }
  },
  "routing": {
    "mode": "hybrid",
    "provider": "nvidia",
    "defaultModel": "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "allowFallback": true
  }
}
```

---

## 3. CLI Usage

```bash
# Authenticate or check status
export NVIDIA_API_KEY="nvapi-..."
wa auth status
wa providers list
wa providers inspect nvidia
wa providers test nvidia

# List discovered & curated NVIDIA models
wa models list

# Run a single prompt on NVIDIA
wa ask "Analyze the scheduler placement invariants" --allow-hosted --model nvidia/nemotron-3.5-super-vl-120b-a12b
wa ask "Explain the diff" --routing-mode NVIDIA

# Launch interactive Codex-style chat or Mission Control fleet dashboard
wa chat
wa fleet
```
