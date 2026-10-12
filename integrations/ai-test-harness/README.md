# Wazir in schubergphilis/ai-test-harness

Runs Wazir through the [ai-test-harness](https://github.com/schubergphilis/ai-test-harness)
compat contract (`GET /ping`, `POST /invocations`) and the same conformance, Inspect
(repeatability, prompt injection) and behaviour-scenario suites as Strands, LangGraph,
OpenAI Agents and the other reference harnesses.

The harness loop runs on Wazir's own OpenAI-compatible runtime adapter
(`@wazir/runtimes-lmstudio`) and validates tool arguments with Wazir's
`compileToolSchema`, so the suites exercise Wazir's streaming, tool-call parsing,
retry, cancellation and argument validation.

```bash
npm run build                                   # in this repo
git clone https://github.com/schubergphilis/ai-test-harness.git
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
