# Observability Findings

The health command exposes runtime/model readiness, inference health, telemetry state, memory, queue, loaded model, and diagnostic reasons. In this run it accurately identified Google unavailable, LM Studio unreachable, critical memory, and missing telemetry for NVIDIA.

The requested lifecycle telemetry for a live Gemma request was not obtainable because no valid request could be submitted. No claims are made about task ID, queue duration, dispatch, first-token, generation, cancellation, or completion events.

