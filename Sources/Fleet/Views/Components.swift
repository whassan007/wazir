import FleetCore
import SwiftUI

extension Reachability {
    var color: Color {
        switch self {
        case .online(let ms, _): ms > 150 ? .yellow : .green
        case .offline: .red
        case .unknown: .gray
        }
    }

    var shortLabel: String {
        switch self {
        case .online(let ms, _): ms < 1 ? "local" : String(format: "%.0f ms", ms)
        case .offline: "offline"
        case .unknown: "—"
        }
    }
}

extension RuntimeState {
    var color: Color {
        switch status {
        case .online: .green
        case .unreachable: isStale ? .orange : .red
        case .unknown: .gray
        }
    }
}

struct StatusDot: View {
    var color: Color
    var pulsing = false
    var size: CGFloat = 9

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay(Circle().stroke(color.opacity(0.35), lineWidth: pulsing ? 4 : 0))
            .animation(pulsing ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true) : .default, value: pulsing)
            .accessibilityHidden(true)
    }
}

struct Chip: View {
    var text: String
    var color: Color = .secondary
    var systemImage: String?

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(.caption)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.14), in: Capsule())
        .foregroundStyle(color == .secondary ? Color.secondary : color)
    }
}

/// Compact labelled bar for 0…1 values.
struct MeterBar: View {
    var label: String
    var fraction: Double?
    var detail: String

    var tint: Color {
        guard let f = fraction else { return .gray }
        return f > 0.9 ? .red : f > 0.7 ? .orange : .accentColor
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(detail).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            ProgressView(value: fraction ?? 0)
                .tint(tint)
                .opacity(fraction == nil ? 0.3 : 1)
        }
    }
}

struct CopyableText: View {
    var text: String
    var body: some View {
        Text(text)
            .font(.callout.monospaced())
            .textSelection(.enabled)
            .contextMenu {
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                }
            }
    }
}

/// Re-renders relative timestamps periodically.
struct RelativeTime: View {
    var date: Date?
    var prefix = ""
    var body: some View {
        TimelineView(.periodic(from: .now, by: 10)) { ctx in
            Text(date.map { prefix + Format.relative($0, now: ctx.date) } ?? "never")
        }
    }
}

extension HostMetrics {
    var memoryDetail: String {
        guard let t = memTotalBytes, let a = memAvailableBytes else { return "—" }
        return "\(Format.bytes(t - a)) / \(Format.bytes(t))"
    }

    var loadDetail: String {
        guard let l = load1 else { return "—" }
        return String(format: "%.2f", l) + (cpuCount.map { " / \($0) cores" } ?? "")
    }
}

extension HostOS {
    var symbol: String {
        switch self {
        case .linux: "terminal"
        case .macos: "apple.logo"
        case .windows: "pc"
        }
    }
}
