package ai.wazir.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.wazir.mobile.domain.DashboardCards
import ai.wazir.mobile.domain.DashboardSnapshot
import ai.wazir.mobile.domain.MobileApprovalRecord
import ai.wazir.mobile.domain.MobileAutonomyState
import ai.wazir.mobile.domain.MobileStreamEvent
import ai.wazir.mobile.ui.components.StatusBadge
import ai.wazir.mobile.ui.components.formatShortTimestamp
import ai.wazir.mobile.ui.theme.WazirAmber
import ai.wazir.mobile.ui.theme.WazirCrimson
import ai.wazir.mobile.ui.theme.WazirCyan
import ai.wazir.mobile.ui.theme.WazirEmerald
import ai.wazir.mobile.ui.theme.WazirGold
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DashboardScreen(
    dashboard: DashboardSnapshot?,
    recentEvents: List<MobileStreamEvent>,
    isOfflineCached: Boolean,
    canExecute: Boolean,
    onNewTask: () -> Unit,
    onViewTasksWithFilter: (String) -> Unit,
    onViewApprovals: () -> Unit,
    onViewModels: () -> Unit,
    onInspectWorkers: () -> Unit,
    onViewResources: () -> Unit,
    onOpenTaskDetail: (String) -> Unit,
    pendingApprovals: List<MobileApprovalRecord> = emptyList(),
    autonomy: MobileAutonomyState = MobileAutonomyState(),
    canMutate: Boolean = false,
    onResolveApproval: (MobileApprovalRecord, String) -> Unit = { _, _ -> },
    onUpdateAutonomy: (String?, String?) -> Unit = { _, _ -> },
) {
    val cards = dashboard?.cards ?: DashboardCards()

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (pendingApprovals.isNotEmpty()) {
            val topApproval = pendingApprovals.first()
            item {
                Spacer(modifier = Modifier.height(4.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = WazirAmber.copy(alpha = 0.16f)),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Column(
                        modifier = Modifier.padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "Approval Gate (${pendingApprovals.size} pending)",
                                style = MaterialTheme.typography.titleSmall,
                                color = WazirAmber,
                                fontWeight = FontWeight.Bold,
                            )
                            StatusBadge(label = topApproval.riskClassification)
                        }
                        Text(
                            text = "${topApproval.tool}: ${topApproval.operation}",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (topApproval.requiresBiometric) {
                            Text(
                                text = "Biometric verification required before execution",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (canMutate) {
                                Button(
                                    onClick = { onResolveApproval(topApproval, "approve") },
                                    colors = ButtonDefaults.buttonColors(containerColor = WazirEmerald),
                                ) {
                                    Text("Approve")
                                }
                                OutlinedButton(
                                    onClick = { onResolveApproval(topApproval, "reject") },
                                ) {
                                    Text("Reject")
                                }
                            }
                            OutlinedButton(onClick = onViewApprovals) {
                                Text("View All")
                            }
                        }
                    }
                }
            }
        }

        item {
            Spacer(modifier = Modifier.height(4.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = "Operational Overview",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = if (isOfflineCached) {
                            "Cached snapshot from ${formatShortTimestamp(dashboard?.controller?.timestamp)}"
                        } else {
                            "Real-time controller telemetry • ${dashboard?.controller?.hostname ?: "connected"}"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (isOfflineCached) WazirAmber else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (canExecute) {
                    Button(onClick = onNewTask) {
                        Icon(Icons.Default.Add, contentDescription = null)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("New Task")
                    }
                }
            }
        }

        // Supervision Posture & Cellular Network Guard Bar
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                shape = RoundedCornerShape(12.dp),
            ) {
                Column(
                    modifier = Modifier.padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Autonomy & Network Guard",
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            StatusBadge(label = autonomy.posture)
                            StatusBadge(label = autonomy.networkGuard)
                        }
                    }
                    if (canMutate) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            listOf(
                                "read-only" to "Read-Only",
                                "request-review" to "Request Review",
                                "auto-sandbox" to "Auto (Sandbox)",
                            ).forEach { (postureKey, label) ->
                                AssistChip(
                                    onClick = { onUpdateAutonomy(postureKey, null) },
                                    label = {
                                        Text(
                                            text = if (autonomy.posture == postureKey) "✓ $label" else label
                                        )
                                    },
                                )
                            }
                            val nextGuard = if (autonomy.networkGuard == "cellular-strict") "normal" else "cellular-strict"
                            AssistChip(
                                onClick = { onUpdateAutonomy(null, nextGuard) },
                                label = {
                                    Text(
                                        text = if (autonomy.networkGuard == "cellular-strict") {
                                            "✓ Cellular Strict Guard"
                                        } else {
                                            "Enable Cellular Strict"
                                        }
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }

        // 8 Operational Dashboard Cards (2x4 Grid)
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MetricDashboardCard(
                        title = "Running Tasks",
                        value = cards.runningTasks.toString(),
                        subtitle = "Active agent executions",
                        accent = WazirEmerald,
                        modifier = Modifier.weight(1f),
                        onClick = { onViewTasksWithFilter("running") },
                    )
                    MetricDashboardCard(
                        title = "Queued Tasks",
                        value = cards.queuedTasks.toString(),
                        subtitle = "Awaiting dispatch",
                        accent = WazirCyan,
                        modifier = Modifier.weight(1f),
                        onClick = { onViewTasksWithFilter("queued") },
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MetricDashboardCard(
                        title = "Completed Tasks",
                        value = cards.completedTasks.toString(),
                        subtitle = "Verified & finished",
                        accent = WazirEmerald,
                        modifier = Modifier.weight(1f),
                        onClick = { onViewTasksWithFilter("completed") },
                    )
                    MetricDashboardCard(
                        title = "Failed Tasks",
                        value = cards.failedTasks.toString(),
                        subtitle = "Requires inspection",
                        accent = if (cards.failedTasks > 0) WazirCrimson else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                        onClick = { onViewTasksWithFilter("failed") },
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MetricDashboardCard(
                        title = "Requires Approval",
                        value = cards.tasksRequiringApproval.toString(),
                        subtitle = if (cards.tasksRequiringApproval > 0) "Action needed now" else "No pending gates",
                        accent = if (cards.tasksRequiringApproval > 0) WazirAmber else WazirGold,
                        modifier = Modifier.weight(1f),
                        onClick = onViewApprovals,
                    )
                    MetricDashboardCard(
                        title = "Connected Workers",
                        value = "${cards.connectedWorkers}/${cards.totalComputers}",
                        subtitle = "Online compute nodes",
                        accent = WazirCyan,
                        modifier = Modifier.weight(1f),
                        onClick = onInspectWorkers,
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    MetricDashboardCard(
                        title = "Active Models",
                        value = "${cards.activeModels}/${cards.availableModels}",
                        subtitle = "Loaded in VRAM/RAM",
                        accent = WazirGold,
                        modifier = Modifier.weight(1f),
                        onClick = onViewModels,
                    )
                    val res = cards.resourceStatus
                    val resValue = if (res.emergencyStop) "STOPPED" else res.mode.uppercase()
                    val resAccent = when {
                        res.emergencyStop || res.mode == "block" -> WazirCrimson
                        res.mode in listOf("throttle", "degrade") -> WazirAmber
                        else -> WazirEmerald
                    }
                    MetricDashboardCard(
                        title = "Resource Status",
                        value = resValue,
                        subtitle = "${res.totalTokensConsumed} tok • $${"%.2f".format(res.estimatedCostUsd)}",
                        accent = resAccent,
                        modifier = Modifier.weight(1f),
                        onClick = onViewResources,
                    )
                }
            }
        }

        // Quick Actions Bar
        item {
            Text(
                text = "Quick Actions",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 4.dp),
            )
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (canExecute) {
                    AssistChip(
                        onClick = onNewTask,
                        label = { Text("New Task") },
                        leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                    )
                }
                AssistChip(
                    onClick = { onViewTasksWithFilter("running") },
                    label = { Text("View Running Tasks") },
                    leadingIcon = { Icon(Icons.Default.PlayArrow, contentDescription = null) },
                )
                AssistChip(
                    onClick = onViewApprovals,
                    label = { Text("Pending Approvals (${cards.tasksRequiringApproval})") },
                    leadingIcon = { Icon(Icons.Default.Security, contentDescription = null) },
                )
                AssistChip(
                    onClick = onViewModels,
                    label = { Text("View Models") },
                    leadingIcon = { Icon(Icons.Default.Memory, contentDescription = null) },
                )
                AssistChip(
                    onClick = onInspectWorkers,
                    label = { Text("Inspect Workers") },
                    leadingIcon = { Icon(Icons.Default.Computer, contentDescription = null) },
                )
            }
        }

        // Live Chronological Activity Stream
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Live Activity",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = "${recentEvents.size} events",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (recentEvents.isEmpty()) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            imageVector = Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "No recent events recorded yet on this controller.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        } else {
            items(recentEvents, key = { it.eventId.ifBlank { "${it.sequence}-${it.timestamp}" } }) { event ->
                ActivityEventRow(
                    event = event,
                    onClick = {
                        val tid = event.taskId
                        if (!tid.isNullOrBlank()) {
                            onOpenTaskDetail(tid)
                        } else if (event.type.startsWith("approval.")) {
                            onViewApprovals()
                        }
                    },
                )
            }
        }

        item { Spacer(modifier = Modifier.height(24.dp)) }
    }
}

@Composable
private fun MetricDashboardCard(
    title: String,
    value: String,
    subtitle: String,
    accent: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Card(
        modifier = modifier
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.headlineSmall,
                color = accent,
                fontWeight = FontWeight.ExtraBold,
                maxLines = 1,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ActivityEventRow(
    event: MobileStreamEvent,
    onClick: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusBadge(label = event.status ?: event.type)
                Text(
                    text = "#${event.sequence} • ${formatShortTimestamp(event.timestamp)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = event.summary,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            val metaParts = buildList {
                if (!event.taskId.isNullOrBlank()) add("Task: ${event.taskId}")
                if (!event.agentId.isNullOrBlank()) add("Agent: ${event.agentId}")
                if (!event.modelId.isNullOrBlank()) add("Model: ${event.modelId}")
                if (!event.computerId.isNullOrBlank()) add("Node: ${event.computerId}")
            }
            if (metaParts.isNotEmpty()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = metaParts.joinToString(" • "),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
