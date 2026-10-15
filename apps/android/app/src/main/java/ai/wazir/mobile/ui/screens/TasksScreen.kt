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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.wazir.mobile.domain.MobileTaskDetail
import ai.wazir.mobile.domain.MobileTaskSummary
import ai.wazir.mobile.ui.components.StatusBadge
import ai.wazir.mobile.ui.components.formatDurationMs
import ai.wazir.mobile.ui.components.formatShortTimestamp
import ai.wazir.mobile.ui.theme.WazirAmber
import ai.wazir.mobile.ui.theme.WazirCrimson

private val TASK_TABS = listOf(
    "all" to "All",
    "running" to "Running",
    "queued" to "Queued",
    "completed" to "Completed",
    "failed" to "Failed",
    "blocked" to "Blocked",
)

@Composable
fun TasksScreen(
    tasks: List<MobileTaskSummary>,
    selectedTab: String,
    canMutate: Boolean,
    canExecute: Boolean,
    onSelectTab: (String) -> Unit,
    onOpenTaskDetail: (String) -> Unit,
    onCreateTask: () -> Unit,
) {
    val filtered = remember(tasks, selectedTab) {
        if (selectedTab == "all") {
            tasks
        } else {
            tasks.filter { it.state.equals(selectedTab, ignoreCase = true) }
        }
    }

    val selectedIndex = TASK_TABS.indexOfFirst { it.first == selectedTab }.coerceAtLeast(0)

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Task Management",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            if (canExecute) {
                Button(onClick = onCreateTask) {
                    Icon(Icons.Default.Add, contentDescription = null)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Submit Task")
                }
            }
        }

        ScrollableTabRow(
            selectedTabIndex = selectedIndex,
            edgePadding = 12.dp,
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            TASK_TABS.forEach { (key, label) ->
                val count = if (key == "all") {
                    tasks.size
                } else {
                    tasks.count { it.state.equals(key, ignoreCase = true) }
                }
                Tab(
                    selected = selectedTab == key,
                    onClick = { onSelectTab(key) },
                    text = { Text("$label ($count)") },
                )
            }
        }

        if (filtered.isEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "No ${if (selectedTab == "all") "" else "$selectedTab "}tasks found.",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (canExecute) {
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedButton(onClick = onCreateTask) {
                        Text("Create New Task")
                    }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(filtered, key = { it.taskId }) { task ->
                    TaskSummaryCard(
                        task = task,
                        onClick = { onOpenTaskDetail(task.taskId) },
                    )
                }
                item { Spacer(modifier = Modifier.height(20.dp)) }
            }
        }
    }
}

