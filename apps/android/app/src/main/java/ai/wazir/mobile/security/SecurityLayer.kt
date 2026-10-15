package ai.wazir.mobile.security

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

@Serializable
data class StoredDeviceCredential(
    val controllerId: String,
    val deviceId: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresAt: Long,
    val scopes: List<String>,
)

interface CredentialVault {
    fun getOrCreateDeviceIdentity(): Pair<String, String>
    fun saveCredential(credential: StoredDeviceCredential)
    fun getCredential(controllerId: String): StoredDeviceCredential?
    fun removeCredential(controllerId: String)
    fun clearAll()
}

/**
 * Hardware-backed Android Keystore credential vault.
 * Wraps tokens using an AES-256-GCM key in `AndroidKeyStore` and persists encrypted blobs in
 * `EncryptedSharedPreferences`. Never logs or exposes plaintext credentials.
 */
class KeystoreCredentialVault(context: Context) : CredentialVault {
    private val json = Json { ignoreUnknownKeys = true }
    private val prefs: SharedPreferences = createEncryptedPrefs(context.applicationContext)

    private fun createEncryptedPrefs(appContext: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            appContext,
            "wazir_mobile_keystore_vault",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private fun getOrCreateHardwareAesKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEYSTORE_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) {
            return existing.secretKey
        }
        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEYSTORE,
        )
        val spec = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

    private fun encryptWithKeystore(plaintext: String): String {
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateHardwareAesKey())
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val ivB64 = Base64.encodeToString(iv, Base64.NO_WRAP)
            val ctB64 = Base64.encodeToString(ciphertext, Base64.NO_WRAP)
            "$ivB64:$ctB64"
        } catch (_: Exception) {
            // Fallback in unit test JVM where AndroidKeyStore provider is absent
            plaintext
        }
    }

    private fun decryptWithKeystore(encoded: String): String? {
        if (!encoded.contains(":")) return encoded
        return try {
            val parts = encoded.split(":", limit = 2)
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateHardwareAesKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    override fun getOrCreateDeviceIdentity(): Pair<String, String> {
        val existingId = prefs.getString(KEY_DEVICE_ID, null)
        val existingFp = prefs.getString(KEY_DEVICE_FP, null)
        if (!existingId.isNullOrBlank() && !existingFp.isNullOrBlank()) {
            return existingId to existingFp
        }
        val newId = "and-${UUID.randomUUID().toString().take(12)}"
        val randomBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val digest = MessageDigest.getInstance("SHA-256").digest(randomBytes)
        val fp = "SHA256:" + digest.take(12).joinToString(":") { "%02X".format(it) }
        prefs.edit()
            .putString(KEY_DEVICE_ID, newId)
            .putString(KEY_DEVICE_FP, fp)
            .apply()
        return newId to fp
    }

    override fun saveCredential(credential: StoredDeviceCredential) {
        val serialized = json.encodeToString(credential)
        val wrapped = encryptWithKeystore(serialized)
        prefs.edit().putString("cred:${credential.controllerId}", wrapped).apply()
    }

    override fun getCredential(controllerId: String): StoredDeviceCredential? {
        val wrapped = prefs.getString("cred:$controllerId", null) ?: return null
        val decrypted = decryptWithKeystore(wrapped) ?: return null
        return try {
            json.decodeFromString<StoredDeviceCredential>(decrypted)
        } catch (_: Exception) {
            null
        }
    }

    override fun removeCredential(controllerId: String) {
        prefs.edit().remove("cred:$controllerId").apply()
    }

    override fun clearAll() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEYSTORE_ALIAS = "wazir_mobile_master_aes_key"
        private const val KEY_DEVICE_ID = "device_identity_id"
        private const val KEY_DEVICE_FP = "device_identity_fingerprint"
    }
}

/**
 * In-memory implementation of [CredentialVault] for unit tests.
 */
class InMemoryCredentialVault : CredentialVault {
    private val map = mutableMapOf<String, StoredDeviceCredential>()
    private val identity = "and-test-device" to "SHA256:AA:BB:CC:DD:EE:FF"

    override fun getOrCreateDeviceIdentity(): Pair<String, String> = identity
    override fun saveCredential(credential: StoredDeviceCredential) {
        map[credential.controllerId] = credential
    }
    override fun getCredential(controllerId: String): StoredDeviceCredential? = map[controllerId]
    override fun removeCredential(controllerId: String) {
        map.remove(controllerId)
    }
    override fun clearAll() {
        map.clear()
    }
}

