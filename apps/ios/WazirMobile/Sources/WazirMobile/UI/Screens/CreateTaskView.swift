import SwiftUI

struct CreateTaskView: View {
    @ObservedObject var viewModel: MainViewModel
    var onSubmitted: (String) -> Void
    var onCancel: () -> Void

    @State private var input = ""
    @State private var title = ""
    @State private var repository = ""
    @State private var modelId: String?
    @State private var agentId: String?
    @State private var computerId: String?
    @State private var priority = "normal"

    private let priorities = ["low", "normal", "high", "urgent"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("What should the agent do?", text: $input, axis: .vertical)
                        .lineLimit(3...8)
                    TextField("Title (optional)", text: $title)
                    TextField("Repository (optional)", text: $repository)
                }

                Section("Routing") {
                    Picker("Model", selection: $modelId) {
                        Text("Controller default").tag(String?.none)
                        ForEach(viewModel.state.models) { model in
                            Text(model.name).tag(String?.some(model.id))
                        }
                    }
                    Picker("Agent", selection: $agentId) {
                        Text("Controller default").tag(String?.none)
                        ForEach(viewModel.state.agents) { agent in
                            Text(agent.name).tag(String?.some(agent.name))
                        }
                    }
                    Picker("Computer", selection: $computerId) {
                        Text("Controller default").tag(String?.none)
                        ForEach(viewModel.state.computers) { computer in
                            Text(computer.name).tag(String?.some(computer.id))
                        }
                    }
                    Picker("Priority", selection: $priority) {
                        ForEach(priorities, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                }

                if viewModel.state.isSubmittingTask {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .navigationTitle("New Task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") { submit() }
                        .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.state.isSubmittingTask)
                }
            }
        }
    }

    private func submit() {
        let request = CreateTaskRequest(
            input: input,
            title: title.isEmpty ? nil : title,
            repository: repository.isEmpty ? nil : repository,
            modelId: modelId,
            agentId: agentId,
            computerId: computerId,
            priority: priority
        )
        viewModel.submitNewTask(request, onSubmitted: onSubmitted)
    }
}
