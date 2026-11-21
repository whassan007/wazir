# Liquid AI LFM2.5-350M (`wazir-shell-mini`) License Compliance Report

## 1. Artifact Identification & Provenance

| Property | Value |
|---|---|
| **Wazir Model ID** | `wazir-shell-mini` |
| **Runtime Provider** | `wazir-embedded` |
| **Upstream Base Model** | [`LiquidAI/LFM2.5-350M`](https://huggingface.co/LiquidAI/LFM2.5-350M) |
| **Upstream GGUF Distribution** | [`LiquidAI/LFM2.5-350M-GGUF`](https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF) |
| **Pinned Upstream Revision** | `657e078c94084481950a2d555a941481f715536b` |
| **Bundled Weight File** | `assets/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf` |
| **Weight File Size** | `229,129,280` bytes (`218.51 MB`) |
| **Weight File SHA-256** | `7e6f72643caafc9a68256686638c4d7916f2cec76d1df478d4c3ddcd95a6aed4` |
| **Model License** | **LFM Open License v1.0** (`assets/models/wazir-shell-mini/LICENSE-LFM-1.0.txt`) |
| **License File SHA-256** | `5188f2b355da20647257a3156db5834c794e5fb5e6d8dc4d4cdbb3180e75b85b` |
| **Inference Engine** | `llama.cpp` (`llama-server`, MIT License, [`ggml-org/llama.cpp`](https://github.com/ggml-org/llama.cpp)) |

## 2. Separation of Software License and Model License

Wazir maintains a strict legal and technical separation between its software source code/binaries and the bundled model weights:

1. **Wazir Software (`AGPL-3.0-only`):** All Wazir core, CLI, runtime adapter, and desktop shell source code remains licensed under the GNU Affero General Public License v3.0 (`LICENSE`).
2. **Inference Runtime (`MIT`):** The bundled native `llama-server` binaries and `ggml`/`llama` shared libraries in `assets/runtimes/<platform-arch>/` are licensed under the MIT License (`ggml-org/llama.cpp`).
3. **Bundled Model Weights (`LFM Open License v1.0`):** The model file `assets/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf` is distributed as a separate file on disk alongside `LICENSE-LFM-1.0.txt`, `MODEL_CARD.md`, `BASE_MODEL_CARD.md`, and `manifest.json`. Model weights are **never** compiled or embedded into the Node.js Single Executable Application (`bin/wa.js`).

## 3. Compliance with LFM Open License v1.0 Redistribution Terms

Per Section 3 ("Redistribution and Derivative Works") of the **LFM Open License v1.0**:

- **Inclusion of License Copy:** A complete, unmodified copy of the LFM Open License v1.0 is bundled at `assets/models/wazir-shell-mini/LICENSE-LFM-1.0.txt` (SHA-256: `5188f2b355da20647257a3156db5834c794e5fb5e6d8dc4d4cdbb3180e75b85b`).
- **Required Attribution Notice:** Both `NOTICE`, `THIRD_PARTY_LICENSES.md`, and `assets/models/wazir-shell-mini/MODEL_CARD.md` prominently display the mandatory attribution notice required by Section 3(c) of the LFM Open License v1.0:
  > *"LFM 2.5 is licensed under the LFM Open License v1.0, Copyright (c) Liquid AI, Inc. All Rights Reserved."*

## 4. Mandatory Commercial-Use Revenue Gate ($10,000,000 USD Threshold)

Under Section 2 of the **LFM Open License v1.0**:

- **Entities Below $10M Annual Revenue:** Individual developers, academic researchers, non-profits, and commercial legal entities with **less than $10,000,000 USD in annual gross revenue** are permitted to use and redistribute `LFM2.5-350M-Q4_K_M.gguf` free of charge under the LFM Open License v1.0.
- **Entities At or Above $10M Annual Revenue (Mandatory Gate):** If the licensee or downstream distributor is a legal entity (or affiliate group) with **$10,000,000 USD or more in annual revenue**, commercial use or commercial redistribution of the bundled `LFM2.5-350M-Q4_K_M.gguf` weights requires a separate commercial license agreement directly from **Liquid AI, Inc.** (`https://www.liquid.ai`).
- **Operator Override / Opt-Out for Enterprise Deployments:** Enterprises exceeding the $10M annual revenue threshold that have not executed a commercial agreement with Liquid AI can disable or remove the bundled model weights without breaking Wazir Shell:
  - Set `WAZIR_DISABLE_EMBEDDED_MODEL=1`, or
  - Remove `assets/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf` (or `~/.wazir/models/wazir-shell-mini/LFM2.5-350M-Q4_K_M.gguf`), in which case Path A deterministic commands (`ls`, `pwd`, `git status`, `what time is it`, etc.) and Path C external/local providers continue to function normally.
