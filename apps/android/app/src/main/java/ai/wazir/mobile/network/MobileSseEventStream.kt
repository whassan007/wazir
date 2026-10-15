package ai.wazir.mobile.network

import ai.wazir.mobile.domain.ControllerProfile
import ai.wazir.mobile.domain.MobileStreamEvent
import ai.wazir.mobile.security.CredentialVault
import ai.wazir.mobile.security.TlsPinningClientFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

enum class SseConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    AUTH_ERROR,
}

/**
 * Deterministic sequence ordering and deduplication filter for SSE events.
 * Prevents duplicate state mutations or notifications after cursor-based stream resume.
 */
class SseEventDeduplicator(private val maxSeenIds: Int = 512) {
    private val seenEventIds = LinkedHashSet<String>()
    var lastSequence: Long = 0L
        private set

    @Synchronized
    fun accept(event: MobileStreamEvent): Boolean {
        if (event.eventId.isNotBlank() && seenEventIds.contains(event.eventId)) {
            return false
        }
        if (event.sequence > 0 && event.sequence <= lastSequence) {
            return false
        }
        if (event.sequence > lastSequence) {
            lastSequence = event.sequence
        }
        if (event.eventId.isNotBlank()) {
            seenEventIds.add(event.eventId)
            while (seenEventIds.size > maxSeenIds) {
                val first = seenEventIds.iterator().next()
                seenEventIds.remove(first)
            }
        }
        return true
    }

    @Synchronized
    fun reset(initialCursor: Long = 0L) {
        seenEventIds.clear()
        lastSequence = initialCursor
    }
}

class MobileSseEventStream(
    private val credentialVault: CredentialVault,
    private val scope: CoroutineScope,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val deduplicator = SseEventDeduplicator()

    private val _connectionState = MutableStateFlow(SseConnectionState.DISCONNECTED)
    val connectionState: StateFlow<SseConnectionState> = _connectionState.asStateFlow()

    private val _lastHeartbeatMs = MutableStateFlow<Long?>(null)
    val lastHeartbeatMs: StateFlow<Long?> = _lastHeartbeatMs.asStateFlow()

    private val _events = MutableSharedFlow<MobileStreamEvent>(extraBufferCapacity = 128)
    val events: SharedFlow<MobileStreamEvent> = _events.asSharedFlow()

    private var activeJob: Job? = null
    private var activeEventSource: EventSource? = null
    private var activeControllerId: String? = null

    fun connect(profile: ControllerProfile, initialCursor: Long = 0L) {
        if (activeControllerId == profile.id &&
            (_connectionState.value == SseConnectionState.CONNECTED ||
                _connectionState.value == SseConnectionState.CONNECTING)
        ) {
            return
        }

        disconnect()
        activeControllerId = profile.id
        if (initialCursor > deduplicator.lastSequence) {
            deduplicator.reset(initialCursor)
        }

        activeJob = scope.launch(Dispatchers.IO) {
            var attempt = 0
            while (isActive && activeControllerId == profile.id) {
                val credential = credentialVault.getCredential(profile.id)
                if (credential == null) {
                    _connectionState.value = SseConnectionState.AUTH_ERROR
                    break
                }

                _connectionState.value = if (attempt == 0) {
                    SseConnectionState.CONNECTING
                } else {
                    SseConnectionState.RECONNECTING
                }

                val cursor = deduplicator.lastSequence
                val cleanUrl = profile.baseUrl.trimEnd('/')
                val request = Request.Builder()
                    .url("$cleanUrl/api/v1/mobile/events?cursor=$cursor")
                    .header("Authorization", "Bearer ${credential.accessToken}")
                    .header("Last-Event-ID", cursor.toString())
                    .header("Accept", "text/event-stream")
                    .build()

                val client = TlsPinningClientFactory.createClient(
                    baseUrl = cleanUrl,
                    tlsCertFingerprint = profile.tlsCertFingerprint,
                    readTimeoutSeconds = 0L, // Infinite read timeout for SSE stream
                ).newBuilder()
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                    .build()

                val disconnectSignal = kotlinx.coroutines.CompletableDeferred<Int>()

                val listener = object : EventSourceListener() {
                    override fun onOpen(eventSource: EventSource, response: Response) {
                        attempt = 0
                        _connectionState.value = SseConnectionState.CONNECTED
                        _lastHeartbeatMs.value = System.currentTimeMillis()
                    }

                    override fun onEvent(
                        eventSource: EventSource,
                        id: String?,
                        type: String?,
                        data: String,
                    ) {
                        _lastHeartbeatMs.value = System.currentTimeMillis()
                        if (type == "wazir.heartbeat") {
                            return
                        }
                        try {
                            val event = json.decodeFromString<MobileStreamEvent>(data)
                            if (deduplicator.accept(event)) {
                                _events.tryEmit(event)
                            }
                        } catch (_: Exception) {
                            // Ignore malformed individual frame
                        }
                    }

                    override fun onClosed(eventSource: EventSource) {
                        disconnectSignal.complete(200)
                    }

                    override fun onFailure(
                        eventSource: EventSource,
                        t: Throwable?,
                        response: Response?,
                    ) {
                        val code = response?.code ?: 0
                        disconnectSignal.complete(code)
                    }
                }

                val factory = EventSources.createFactory(client)
                val source = factory.newEventSource(request, listener)
                activeEventSource = source

                val statusCode = disconnectSignal.await()
                source.cancel()

                if (!isActive || activeControllerId != profile.id) {
                    break
                }

                if (statusCode == 401 || statusCode == 403) {
                    _connectionState.value = SseConnectionState.AUTH_ERROR
                    break
                }

                attempt += 1
                _connectionState.value = SseConnectionState.RECONNECTING
                val baseDelayMs = min(15_000L, 1_000L * (1L shl min(attempt, 4)))
                val jitterMs = Random.nextLong(100L, 650L)
                delay(baseDelayMs + jitterMs)
            }
        }
    }

    fun disconnect() {
        activeControllerId = null
        activeEventSource?.cancel()
        activeEventSource = null
        activeJob?.cancel()
        activeJob = null
        _connectionState.value = SseConnectionState.DISCONNECTED
    }

    fun currentCursor(): Long = deduplicator.lastSequence
}