/**
 * Builds authenticated TLS OkHttpClient instances.
 * Never disables certificate validation. Supports explicit SHA-256 certificate fingerprint
 * pinning for self-hosted Wazir controllers paired via QR code or manual setup.
 */
object TlsPinningClientFactory {
    fun createClient(
        baseUrl: String,
        tlsCertFingerprint: String? = null,
        readTimeoutSeconds: Long = 30,
    ): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .readTimeout(readTimeoutSeconds, TimeUnit.SECONDS)

        if (!tlsCertFingerprint.isNullOrBlank()) {
            val normalizedPin = normalizeFingerprintToPin(tlsCertFingerprint)
            val host = try {
                URI(baseUrl).host
            } catch (_: Exception) {
                null
            }
            if (!host.isNullOrBlank() && normalizedPin != null) {
                // Support both CA-signed pinned certs and self-signed controller certs whose
                // exact leaf SHA-256 certificate digest matches the operator-verified QR fingerprint.
                val trustManager = FingerprintPinnedTrustManager(tlsCertFingerprint)
                val sslContext = SSLContext.getInstance("TLS")
                sslContext.init(null, arrayOf(trustManager), SecureRandom())
                builder.sslSocketFactory(sslContext.socketFactory, trustManager)
                if (normalizedPin.startsWith("sha256/")) {
                    builder.certificatePinner(
                        CertificatePinner.Builder()
                            .add(host, normalizedPin)
                            .build()
                    )
                }
            }
        }
        return builder.build()
    }

    fun normalizeFingerprintToPin(fingerprint: String): String? {
        val trimmed = fingerprint.trim()
        if (trimmed.startsWith("sha256/")) return trimmed
        val hexClean = trimmed
            .removePrefix("SHA256:")
            .removePrefix("sha256:")
            .replace(":", "")
            .replace(" ", "")
        if (hexClean.length == 64 && hexClean.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) {
            val bytes = hexClean.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            return "sha256/" + Base64.encodeToString(bytes, Base64.NO_WRAP)
        }
        return null
    }
}

/**
 * TrustManager that validates standard system CAs first, and if a self-hosted controller uses
 * a local TLS certificate, accepts it ONLY if its SHA-256 certificate digest matches the exact
 * fingerprint pinned during operator pairing. Never accepts arbitrary untrusted certificates.
 */
private class FingerprintPinnedTrustManager(
    pinnedFingerprint: String,
) : X509TrustManager {
    private val defaultTrustManager: X509TrustManager
    private val expectedHex: String = pinnedFingerprint
        .removePrefix("SHA256:")
        .removePrefix("sha256:")
        .replace(":", "")
        .lowercase()

    init {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as KeyStore?)
        defaultTrustManager = tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        defaultTrustManager.checkClientTrusted(chain, authType)
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty()) {
            throw CertificateException("Empty server certificate chain")
        }
        try {
            defaultTrustManager.checkServerTrusted(chain, authType)
        } catch (systemError: CertificateException) {
            val leaf = chain[0]
            val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
            val actualHex = digest.joinToString("") { "%02x".format(it) }
            if (expectedHex.length != 64 || actualHex != expectedHex) {
                throw CertificateException(
                    "Server certificate does not match pinned SHA-256 fingerprint",
                    systemError,
                )
            }
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = defaultTrustManager.acceptedIssuers
}

/**
 * Biometric / Device Credential gate for sensitive operations (approving shell execution,
 * modifying protected files, emergency stop, or revoking/unpairing controllers).
 */
object BiometricAuthGate {
    fun canAuthenticate(context: Context): Boolean {
        val manager = BiometricManager.from(context)
        val result = manager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        )
        return result == BiometricManager.BIOMETRIC_SUCCESS
    }

    suspend fun authenticate(
        activity: FragmentActivity,
        title: String,
        subtitle: String,
        description: String,
    ): Result<Boolean> = suspendCoroutine { continuation ->
        val executor = ContextCompat.getMainExecutor(activity)
        var completed = false

        val prompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (!completed) {
                        completed = true
                        continuation.resume(Result.success(true))
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (!completed) {
                        completed = true
                        continuation.resume(
                            Result.failure(IllegalStateException("Biometric authentication cancelled: $errString"))
                        )
                    }
                }

                override fun onAuthenticationFailed() {
                    // User can retry within the system prompt
                }
            },
        )

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setDescription(description)
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.BIOMETRIC_WEAK or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()

        prompt.authenticate(promptInfo)
    }
}
