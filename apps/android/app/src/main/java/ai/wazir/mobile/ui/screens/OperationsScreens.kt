package ai.wazir.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import ai.wazir.mobile.domain.ComputerTelemetryItem
import ai.wazir.mobile.domain.CreateScheduleRequest
import ai.wazir.mobile.domain.MobileApprovalRecord
import ai.wazir.mobile.domain.MobileAutonomyState
import ai.wazir.mobile.domain.MobileScheduleItem
import ai.wazir.mobile.domain.ModelCatalogItem
import ai.wazir.mobile.domain.ModelInstanceItem
import ai.wazir.mobile.domain.PushRelayRegistration
import ai.wazir.mobile.domain.PushWakeupEvent
import ai.wazir.mobile.domain.ResourceBudgetSnapshot
import ai.wazir.mobile.domain.RuntimeItem
import ai.wazir.mobile.ui.components.StatusBadge
import ai.wazir.mobile.ui.components.formatShortTimestamp
import androidx.compose.material3.OutlinedTextField

@Composable
fun ApprovalCenterScreen(
    approvals: List<MobileApprovalRecord>,
    canMutate: Boolean,
    onDecide: (MobileApprovalRecord, String) -> Unit,
    autonomy: MobileAutonomyState = MobileAutonomyState(),
    schedules: List<MobileScheduleItem> = emptyList(),
    pushRegistrations: List<PushRelayRegistration> = emptyList(),
    recentPushWakeups: List<PushWakeupEvent> = emptyList(),
    onUpdateAutonomy: (String?, String?) -> Unit = { _, _ -> },
    onCreateSchedule: (CreateScheduleRequest) -> Unit = {},
    onToggleSchedule: (String, Boolean) -> Unit = { _, _ -> },
    onRunScheduleNow: (String) -> Unit = {},
    onDeleteSchedule: (String) -> Unit = {},
    onRegisterPushRelay: (String) -> Unit = {},
    onUnregisterPushRelay: () -> Unit = {},
    onTestPushWakeup: () -> Unit = {},
) {
    var tab by remember { mutableStateOf(0) }
    var showCreateSchedule by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val pending = approvals.filter { it.status == "pending" && it.expiresAt > now }
    val resolved = approvals.filter { it !in pending }

    Column(Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = tab) {
            Tab(tab == 0, { tab = 0 }, text = { Text("Pending (${pending.size})") })
            Tab(tab == 1, { tab = 1 }, text = { Text("Resolved (${resolved.size})") })
            Tab(tab == 2, { tab = 2 }, text = { Text("Schedules (${schedules.size})") })
        }
        if (tab == 2) {
            LazyColumn(
                Modifier.fillMaxSize().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("Autonomy & Cellular Guard", fontWeight = FontWeight.Bold)
                                StatusBadge("${autonomy.posture} • ${autonomy.networkGuard}")
                            }
                            if (canMutate) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    OutlinedButton(onClick = { onUpdateAutonomy("read-only", null) }) { Text("Read-Only") }
                                    OutlinedButton(onClick = { onUpdateAutonomy("request-review", null) }) { Text("Review") }
                                    OutlinedButton(onClick = { onUpdateAutonomy("auto-sandbox", null) }) { Text("Sandbox") }
                                }
                                val nextGuard = if (autonomy.networkGuard == "cellular-strict") "normal" else "cellular-strict"
                                OutlinedButton(onClick = { onUpdateAutonomy(null, nextGuard) }) {
                                    Text(
                                        if (autonomy.networkGuard == "cellular-strict") {
                                            "Disable Cellular Strict Guard"
                                        } else {
                                            "Enable Cellular Strict Guard (Require Approval on Cellular)"
                                        }
                                    )
                                }
                            }
                        }
                    }
                }
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("Out-of-Band Push Relay", fontWeight = FontWeight.Bold)
                                StatusBadge(if (pushRegistrations.isEmpty()) "disabled" else "${pushRegistrations.size} active")
                            }
                            if (recentPushWakeups.isNotEmpty()) {
                                val latest = recentPushWakeups.first()
                                Text(
                                    "Last wakeup: ${latest.title} (${latest.deliveryStatus})",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (canMutate) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Button(onClick = { onRegisterPushRelay("fcm") }) { Text("Enable FCM Push") }
                                    OutlinedButton(onClick = onTestPushWakeup) { Text("Test Wakeup") }
                                    if (pushRegistrations.isNotEmpty()) {
                                        OutlinedButton(onClick = onUnregisterPushRelay) { Text("Disable") }
                                    }
                                }
                            }
                        }
                    }
                }
                item {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "Recurring Tasks (@wazir/scheduler)",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        if (canMutate) {
                            Button(onClick = { showCreateSchedule = true }) { Text("+ Schedule") }
                        }
                    }
                }
                if (schedules.isEmpty()) {
                    item {
                        Text(
                            "No scheduled tasks configured.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(schedules, key = { it.id }) { sched ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(sched.name, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                                StatusBadge(if (sched.enabled) "enabled" else "paused")
                            }
                            Text(
                                "Cron: ${sched.cronExpression} • ${sched.nextRunDescription}",
                                fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.labelSmall,
                            )
                            Text(sched.prompt, style = MaterialTheme.typography.bodySmall)
                            Text(
                                "Agent: ${sched.agentId} • Posture: ${sched.autonomyPosture}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (canMutate) {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(onClick = { onRunScheduleNow(sched.id) }) { Text("Run Now") }
                                    OutlinedButton(onClick = { onToggleSchedule(sched.id, !sched.enabled) }) {
                                        Text(if (sched.enabled) "Pause" else "Resume")
                                    }
                                    OutlinedButton(onClick = { onDeleteSchedule(sched.id) }) { Text("Delete") }
                                }
                            }
                        }
                    }
                }
            }
            if (showCreateSchedule) {
                var schedName by remember { mutableStateOf("") }
                var schedCron by remember { mutableStateOf("0 9 * * *") }
                var schedPrompt by remember { mutableStateOf("") }
                AlertDialog(
                    onDismissRequest = { showCreateSchedule = false },
                    title = { Text("New Scheduled Task") },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = schedName,
                                onValueChange = { schedName = it },
                                label = { Text("Task Name") },
                                singleLine = true,
                            )
                            OutlinedTextField(
                                value = schedCron,
                                onValueChange = { schedCron = it },
                                label = { Text("Cron Expression") },
                                singleLine = true,
                            )
                            OutlinedTextField(
                                value = schedPrompt,
                                onValueChange = { schedPrompt = it },
                                label = { Text("Agent Prompt") },
                            )
                        }
                    },
                    confirmButton = {
                        TextButton(
                            onClick = {
                                if (schedName.isNotBlank() && schedPrompt.isNotBlank()) {
                                    onCreateSchedule(
                                        CreateScheduleRequest(
                                            name = schedName.trim(),
                                            prompt = schedPrompt.trim(),
                                            cronExpression = schedCron.trim().ifBlank { "0 9 * * *" },
                                        )
                                    )
                                    showCreateSchedule = false
                                }
                            }
                        ) { Text("Create") }
                    },
                    dismissButton = {
                        TextButton(onClick = { showCreateSchedule = false }) { Text("Cancel") }
                    },
                )
            }
        } else {
            val list = if (tab == 0) pending else resolved
            if (list.isEmpty()) {
                Text(
                    "No ${if (tab == 0) "pending" else "resolved"} approvals.",
                    Modifier.padding(24.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn(
                Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(list, key = { it.id }) { a ->
                    var confirm by remember { mutableStateOf<String?>(null) }
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("${a.tool}: ${a.operation}", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                                StatusBadge(a.riskClassification)
                            }
                            Text("Task: ${a.taskTitle ?: a.taskId ?: "—"} • Agent: ${a.agentId ?: "—"}", style = MaterialTheme.typography.bodySmall)
                            Text("Rule: ${a.rule}", style = MaterialTheme.typography.bodySmall)
                            a.reasons.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
                            if (a.expectedSideEffects.isNotBlank()) Text("Side effects: ${a.expectedSideEffects}", style = MaterialTheme.typography.bodySmall)
                            if (a.relevantResources.isNotEmpty()) Text("Resources: ${a.relevantResources.joinToString()}", style = MaterialTheme.typography.bodySmall)
                            Text("Arguments (redacted): ${a.redactedArguments}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall)
                            if (a.status == "pending" && a.expiresAt > now) {
                                val secs = ((a.expiresAt - now) / 1000).coerceAtLeast(0)
                                Text("Expires in ${secs / 60}m ${secs % 60}s", style = MaterialTheme.typography.labelMedium)
                                if (a.requiresBiometric) Text("Biometric confirmation required", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                                if (canMutate) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Button(onClick = { confirm = "approve" }) { Text("Approve") }
                                        OutlinedButton(onClick = { confirm = "reject" }) { Text("Reject") }
                                    }
                                } else Text("Read-only device: cannot resolve approvals", style = MaterialTheme.typography.labelSmall)
                            } else {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    StatusBadge(if (a.status == "pending") "expired" else a.status)
                                    Text(formatShortTimestamp(a.resolvedAt), style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                    confirm?.let { decision ->
                        AlertDialog(
                            onDismissRequest = { confirm = null },
                            title = { Text(if (decision == "approve") "Approve operation?" else "Reject operation?") },
                            text = { Text("${a.tool}: ${a.operation}\nHash ${a.argumentsHash.take(12)}…") },
                            confirmButton = { TextButton(onClick = { confirm = null; onDecide(a, decision) }) { Text("Confirm") } },
                            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Back") } },
                        )
                    }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

@Composable
fun ModelsRuntimesScreen(
    models: List<ModelCatalogItem>,
    instances: List<ModelInstanceItem>,
    runtimes: List<RuntimeItem>,
) {
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Models & Runtimes", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            }
        }
        item {
            Text(
                "Load, unload, pin, and reconcile are operator-only on the Wazir host and can't be performed from a paired mobile device.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        item { Text("Runtimes", style = MaterialTheme.typography.titleMedium) }
        if (runtimes.isEmpty()) item { Text("No runtimes reported.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(runtimes, key = { "rt-${it.id}" }) { r ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${r.name} (${r.type}${r.version?.let { " $it" } ?: ""})", fontWeight = FontWeight.Bold)
                        Text("Computer: ${r.computerId}", style = MaterialTheme.typography.bodySmall)
                        r.healthMessage?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
                    }
                    StatusBadge(r.health)
                }
            }
        }
        item { Text("Models", style = MaterialTheme.typography.titleMedium) }
        if (models.isEmpty()) item { Text("No models reported.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(models, key = { "m-${it.id}" }) { m ->
            val inst = instances.filter { it.modelId == m.id }
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(m.name, fontWeight = FontWeight.Bold)
                    Text(
                        listOfNotNull(m.provider, m.parameters, m.quantization, "ctx ${m.configuredContext ?: m.contextMax}").joinToString(" • "),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (inst.isEmpty()) Text("Installed, not loaded", style = MaterialTheme.typography.labelSmall)
                    inst.forEach { i ->
                        val computer = i.computerId ?: "local"
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    StatusBadge(if (i.loaded) "loaded" else (i.state ?: "installed"))
                                    StatusBadge(i.health)
                                    if (i.pinned == true) StatusBadge("pinned")
                                }
                                Text("${i.runtimeId} @ $computer", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ComputeWorkersScreen(computers: List<ComputerTelemetryItem>) {
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Compute & Workers", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
        if (computers.isEmpty()) item { Text("No computers registered.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(computers, key = { it.id }) { c ->
            val t = c.telemetry
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("${c.name}${if (c.local) " (controller)" else ""}", fontWeight = FontWeight.Bold)
                        StatusBadge(c.status)
                    }
                    Text("${c.type} • ${c.os?.platform.orEmpty()} ${c.os?.architecture.orEmpty()}", style = MaterialTheme.typography.bodySmall)
                    Text("Last heartbeat: ${formatShortTimestamp(c.lastHeartbeat)}", style = MaterialTheme.typography.labelSmall)
                    val hw = c.hardware
                    Text("CPU: ${hw.cpuModel ?: "unknown"} (${hw.cpuCores ?: "?"} cores)", style = MaterialTheme.typography.bodySmall)
                    if (!t.telemetryAvailable) {
                        Text("Live telemetry: Unavailable", style = MaterialTheme.typography.bodySmall)
                    } else {
                        Text("CPU utilization: ${t.cpuUtilizationPercent?.let { "%.0f%%".format(it) } ?: "Unavailable"}", style = MaterialTheme.typography.bodySmall)
                        Text(
                            "RAM: ${t.memoryUsedGB?.let { "%.1f".format(it) } ?: "?"} / ${t.memoryTotalGB?.let { "%.1f".format(it) } ?: "?"} GB",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (hw.gpus.isEmpty()) Text("GPU: none reported", style = MaterialTheme.typography.bodySmall)
                    hw.gpus.forEach { g ->
                        Text("GPU: ${g.vendor} ${g.model} • VRAM ${g.vramGB?.let { "%.0f GB".format(it) } ?: "unknown"}", style = MaterialTheme.typography.bodySmall)
                    }
                    // GPU % is shown only when the controller actually measured it.
                    Text(
                        "GPU utilization: ${t.gpuUtilizationPercent?.let { "%.0f%%".format(it) } ?: "Unavailable"}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (t.gpuMemoryUsedGB != null) {
                        Text("VRAM used: ${"%.1f".format(t.gpuMemoryUsedGB)} / ${t.gpuMemoryTotalGB?.let { "%.1f".format(it) } ?: "?"} GB", style = MaterialTheme.typography.bodySmall)
                    }
                    if (c.runningTasks.isNotEmpty()) {
                        Text("Running tasks:", style = MaterialTheme.typography.labelMedium)
                        c.runningTasks.forEach { Text("• ${it.title} (${it.taskId})", style = MaterialTheme.typography.bodySmall) }
                    }
                    if (c.modelAssignments.isNotEmpty()) {
                        Text("Models:", style = MaterialTheme.typography.labelMedium)
                        c.modelAssignments.forEach { Text("• ${it.modelId} — ${if (it.loaded) "loaded" else it.state}", style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}

@Composable
fun ResourceBudgetsScreen(
    resources: ResourceBudgetSnapshot?,
) {
    if (resources == null) {
        Text("Resource data unavailable.", Modifier.padding(24.dp))
        return
    }
    val stopped = resources.emergencyStop != null
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Resources & Budgets", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                StatusBadge(if (stopped) "blocked" else resources.overallMode)
            }
        }
        item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val tot = resources.totals
                    val lh = resources.localVsHosted
                    Text("Tokens: ${tot.totalTokens} (in ${tot.inputTokens}, out ${tot.outputTokens})")
                    Text("Cost: $${"%.4f".format(tot.totalCostUsd)} (provider-reported $${"%.4f".format(tot.providerReportedCostUsd)}, estimated $${"%.4f".format(tot.estimatedCostUsd)})", style = MaterialTheme.typography.bodySmall)
                    Text("Local: ${lh.localTokens} tok / ${lh.localRequests} req • Hosted: ${lh.hostedTokens} tok / ${lh.hostedRequests} req", style = MaterialTheme.typography.bodySmall)
                    val s = resources.usageBySource
                    Text("Usage source — provider: ${s.providerReportedTokens}, estimated: ${s.estimatedTokens}, conservative: ${s.conservativeTokens}", style = MaterialTheme.typography.labelSmall)
                    Text("Active reservations: ${tot.activeReservations}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        items(resources.warnings, key = { "w-${it.accountId}-${it.message}" }) { w ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusBadge(w.severity)
                    Text(w.message, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item { Text("Accounts & Quotas", style = MaterialTheme.typography.titleMedium) }
        items(resources.accounts, key = { "a-${it.id}" }) { a ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${a.provider} (${a.kind})", fontWeight = FontWeight.Bold)
                        StatusBadge(a.throttlingMode)
                    }
                    a.limits.forEach { l ->
                        Text(
                            "${l.unit}/${l.window}: ${"%.0f".format(l.used)}${l.limit?.let { " of ${"%.0f".format(it)}" } ?: ""} (${l.source})${l.utilizationPercent?.let { " • $it%" } ?: ""}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
        item { Text("Active Reservations", style = MaterialTheme.typography.titleMedium) }
        if (resources.reservations.isEmpty()) item { Text("None", style = MaterialTheme.typography.bodySmall) }
        items(resources.reservations, key = { "r-${it.id}" }) { r ->
            Text("• ${r.modelId} (${r.workload}) ~${r.estimatedInputTokens + r.estimatedOutputTokens} tok", style = MaterialTheme.typography.bodySmall)
        }
        item {
            Text(
                if (stopped) {
                    "Emergency stop is active. Resuming requires operator access on the Wazir host — not available from a paired mobile device."
                } else {
                    "Emergency Stop is operator-only on the Wazir host and can't be triggered from a paired mobile device."
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
