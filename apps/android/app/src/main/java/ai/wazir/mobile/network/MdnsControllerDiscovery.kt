package ai.wazir.mobile.network

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class DiscoveredWazirController(
    val serviceName: String,
    val host: String,
    val port: Int,
    val httpsUrl: String,
)

/**
 * Local/private-network controller discovery using Android Network Service Discovery (mDNS / DNS-SD).
 * Discovers `_wazir._tcp.` services advertised on the local LAN or private overlay network.
 */
class MdnsControllerDiscovery(context: Context) {
    private val nsdManager: NsdManager? =
        context.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager

    private val _discovered = MutableStateFlow<List<DiscoveredWazirController>>(emptyList())
    val discovered: StateFlow<List<DiscoveredWazirController>> = _discovered.asStateFlow()

    private val _isScanning = MutableStateFlow(false)
    val isScanning: StateFlow<Boolean> = _isScanning.asStateFlow()

    private var discoveryListener: NsdManager.DiscoveryListener? = null

    fun startDiscovery() {
        val manager = nsdManager ?: return
        if (_isScanning.value) return

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
                _isScanning.value = true
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                if (!service.serviceType.contains("_wazir")) return
                try {
                    @Suppress("DEPRECATION")
                    manager.resolveService(
                        service,
                        object : NsdManager.ResolveListener {
                            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                                // Ignore unresolvable mDNS announcement
                            }

                            override fun onServiceResolved(resolved: NsdServiceInfo) {
                                @Suppress("DEPRECATION")
                                val hostAddress = resolved.host?.hostAddress ?: return
                                val port = resolved.port
                                val item = DiscoveredWazirController(
                                    serviceName = resolved.serviceName,
                                    host = hostAddress,
                                    port = port,
                                    httpsUrl = "https://$hostAddress:$port",
                                )
                                val current = _discovered.value.toMutableList()
                                if (current.none { it.httpsUrl == item.httpsUrl }) {
                                    current.add(item)
                                    _discovered.value = current
                                }
                            }
                        },
                    )
                } catch (_: Exception) {
                    // Safe fallback if NSD resolution fails on restricted network
                }
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                _discovered.value = _discovered.value.filterNot {
                    it.serviceName == service.serviceName
                }
            }

            override fun onDiscoveryStopped(serviceType: String) {
                _isScanning.value = false
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                _isScanning.value = false
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                _isScanning.value = false
            }
        }

        discoveryListener = listener
        try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: Exception) {
            _isScanning.value = false
        }
    }

    fun stopDiscovery() {
        val manager = nsdManager ?: return
        val listener = discoveryListener ?: return
        try {
            manager.stopServiceDiscovery(listener)
        } catch (_: Exception) {
            // Already stopped
        } finally {
            discoveryListener = null
            _isScanning.value = false
        }
    }

    companion object {
        private const val SERVICE_TYPE = "_wazir._tcp."
    }
}
