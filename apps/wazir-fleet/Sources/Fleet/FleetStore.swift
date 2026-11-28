import AppKit
import FleetCore
import Foundation
import Observation

enum SidebarItem: Hashable {
    case overview
    case cloudServices
    case activity
    case flow
    case studio
    case host(String)
}

struct CommandMessage: Equatable {
    enum Kind { case info, error }
    var kind: Kind
    var text: String
}

/// Main-actor app state. All mutations of `state` go through `send(_:)` → `FleetReducer`;
/// all network/SSH work happens off the main actor and reports back via events.
@MainActor
@Observable
final class FleetStore {
    private(set) var state = FleetState()
    private(set) var config: FleetConfig = DefaultFleet.config
    private(set) var configError: String?
    private(set) var configNotice: String?
    var configProblems: [String] { config.validate() }

    var selection: SidebarItem? = .overview
    var selectedOperation: UUID?

    var commandText = ""
    var commandMessage: CommandMessage?
    var pendingPlan: ExecutionPlan?
    private(set) var isCheckingRegistry = false
    private(set) var history: [String] = []
    private(set) var lastFullRefresh: Date?

    var projectFolderPath: String = UserDefaults.standard.string(forKey: "FleetActiveProjectPath")
        ?? FileManager.default.currentDirectoryPath
    private(set) var projectContext: ProjectRepositoryContext?
    private(set) var discoveredCodeProjects: [String] = []

    let configStore = ConfigStore()
    private var pollTask: Task<Void, Never>?
    private var inflight: Set<String> = []
    private var opTasks: [UUID: Task<Void, Never>] = [:]
    private var started = false
    private var wakeObserver: NSObjectProtocol?

    init() {
        Task { @MainActor in self.start() }
    }

    // MARK: Lifecycle

