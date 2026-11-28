import AppKit
import FleetCore
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when launched via `swift run` (no bundle): show in Dock and take focus.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct FleetApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store = FleetStore()

    var body: some Scene {
        Window("Fleet", id: "main") {
            ContentView()
                .environment(store)
                .frame(minWidth: 960, minHeight: 600)
        }
        .defaultSize(width: 1240, height: 800)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Refresh All") { Task { await store.refreshAll() } }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Focus Command Bar") { NotificationCenter.default.post(name: .focusCommandBar, object: nil) }
                    .keyboardShortcut("k", modifiers: .command)
            }
        }

        MenuBarExtra {
            MenuBarView().environment(store)
        } label: {
            Image(systemName: store.menuBarSymbol)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView().environment(store)
        }
    }
}

extension Notification.Name {
    static let focusCommandBar = Notification.Name("FleetFocusCommandBar")
}
