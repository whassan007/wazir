import FleetCore
import SwiftUI

enum GenericWorkspace: String, CaseIterable, Hashable, Identifiable {
    case fleetOverview = "Fleet Overview"
    case visualStudio = "Visual Orchestration Studio"
    case physicalTopology = "Physical Resource Topology"
    case machineInventory = "Machine Inventory"
    case installedModels = "Installed Model Registry"
    case modelInstances = "Model Instance Management"
    case agentTasks = "Agent & Task Management"
    case decisionJournal = "Decision Journal"
    case improvementLoops = "Improvement Loops"
    case evaluationEvidence = "Evaluation & Evidence"
    case ontologyExplorer = "Ontology Explorer"
    case frameworkRegistry = "Framework Registry"
    case workflowLibrary = "Workflow Library"
    case backlogGraph = "Backlog & Dependencies"
    case modelIntelligence = "Model Intelligence"
    case resourceManagement = "Resource Management"
    case executionHistory = "Execution History"
    case extensionManager = "Extension Manager"
    case releaseReadiness = "Release Readiness"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .fleetOverview: "square.grid.2x2"
        case .visualStudio: "drop.halffull"
        case .physicalTopology: "network"
        case .machineInventory: "desktopcomputer"
        case .installedModels: "shippingbox"
        case .modelInstances: "cpu"
        case .agentTasks: "person.3"
        case .decisionJournal: "book.closed"
        case .improvementLoops: "arrow.triangle.2.circlepath"
        case .evaluationEvidence: "checkmark.seal"
        case .ontologyExplorer: "point.3.connected.trianglepath.dotted"
        case .frameworkRegistry: "shield.checkered"
        case .workflowLibrary: "flowchart"
        case .backlogGraph: "list.bullet.indent"
        case .modelIntelligence: "brain"
        case .resourceManagement: "server.rack"
        case .executionHistory: "clock.arrow.circlepath"
        case .extensionManager: "puzzlepiece.extension"
        case .releaseReadiness: "checkmark.shield"
        }
    }
}

struct GenericWorkspaceDetailView: View {
    var workspace: GenericWorkspace

    var body: some View {
        if workspace == .visualStudio {
            VisualOrchestrationStudioView()
        } else {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Image(systemName: workspace.symbol).font(.title2).foregroundStyle(Color.accentColor)
                    Text(workspace.rawValue).font(.title2.weight(.semibold))
                    Spacer()
                    Chip(text: "LIVE", color: .green)
                }
                Divider()
                Text("Fleet Core V2 Control Plane — \(workspace.rawValue) workspace.")
                    .font(.callout).foregroundStyle(.secondary)
                Text("Every quality score links to its underlying evaluation evidence in Evaluation & Evidence.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(20)
        }
    }
}
