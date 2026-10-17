package ai.wazir.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.wazir.mobile.domain.ControllerProfile
import ai.wazir.mobile.network.SseConnectionState
import ai.wazir.mobile.ui.theme.WazirAmber
import ai.wazir.mobile.ui.theme.WazirCrimson
import ai.wazir.mobile.ui.theme.WazirCyan
import ai.wazir.mobile.ui.theme.WazirEmerald
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ControllerTopBar(
    controllers: List<ControllerProfile>,
    activeController: ControllerProfile?,
    sseState: SseConnectionState,
    isOfflineCached: Boolean,
    onSelectController: (String) -> Unit,
    onAddController: () -> Unit,
    onUnpairController: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }

    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
        title = {
            Box {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { menuExpanded = true }
                        .padding(vertical = 4.dp, horizontal = 6.dp),
                ) {
                    ConnectionDot(sseState = sseState, isOfflineCached = isOfflineCached)
                    Spacer(modifier = Modifier.width(8.dp))
                    Column(modifier = Modifier.weight(1f, fill = false)) {
                        Text(
                            text = activeController?.name ?: "No Controller Paired",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = buildConnectionSubtitle(activeController, sseState, isOfflineCached),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Icon(
                        imageVector = Icons.Default.ArrowDropDown,
                        contentDescription = "Switch Wazir Controller",
                    )
                }

                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false },
                ) {
                    controllers.forEach { ctrl ->
                        val isSelected = ctrl.id == activeController?.id
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(
                                        text = if (isSelected) "● ${ctrl.name}" else ctrl.name,
                                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                    )
                                    Text(
                                        text = "${ctrl.baseUrl} (${ctrl.scopes.joinToString(",")})",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            },
                            onClick = {
                                menuExpanded = false
                                onSelectController(ctrl.id)
                            },
                        )
                    }
                    HorizontalDivider()
                    DropdownMenuItem(
                        leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                        text = { Text("Pair Another Wazir Controller") },
                        onClick = {
                            menuExpanded = false
                            onAddController()
                        },
                    )
                    if (activeController != null) {
                        DropdownMenuItem(
                            leadingIcon = {
                                Icon(
                                    Icons.Default.Delete,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            },
                            text = {
                                Text(
                                    "Unpair ${activeController.name}",
                                    color = MaterialTheme.colorScheme.error,
                                )
                            },
                            onClick = {
                                menuExpanded = false
                                onUnpairController(activeController.id)
                            },
                        )
                    }
                }
            }
        },
        actions = {
            IconButton(
                onClick = onRefresh,
                modifier = Modifier.semantics { contentDescription = "Refresh controller data" },
            ) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh")
            }
        },
    )
}

@Composable
private fun ConnectionDot(sseState: SseConnectionState, isOfflineCached: Boolean) {
    val color = when {
        isOfflineCached -> WazirAmber
        sseState == SseConnectionState.CONNECTED -> WazirEmerald
        sseState == SseConnectionState.CONNECTING || sseState == SseConnectionState.RECONNECTING -> WazirCyan
        sseState == SseConnectionState.AUTH_ERROR -> WazirCrimson
        else -> Color.Gray
    }
    Box(
        modifier = Modifier
            .size(10.dp)
            .clip(CircleShape)
            .background(color),
    )
}

private fun buildConnectionSubtitle(
    controller: ControllerProfile?,
    sseState: SseConnectionState,
    isOfflineCached: Boolean,
): String {
    if (controller == null) return "Tap to pair a controller"
    val stateLabel = when {
        isOfflineCached -> "Offline Cache"
        sseState == SseConnectionState.CONNECTED -> "Live Stream"
        sseState == SseConnectionState.RECONNECTING -> "Reconnecting…"
        sseState == SseConnectionState.CONNECTING -> "Connecting…"
        sseState == SseConnectionState.AUTH_ERROR -> "Auth Expired"
        else -> "Standby"
    }
    return "$stateLabel • v${controller.controllerVersion} • ${controller.baseUrl}"
}

@Composable
fun StalenessBanner(
    isOfflineCached: Boolean,
    lastSyncedAtMs: Long?,
    bannerMessage: String?,
    bannerIsError: Boolean,
    onDismissBanner: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        if (isOfflineCached) {
            val timeStr = if (lastSyncedAtMs != null) {
                SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(lastSyncedAtMs))
            } else {
                "unknown"
            }
            Surface(
                color = WazirAmber.copy(alpha = 0.18f),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Default.Warning,
                        contentDescription = "Stale cached state warning",
                        tint = WazirAmber,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "STALE CACHED DATA — Controller unreachable. Last synced at $timeStr.",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }

        if (!bannerMessage.isNullOrBlank()) {
            val bgColor = if (bannerIsError) {
                WazirCrimson.copy(alpha = 0.16f)
            } else {
                WazirEmerald.copy(alpha = 0.16f)
            }
            val accent = if (bannerIsError) WazirCrimson else WazirEmerald
            Surface(
                color = bgColor,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = bannerMessage,
                        style = MaterialTheme.typography.bodySmall,
                        color = accent,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = onDismissBanner, modifier = Modifier.size(24.dp)) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Dismiss notification banner",
                            tint = accent,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun StatusBadge(label: String, modifier: Modifier = Modifier) {
    val norm = label.lowercase()
    val (bg, fg) = when {
        norm in listOf("running", "active", "in_progress", "loaded", "online", "healthy", "passed", "normal", "approve", "approved") ->
            WazirEmerald.copy(alpha = 0.18f) to WazirEmerald
        norm in listOf("queued", "pending", "loading", "reconnecting", "throttle", "medium", "pinned") ->
            WazirCyan.copy(alpha = 0.18f) to WazirCyan
        norm in listOf("blocked", "awaiting_approval", "degraded", "high", "warning", "degrade") ->
            WazirAmber.copy(alpha = 0.20f) to WazirAmber
        norm in listOf("failed", "error", "critical", "unavailable", "offline", "rejected", "expired", "cancelled", "block") ->
            WazirCrimson.copy(alpha = 0.20f) to WazirCrimson
        else ->
            MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }

    Surface(
        color = bg,
        shape = RoundedCornerShape(6.dp),
        modifier = modifier,
    ) {
        Text(
            text = label.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = fg,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

fun formatDurationMs(ms: Long): String {
    if (ms <= 0L) return "0s"
    val totalSeconds = ms / 1000L
    val mins = totalSeconds / 60L
    val secs = totalSeconds % 60L
    return if (mins > 0) "${mins}m ${secs}s" else "${secs}s"
}

fun formatShortTimestamp(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return iso.replace("T", " ").take(19)
}
