import SwiftUI
import UserNotifications
#if canImport(BackgroundTasks)
import BackgroundTasks
#endif

@MainActor
final class AppDependencies: ObservableObject {
    static let backgroundRefreshTaskIdentifier = "ai.wazir.mobile.refresh"

    let credentialVault: CredentialVault
    let store: ControllerStore
    let sseStream: MobileSseEventStream
    let mdnsDiscovery: MdnsControllerDiscovery
    let repository: WazirRepository
    let viewModel: MainViewModel
    @Published var pendingDeepLinkRoute: String?

    init() {
        let vault = KeychainCredentialVault()
        let store = ControllerStore()
        let sse = MobileSseEventStream(credentialVault: vault)
        let mdns = MdnsControllerDiscovery()
        let repo = WazirRepository(credentialVault: vault, store: store)
        let vm = MainViewModel(repository: repo, store: store, sseStream: sse, mdnsDiscovery: mdns, notificationManager: .shared)

        self.credentialVault = vault
        self.store = store
        self.sseStream = sse
        self.mdnsDiscovery = mdns
        self.repository = repo
        self.viewModel = vm
    }

    func scheduleNextBackgroundRefresh() {
        #if canImport(BackgroundTasks)
        let request = BGAppRefreshTaskRequest(identifier: Self.backgroundRefreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
        #endif
    }
}

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    var onTargetRoute: ((String) -> Void)?

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let route = response.notification.request.content.userInfo[NotificationUserInfoKey.targetRoute] as? String {
            onTargetRoute?(route)
        }
        completionHandler()
    }
}

@main
struct WazirMobileApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var dependencies = AppDependencies()
    private let notificationDelegate = NotificationDelegate()

    var body: some Scene {
        WindowGroup {
            RootView(viewModel: dependencies.viewModel, pendingDeepLinkRoute: $dependencies.pendingDeepLinkRoute)
                .onAppear {
                    WazirNotificationManager.shared.requestAuthorizationIfNeeded()
                    UNUserNotificationCenter.current().delegate = notificationDelegate
                    notificationDelegate.onTargetRoute = { route in
                        dependencies.pendingDeepLinkRoute = route
                    }
                    dependencies.scheduleNextBackgroundRefresh()
                }
                .onOpenURL { url in
                    guard url.scheme?.lowercased() == "wazir", url.host?.lowercased() == "pair" else { return }
                    dependencies.viewModel.pairFromQrUri(url.absoluteString)
                }
                .onChange(of: scenePhase) { newPhase in
                    if newPhase == .background {
                        dependencies.scheduleNextBackgroundRefresh()
                    }
                }
        }
        .backgroundTask(.appRefresh(AppDependencies.backgroundRefreshTaskIdentifier)) {
            await dependencies.scheduleNextBackgroundRefresh()
            _ = await dependencies.viewModel.performBackgroundRefresh()
        }
    }
}
