import Foundation
import Network

struct DiscoveredWazirController: Identifiable, Equatable {
    var serviceName: String
    var host: String
    var port: Int
    var httpsUrl: String

    var id: String { httpsUrl }
}

/// Local-network controller discovery via Bonjour/mDNS (`_wazir._tcp.`), mirroring
/// Android's `MdnsControllerDiscovery` (Android NSD) using Apple's `Network.framework`
/// `NWBrowser` + per-result `NWConnection` resolution instead.
@MainActor
final class MdnsControllerDiscovery: ObservableObject {
    @Published private(set) var discovered: [DiscoveredWazirController] = []
    @Published private(set) var isScanning = false

    private var browser: NWBrowser?
    private var resolvers: [String: NWConnection] = [:]

    func startDiscovery() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = true
        let descriptor = NWBrowser.Descriptor.bonjour(type: "_wazir._tcp", domain: nil)
        let b = NWBrowser(for: descriptor, using: params)

        b.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready: self?.isScanning = true
                case .failed, .cancelled: self?.isScanning = false
                default: break
                }
            }
        }

        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                self?.handleResults(results)
            }
        }

        browser = b
        b.start(queue: .main)
    }

    func stopDiscovery() {
        browser?.cancel()
        browser = nil
        for (_, conn) in resolvers { conn.cancel() }
        resolvers.removeAll()
        isScanning = false
    }

    private func handleResults(_ results: Set<NWBrowser.Result>) {
        let currentServiceNames = Set(results.compactMap { result -> String? in
            if case let .service(name, _, _, _) = result.endpoint { return name }
            return nil
        })
        discovered.removeAll { !currentServiceNames.contains($0.serviceName) }

        for result in results {
            guard case let .service(name, _, _, _) = result.endpoint else { continue }
            if resolvers[name] != nil { continue }
            resolve(result: result, serviceName: name)
        }
    }

    private func resolve(result: NWBrowser.Result, serviceName: String) {
        let connection = NWConnection(to: result.endpoint, using: .tcp)
        resolvers[serviceName] = connection

        connection.stateUpdateHandler = { [weak self] state in
            guard case .ready = state else { return }
            guard let path = connection.currentPath, let endpoint = path.remoteEndpoint else { return }
            if case let .hostPort(host, port) = endpoint {
                let hostString = "\(host)".components(separatedBy: "%").first ?? "\(host)"
                let item = DiscoveredWazirController(
                    serviceName: serviceName,
                    host: hostString,
                    port: Int(port.rawValue),
                    httpsUrl: "https://\(hostString):\(port.rawValue)"
                )
                Task { @MainActor in
                    guard let self else { return }
                    if !self.discovered.contains(where: { $0.httpsUrl == item.httpsUrl }) {
                        self.discovered.append(item)
                    }
                    connection.cancel()
                    self.resolvers.removeValue(forKey: serviceName)
                }
            }
        }
        connection.start(queue: .main)
    }
}
