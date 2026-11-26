# UI Regression Matrix — Wazir Shell

| Scenario | Expected Behavior | Verified Result | Status |
|---|---|---|---|
| First launch | Opens `ONBOARDING` only; no About or Command Palette | Verified in `wazir-shell` native run | `VERIFIED_FIXED` |
| Review diagnostic data | Transitions `ONBOARDING` -> `DIAGNOSTICS_CONSENT` cleanly | Verified in `wazir-shell` native run | `VERIFIED_FIXED` |
| Decline diagnostics | Persists `declined: true` to `~/.wazir/consent.json`, purges queue, enables terminal | Verified in `cargo test` & native run | `VERIFIED_FIXED` |
| Native command execution | `pwd`, `ls`, `ls -la`, `git status`, `echo hello` execute in PTY | Verified in `COMMAND_EXECUTION_RESULTS.json` | `VERIFIED_FIXED` |
| Deterministic Tier 0 routing | `what time is it`, `what is the date`, `version`, `wa --version`, `show available models/computers/jobs` | Verified in `COMMAND_EXECUTION_RESULTS.json` | `VERIFIED_FIXED` |
| Ambiguous input clarification | `hello`, `run hello` show actionable clarification | Verified in `COMMAND_EXECUTION_RESULTS.json` | `VERIFIED_FIXED` |
| Command Palette (`Cmd+K`) | Opens single overlay, filters items, `Escape` closes and restores focus | Verified in `wazir-shell` native run | `VERIFIED_FIXED` |
| Settings (`Cmd+,`) | Opens Settings dialog, saves theme/fontSize/mode/permissions | Verified in `wazir-shell` native run | `VERIFIED_FIXED` |
| About dialog | Opens About dialog with `AGPL-3.0-only` license | Verified in `wazir-shell` native run | `VERIFIED_FIXED` |
| Fleet & Workflows drawer | Toggles drawer, loads jobs/computers/models/audit | Verified in `wazir-shell` native run | `VERIFIED_FIXED` |
| Split panes (`Cmd+Shift+D`) | Spawns independent PTY session in split grid | Verified in `wazir-shell` native run | `VERIFIED_FIXED` |
