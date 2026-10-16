package ai.wazir.mobile

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Task
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import ai.wazir.mobile.notifications.WazirNotificationManager
import ai.wazir.mobile.security.BiometricAuthGate
import ai.wazir.mobile.ui.MainViewModel
import ai.wazir.mobile.ui.components.ControllerTopBar
import ai.wazir.mobile.ui.components.StalenessBanner
import ai.wazir.mobile.ui.screens.ApprovalCenterScreen
import ai.wazir.mobile.ui.screens.ComputeWorkersScreen
import ai.wazir.mobile.ui.screens.CreateTaskScreen
import ai.wazir.mobile.ui.screens.DashboardScreen
import ai.wazir.mobile.ui.screens.LiveExecutionMonitorScreen
import ai.wazir.mobile.ui.screens.ModelsRuntimesScreen
import ai.wazir.mobile.ui.screens.PairingOnboardingScreen
import ai.wazir.mobile.ui.screens.ResourceBudgetsScreen
import ai.wazir.mobile.ui.screens.TaskDetailScreen
import ai.wazir.mobile.ui.screens.TasksScreen
import ai.wazir.mobile.ui.theme.WazirMobileTheme
import kotlinx.coroutines.launch

class MainActivity : FragmentActivity() {
    private val viewModel: MainViewModel by viewModels { MainViewModel.Factory(applicationContext) }
    private var pendingRoute by androidx.compose.runtime.mutableStateOf<String?>(null)

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        handleIntent(intent)
        setContent {
            WazirMobileTheme {
                Surface { WazirApp(viewModel, this, pendingRoute) { pendingRoute = null } }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent?.getStringExtra(WazirNotificationManager.EXTRA_TARGET_ROUTE)?.let { pendingRoute = it }
        intent?.getStringExtra(WazirNotificationManager.EXTRA_CONTROLLER_ID)?.let { viewModel.selectController(it) }
        val data = intent?.data
        if (data != null && data.scheme == "wazir" && data.host == "pair") {
            viewModel.pairFromQrUri(data.toString())
        }
    }
}

private object Routes {
    const val PAIR = "pair"
    const val DASHBOARD = "dashboard"
    const val TASKS = "tasks"
    const val TASK_DETAIL = "task/{id}"
    const val MONITOR = "monitor/{id}"
    const val NEW_TASK = "new-task"
    const val APPROVALS = "approvals"
    const val MODELS = "models"
    const val WORKERS = "workers"
    const val RESOURCES = "resources"
}

@Composable
private fun WazirApp(
    vm: MainViewModel,
    activity: FragmentActivity,
    pendingRoute: String?,
    onRouteConsumed: () -> Unit,
) {
    val state by vm.uiState.collectAsState()
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val active = state.activeController
    val canMutate = active?.canMutate == true
    val canExecute = active?.canExecute == true
    val backEntry by nav.currentBackStackEntryAsState()
    val route = backEntry?.destination?.route

    LaunchedEffect(active == null) {
        if (active == null) nav.navigate(Routes.PAIR) { popUpTo(0) }
        else if (route == null || route == Routes.PAIR) nav.navigate(Routes.DASHBOARD) { popUpTo(0) }
    }
    LaunchedEffect(pendingRoute, active?.id) {
        if (pendingRoute != null && active != null) {
            val target = when (pendingRoute) {
                "approvals" -> Routes.APPROVALS
                "tasks" -> Routes.TASKS
                "workers" -> Routes.WORKERS
                "resources" -> Routes.RESOURCES
                else -> Routes.DASHBOARD
            }
            nav.navigate(target)
            onRouteConsumed()
        }
    }

    val tabs = listOf(
        Triple(Routes.DASHBOARD, "Home", Icons.Default.Dashboard),
        Triple(Routes.TASKS, "Tasks", Icons.Default.Task),
        Triple(Routes.APPROVALS, "Approvals", Icons.Default.Security),
        Triple(Routes.MODELS, "Models", Icons.Default.Memory),
        Triple(Routes.WORKERS, "Workers", Icons.Default.Storage),
    )

    fun go(r: String) = nav.navigate(r) { launchSingleTop = true }

    suspend fun authenticate(title: String, desc: String): Boolean =
        BiometricAuthGate.canAuthenticate(activity) &&
            BiometricAuthGate.authenticate(activity, title, "Wazir Mobile", desc).getOrDefault(false)

    Scaffold(
        topBar = {
            if (route != Routes.PAIR) {
                Column {
                    ControllerTopBar(
                        controllers = state.controllers,
                        activeController = active,
                        sseState = state.sseState,
                        isOfflineCached = state.isOfflineCached,
                        onSelectController = vm::selectController,
                        onAddController = { vm.resetPairingStage(); go(Routes.PAIR) },
                        onUnpairController = vm::unpairController,
                        onRefresh = { vm.refreshAll() },
                    )
                    StalenessBanner(state.isOfflineCached, state.lastSyncedAtMs, state.bannerMessage, state.bannerIsError, vm::clearBanner)
                }
            }
        },
        bottomBar = {
            if (route != Routes.PAIR && active != null) {
                NavigationBar {
                    tabs.forEach { (r, label, icon) ->
                        NavigationBarItem(
                            selected = route == r,
                            onClick = { go(r) },
                            icon = { Icon(icon, contentDescription = label) },
                            label = { Text(label) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        NavHost(nav, startDestination = if (active == null) Routes.PAIR else Routes.DASHBOARD, modifier = Modifier.padding(padding)) {
            composable(Routes.PAIR) {
                PairingOnboardingScreen(
                    pairingStage = state.pairingStage,
                    discoveredControllers = state.discoveredControllers,
                    isMdnsScanning = state.isMdnsScanning,
                    hasExistingControllers = state.controllers.isNotEmpty(),
                    onPairFromQr = { uri, url -> vm.pairFromQrUri(uri, url) },
                    onPairManual = { url, fp, sid, secret, name -> vm.startPairingSession(url, fp, sid, secret, name) },
                    onStartMdns = vm::startMdnsScan,
                    onStopMdns = vm::stopMdnsScan,
                    onResetStage = vm::resetPairingStage,
                    onPairingCompleteNavigate = { nav.navigate(Routes.DASHBOARD) { popUpTo(0) } },
                )
            }
            composable(Routes.DASHBOARD) {
                DashboardScreen(
                    dashboard = state.dashboard,
                    recentEvents = state.recentEvents,
                    isOfflineCached = state.isOfflineCached,
                    canExecute = canExecute,
                    onNewTask = { go(Routes.NEW_TASK) },
                    onViewTasksWithFilter = { vm.setTaskTab(it); go(Routes.TASKS) },
                    onViewApprovals = { go(Routes.APPROVALS) },
                    onViewModels = { go(Routes.MODELS) },
                    onInspectWorkers = { go(Routes.WORKERS) },
                    onViewResources = { go(Routes.RESOURCES) },
                    onOpenTaskDetail = { vm.loadTaskDetail(it); go("task/$it") },
                )
            }
            composable(Routes.TASKS) {
                TasksScreen(
                    tasks = state.tasks,
                    selectedTab = state.selectedTaskTab,
                    canMutate = canMutate,
                    canExecute = canExecute,
                    onSelectTab = vm::setTaskTab,
                    onOpenTaskDetail = { vm.loadTaskDetail(it); go("task/$it") },
                    onCreateTask = { go(Routes.NEW_TASK) },
                )
            }
            composable(Routes.TASK_DETAIL) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                LaunchedEffect(id) { vm.loadTaskDetail(id) }
                TaskDetailScreen(
                    task = state.activeTaskDetail?.takeIf { it.taskId == id },
                    isCached = state.activeTaskDetailCached,
                    canMutate = canMutate,
                    canExecute = canExecute,
                    onBack = { nav.popBackStack() },
                    onOpenLiveMonitor = { vm.startTaskLivePolling(it); go("monitor/$it") },
                    onOpenApprovals = { go(Routes.APPROVALS) },
                    onCancelTask = vm::cancelTask,
                    onRetryTask = { vm.retryTask(it) { newId -> vm.loadTaskDetail(newId); go("task/$newId") } },
                    onResumeTask = vm::resumeTask,
                )
            }
            composable(Routes.MONITOR) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                LaunchedEffect(id) { vm.startTaskLivePolling(id) }
                androidx.compose.runtime.DisposableEffect(id) { onDispose { vm.stopTaskLivePolling() } }
                LiveExecutionMonitorScreen(
                    task = state.activeTaskDetail?.takeIf { it.taskId == id },
                    canMutate = canMutate,
                    onBack = { nav.popBackStack() },
                    onCancel = vm::cancelTask,
                    onOpenDetail = { go("task/$it") },
                )
            }
            composable(Routes.NEW_TASK) {
                CreateTaskScreen(
                    models = state.models,
                    agents = state.agents,
                    computers = state.computers,
                    isSubmitting = state.isSubmittingTask,
                    onSubmit = { req, key ->
                        vm.submitNewTask(req, key) { id ->
                            vm.startTaskLivePolling(id)
                            nav.navigate("monitor/$id") { popUpTo(Routes.NEW_TASK) { inclusive = true } }
                        }
                    },
                    onCancel = { nav.popBackStack() },
                )
            }
            composable(Routes.APPROVALS) {
                ApprovalCenterScreen(
                    approvals = state.approvals,
                    canMutate = canMutate,
                    onDecide = { approval, decision ->
                        scope.launch {
                            var biometric = false
                            if (decision == "approve" && approval.requiresBiometric) {
                                biometric = authenticate("Approve ${approval.tool}", approval.operation)
                                if (!biometric) return@launch
                            }
                            vm.resolveApproval(approval, decision, biometric)
                        }
                    },
                )
            }
            composable(Routes.MODELS) {
                ModelsRuntimesScreen(
                    models = state.models,
                    instances = state.modelInstances,
                    runtimes = state.runtimes,
                )
            }
            composable(Routes.WORKERS) { ComputeWorkersScreen(state.computers) }
            composable(Routes.RESOURCES) {
                ResourceBudgetsScreen(resources = state.resources)
            }
        }
    }
}
