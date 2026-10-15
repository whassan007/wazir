# Wazir Cross-Platform Compatibility Matrix

| Platform | Architecture | Controller Role | Worker Role | Hardware Acceleration | Tested Runtimes | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Linux (Ubuntu / Debian / RHEL)** | `arm64` | Supported | Supported | NVIDIA CUDA (GB10 sm_100, ATS UMA) | Ollama, vLLM, LM Studio, Native CLI | **Verified (DGX Spark)** |
| **Linux (Ubuntu / Debian / Fedora)** | `x64` | Supported | Supported | NVIDIA CUDA, AMD ROCm | Ollama, vLLM, LM Studio, Docker | **Verified** |
| **macOS (Sonoma / Sequoia / Tahoe)** | `arm64` (Apple Silicon) | Supported | Supported | Apple Metal / MLX Unified Memory | LM Studio, Ollama, MLX, llama.cpp | **Verified (M-Series)** |
| **macOS (Ventura / Sonoma)** | `x64` (Intel) | Supported | Supported | CPU (AVX2), eGPU AMD Metal | Ollama, llama.cpp | **Verified** |
| **Windows 10 / 11 / Server** | `x64` | Supported | Supported | NVIDIA CUDA, DirectML | LM Studio, Ollama, WSL2 | **Verified** |
| **Windows 11 on Snapdragon** | `arm64` | Experimental | Experimental | Qualcomm Hexagon NPU | ONNX Runtime, llama.cpp | **Preview / Experimental** |

---

## Hardware Accelerator Matrix

- **NVIDIA Blackwell GB10 (DGX Spark)**: Full support for CUDA 12.8+, sm_100 compute capability, and 122 GB ATS unified memory.
- **Apple Silicon (M1/M2/M3/M4)**: Full support for Metal Performance Shaders (MPS), MLX framework, and unified memory architecture.
- **NVIDIA GeForce RTX 30/40 Series & Ada Lovelace**: Full support on Windows x64 and Linux x64 with dedicated VRAM management and CUDA kernels.
