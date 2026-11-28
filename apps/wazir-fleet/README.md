# Fleet

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)

A native macOS (SwiftUI) dashboard and command console for a local LLM compute fleet:
Jetson AGX Thor, DGX Spark, ASUS GX10, Mac Studio, M5 MacBook Pro, the RTX workstation and the
Legion laptop, over Tailscale or the LAN. It covers Ollama, LM Studio, llama.cpp and MLX.

## Build & run

```sh
scripts/bundle.sh --open        # release build → build/Fleet.app (ad-hoc signed), then launch
scripts/bundle.sh --install     # copy to /Applications
swift test                      # unit tests (parser, planner, state machine, wire formats)
FLEET_LIVE=1 swift test --filter Live   # read-only smoke test against the real fleet
```

Run the bundled app rather than `swift run`. Only the bundle carries the Info.plist ATS
exception needed for plain-HTTP runtime APIs on 100.x and LAN addresses.

## Using it

- **Main window**: Overview grid (reachability, latency, IPs, runtimes, loaded models, mem/CPU/GPU
  meters), per-host detail (model tables with Reload/Update/Remove context menus and an
  Add Model button per runtime), and Activity (per-step status, progress, streamed logs, cancel).
- **Flow**: a liquid-cooling view of work moving through the fleet. The command is the pump and
  each plan step is a block named after its host. Coolant fills the tubes as steps start and is
  colored by status: blue while running, green when done, amber on retry, and a pulsing red on
  failure. A Gantt strip underneath shows the timing. Pick any operation from the source menu, or
  choose "Agent run" to watch a planner, parallel workers, a synthesizer and a critic spread
  across the models on your machines. **Simulated** (the default) sends nothing to any host.
  **Live** runs every agent as a streamed `/v1/chat/completions` call (Ollama, LM Studio,
  llama.cpp and MLX all serve it) against chat models on online machines. It prefers loaded
  models and interleaves machines so parallel workers land on different hardware. A failed agent
  fails over once to a model on another machine, shown amber in the loop. Click any block to
  see its streamed output; the Result block holds the critic's final answer.
- **Menu bar extra**: fleet status at a glance, running ops, and a quick command field.
- **Command bar** (⌘K, ↑/↓ for history):

```
add model qwen2.5 on machine jetson
pull llama3.2:3b to dgx via ollama --live
remove gemma3 from studio
update qwen2.5, llama3.2 on jetson and dgx
reload qwen3:8b @gb10
add mlx-community/Qwen3-4B-4bit on studio
add unsloth/Qwen3-8B-GGUF:Q4_K_M on macbook with llamacpp
add model=qwen2.5 host=jetson runtime=ollama --dry-run
refresh · refresh dgx · list studio · help
```

Every mutation first opens a **plan sheet** showing the exact HTTP request or SSH command per
step. For Ollama pulls it also shows a registry check (does the model exist, "did you mean",
download size) plus memory-fit and large-download warnings. Plans default to **dry-run**, which
sends nothing to any host. A live delete also needs a confirmation checkbox. When a live
operation finishes, the touched hosts' inventories are refreshed.

## How operations are executed

| Runtime   | Inventory                     | add / update                 | remove                | reload                     |
|-----------|-------------------------------|------------------------------|-----------------------|----------------------------|
| Ollama    | `/api/tags`, `/api/ps`        | `POST /api/pull` (streamed)  | `DELETE /api/delete`  | unload (`keep_alive:0`) + load |
| LM Studio | `/api/v0/models`              | `ssh … lms get`              | not supported by default | `ssh … lms unload; lms load` |
| llama.cpp | `/v1/models`                  | `ssh … hf download --include *QUANT*.gguf` into `modelsDir` | `rm -rf` that dir | configure |
| MLX       | `/v1/models`                  | `ssh … hf download <repo>`   | delete HF cache dir   | configure                  |

SSH runs with `BatchMode=yes` and never prompts, using your `~/.ssh/config` hosts. Every value
substituted into a command is shell-quoted, and model names are checked against a strict
character set. Default SSH templates assume a POSIX shell, so on the Windows hosts only Ollama
over HTTP works unless you give explicit commands.

## Configuration

`~/Library/Application Support/Fleet/hosts.json` is seeded on first launch with an example
seven-machine fleet (`Sources/FleetCore/DefaultFleet.swift`, placeholder `100.64.0.x` addresses) and never overwritten.
You can edit it in **Settings → Hosts** or by hand. Per host you can set: `id`, `aliases`,
`tailscaleIP`/`lanIP`, `sshTarget`, `os`, `isLocal`, `collectMetrics` and `runtimes[]`. Each
runtime takes `kind`, `port`, `baseURL` (for example an SSH tunnel), `modelsDir` and `commands`
(`add`/`remove`/`update`/`reload` templates). Templates accept the placeholders `{model}`,
`{repo}`, `{repoSlug}`, `{include}`, `{modelsDir}`, `{hfCacheDir}` and `{hfCacheName}`.
Global settings are `pollIntervalSeconds`, `dryRunByDefault`, timeouts, `registryLookup` and
`largeDownloadWarningGB`.

## Architecture

- `FleetCore` (library, no UI):
  - `CommandParser`: deterministic parsing of natural-language and structured commands.
  - `Planner` and `PlanEnricher`: pure functions from command + state to a plan.
  - `FleetReducer`: all state transitions, including the operation and step state machine,
    which rejects illegal transitions and records them as diagnostics.
  - Runtime clients, `ReachabilityProbe` (TCP races with a hard timeout), Tailscale status,
    SSH metrics, `PlanExecutor`.
- `Fleet` (app): the `@MainActor @Observable FleetStore` sends every change through the reducer.
  Probes run concurrently off the main actor, and overlapping refreshes of the same host are
  merged into one. The app re-polls after the Mac wakes. Hosts that are offline keep their
  last-known inventory, marked stale.

## Requirements

macOS 15+, Swift 6 toolchain (Xcode 16 or newer). Runtimes you want to manage must listen on a
reachable address (for Ollama, `OLLAMA_HOST=0.0.0.0`).

## License

Fleet is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
Personal, hobby, research, educational, nonprofit and government use are allowed, including
changes and redistribution under the same terms. **Any commercial use is prohibited.** For a
commercial license, open an issue to get in touch.

Because it restricts commercial use, this license is not an OSI-approved open-source license.
