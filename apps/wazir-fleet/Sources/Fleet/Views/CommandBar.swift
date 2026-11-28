import FleetCore
import SwiftUI

struct CommandBar: View {
    @Environment(FleetStore.self) private var store
    @FocusState private var focused: Bool
    @State private var historyOffset = 0

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right.square").foregroundStyle(.secondary)
                TextField("add model qwen2.5 on machine jetson   (⌘K · help)", text: $store.commandText)
                    .textFieldStyle(.plain)
                    .font(.body.monospaced())
                    .focused($focused)
                    .onSubmit {
                        historyOffset = 0
                        store.submitCommand()
                    }
                    .onKeyPress(.upArrow) { recall(+1) }
                    .onKeyPress(.downArrow) { recall(-1) }
                    .onKeyPress(.escape) {
                        store.commandMessage = nil
                        return .handled
                    }
                Button("Plan") {
                    historyOffset = 0
                    store.submitCommand()
                }
                .disabled(store.commandText.trimmingCharacters(in: .whitespaces).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(focused ? Color.accentColor : Color.secondary.opacity(0.3)))

            if let msg = store.commandMessage {
                HStack(alignment: .top) {
                    Image(systemName: msg.kind == .error ? "xmark.octagon.fill" : "info.circle")
                    Text(msg.text).font(msg.text.contains("\n") ? .caption.monospaced() : .callout).textSelection(.enabled)
                    Spacer()
                    Button { store.commandMessage = nil } label: { Image(systemName: "xmark") }.buttonStyle(.borderless)
                }
                .foregroundStyle(msg.kind == .error ? .red : .secondary)
            }

            ForEach(store.state.runningOperations) { op in
                Button {
                    store.selectedOperation = op.id
                    store.selection = .activity
                } label: {
                    HStack {
                        ProgressView().controlSize(.mini)
                        Text(op.plan.summary).lineLimit(1)
                        Spacer()
                        if let p = op.overallProgress {
                            ProgressView(value: p).frame(width: 120)
                            Text("\(Int(p * 100))%").monospacedDigit()
                        }
                    }
                    .font(.caption)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .onReceive(NotificationCenter.default.publisher(for: .focusCommandBar)) { _ in focused = true }
    }

    private func recall(_ delta: Int) -> KeyPress.Result {
        let next = historyOffset + delta
        if next <= 0 {
            historyOffset = 0
            store.commandText = ""
            return .handled
        }
        guard let entry = store.historyEntry(offset: next) else { return .ignored }
        historyOffset = next
        store.commandText = entry
        return .handled
    }
}
