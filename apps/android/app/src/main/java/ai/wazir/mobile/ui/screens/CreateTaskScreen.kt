package ai.wazir.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.unit.dp
import ai.wazir.mobile.domain.AgentDescriptorItem
import ai.wazir.mobile.domain.ComputerTelemetryItem
import ai.wazir.mobile.domain.CreateTaskRequest
import ai.wazir.mobile.domain.MobileTaskDetail
import ai.wazir.mobile.domain.ModelCatalogItem
import ai.wazir.mobile.domain.TaskPolicyRequest
import ai.wazir.mobile.domain.TaskResourceBudgetRequest
import ai.wazir.mobile.ui.components.StatusBadge
import ai.wazir.mobile.ui.components.formatDurationMs
import ai.wazir.mobile.ui.components.formatShortTimestamp
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OptionDropdown(
    label: String,
    options: List<Pair<String, String>>,
    selected: String?,
    onSelected: (String?) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val display = options.firstOrNull { it.first == selected }?.second ?: "Controller default"
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = display,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier
                .menuAnchor()
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(text = { Text("Controller default") }, onClick = { onSelected(null); expanded = false })
            options.forEach { (id, name) ->
                DropdownMenuItem(text = { Text(name) }, onClick = { onSelected(id); expanded = false })
            }
        }
    }
}

