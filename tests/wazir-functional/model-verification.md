# Model verification

Eight isolated roles A1–A8 used the available `gpt-6-luna` agent launcher model at high reasoning effort. The launcher's actual model list did not contain the requested Qwen, Claude, Gemini, GPT-5 Codex, or GPT-5.3 identifiers. `gpt-6-luna` is described by that launcher as its fast, affordable model. No provider prices or individual agent charges were measured. The four-slot limit required sequential batches. Each role used its own branch and worktree under `/private/tmp/wazir-repair-a{1,2,3,4,5,6,7,8}`. Direct shell, TypeScript and Vitest execution provided the bootstrap alternative, independent of Wazir routing.

Live LM Studio discovery on 2026-10-23 returned:

| Model | Runtime state | Advertised context | Loaded context |
|---|---|---:|---:|
| google/gemma-4-12b-qat | loaded, GGUF Q4_0 | 262144 | 8192 |
| qwen2.5-coder-14b-instruct | not loaded, MLX 4bit | 32768 | unknown |
| qwen/qwen3.8-27b | not loaded, MLX 4bit | 262144 | unknown |

Sources: actual local `GET http://localhost:1234/v1/models` and `/api/v0/models`. A catalog listing alone is not inference verification. Final live execution evidence and actual model attribution belong to `execution-results.csv` and the saved execution records.

The host reports Darwin arm64 and 25,769,803,776 bytes (24 GiB) of physical memory. At 08:06:15 UTC, Node reported 377,307,136 immediately free bytes. A nearby `vm_stat` sample used 16,384-byte pages and reported 8,635 free, 112,994 inactive, 10,862 speculative and 1,060 purgeable pages. These samples are not simultaneous and do not establish the historical 0.1 GiB value. Current telemetry counts reclaimable queues conservatively, without adding purgeable pages again. The scheduler still applies safety reserves; reclaimability is not a guarantee of successful allocation.

Live acceptance uses isolated homes/projects and local routing. Hosted credentials are removed from test process environments; no new hosted inference budget is authorized by these tests. No model download, unrelated process termination, push or publication is part of this repair.
