# Wazir functional regression suite

`manifest.json` is the source of truth for the 20 requested functional areas. Each case points to existing deterministic tests where available. The runner deduplicates shared test files, checks that manifest paths exist, and can run the deterministic set.

List the coverage and validate the manifest:

```sh
node tests/wazir-functional/run.mjs
```

Build the workspaces and run the deterministic cases:

```sh
node tests/wazir-functional/run.mjs --run
```

Use `--no-build` only when the workspace packages have already been built:

```sh
node tests/wazir-functional/run.mjs --run --no-build
```

Cases marked `live` require a real-model qualification run. Some deterministic cases also carry a `liveRequirement` for a higher-level real-model check. The manifest lists evidence needed; listing it does not claim that those runs happened or passed.
