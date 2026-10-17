import Foundation
import UserNotifications

/// Local-notification mapping for SSE stream events, mirroring Android's
/// `WazirNotificationManager.onStreamEvent`. iOS has no channel concept, so categories
/// are used only to group identifiers; routing on tap goes through `userInfo`.
enum NotificationUserInfoKey {
    static let targetRoute = "targetRoute"
    static let controllerId = "controllerId"
    static let taskId = "taskId"
    static let approvalId = "approvalId"
}

@MainActor
final class WazirNotificationManager {
    static let shared = WazirNotificationManager()

    func requestAuthorizationIfNeeded() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func onStreamEvent(controllerId: String, controllerName: String, event: MobileStreamEvent) {
        switch event.type {
        case "approval.requested":
            post(
                id: "approval:\(event.approvalId ?? event.eventId)",
                title: "Approval Required (\(controllerName))",
                body: event.summary,
                targetRoute: "approvals",
                controllerId: controllerId,
                taskId: event.taskId,
                approvalId: event.approvalId
            )
        case "task.completed":
            post(
                id: "task:\(event.taskId ?? event.eventId)",
                title: "Task Completed (\(controllerName))",
                body: event.summary,
                targetRoute: "tasks",
                controllerId: controllerId,
                taskId: event.taskId
            )
        case "task.failed", "verification.failed":
            post(
                id: "task-fail:\(event.taskId ?? event.eventId)",
                title: "Task Failed (\(controllerName))",
                body: event.summary,
                targetRoute: "tasks",
                controllerId: controllerId,
                taskId: event.taskId
            )
        case "worker.disconnected":
            post(
                id: "worker:\(event.computerId ?? event.eventId)",
                title: "Worker Disconnected (\(controllerName))",
                body: event.summary,
                targetRoute: "workers",
                controllerId: controllerId
            )
        case "resource.emergency_stop":
            post(
                id: "resource:stop:\(controllerId)",
                title: "Emergency Stop Triggered (\(controllerName))",
                body: event.summary,
                targetRoute: "resources",
                controllerId: controllerId
            )
        default:
            break
        }
    }

    func notifyPendingApprovalSummary(controllerId: String, controllerName: String, pendingCount: Int) {
        guard pendingCount > 0 else { return }
        post(
            id: "pending-approvals:\(controllerId)",
            title: "\(pendingCount) Pending Approval\(pendingCount == 1 ? "" : "s") (\(controllerName))",
            body: "Tap to review and authorize pending Wazir operations.",
            targetRoute: "approvals",
            controllerId: controllerId
        )
    }

    private func post(id: String, title: String, body: String, targetRoute: String, controllerId: String, taskId: String? = nil, approvalId: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        var userInfo: [String: String] = [
            NotificationUserInfoKey.targetRoute: targetRoute,
            NotificationUserInfoKey.controllerId: controllerId,
        ]
        if let taskId { userInfo[NotificationUserInfoKey.taskId] = taskId }
        if let approvalId { userInfo[NotificationUserInfoKey.approvalId] = approvalId }
        content.userInfo = userInfo

        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
