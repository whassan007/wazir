# Telemetry & Diagnostics Privacy Policy

**Notice Version:** `2026-11-20.1`

## 1. Affirmative Consent Gate
- On first launch of Wazir Shell or via `wa diagnostics notice`, users are presented with the licensing and diagnostic disclosure.
- Agreement is **never preselected**.
- **Zero telemetry** is queued or transmitted before affirmative acceptance.
- Declining disables diagnostics completely and **never blocks or alters** the native OS shell.

## 2. Minimum Diagnostic Schema (`@wazir/observability`)
Only the following fields are allowlisted:
- `eventId`, `appVersion`, `osFamily`, `arch`, `errorCode`, `failureCategory`, `component`, `exceptionCategory`, `taskPhase`, `workerCapability`, `modelCategory`, `timestamp`, `installationId` (random UUID), `noticeVersion`, `fingerprint`, and bounded `sanitizedNote`.

## 3. Redaction & Deletion
- Raw shell history, source files, prompts, environment variables, API keys, tokens, emails, IPv4 addresses, and private paths are stripped by `redactDiagnosticPayload()` on both client and server.
- Users may purge queued/stored events via `wa diagnostics purge` or `DELETE /api/v1/diagnostics/events`.
- Rich analytics (extended traces, profiling) require separate opt-in.
