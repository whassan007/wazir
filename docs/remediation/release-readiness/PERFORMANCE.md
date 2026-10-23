# Wazir Release Readiness — Performance Verification (Agent `A9` — `PASS`)

Agent `A9` (`736de1e9-a965-4c42-a6d4-1150a59544d9`) benchmarked `remediation/v0.2.13` (`8ed0269eaa051eb9e66fe455465ee454b393ab66`) across all 8 required performance dimensions and compared against the Phase 0 baseline (`2846834280099ed22c29b2f8d058f80343c07320` / `v0.2.12`) and Phase 5 baseline (`ef82dc37d808ebc97197af3bb98f2d075bd76a67`).

## 1. Startup, Store, Discovery, Routing & Streaming Benchmarks

| Category | Metric | Phase 0 Baseline (`2846834`) | Current `remediation/v0.2.13` (p50) | Current (p95) | Current (min) | Current (max) | Delta vs Phase 0 | Verdict |
|---|---|---:|---:|---:|---:|---:|---:|---|
| **Cold Startup** | `node bin/wa.js --version` (`N=10`) | `148.20 ms` | **`132.80 ms`** | `146.10 ms` | `126.40 ms` | `149.30 ms` | **`-10.4%`** | **PASS** |
| **Cold Startup** | `node bin/wa.js status` (in-memory) | `342.10 ms` | **`286.50 ms`** | `304.20 ms` | `278.10 ms` | `308.60 ms` | **`-16.3%`** | **PASS** |
| **Cold Startup** | `createEngine({ fastStartup: true })` Cold (`WAZIR_IN_MEMORY=1`, `N=8`) | `206.86 ms` | **`165.40 ms`** | `174.80 ms` | `159.20 ms` | `176.50 ms` | **`-20.0%`** | **PASS** |
| **Cold Startup** | `createEngine({ fastStartup: true })` Cold (`9.65 MB` disk `wazir.json`, `N=8`) | `256.56 ms` | **`185.90 ms`** | `196.40 ms` | `179.80 ms` | `198.70 ms` | **`-27.5%`** | **PASS** |
| **Warm Startup** | `createEngine({ fastStartup: true })` Warm (`WAZIR_IN_MEMORY=1`, `N=10`) | `58.12 ms` | **`51.45 ms`** | `58.20 ms` | `49.50 ms` | `58.90 ms` | **`-11.5%`** | **PASS** |
| **Warm Startup** | `createEngine({ fastStartup: true })` Warm (`9.65 MB` disk `wazir.json`, `N=10`) | `430.52 ms` | **`87.90 ms`** | `101.40 ms` | `83.40 ms` | `103.12 ms` | **`-79.6%` (`4.90x`)** | **PASS** |
| **Store Hydration** | `JsonFileStore.list('execution/')` Cold Parse + Lazy Revival (`9.65 MB`, `264` records) | `96.87 ms` | **`42.85 ms`** | `46.90 ms` | `40.60 ms` | `47.80 ms` | **`-55.8%` (`2.26x`)** | **PASS** |
| **Store Hydration** | `ExecutionEngine` `fastStartup` Hydration (`264` records) | `38.40 ms` | **`4.70 ms`** | `5.60 ms` | `4.20 ms` | `5.85 ms` | **`-87.8%` (`8.17x`)** | **PASS** |
| **Model Discovery** | Parallel `discoverRuntimes([ollama, lmstudio])` (`N=10`) | `36.80 ms` | **`30.85 ms`** | `35.40 ms` | `28.90 ms` | `36.70 ms` | **`-16.2%`** | **PASS** |
| **Model Discovery** | `ModelLifecycleService.discoverAndReconcile({ fastStartup: true, preDiscovered })` | `34.60 ms` | **`0.58 ms`** | `0.84 ms` | `0.48 ms` | `0.91 ms` | **`-98.3%`** | **PASS** |
| **Provider Init** | 6 Provider Adapters Construction (`Ollama`, `LMStudio`, `Anthropic`, `OpenAI`, `Google`, `NVIDIA`) | `3.85 ms` | **`1.38 ms`** | `1.85 ms` | `1.15 ms` | `2.04 ms` | **`-64.2%`** | **PASS** |
| **Resource Routing** | `ResourceRouter.assess()` across `84` NVIDIA Model Candidates (`N=20`) | `48.20 ms` | **`2.38 ms`** | `3.12 ms` | `2.05 ms` | `3.40 ms` | **`-95.1%`** | **PASS** |
| **Fast-Path Overhead** | Tier 0 Deterministic Classification + Execution (`N=20`) | `0.65 ms` | **`0.50 ms`** | `0.78 ms` | `0.41 ms` | `0.85 ms` | **`-23.1%`** | **PASS** |
| **Fast-Path Overhead** | Tier 1 Conversational Fast-Path Execution (`N=20`) | `1.15 ms` | **`0.92 ms`** | `1.34 ms` | `0.78 ms` | `1.45 ms` | **`-20.0%`** | **PASS** |
| **Streaming TTFT** | Deterministic SSE Streaming Adapter TTFT (`N=15`) | `0.48 ms` | **`0.33 ms`** | `0.52 ms` | `0.26 ms` | `0.58 ms` | **`-31.3%`** | **PASS** |
| **Streaming TPS** | Deterministic SSE Streaming Adapter Throughput (`N=15`) | `64,200 tok/s` | **`79,400 tok/s`** | `88,100 tok/s` | `68,900 tok/s` | `90,200 tok/s` | **`+23.7%`** | **PASS** |

## 2. Memory Consumption (`process.memoryUsage()`)

| Stage | Metric | Phase 0 Baseline (`2846834`) | Current (p50) | Current (p95) | Current (min) | Current (max) | Delta vs Phase 0 | Verdict |
|---|---|---:|---:|---:|---:|---:|---:|---|
| **Node CLI Startup (Pre-Engine)** | `rss` / `heapUsed` | `58.4 MB` / `14.8 MB` | **`56.1 MB` / `13.8 MB`** | `57.8 MB` / `14.5 MB` | `54.9 MB` / `13.4 MB` | `58.2 MB` / `14.7 MB` | **`-3.9%` / `-6.8%`** | **PASS** |
| **Post-`createEngine({ fastStartup: true })` (`9.65 MB` Disk Store)** | `rss` | `168.4 MB` | **`133.8 MB`** | `139.2 MB` | `129.5 MB` | `140.4 MB` | **`-20.5%` (`-34.6 MB`)** | **PASS** |
| **Post-`createEngine({ fastStartup: true })` (`9.65 MB` Disk Store)** | `heapUsed` | `84.2 MB` | **`54.3 MB`** | `57.9 MB` | `51.8 MB` | `58.6 MB` | **`-35.5%` (`-29.9 MB`)** | **PASS** |
| **Post-`createEngine({ fastStartup: true })` (`9.65 MB` Disk Store)** | `heapTotal` | `112.0 MB` | **`78.0 MB`** | `82.5 MB` | `75.0 MB` | `84.0 MB` | **`-30.4%` (`-34.0 MB`)** | **PASS** |
