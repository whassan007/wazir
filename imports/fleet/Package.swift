// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Fleet",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Fleet", targets: ["Fleet"]),
        .library(name: "FleetCore", targets: ["FleetCore"]),
    ],
    targets: [
        // Pure, testable logic: config, command parsing, planning, state machine,
        // runtime clients, SSH/process execution, probes.
        .target(name: "FleetCore"),
        // SwiftUI app (main window + menu bar extra + settings).
        .executableTarget(name: "Fleet", dependencies: ["FleetCore"]),
        .testTarget(name: "FleetCoreTests", dependencies: ["FleetCore"]),
    ]
)
