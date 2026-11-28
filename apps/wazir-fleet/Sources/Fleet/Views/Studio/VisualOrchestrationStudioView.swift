import FleetCore
import SwiftUI

/// Primary 5-region Visual Orchestration Studio connected to FleetStore & ControlPlaneRuntime.
struct VisualOrchestrationStudioView: View {
    @Environment(FleetStore.self) private var store
    @State private var targetRepoPath: String = FileManager.default.currentDirectoryPath
    @State private var objectiveText: String = "Implement and verify the requested feature in the target repository"
    @State private var viewMode: StudioViewMode = .logical
    @State private var zoomLevel: Double = 1.0
    @State private var selectedMachineID: String?
    @State private var participatingMachines: [String] = []
    @State private var selectionModes: [String: String] = [:] // machineID -> AUTO / PREFERRED / PINNED

    enum StudioViewMode: String, CaseIterable {
        case logical = "Logical Workflow"
        case physical = "Physical Deployment"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Top Project Repository & Toolbar Bar
            HStack(spacing: 10) {
                Image(systemName: "folder.badge.gearshape").foregroundStyle(Color.accentColor)
                Text("Repo:").font(.caption).foregroundStyle(.secondary)
                Text(store.projectFolderPath)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 320, alignment: .leading)
                Button("Load Folder…") { store.promptForProjectFolder() }
                    .controlSize(.small)
                Picker("View", selection: $viewMode) {
                    ForEach(StudioViewMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 240)
                Spacer()
                Button("Validate") {}
                Button("Run") {}.buttonStyle(.borderedProminent)
            }
            .padding(10)
            .background(.bar)

            Divider()

            HSplitView {
                // Left Sidebar: Resource Inventory
                List(store.orderedHosts, id: \.0.id) { cfg, hs in
                    HStack {
                        StatusDot(color: hs.reachability.color, pulsing: hs.isProbing)
                        VStack(alignment: .leading) {
                            Text(cfg.name).font(.callout)
                            Text("\(hs.modelCount) models · \(hs.reachability.shortLabel)")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("+") {
                            if !participatingMachines.contains(cfg.id) { participatingMachines.append(cfg.id) }
                            selectedMachineID = cfg.id
                        }
                        .buttonStyle(.borderless)
                        .help("Add \(cfg.name) to orchestration canvas")
                    }
                }
                .frame(minWidth: 210, maxWidth: 250)

                // Center: Interactive Orchestration Canvas
                VStack(spacing: 12) {
                    HStack {
                        Text("\(viewMode.rawValue) · Semantic Zoom: \(Int(zoomLevel * 100))%")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Slider(value: $zoomLevel, in: 0.4...2.0).frame(width: 120)
                    }
                    .padding(.horizontal, 12).padding(.top, 8)

                    TextField("Project Objective", text: $objectiveText)
                        .textFieldStyle(.roundedBorder)
                        .padding(.horizontal, 12)

                    if participatingMachines.isEmpty {
                        ContentUnavailableView(
                            "Add Physical Machines to Canvas",
                            systemImage: "server.rack",
                            description: Text("Click + on any machine in the Resource Inventory to compose your distributed AI system.")
                        )
                    } else {
                        ScrollView {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220))], spacing: 12) {
                                ForEach(participatingMachines, id: \.self) { id in
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack {
                                            Text(id).font(.headline)
                                            Spacer()
                                            Chip(text: selectionModes[id] ?? "AUTO", color: .blue)
                                        }
                                        Text(zoomLevel < 0.65 ? "Stage Group" : (zoomLevel > 1.35 ? "Slots & Agents" : "Machine & Models"))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    .padding(12)
                                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
                                    .onTapGesture { selectedMachineID = id }
                                }
                            }
                            .padding(12)
                        }
                    }
                    Spacer()
                }
                .frame(minWidth: 420, maxWidth: .infinity)

                // Right Sidebar: Configuration Inspector
                VStack(alignment: .leading, spacing: 10) {
                    Text("Configuration Inspector").font(.headline)
                    if let id = selectedMachineID {
                        Text("Selected: \(id)").font(.callout.monospaced())
                        Picker("Model Policy", selection: Binding(
                            get: { selectionModes[id] ?? "AUTO" },
                            set: { selectionModes[id] = $0 }
                        )) {
                            Text("AUTO").tag("AUTO")
                            Text("PREFERRED").tag("PREFERRED")
                            Text("PINNED").tag("PINNED")
                        }
                        .pickerStyle(.segmented)
                    } else {
                        Text("Select a machine or node on the canvas.").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(12)
                .frame(minWidth: 220, maxWidth: 260)
            }
        }
    }
}
