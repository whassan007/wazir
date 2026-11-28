// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Fleet",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Fleet", targets: ["Fleet"]),
        .executable(name: "fleet", targets: ["FleetCLI"]),
        .library(name: "FleetCore", targets: ["FleetCore"]),
    ],
    targets: [
        // Pure, testable logic: config, command parsing, planning, state machine,
        // runtime clients, SSH/process execution, probes, orchestration, evaluation,
        // optimization loops, ontology, policies, workflows, extension SDK.
        .target(
            name: "FleetCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        // SwiftUI app (main window + menu bar extra + settings).
        .executableTarget(name: "Fleet", dependencies: ["FleetCore"]),
        // Headless CLI & JSON control-plane interface sharing FleetCore contracts.
        .executableTarget(name: "FleetCLI", dependencies: ["FleetCore"]),
        .testTarget(name: "FleetCoreTests", dependencies: ["FleetCore"]),
    ]
)
