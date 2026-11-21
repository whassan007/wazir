# Third-Party Licenses & Attributions

Wazir AI OS incorporates or depends on the following third-party open-source software:

## 1. QwenLM/qwen-code (Apache License 2.0)
- **Used in:** `packages/agents/src/qwenCore/*`, `packages/tools/src/{editMatcher,multiEdit,readManyFiles,todoTool}.ts`
- **Copyright:** Alibaba Group / QwenLM Contributors
- **License:** Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)

## 2. Node.js Ecosystem Dependencies
- `commander` (MIT)
- `express` (MIT)
- `zod` (MIT)
- `@modelcontextprotocol/sdk` / `@modelcontextprotocol/server` (MIT)
- `esbuild` (MIT)
- `vitest` (MIT)
- `typescript` (Apache-2.0)
- `better-sqlite3` / `pg` (MIT)

## 3. Rust / Tauri Ecosystem Dependencies
- `tauri` & `tauri-build` (MIT OR Apache-2.0)
- `serde` & `serde_json` (MIT OR Apache-2.0)
- `rand` (MIT OR Apache-2.0)
- `portable-pty` (MIT)

## 4. Android / Jetpack Compose Dependencies
- AndroidX Core, Lifecycle, Activity Compose, Room, Material3 (Apache-2.0)
- Kotlinx Serialization & Coroutines (Apache-2.0)
- OkHttp (Apache-2.0)

## 5. Bundled Embedded / Edge AI Models & Runtimes
- **LiquidAI/LFM2.5-350M (`wazir-shell-mini`, `LFM2.5-350M-Q4_K_M.gguf`):**
  - *Notice:* "LFM 2.5 is licensed under the LFM Open License v1.0, Copyright (c) Liquid AI, Inc. All Rights Reserved."
  - *Upstream:* `https://huggingface.co/LiquidAI/LFM2.5-350M` and `https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF` (pinned revision `657e078c94084481950a2d555a941481f715536b`, SHA-256 `7e6f72643caafc9a68256686638c4d7916f2cec76d1df478d4c3ddcd95a6aed4`).
  - *License:* **LFM Open License v1.0** (`assets/models/wazir-shell-mini/LICENSE-LFM-1.0.txt`, `docs/legal/lfm-license-compliance.md`). Kept separate from Wazir's AGPL-3.0-only software license. Commercial use by entities with >= $10,000,000 USD annual revenue requires a commercial license from Liquid AI, Inc.
- **llama.cpp (`llama-server`):** MIT License (`https://github.com/ggml-org/llama.cpp`).
