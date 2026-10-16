import Foundation

enum SseConnectionState {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case authError
}

/// Deterministic sequence ordering and deduplication filter for SSE events. Prevents
/// duplicate state mutations or notifications after a cursor-based stream resume.
/// Mirrors Android's `SseEventDeduplicator`.
final class SseEventDeduplicator {
    private var seenEventIds: [String] = []
    private var seenSet: Set<String> = []
    private let maxSeenIds: Int
    private(set) var lastSequence: Int64 = 0

    init(maxSeenIds: Int = 512) {
        self.maxSeenIds = maxSeenIds
    }

    func accept(_ event: MobileStreamEvent) -> Bool {
        if !event.eventId.isEmpty, seenSet.contains(event.eventId) {
            return false
        }
        if event.sequence > 0, event.sequence <= lastSequence {
            return false
        }
        if event.sequence > lastSequence {
            lastSequence = event.sequence
        }
        if !event.eventId.isEmpty {
            seenSet.insert(event.eventId)
            seenEventIds.append(event.eventId)
            while seenEventIds.count > maxSeenIds {
                let first = seenEventIds.removeFirst()
                seenSet.remove(first)
            }
        }
        return true
    }

    func reset(initialCursor: Int64 = 0) {
        seenEventIds.removeAll()
        seenSet.removeAll()
        lastSequence = initialCursor
    }
}

/// Streams `/api/v1/mobile/events` (see `MobileEventHub.subscribeSse` in
/// `apps/api/src/mobile.ts`) with cursor-based resume and exponential backoff +
/// jitter reconnection. Mirrors Android's `MobileSseEventStream` (OkHttp SSE) using
/// `URLSession.bytes(for:)` line-by-line iteration instead.
@MainActor
final class MobileSseEventStream: ObservableObject {
    @Published private(set) var connectionState: SseConnectionState = .disconnected
    @Published private(set) var lastHeartbeatAt: Date?

    var onEvent: ((MobileStreamEvent) -> Void)?

    private let credentialVault: CredentialVault
    private let deduplicator = SseEventDeduplicator()
    private var streamTask: Task<Void, Never>?
    private var activeControllerId: String?
    private let decoder = JSONDecoder()

    init(credentialVault: CredentialVault) {
        self.credentialVault = credentialVault
    }

    func currentCursor() -> Int64 { deduplicator.lastSequence }

    func connect(profile: ControllerProfile, initialCursor: Int64 = 0) {
        if activeControllerId == profile.id, connectionState == .connected || connectionState == .connecting {
            return
        }
        disconnect()
        activeControllerId = profile.id
        if initialCursor > deduplicator.lastSequence {
            deduplicator.reset(initialCursor: initialCursor)
        }

        streamTask = Task { [weak self] in
            await self?.runLoop(profile: profile)
        }
    }

    func disconnect() {
        activeControllerId = nil
        streamTask?.cancel()
        streamTask = nil
        connectionState = .disconnected
    }

    private func runLoop(profile: ControllerProfile) async {
        var attempt = 0
        while !Task.isCancelled, activeControllerId == profile.id {
            guard let credential = credentialVault.getCredential(controllerId: profile.id) else {
                connectionState = .authError
                return
            }

            connectionState = attempt == 0 ? .connecting : .reconnecting
            let cursor = deduplicator.lastSequence
            let cleanUrl = trimmedTrailingSlash(profile.baseUrl)
            guard let url = URL(string: "\(cleanUrl)/api/v1/mobile/events?cursor=\(cursor)") else { return }

            var request = URLRequest(url: url)
            request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue("\(cursor)", forHTTPHeaderField: "Last-Event-ID")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.timeoutInterval = 24 * 3600 // effectively unbounded; the server heartbeats every 5s

            let session = TlsPinningSessionFactory.makeSession(tlsCertFingerprint: profile.tlsCertFingerprint, timeoutSeconds: 24 * 3600)
            let statusCode = await streamOnce(session: session, request: request)

            if Task.isCancelled || activeControllerId != profile.id {
                return
            }
            if statusCode == 401 || statusCode == 403 {
                connectionState = .authError
                return
            }

            attempt += 1
            connectionState = .reconnecting
            let baseDelayMs = min(15_000, 1_000 * (1 << min(attempt, 4)))
            let jitterMs = Int.random(in: 100...650)
            try? await Task.sleep(nanoseconds: UInt64(baseDelayMs + jitterMs) * 1_000_000)
        }
    }

    /// Opens one connection and parses SSE frames until it closes or fails; returns the
    /// HTTP status (0 if the connection never opened).
    private func streamOnce(session: URLSession, request: URLRequest) async -> Int {
        var eventType: String?
        var dataLines: [String] = []

        func dispatchIfNeeded() {
            defer { eventType = nil; dataLines = [] }
            guard !dataLines.isEmpty else { return }
            lastHeartbeatAt = Date()
            if eventType == "wazir.heartbeat" { return }
            let payload = dataLines.joined(separator: "\n")
            guard let data = payload.data(using: .utf8),
                  let event = try? decoder.decode(MobileStreamEvent.self, from: data) else { return }
            if deduplicator.accept(event) {
                onEvent?(event)
            }
        }

        do {
            let (bytes, response) = try await session.bytes(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard statusCode == 200 else { return statusCode }

            connectionState = .connected
            lastHeartbeatAt = Date()

            for try await line in bytes.lines {
                if Task.isCancelled { break }
                if line.isEmpty {
                    dispatchIfNeeded()
                    continue
                }
                if line.hasPrefix(":") { continue } // comment / heartbeat line
                if line.hasPrefix("id:") {
                    continue // frame id isn't used for dedup — the decoded event's own sequence/eventId is authoritative
                } else if let value = line.stripPrefix("event:") {
                    eventType = value
                } else if let value = line.stripPrefix("data:") {
                    dataLines.append(value)
                }
            }
            return 200
        } catch {
            return 0
        }
    }

    private func trimmedTrailingSlash(_ s: String) -> String {
        var t = s
        while t.hasSuffix("/") { t.removeLast() }
        return t
    }
}

private extension String {
    func stripPrefix(_ prefix: String) -> String? {
        guard hasPrefix(prefix) else { return nil }
        return String(dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }
}
