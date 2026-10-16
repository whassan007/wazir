import SwiftUI

enum WazirColor {
    static let cyan = Color(red: 0.22, green: 0.74, blue: 0.95)
    static let emerald = Color(red: 0.20, green: 0.78, blue: 0.53)
    static let amber = Color(red: 0.96, green: 0.70, blue: 0.20)
    static let crimson = Color(red: 0.92, green: 0.33, blue: 0.33)
}

/// Maps the free-text status strings the controller API returns ("running", "healthy",
/// "pending", "failed", ...) to a color, mirroring Android's `StatusBadge`.
func statusColor(_ status: String) -> Color {
    switch status.lowercased() {
    case "running", "connected", "healthy", "ok", "loaded", "online", "approved", "completed", "normal", "pinned":
        return WazirColor.emerald
    case "queued", "pending", "connecting", "reconnecting", "degraded", "installed", "blocked", "warning":
        return WazirColor.amber
    case "failed", "error", "offline", "rejected", "expired", "critical", "disconnected", "auth_error", "unavailable":
        return WazirColor.crimson
    default:
        return WazirColor.cyan
    }
}

struct StatusBadge: View {
    let text: String

    var body: some View {
        Text(text.capitalized)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(statusColor(text).opacity(0.18))
            .foregroundStyle(statusColor(text))
            .clipShape(Capsule())
    }
}

func formatShortTimestamp(_ iso: String?) -> String {
    guard let iso, !iso.isEmpty else { return "—" }
    let isoFormatter = ISO8601DateFormatter()
    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = isoFormatter.date(from: iso)
    if date == nil {
        isoFormatter.formatOptions = [.withInternetDateTime]
        date = isoFormatter.date(from: iso)
    }
    guard let date else { return iso }
    let formatter = DateFormatter()
    formatter.dateStyle = .none
    formatter.timeStyle = .short
    if !Calendar.current.isDateInToday(date) {
        formatter.dateStyle = .short
    }
    return formatter.string(from: date)
}

func formatShortTimestamp(ms: Int64?) -> String {
    guard let ms else { return "—" }
    let date = Date(timeIntervalSince1970: Double(ms) / 1000)
    let formatter = DateFormatter()
    formatter.timeStyle = .short
    formatter.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
    return formatter.string(from: date)
}

func formatDurationMs(_ ms: Int64) -> String {
    let totalSeconds = ms / 1000
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    let seconds = totalSeconds % 60
    if hours > 0 { return "\(hours)h \(minutes)m" }
    if minutes > 0 { return "\(minutes)m \(seconds)s" }
    return "\(seconds)s"
}