    func start() {
        guard !started else { return }
        started = true
        loadConfig()
        loadProjectFolder(path: projectFolderPath)
        restartPolling()
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))  // let networking come back
                await self?.refreshAll()
            }
        }
    }

    func send(_ event: FleetEvent) {
        FleetReducer.reduce(&state, event)
    }

    func loadConfig() {
        do {
            switch try configStore.loadOrSeed() {
            case .loaded(let c):
                config = c
                configNotice = nil
            case .seeded(let c):
                config = c
                configNotice = "Created \(configStore.url.path) with your fleet's defaults."
            }
            configError = nil
        } catch {
            // Keep running on the last good config; never overwrite the user's file.
            configError = (error as? FleetError)?.message ?? error.localizedDescription
        }
        send(.configLoaded(config))
    }

    func apply(config newConfig: FleetConfig) throws {
        let problems = newConfig.validate()
        guard problems.isEmpty else { throw FleetError(problems.joined(separator: "\n")) }
        try configStore.save(newConfig)
        config = newConfig
        configError = nil
        send(.configLoaded(newConfig))
        restartPolling()
    }

    private func restartPolling() {
        pollTask?.cancel()
        let interval = max(5, config.pollIntervalSeconds)
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshAll()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    // MARK: Polling

    func refreshAll() async {
        let ids = state.hostOrder
        let cloudConfigs = config.cloudServices
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.refreshTailscale() }
            group.addTask {
                let snaps = CloudServiceBudgetEngine().discoverAll(configs: cloudConfigs)
                await MainActor.run { self.send(.cloudServicesUpdated(snaps, at: Date())) }
            }
            for id in ids { group.addTask { await self.refresh(id) } }
        }
        lastFullRefresh = Date()
    }

    func refreshTailscale() async {
        do throws(FleetError) {
            let peers = try await TailscaleStatus.fetch()
            send(.tailscale(.success(peers), at: Date()))
        } catch {
            send(.tailscale(.failure(error), at: Date()))
        }
    }

    var isRefreshing: Bool { !inflight.isEmpty }

    /// Probes one host. Bounded by timeouts, never blocks the main actor, and coalesces
    /// overlapping requests for the same host.
    func refresh(_ id: String) async {
        guard let host = config.host(id: id), !inflight.contains(id) else { return }
        inflight.insert(id)
        defer {
            inflight.remove(id)
            send(.probeFinished(host: id, at: Date()))
        }
        send(.probeStarted(host: id))

        let cfg = config
        let reach: Reachability
        if host.isLocal {
            reach = .online(latencyMS: 0, address: "127.0.0.1")
        } else {
            var ports = host.enabledRuntimes.map(\.port)
            if host.sshTarget != nil { ports.insert(22, at: 0) }
            if ports.isEmpty { ports = [22] }
            reach = await ReachabilityProbe.probe(addresses: host.candidateAddresses, ports: ports, timeout: 2.5)
        }
        send(.reachability(host: id, enrich(reach, host: id), at: Date()))
        guard reach.isOnline else { return }

        let hostState = state.hosts[id]
        let http = HTTPClient(timeout: cfg.httpTimeoutSeconds)
        let ssh = SSHRunner(connectTimeout: cfg.sshConnectTimeoutSeconds)
        let jobs: [(RuntimeKind, URL?)] = host.enabledRuntimes.map {
            ($0.kind, Endpoint.baseURL(host: host, runtime: $0, state: hostState))
        }
        let wantMetrics = host.collectMetrics && (host.isLocal || host.sshTarget != nil)
        let metricsTimeout = TimeInterval(cfg.sshConnectTimeoutSeconds + 6)

        await withTaskGroup(of: FleetEvent.self) { group in
            for (kind, base) in jobs {
                group.addTask {
                    guard let base else {
                        return .inventory(host: id, kind, .failure(FleetError("No address")), at: Date())
                    }
                    do throws(FleetError) {
                        let snap = try await RuntimeClients.inventory(kind: kind, base: base, http: http)
                        return .inventory(host: id, kind, .success(snap), at: Date())
                    } catch {
                        return .inventory(host: id, kind, .failure(error), at: Date())
                    }
                }
            }
            if wantMetrics {
                group.addTask {
                    do throws(FleetError) {
                        let m = try await MetricsProbe.collect(host: host, ssh: ssh, timeout: metricsTimeout)
                        return .metrics(host: id, .success(m), at: Date())
                    } catch {
                        return .metrics(host: id, .failure(error), at: Date())
                    }
                }
            }
            for await event in group { send(event) }
        }
    }

    /// Adds Tailscale context to an offline result ("asleep?").
    private func enrich(_ r: Reachability, host id: String) -> Reachability {
        guard case .offline(let reason) = r, let peer = state.hosts[id]?.tailscale else { return r }
        if !peer.online {
            let seen = peer.lastSeen.map { "last seen \(Format.relative($0))" } ?? "offline"
            return .offline(reason: "Tailscale: \(seen), probably asleep or powered off")
        }
        return .offline(reason: "Tailscale peer online, but \(reason.prefix(1).lowercased() + reason.dropFirst())")
    }

    // MARK: Commands

    func submitCommand() {
        let input = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        if history.last != input { history.append(input) }
        commandMessage = nil
        let parser = CommandParser(config: config)
        let command: FleetCommand
        do {
            command = try parser.parse(input)
        } catch {
            commandMessage = CommandMessage(kind: .error, text: error.errorDescription ?? "\(error)")
            return
        }
        switch command {
        case .help:
            commandMessage = CommandMessage(kind: .info, text: CommandParser.helpText)
            commandText = ""
        case .refresh(let target):
            do {
                let hosts = try Planner(config: config).resolveHosts(target)
                commandMessage = CommandMessage(kind: .info, text: "Refreshing \(hosts.map(\.name).joined(separator: ", "))…")
                commandText = ""
                Task {
                    if case .all = target { await refreshAll() } else {
                        await withTaskGroup(of: Void.self) { g in for h in hosts { g.addTask { await self.refresh(h.id) } } }
                    }
                    commandMessage = nil
                }
            } catch {
                commandMessage = CommandMessage(kind: .error, text: error.errorDescription ?? "")
            }
        case .list(let target):
            do {
                let hosts = try Planner(config: config).resolveHosts(target)
                selection = hosts.count == 1 ? .host(hosts[0].id) : .overview
                commandText = ""
            } catch {
                commandMessage = CommandMessage(kind: .error, text: error.errorDescription ?? "")
            }
        case .model(let c):
            do {
                let plan = try Planner(config: config).plan(c, input: input, state: state)
                pendingPlan = plan
                commandText = ""
                checkRegistry(for: plan)
            } catch {
                commandMessage = CommandMessage(kind: .error, text: error.errorDescription ?? "")
            }
        }
    }

    func historyEntry(offset: Int) -> String? {
        guard !history.isEmpty else { return nil }
        let idx = history.count - offset
        return history.indices.contains(idx) ? history[idx] : nil
    }

    /// Builds and submits a structured command (used by context menus).
    func prepare(_ verb: ModelVerb, model: String, host: String, runtime: RuntimeKind?) {
        var cmd = "\(verb.rawValue) model=\(model) host=\(host)"
        if let runtime { cmd += " runtime=\(runtime.rawValue)" }
        commandText = cmd
        submitCommand()
    }

    private func checkRegistry(for plan: ExecutionPlan) {
        guard config.registryLookup, !plan.registryLookups.isEmpty else { return }
        isCheckingRegistry = true
        let registry = OllamaRegistry()
        let models = plan.registryLookups
        Task {
            var results: [String: OllamaRegistry.Lookup] = [:]
            await withTaskGroup(of: (String, OllamaRegistry.Lookup).self) { g in
                for m in models { g.addTask { (m, await registry.lookup(m)) } }
                for await (m, r) in g { results[m] = r }
            }
            isCheckingRegistry = false
            // Only apply if the user is still looking at the same plan.
            guard let current = pendingPlan, current.id == plan.id else { return }
            let inventory = state.hosts.values.flatMap { $0.allModels.map(\.1.name) }
            pendingPlan = PlanEnricher.apply(results, to: current, config: config, inventory: inventory)
        }
    }

    // MARK: Execution

    func execute(_ plan: ExecutionPlan, dryRun: Bool) {
        pendingPlan = nil
        var p = plan
        p.dryRun = dryRun
        let op = OperationRecord(plan: p, dryRun: dryRun, startedAt: Date())
        send(.operationStarted(op))
        selectedOperation = op.id
        if !dryRun { selection = .activity }

        let executor = PlanExecutor(http: HTTPClient(timeout: max(10, config.httpTimeoutSeconds * 3)),
                                    ssh: SSHRunner(connectTimeout: config.sshConnectTimeoutSeconds))
        let opID = op.id
        opTasks[opID] = Task { [weak self] in
            for await ev in executor.run(p, dryRun: dryRun) {
                self?.send(.operation(opID, ev, at: Date()))
            }
            guard let self else { return }
            self.opTasks[opID] = nil
            if let rec = self.state.operation(opID) {
                let kind: CommandMessage.Kind = { if case .failed = rec.phase { return .error } else { return .info } }()
                self.commandMessage = CommandMessage(kind: kind, text: "\(dryRun ? "Dry run " : "")\(rec.phase.label.lowercased()): \(p.summary)")
            }
            if !dryRun {
                for h in p.touchedHosts { await self.refresh(h) }
            }
        }
    }

    func cancel(_ id: UUID) {
        guard state.operation(id)?.phase == .running else { return }
        opTasks[id]?.cancel()
        opTasks[id] = nil
        send(.operation(id, .cancelled, at: Date()))
    }

    // MARK: Derived

    var orderedHosts: [(HostConfig, HostState)] {
        state.hostOrder.compactMap { id in
            guard let c = config.host(id: id), let s = state.hosts[id] else { return nil }
            return (c, s)
        }
    }

    func loadProjectFolder(path: String) {
        projectFolderPath = path
        UserDefaults.standard.set(path, forKey: "FleetActiveProjectPath")
        let codeDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Code")
        if let items = try? FileManager.default.contentsOfDirectory(at: codeDir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) {
            discoveredCodeProjects = items
                .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
                .map(\.path)
                .sorted()
        }
        Task {
            let ctx = try? await RepositoryIntrospector().introspect(repoPath: path, coordinator: nil)
            await MainActor.run { self.projectContext = ctx }
        }
    }

    func promptForProjectFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Load Project Folder"
        panel.message = "Select the project repository folder Fleet should operate in"
        panel.directoryURL = URL(fileURLWithPath: projectFolderPath)
        if panel.runModal() == .OK, let url = panel.url {
            loadProjectFolder(path: url.path)
        }
    }

    var orderedCloudServices: [(CloudServicePlanConfig, CloudServiceSnapshot?)] {
        config.cloudServices.map { ($0, state.cloudSnapshots[$0.id]) }
    }

    var allFrontierCloudModels: [FrontierCloudModel] {
        config.cloudServices.flatMap { state.cloudSnapshots[$0.id]?.discoveredModels ?? [] }
    }

    func openCloudWebLogin(_ service: CloudServicePlanConfig) {
        if let url = URL(string: service.webLoginURL) { NSWorkspace.shared.open(url) }
    }

    func openCloudBillingPortal(_ service: CloudServicePlanConfig) {
        if let url = URL(string: service.billingURL) { NSWorkspace.shared.open(url) }
    }

    func revealCloudConfigFile(_ service: CloudServicePlanConfig) {
        let engine = CloudServiceBudgetEngine()
        for raw in service.configPaths {
            let p = engine.expand(raw)
            if FileManager.default.fileExists(atPath: p) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
                return
            }
        }
    }

    func updateCloudBudget(id: String, monthlyPlanUSD: Double, additionalLimitUSD: Double) {
        var next = config
        if let idx = next.cloudServices.firstIndex(where: { $0.id == id }) {
            next.cloudServices[idx].monthlyPlanBudgetUSD = max(0, monthlyPlanUSD)
            next.cloudServices[idx].additionalSpendLimitUSD = max(0, additionalLimitUSD)
            try? apply(config: next)
            let snaps = CloudServiceBudgetEngine().discoverAll(configs: next.cloudServices)
            send(.cloudServicesUpdated(snaps, at: Date()))
        }
    }

    var menuBarSymbol: String {
        if !state.runningOperations.isEmpty { return "arrow.down.circle" }
        return "server.rack"
    }
}
