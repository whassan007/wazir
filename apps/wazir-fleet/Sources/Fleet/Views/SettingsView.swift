import FleetCore
import SwiftUI

struct SettingsView: View {
    @Environment(FleetStore.self) private var store
    @State private var draft: FleetConfig = DefaultFleet.config
    @State private var loaded = false
    @State private var saveError: String?
    @State private var savedAt: Date?

    var body: some View {
        TabView {
            GeneralSettings(draft: $draft)
                .tabItem { Label("General", systemImage: "gearshape") }
            HostsEditor(draft: $draft)
                .tabItem { Label("Hosts", systemImage: "server.rack") }
        }
        .safeAreaInset(edge: .bottom) { footer }
        .frame(width: 820, height: 600)
        .onAppear {
            if !loaded { draft = store.config; loaded = true }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            let problems = draft.validate()
            ForEach(problems, id: \.self) { Label($0, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if let saveError { Label(saveError, systemImage: "xmark.octagon").foregroundStyle(.red) }
            HStack {
                Text(store.configStore.url.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                Button("Reveal") { NSWorkspace.shared.activateFileViewerSelecting([store.configStore.url]) }
                    .controlSize(.small)
                Button("Reload from Disk") {
                    store.loadConfig()
                    draft = store.config
                    saveError = store.configError
                }
                .controlSize(.small)
                Spacer()
                if let savedAt { Text("Saved \(savedAt, style: .time)").font(.caption).foregroundStyle(.secondary) }
                Button("Revert") { draft = store.config; saveError = nil }
                    .disabled(draft == store.config)
                Button("Save") {
                    do {
                        try store.apply(config: draft)
                        saveError = nil
                        savedAt = Date()
                    } catch {
                        saveError = (error as? FleetError)?.message ?? error.localizedDescription
                    }
                }
                .keyboardShortcut("s", modifiers: .command)
                .disabled(draft == store.config || !problems.isEmpty)
            }
        }
        .font(.callout)
        .padding(12)
        .background(.bar)
    }
}

struct GeneralSettings: View {
    @Binding var draft: FleetConfig

    var body: some View {
        Form {
            Section("Execution") {
                Toggle("Default new plans to dry-run", isOn: $draft.dryRunByDefault)
                Text("Every mutation is previewed and confirmed. In dry-run nothing is sent to hosts; pick Live in the plan sheet or add `--live` to a command.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Validate Ollama models against the registry (sends only the model name)", isOn: $draft.registryLookup)
                LabeledContent("Large download warning") {
                    TextField("GB", value: $draft.largeDownloadWarningGB, format: .number).frame(width: 70)
                    Text("GB")
                }
            }
            Section("Polling") {
                LabeledContent("Poll interval") {
                    TextField("seconds", value: $draft.pollIntervalSeconds, format: .number).frame(width: 70)
                    Text("seconds")
                }
                LabeledContent("HTTP timeout") {
                    TextField("seconds", value: $draft.httpTimeoutSeconds, format: .number).frame(width: 70)
                    Text("seconds")
                }
                LabeledContent("SSH connect timeout") {
                    TextField("seconds", value: $draft.sshConnectTimeoutSeconds, format: .number).frame(width: 70)
                    Text("seconds")
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct HostsEditor: View {
    @Binding var draft: FleetConfig
    @State private var selected: String?

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                List(selection: $selected) {
                    ForEach(draft.hosts) { h in
                        VStack(alignment: .leading) {
                            Text(h.name)
                            Text(h.id).font(.caption).foregroundStyle(.secondary)
                        }
                        .tag(h.id)
                    }
                    .onMove { draft.hosts.move(fromOffsets: $0, toOffset: $1) }
                }
                HStack {
                    Button {
                        var n = 1
                        while draft.hosts.contains(where: { $0.id == "host\(n)" }) { n += 1 }
                        draft.hosts.append(HostConfig(id: "host\(n)", name: "New Host", os: .linux, runtimes: [RuntimeConfig(kind: .ollama)]))
                        selected = "host\(n)"
                    } label: { Image(systemName: "plus") }
                    Button {
                        draft.hosts.removeAll { $0.id == selected }
                        selected = draft.hosts.first?.id
                    } label: { Image(systemName: "minus") }
                    .disabled(selected == nil)
                    Spacer()
                }
                .buttonStyle(.borderless)
                .padding(6)
            }
            .frame(minWidth: 200, maxWidth: 240)

            if let idx = draft.hosts.firstIndex(where: { $0.id == selected }) {
                HostForm(host: $draft.hosts[idx], selected: $selected)
            } else {
                ContentUnavailableView("Select a host", systemImage: "server.rack")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { if selected == nil { selected = draft.hosts.first?.id } }
    }
}

struct HostForm: View {
    @Binding var host: HostConfig
    @Binding var selected: String?

    var body: some View {
        Form {
            Section("Identity") {
                TextField("Primary alias (id)", text: Binding(get: { host.id }, set: { host.id = $0; selected = $0 }))
                TextField("Display name", text: $host.name)
                TextField("Other aliases (comma-separated)", text: Binding(
                    get: { host.aliases.joined(separator: ", ") },
                    set: { host.aliases = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
                ))
                TextField("Role", text: optional($host.role))
                TextField("Hardware", text: optional($host.hardware))
                TextField("Memory (GB)", value: $host.memoryGB, format: .number)
                Picker("OS", selection: $host.os) {
                    ForEach(HostOS.allCases, id: \.self) { Text($0.displayName).tag($0) }
                }
            }
            Section("Network") {
                TextField("Tailscale IP", text: optional($host.tailscaleIP))
                TextField("Tailscale machine name", text: optional($host.tailscaleName))
                TextField("LAN IP", text: optional($host.lanIP))
                TextField("SSH target (~/.ssh/config Host or user@host)", text: optional($host.sshTarget))
                Toggle("This Mac (probe via 127.0.0.1, run commands locally)", isOn: $host.isLocal)
                Toggle("Collect CPU / memory / GPU metrics over SSH", isOn: $host.collectMetrics)
            }
            Section("Runtimes") {
                ForEach($host.runtimes) { $rt in
                    RuntimeForm(runtime: $rt) { host.runtimes.removeAll { $0.kind == rt.kind } }
                }
                let missing = RuntimeKind.allCases.filter { k in !host.runtimes.contains { $0.kind == k } }
                if !missing.isEmpty {
                    Menu("Add Runtime") {
                        ForEach(missing) { k in Button(k.displayName) { host.runtimes.append(RuntimeConfig(kind: k)) } }
                    }
                    .fixedSize()
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct RuntimeForm: View {
    @Binding var runtime: RuntimeConfig
    var onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Toggle(runtime.kind.displayName, isOn: $runtime.enabled).font(.headline)
                Spacer()
                Button(role: .destructive, action: onRemove) { Image(systemName: "trash") }.buttonStyle(.borderless)
            }
            HStack {
                TextField("Port", value: $runtime.port, format: .number.grouping(.never)).frame(width: 110)
                TextField("Base URL override (e.g. SSH tunnel)", text: optional($runtime.baseURL))
            }
            if runtime.kind == .llamacpp {
                TextField("Models directory on host (e.g. ~/models)", text: optional($runtime.modelsDir))
            }
            if runtime.kind != .ollama {
                let t = runtime.effectiveTemplates
                Text("Commands (over SSH): add `\(t.add ?? "—")` · remove `\(t.remove ?? "—")` · reload `\(t.reload ?? "—")`. Override in hosts.json → commands.")
                    .font(.caption).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Binds an optional String to a TextField, mapping "" ↔ nil.
func optional(_ b: Binding<String?>) -> Binding<String> {
    Binding(get: { b.wrappedValue ?? "" }, set: { b.wrappedValue = $0.isEmpty ? nil : $0 })
}
