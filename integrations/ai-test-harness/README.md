# Wazir in schubergphilis/ai-test-harness

Runs Wazir through the [ai-test-harness](https://github.com/schubergphilis/ai-test-harness)
compat contract (`GET /ping`, `POST /invocations`) and the same conformance, Inspect
(repeatability, prompt injection) and behaviour-scenario suites as Strands, LangGraph,
OpenAI Agents and the other reference harnesses.

The compatibility adapter invokes Wazir's production `CodingAgent.run`, through
`LMStudioAdapter.generate`. It preserves the upstream simulated tool implementations,
validates arguments, propagates user/session identifiers into OpenTelemetry spans,
reports runtime token usage, and cancels generation on disconnect. Native runs bind
loopback. Session identifiers are correlation identifiers; this upstream interface
does not provide persistent conversation memory or a production authorization boundary.

The original adapter implemented its own tool loop. Its old results established runtime
adapter coverage only. Current results exercise the production agent loop; CLI/scheduler,
physical tools, persistence, and browser wiring require the separate Wazir suites.
Both pinned upstreams are Apache-2.0; generated upstream files retain their attribution.

Wazir can stop a runaway task before `AGENT_MAX_TURNS` when its repeat-action guard
fires. The pinned upstream `perf/respects_turn_limit` scorer requires exactly the
configured call count, so it reports a failure for this stricter bound. Keep that
failure visible; do not disable Wazir's guard to improve the upstream score.

```bash
npm run build                                   # in this repo
git clone https://github.com/schubergphilis/ai-test-harness.git
git -C ai-test-harness checkout "$(node -p 'require("./integrations/ai-test-harness/upstream-revisions.json")["ai-test-harness"].commit')"   # install.sh requires the pinned revision
integrations/ai-test-harness/install.sh ./ai-test-harness
cd ai-test-harness && cp .env.example .env
make native-up
make test-native HARNESS=wazir      # conformance on the mock model
python3 qa/run.py --models mock --harnesses strands,wazir \
  --suites conformance,inspect,scenarios,perf --epochs 3      # side by side with Strands
```

For a live model, point `SOVEREIGN_LITELLM_BASE_URL` / `SOVEREIGN_MODEL` in `.env` at
any OpenAI-compatible endpoint (e.g. LM Studio `http://127.0.0.1:1234/v1`), run
`make gen && make native-down && make native-up`, then use `--models sovereign`.
