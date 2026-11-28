import Foundation

/// Seed configuration written to `hosts.json` on first launch. Edit in Settings → Hosts
/// or directly in the JSON file; the app never overwrites an existing file.
public enum DefaultFleet {
    public static let config = FleetConfig(hosts: hosts)

    public static let hosts: [HostConfig] = [
        HostConfig(
            id: "jetson", name: "Jetson AGX Thor Developer Kit",
            aliases: ["thor", "agx"], role: "Robotics perception testbed",
            hardware: "NVIDIA Jetson AGX Thor", memoryGB: 128, os: .linux,
            tailscaleIP: "100.64.0.11", tailscaleName: "jetson-thor", sshTarget: "jetson",
            runtimes: [RuntimeConfig(kind: .ollama)]
        ),
        HostConfig(
            id: "dgx", name: "NVIDIA DGX Spark",
            aliases: ["spark", "dgx-spark"], role: "GB10 desktop AI system",
            hardware: "NVIDIA GB10 Grace Blackwell", memoryGB: 128, os: .linux,
            tailscaleIP: "100.64.0.12", tailscaleName: "dgx-spark", sshTarget: "dgx",
            runtimes: [RuntimeConfig(kind: .ollama), RuntimeConfig(kind: .lmstudio)]
        ),
        HostConfig(
            id: "gb10", name: "ASUS Ascent GX10",
            aliases: ["gx10", "ascent"], role: "GB10 Superchip node",
            hardware: "NVIDIA GB10 Superchip, 128 GB LPDDR5x", memoryGB: 128, os: .linux,
            tailscaleIP: "100.64.0.13", tailscaleName: "gx10", sshTarget: "gb10",
            runtimes: [RuntimeConfig(kind: .ollama)]
        ),
        HostConfig(
            id: "studio", name: "Apple Mac Studio",
            aliases: ["macstudio", "mac-studio"], role: "Apple silicon inference",
            hardware: "Apple Mac Studio", os: .macos,
            tailscaleIP: "100.64.0.14", tailscaleName: "studio", sshTarget: "studio",
            runtimes: [RuntimeConfig(kind: .ollama), RuntimeConfig(kind: .lmstudio), RuntimeConfig(kind: .mlx)]
        ),
        HostConfig(
            id: "macbook", name: "Apple M5 MacBook Pro",
            aliases: ["mbp", "m5", "laptop-mac", "local", "localhost"], role: "This Mac (local)",
            hardware: "Apple M5, 16 GB unified memory", memoryGB: 16, os: .macos,
            tailscaleIP: "100.64.0.15", tailscaleName: "macbook-pro", isLocal: true,
            runtimes: [RuntimeConfig(kind: .ollama), RuntimeConfig(kind: .lmstudio), RuntimeConfig(kind: .mlx, port: 8080)]
        ),
        HostConfig(
            id: "rtx", name: "RTX Workstation",
            aliases: ["workstation", "desktop", "rtx-desktop"], role: "Main desktop RTX machine",
            hardware: "NVIDIA RTX desktop", os: .windows,
            tailscaleIP: "100.64.0.16", tailscaleName: "rtx-desktop",
            runtimes: [RuntimeConfig(kind: .ollama)]
        ),
        HostConfig(
            id: "legion", name: "Lenovo Legion Laptop",
            aliases: ["laptop-rtx-win", "lenovo", "4080"], role: "Windows laptop",
            hardware: "NVIDIA RTX 4080 Laptop GPU", os: .windows,
            tailscaleIP: "100.64.0.17", tailscaleName: "laptop-rtx-win",
            runtimes: [RuntimeConfig(kind: .ollama)]
        ),
    ]
}
