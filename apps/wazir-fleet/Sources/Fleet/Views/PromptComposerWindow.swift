import AppKit
import FleetCore
import SwiftUI

struct PromptComposerView: View {
    @Environment(FleetStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    enum SourceTab: String, CaseIterable {
        case local = "Local Fleet Model ($0)"
        case cloud = "Frontier Cloud Model"
    }

    @State private var sourceTab: SourceTab = .local
    @State private var selectedSourceID: String = ""
    @State private var style: PromptTemplateStyle = .engineeringGoal
    @State private var includeRepoContext = true
    @State private var roughIdea = ""
    @State private var generatedPrompt = ""
    @State private var isGenerating = false
    @State private var generationTask: Task<Void, Never>?

    private var localSources: [PromptGeneratorSource] {
        var out: [PromptGeneratorSource] = []
        for (cfg, hs) in store.orderedHosts where hs.reachability.isOnline {
            for (kind, m) in hs.allModels {
                guard let rt = cfg.enabledRuntimes.first(where: { $0.kind == kind }),
                      let base = Endpoint.baseURL(host: cfg, runtime: rt, state: hs) else { continue }
                out.append(.localModel(hostID: cfg.id, hostName: cfg.name, model: m.name,
                                       runtime: kind, baseURL: base, isLoaded: m.isLoaded))
            }
        }
        return out.sorted { a, b in
            let l0: Bool = { if case .localModel(_, _, _, _, _, let l) = a { return l }; return false }()
            let l1: Bool = { if case .localModel(_, _, _, _, _, let l) = b { return l }; return false }()
            return l0 && !l1
        }
    }

    private var cloudSources: [PromptGeneratorSource] {
        var out: [PromptGeneratorSource] = []
        let snaps = store.state.cloudSnapshots.isEmpty
            ? Dictionary(uniqueKeysWithValues: CloudServiceBudgetEngine().discoverAll(configs: store.config.cloudServices).map { ($0.id, $0) })
            : store.state.cloudSnapshots
        for cfg in store.config.cloudServices {
            let models = snaps[cfg.id]?.discoveredModels ?? []
            for m in models {
                out.append(.cloudModel(providerID: cfg.id, providerName: cfg.displayName,
                                       modelID: m.id, executablePath: cfg.executablePath))
            }
        }
        return out
    }

    private var currentSources: [PromptGeneratorSource] {
        sourceTab == .local ? localSources : cloudSources
    }

    private var activeSource: PromptGeneratorSource? {
        currentSources.first { $0.id == selectedSourceID } ?? currentSources.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Image(systemName: "sparkles").font(.title2).foregroundStyle(Color.accentColor)
                Text("AI Prompt Studio").font(.title2.weight(.semibold))
                Spacer()
                let repoName = URL(fileURLWithPath: store.projectFolderPath).lastPathComponent
                Chip(text: "\(repoName) · \(store.projectContext?.gitBranch ?? "repo")", color: .blue, systemImage: "folder.fill")
                Button("Load Folder…") { store.promptForProjectFolder() }.controlSize(.small)
            }

            // Model & Style Controls
            HStack(spacing: 10) {
                Picker("Source", selection: $sourceTab) {
                    ForEach(SourceTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 310)

                Picker("Model", selection: $selectedSourceID) {
                    ForEach(currentSources) { src in
                        Text(src.displayName).tag(src.id)
                    }
                }
                .frame(minWidth: 220)

                Picker("Style", selection: $style) {
                    ForEach(PromptTemplateStyle.allCases) { s in
                        Text(s.rawValue).tag(s)
                    }
                }
                .frame(width: 200)
            }

            Toggle("Include active project repository context (branch, build system, tracked files)", isOn: $includeRepoContext)
                .font(.caption)

            // Rough Idea Input
            Text("Your Rough Idea or Goal").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $roughIdea)
                .font(.body)
                .frame(height: 90)
                .padding(6)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))

            HStack {
                Button {
                    generate()
                } label: {
                    Label(isGenerating ? "Generating…" : "Create Prompt with AI", systemImage: "wand.and.stars")
                }
                .buttonStyle(.borderedProminent)
                .disabled(roughIdea.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isGenerating)

                if isGenerating {
                    Button("Stop") { generationTask?.cancel(); isGenerating = false }
                }
                Spacer()
                if let src = activeSource {
                    Text("Using: \(src.displayName)").font(.caption).foregroundStyle(.secondary)
                }
            }

            // Generated Prompt Output
            Text("Generated Prompt (Editable)").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $generatedPrompt)
                .font(.body.monospaced())
                .frame(minHeight: 160)
                .padding(6)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))

            // Footer
            HStack {
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(generatedPrompt, forType: .string)
                }
                .disabled(generatedPrompt.isEmpty)
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Apply to Prompt") {
                    store.activePromptText = generatedPrompt
                    dismiss()
                }
                .disabled(generatedPrompt.isEmpty)
                Button("Apply & Open in Flow") {
                    store.activePromptText = generatedPrompt
                    store.selection = .flow
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(generatedPrompt.isEmpty)
            }
        }
        .padding(18)
        .onAppear {
            if selectedSourceID.isEmpty, let first = currentSources.first { selectedSourceID = first.id }
            if generatedPrompt.isEmpty { generatedPrompt = store.activePromptText }
        }
        .onChange(of: sourceTab) { _, _ in
            selectedSourceID = currentSources.first?.id ?? ""
        }
    }

    private func generate() {
        let engine = PromptArchitectEngine()
        let ctx = includeRepoContext ? store.projectContext : nil
        guard let src = activeSource else {
            generatedPrompt = engine.synthesizeStructuredFallbackPrompt(roughIdea: roughIdea, style: style, repoContext: ctx)
            return
        }
        isGenerating = true
        generatedPrompt = ""
        generationTask = Task {
            do {
                for try await text in engine.generatePrompt(roughIdea: roughIdea, style: style, source: src, repoContext: ctx) {
                    await MainActor.run { generatedPrompt = text }
                }
            } catch {
                await MainActor.run {
                    generatedPrompt = engine.synthesizeStructuredFallbackPrompt(roughIdea: roughIdea, style: style, repoContext: ctx)
                }
            }
            await MainActor.run { isGenerating = false }
        }
    }
}