@Composable
private fun TaskSummaryCard(
    task: MobileTaskSummary,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = task.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(modifier = Modifier.width(8.dp))
                StatusBadge(label = task.state)
            }

            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = "ID: ${task.taskId} • Phase: ${task.phase}",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Agent: ${task.agentId}", style = MaterialTheme.typography.bodySmall)
                    Text("Model: ${task.modelId}", style = MaterialTheme.typography.bodySmall)
                    Text("Computer: ${task.computerId}", style = MaterialTheme.typography.bodySmall)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "Elapsed: ${formatDurationMs(task.elapsedMs)}",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = "Started: ${formatShortTimestamp(task.startedAt ?: task.createdAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "Last Activity: ${formatShortTimestamp(task.lastActivityAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Verification: ",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    StatusBadge(label = task.verificationStatus)
                }
                if (task.pendingApprovalIds.isNotEmpty()) {
                    StatusBadge(label = "${task.pendingApprovalIds.size} APPROVAL PENDING")
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaskDetailScreen(
    task: MobileTaskDetail?,
    isCached: Boolean,
    canMutate: Boolean,
    canExecute: Boolean,
    onBack: () -> Unit,
    onOpenLiveMonitor: (String) -> Unit,
    onOpenApprovals: () -> Unit,
    onCancelTask: (String) -> Unit,
    onRetryTask: (String) -> Unit,
    onResumeTask: (String) -> Unit,
) {
    var showFullLogs by remember { mutableStateOf(false) }

    if (task == null) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Loading task details from controller…")
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedButton(onClick = onBack) {
                Text("Back to Tasks")
            }
        }
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                Spacer(modifier = Modifier.width(6.dp))
                Text("Tasks")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (isCached) {
                    StatusBadge(label = "Cached")
                }
                StatusBadge(label = task.state)
            }
        }

        // Header Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = task.title,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Task ID: ${task.taskId} • Execution: ${task.executionId ?: "—"}",
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(10.dp))

                Text("Original Request", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                ) {
                    Text(
                        text = task.input,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(10.dp),
                    )
                }

                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    text = "Agent: ${task.agentId} • Model: ${task.modelId} (${task.runtimeId}) • Computer: ${task.computerId}",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (!task.repository.isNullOrBlank()) {
                    Text(
                        text = "Repository: ${task.repository}",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                Text(
                    text = "Elapsed: ${formatDurationMs(task.elapsedMs)} • Verification: ${task.verificationStatus}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                // Supported Task Actions (backend-enforced semantics only)
                Spacer(modifier = Modifier.height(12.dp))
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(onClick = { onOpenLiveMonitor(task.taskId) }) {
                        Icon(Icons.Default.Visibility, contentDescription = null)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Live Monitor")
                    }

                    if (canMutate && task.supportedActions.contains("cancel")) {
                        Button(
                            onClick = { onCancelTask(task.taskId) },
                            colors = ButtonDefaults.buttonColors(containerColor = WazirCrimson),
                        ) {
                            Icon(Icons.Default.Cancel, contentDescription = null)
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Cancel")
                        }
                    }

                    if (canExecute && task.supportedActions.contains("retry")) {
                        OutlinedButton(onClick = { onRetryTask(task.taskId) }) {
                            Icon(Icons.Default.Refresh, contentDescription = null)
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Retry")
                        }
                    }

                    if (canExecute && task.supportedActions.contains("resume")) {
                        Button(onClick = { onResumeTask(task.taskId) }) {
                            Icon(Icons.Default.PlayArrow, contentDescription = null)
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Resume")
                        }
                    }

                    if (task.pendingApprovalIds.isNotEmpty()) {
                        Button(
                            onClick = onOpenApprovals,
                            colors = ButtonDefaults.buttonColors(containerColor = WazirAmber),
                        ) {
                            Text("Review Approval (${task.pendingApprovalIds.size})")
                        }
                    }

                    if (task.supportedActions.contains("view_logs") || task.logs.isNotEmpty()) {
                        OutlinedButton(onClick = { showFullLogs = !showFullLogs }) {
                            Icon(Icons.Default.Terminal, contentDescription = null)
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(if (showFullLogs) "Hide Logs" else "View Logs (${task.logs.size})")
                        }
                    }
                }
            }
        }

        // Execution Timeline
        if (task.timeline.isNotEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Execution Timeline", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(8.dp))
                    task.timeline.forEach { step ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = "${step.phase}: ${step.title}",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                if (!step.detail.isNullOrBlank()) {
                                    Text(
                                        text = step.detail,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            StatusBadge(label = step.status)
                        }
                    }
                }
            }
        }

        // Agent Reasoning Summaries (explicitly permitted summaries only)
        if (task.reasoningSummaries.isNotEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Agent Reasoning Summaries",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    task.reasoningSummaries.forEach { summary ->
                        Text(
                            text = "• $summary",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(vertical = 2.dp),
                        )
                    }
                }
            }
        }

        // Tool Calls & Tool Results
        if (task.toolCalls.isNotEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Tool Calls (${task.toolCalls.size})",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    task.toolCalls.forEach { call ->
                        Surface(
                            color = MaterialTheme.colorScheme.surface,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp),
                        ) {
                            Column(modifier = Modifier.padding(10.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(
                                        text = call.tool,
                                        fontFamily = FontFamily.Monospace,
                                        fontWeight = FontWeight.Bold,
                                    )
                                    StatusBadge(label = call.status)
                                }
                                Text(
                                    text = "Args: ${call.input}",
                                    style = MaterialTheme.typography.labelSmall,
                                    fontFamily = FontFamily.Monospace,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                if (!call.output.isNullOrBlank()) {
                                    Text(
                                        text = "Result: ${call.output}",
                                        style = MaterialTheme.typography.bodySmall,
                                        fontFamily = FontFamily.Monospace,
                                    )
                                }
                                if (!call.error.isNullOrBlank()) {
                                    Text(
                                        text = "Error: ${call.error}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = WazirCrimson,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // Files Changed & Verification Report
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Verification & Files Changed",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(modifier = Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Verification Status: ", style = MaterialTheme.typography.bodySmall)
                    StatusBadge(label = task.verificationReport?.status ?: task.verificationStatus)
                }
                task.verificationReport?.checks?.forEach { check ->
                    Text(
                        text = "• ${check.name}: ${check.status} (${check.durationMs}ms)",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                if (task.filesChanged.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("Modified Files (${task.filesChanged.size}):", style = MaterialTheme.typography.labelMedium)
                    task.filesChanged.forEach { file ->
                        Text(
                            text = file,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }

        // Resource Consumption
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Resource Consumption", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                val rc = task.resourceConsumption
                Text(
                    text = "Tokens: ${rc.totalTokens} (in: ${rc.inputTokens}, out: ${rc.outputTokens}) • Source: ${rc.source}",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    text = "Cost: $${"%.4f".format(rc.estimatedCostUsd)} • Duration: ${formatDurationMs(rc.durationMs)}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        // Errors
        if (task.errors.isNotEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = WazirCrimson.copy(alpha = 0.14f)),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Errors (${task.errors.size})",
                        style = MaterialTheme.typography.titleMedium,
                        color = WazirCrimson,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    task.errors.forEach { err ->
                        Text(
                            text = "• $err",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }

        // Final Output
        if (!task.finalOutput.isNullOrBlank()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Final Output", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(6.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.surface,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = task.finalOutput,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }
            }
        }

        // Logs Viewer
        if (showFullLogs && task.logs.isNotEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Execution Logs", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                    task.logs.forEach { entry ->
                        Text(
                            text = "[${formatShortTimestamp(entry.timestamp)}] [${entry.phase}] ${entry.message}",
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.padding(vertical = 2.dp),
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(24.dp))
    }
}