@Composable
fun CreateTaskScreen(
    models: List<ModelCatalogItem>,
    agents: List<AgentDescriptorItem>,
    computers: List<ComputerTelemetryItem>,
    isSubmitting: Boolean,
    onSubmit: (CreateTaskRequest, String) -> Unit,
    onCancel: () -> Unit,
) {
    var prompt by remember { mutableStateOf("") }
    var repository by remember { mutableStateOf("") }
    var modelId by remember { mutableStateOf<String?>(null) }
    var agentId by remember { mutableStateOf<String?>(null) }
    var computerId by remember { mutableStateOf<String?>(null) }
    var priority by remember { mutableStateOf("normal") }
    var maxTokens by remember { mutableStateOf("") }
    var maxCost by remember { mutableStateOf("") }
    var maxSeconds by remember { mutableStateOf("") }
    var localOnly by remember { mutableStateOf(true) }
    var networkAccess by remember { mutableStateOf(false) }
    var toolAccess by remember { mutableStateOf(true) }
    // One idempotency key per composed form; rotated only after the prompt is edited post-submit.
    var idempotencyKey by remember { mutableStateOf(UUID.randomUUID().toString()) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("New Task", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it; },
            label = { Text("What would you like Wazir to do?") },
            minLines = 5,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = repository,
            onValueChange = { repository = it },
            label = { Text("Target repository (optional)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OptionDropdown("Model", models.map { it.id to it.name }, modelId) { modelId = it }
        OptionDropdown("Agent", agents.map { it.name to it.name }, agentId) { agentId = it }
        OptionDropdown("Execution computer", computers.map { it.id to it.name }, computerId) { computerId = it }

        Text("Priority", style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("low", "normal", "high").forEach { p ->
                FilterChip(selected = priority == p, onClick = { priority = p }, label = { Text(p.replaceFirstChar { it.uppercase() }) })
            }
        }

        Text("Resource budget (optional)", style = MaterialTheme.typography.labelLarge)
        OutlinedTextField(maxTokens, { maxTokens = it.filter(Char::isDigit) }, label = { Text("Max tokens") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(maxCost, { maxCost = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Max cost (USD)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(maxSeconds, { maxSeconds = it.filter(Char::isDigit) }, label = { Text("Max execution time (seconds)") }, singleLine = true, modifier = Modifier.fillMaxWidth())

        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
            Column(Modifier.padding(12.dp)) {
                Text("Approval & policy", style = MaterialTheme.typography.labelLarge)
                Text(
                    "The controller's policy engine still decides what needs approval; these only narrow the task's allowances.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SwitchRow("Local models only", localOnly) { localOnly = it }
                SwitchRow("Allow network access", networkAccess) { networkAccess = it }
                SwitchRow("Allow tool use", toolAccess) { toolAccess = it }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) { Text("Cancel") }
            Button(
                enabled = prompt.isNotBlank() && !isSubmitting,
                modifier = Modifier.weight(1f),
                onClick = {
                    val budget = if (maxTokens.isNotBlank() || maxCost.isNotBlank() || maxSeconds.isNotBlank()) {
                        TaskResourceBudgetRequest(
                            maxTokens = maxTokens.toLongOrNull(),
                            maxCostUsd = maxCost.toDoubleOrNull(),
                            maxExecutionTimeSeconds = maxSeconds.toIntOrNull(),
                        )
                    } else null
                    onSubmit(
                        CreateTaskRequest(
                            input = prompt.trim(),
                            repository = repository.takeIf { it.isNotBlank() },
                            modelId = modelId,
                            agentId = agentId,
                            computerId = computerId,
                            priority = priority,
                            resourceBudget = budget,
                            policy = TaskPolicyRequest(localOnly, networkAccess, toolAccess),
                        ),
                        idempotencyKey,
                    )
                },
            ) {
                if (isSubmitting) CircularProgressIndicator(Modifier.height(18.dp).width(18.dp), strokeWidth = 2.dp) else Text("Submit")
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

private val STAGES = listOf("Planning", "Agent Execution", "Tool Calls", "Verification", "Completion")

private fun stageIndex(task: MobileTaskDetail): Int {
    if (task.state == "completed") return 4
    val p = task.phase.lowercase()
    return when {
        p.contains("verif") -> 3
        p.contains("tool") -> 2
        p.contains("agent") || p.contains("execut") || p.contains("running") -> 1
        p.contains("complete") -> 4
        else -> 0
    }
}

@Composable
fun LiveExecutionMonitorScreen(
    task: MobileTaskDetail?,
    canMutate: Boolean,
    onBack: () -> Unit,
    onCancel: (String) -> Unit,
    onOpenDetail: (String) -> Unit,
) {
    if (task == null) {
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            CircularProgressIndicator()
            Spacer(Modifier.height(12.dp))
            Text("Waiting for task from controller…")
            OutlinedButton(onClick = onBack) { Text("Back") }
        }
        return
    }
    val terminal = task.state in listOf("completed", "failed", "cancelled")
    val current = stageIndex(task)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(task.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            StatusBadge(task.state)
        }
        Text(
            "Elapsed ${formatDurationMs(task.elapsedMs)} • ${task.currentOperation ?: task.phase}",
            style = MaterialTheme.typography.bodySmall,
        )
        // Progress is never fabricated: indeterminate unless the task is terminal.
        if (terminal) {
            LinearProgressIndicator(progress = { if (task.state == "completed") 1f else 0f }, modifier = Modifier.fillMaxWidth())
        } else {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                STAGES.forEachIndexed { i, name ->
                    val status = when {
                        task.state == "failed" && i == current -> "failed"
                        i < current || (terminal && task.state == "completed") -> "passed"
                        i == current && !terminal -> "running"
                        else -> "pending"
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(name, fontWeight = if (i == current) FontWeight.Bold else FontWeight.Normal)
                        StatusBadge(status)
                    }
                }
            }
        }
        if (task.toolCalls.isNotEmpty()) {
            Text("Tool Calls", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            task.toolCalls.takeLast(10).forEach {
                Text("${it.tool} — ${it.status}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (task.logs.isNotEmpty()) {
            Text("Live Logs", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            task.logs.takeLast(30).forEach {
                Text(
                    "[${formatShortTimestamp(it.timestamp)}] ${it.message}",
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onBack) { Text("Back") }
            OutlinedButton(onClick = { onOpenDetail(task.taskId) }) { Text("Details") }
            if (canMutate && !terminal && task.supportedActions.contains("cancel")) {
                Button(onClick = { onCancel(task.taskId) }) { Text("Cancel Task") }
            }
        }
    }
}
