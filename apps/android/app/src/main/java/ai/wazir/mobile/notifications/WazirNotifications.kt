package ai.wazir.mobile.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import ai.wazir.mobile.MainActivity
import ai.wazir.mobile.R
import ai.wazir.mobile.domain.MobileStreamEvent
import ai.wazir.mobile.network.WazirControllerApi
import ai.wazir.mobile.persistence.WazirDatabase
import ai.wazir.mobile.security.KeystoreCredentialVault
import kotlinx.serialization.json.Json
import java.util.concurrent.TimeUnit

class WazirNotificationManager(private val context: Context) {
    private val appContext = context.applicationContext

    init {
        ensureChannelsCreated()
    }

    private fun ensureChannelsCreated() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val approvalsChannel = NotificationChannel(
                CHANNEL_APPROVALS,
                "Policy Approvals",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Human-in-the-loop policy approval requests from Wazir agents"
            }

            val tasksChannel = NotificationChannel(
                CHANNEL_TASKS,
                "Task Updates",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Task completions, failures, and verification reports"
            }

            val infraChannel = NotificationChannel(
                CHANNEL_INFRASTRUCTURE,
                "Workers & Resource Alerts",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Worker disconnections, model crashes, and resource budget warnings"
            }

            manager.createNotificationChannels(listOf(approvalsChannel, tasksChannel, infraChannel))
        }
    }

    fun onStreamEvent(controllerId: String, controllerName: String, event: MobileStreamEvent) {
        if (!canPostNotifications()) return

        when (event.type) {
            "approval.requested" -> {
                postNotification(
                    id = ("approval:${event.approvalId ?: event.eventId}").hashCode(),
                    channelId = CHANNEL_APPROVALS,
                    title = "Approval Required ($controllerName)",
                    body = event.summary,
                    targetRoute = "approvals",
                    controllerId = controllerId,
                    taskId = event.taskId,
                    approvalId = event.approvalId,
                    highPriority = true,
                )
            }
            "task.completed" -> {
                postNotification(
                    id = ("task:${event.taskId ?: event.eventId}").hashCode(),
                    channelId = CHANNEL_TASKS,
                    title = "Task Completed ($controllerName)",
                    body = event.summary,
                    targetRoute = "tasks",
                    controllerId = controllerId,
                    taskId = event.taskId,
                )
            }
            "task.failed", "verification.failed" -> {
                postNotification(
                    id = ("task-fail:${event.taskId ?: event.eventId}").hashCode(),
                    channelId = CHANNEL_TASKS,
                    title = "Task Failed ($controllerName)",
                    body = event.summary,
                    targetRoute = "tasks",
                    controllerId = controllerId,
                    taskId = event.taskId,
                    highPriority = true,
                )
            }
            "worker.disconnected" -> {
                postNotification(
                    id = ("worker:${event.computerId ?: event.eventId}").hashCode(),
                    channelId = CHANNEL_INFRASTRUCTURE,
                    title = "Worker Disconnected ($controllerName)",
                    body = event.summary,
                    targetRoute = "workers",
                    controllerId = controllerId,
                )
            }
            "resource.emergency_stop" -> {
                postNotification(
                    id = ("resource:stop:$controllerId").hashCode(),
                    channelId = CHANNEL_INFRASTRUCTURE,
                    title = "Emergency Stop Triggered ($controllerName)",
                    body = event.summary,
                    targetRoute = "resources",
                    controllerId = controllerId,
                    highPriority = true,
                )
            }
        }
    }

    fun notifyPendingApprovalSummary(controllerId: String, controllerName: String, pendingCount: Int) {
        if (!canPostNotifications() || pendingCount <= 0) return
        postNotification(
            id = ("pending-approvals:$controllerId").hashCode(),
            channelId = CHANNEL_APPROVALS,
            title = "$pendingCount Pending Approval${if (pendingCount == 1) "" else "s"} ($controllerName)",
            body = "Tap to review and authorize pending Wazir operations.",
            targetRoute = "approvals",
            controllerId = controllerId,
            highPriority = true,
        )
    }

    private fun canPostNotifications(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    private fun postNotification(
        id: Int,
        channelId: String,
        title: String,
        body: String,
        targetRoute: String,
        controllerId: String,
        taskId: String? = null,
        approvalId: String? = null,
        highPriority: Boolean = false,
    ) {
        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_TARGET_ROUTE, targetRoute)
            putExtra(EXTRA_CONTROLLER_ID, controllerId)
            if (taskId != null) putExtra(EXTRA_TASK_ID, taskId)
            if (approvalId != null) putExtra(EXTRA_APPROVAL_ID, approvalId)
        }

        val pendingIntent = PendingIntent.getActivity(
            appContext,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(appContext, channelId)
            .setSmallIcon(R.drawable.ic_stat_wazir)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(
                if (highPriority) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT
            )
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)

        if (!approvalId.isNullOrBlank()) {
            val approveIntent = Intent(appContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_TARGET_ROUTE, "approvals")
                putExtra(EXTRA_CONTROLLER_ID, controllerId)
                putExtra(EXTRA_APPROVAL_ID, approvalId)
                putExtra(EXTRA_APPROVAL_DECISION, "approve")
            }
            val approvePending = PendingIntent.getActivity(
                appContext,
                (id xor 0x1111),
                approveIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val rejectIntent = Intent(appContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_TARGET_ROUTE, "approvals")
                putExtra(EXTRA_CONTROLLER_ID, controllerId)
                putExtra(EXTRA_APPROVAL_ID, approvalId)
                putExtra(EXTRA_APPROVAL_DECISION, "reject")
            }
            val rejectPending = PendingIntent.getActivity(
                appContext,
                (id xor 0x2222),
                rejectIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            builder.addAction(0, "Approve", approvePending)
            builder.addAction(0, "Reject", rejectPending)
        }

        try {
            NotificationManagerCompat.from(appContext).notify(id, builder.build())
        } catch (_: SecurityException) {
            // Permission revoked at runtime
        }
    }

    companion object {
        const val CHANNEL_APPROVALS = "wazir_approvals"
        const val CHANNEL_TASKS = "wazir_tasks"
        const val CHANNEL_INFRASTRUCTURE = "wazir_infrastructure"

        const val EXTRA_TARGET_ROUTE = "extra_target_route"
        const val EXTRA_CONTROLLER_ID = "extra_controller_id"
        const val EXTRA_TASK_ID = "extra_task_id"
        const val EXTRA_APPROVAL_ID = "extra_approval_id"
        const val EXTRA_APPROVAL_DECISION = "extra_approval_decision"
    }
}

class ControllerSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val json = Json { ignoreUnknownKeys = true }
        val db = WazirDatabase.getInstance(applicationContext)
        val dao = db.cacheDao()
        val vault = KeystoreCredentialVault(applicationContext)
        val api = WazirControllerApi(vault)
        val notifications = WazirNotificationManager(applicationContext)

        val controllers = dao.listControllers().map { it.toDomain(json) }
        for (profile in controllers) {
            val approvalsResult = api.listApprovals(profile, status = "pending")
            approvalsResult.onSuccess { response ->
                if (response.pendingCount > 0) {
                    notifications.notifyPendingApprovalSummary(
                        controllerId = profile.id,
                        controllerName = profile.name,
                        pendingCount = response.pendingCount,
                    )
                }
            }
        }
        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "wazir_controller_background_sync"

        fun schedulePeriodicSync(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<ControllerSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
