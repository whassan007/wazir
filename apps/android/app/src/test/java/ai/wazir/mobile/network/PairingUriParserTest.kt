package ai.wazir.mobile.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingUriParserTest {

    private val validSecret = "a".repeat(24)

    @Test
    fun `parses a well-formed wazir pair uri`() {
        val uri = "wazir://pair?sessionId=pair-123456&secret=$validSecret&name=My+Mac&url=https%3A%2F%2F10.0.0.5%3A8443&fp=SHA256%3AAA%3ABB&v=1.0.0"
        val result = PairingUriParser.parse(uri)
        assertTrue(result.isSuccess)
        val parsed = result.getOrThrow()
        assertEquals("pair-123456", parsed.sessionId)
        assertEquals(validSecret, parsed.pairingSecret)
        assertEquals("My Mac", parsed.controllerName)
        assertEquals("https://10.0.0.5:8443", parsed.controllerUrl)
        assertEquals("SHA256:AA:BB", parsed.tlsCertFingerprint)
        assertEquals("1.0.0", parsed.apiVersion)
    }

    @Test
    fun `defaults controller name and api version when absent`() {
        val uri = "wazir://pair?sessionId=pair-123456&secret=$validSecret"
        val parsed = PairingUriParser.parse(uri).getOrThrow()
        assertEquals("Wazir Controller", parsed.controllerName)
        assertEquals("1.0.0", parsed.apiVersion)
        assertEquals(null, parsed.controllerUrl)
        assertEquals(null, parsed.tlsCertFingerprint)
    }

    @Test
    fun `rejects wrong scheme`() {
        val result = PairingUriParser.parse("https://pair?sessionId=pair-123456&secret=$validSecret")
        assertTrue(result.isFailure)
    }

    @Test
    fun `rejects wrong host`() {
        val result = PairingUriParser.parse("wazir://unpair?sessionId=pair-123456&secret=$validSecret")
        assertTrue(result.isFailure)
    }

    @Test
    fun `rejects a uri carrying a permanent operator token`() {
        val result = PairingUriParser.parse(
            "wazir://pair?sessionId=pair-123456&secret=$validSecret&operatorToken=mob_at_deadbeef",
        )
        assertTrue(result.isFailure)
    }

    @Test
    fun `rejects a uri carrying an apiKey field`() {
        val result = PairingUriParser.parse(
            "wazir://pair?sessionId=pair-123456&secret=$validSecret&apiKey=sk-abcdef123456",
        )
        assertTrue(result.isFailure)
    }

    @Test
    fun `rejects a short session id`() {
        val result = PairingUriParser.parse("wazir://pair?sessionId=abc&secret=$validSecret")
        assertTrue(result.isFailure)
    }

    @Test
    fun `rejects a short pairing secret`() {
        val result = PairingUriParser.parse("wazir://pair?sessionId=pair-123456&secret=tooshort")
        assertTrue(result.isFailure)
    }

    @Test
    fun `rejects empty input`() {
        assertTrue(PairingUriParser.parse("").isFailure)
        assertTrue(PairingUriParser.parse("   ").isFailure)
    }

    @Test
    fun `rejects malformed uri`() {
        assertTrue(PairingUriParser.parse("wazir://pair?sessionId= [not valid]").isFailure)
    }

    // ── validateControllerBaseUrl ──────────────────────────────────────

    @Test
    fun `accepts https urls`() {
        val result = PairingUriParser.validateControllerBaseUrl("https://dgx-spark.local:8443/")
        assertEquals("https://dgx-spark.local:8443", result.getOrThrow())
    }

    @Test
    fun `accepts loopback http when allowed`() {
        assertTrue(PairingUriParser.validateControllerBaseUrl("http://127.0.0.1:8080", allowLoopbackHttp = true).isSuccess)
        assertTrue(PairingUriParser.validateControllerBaseUrl("http://localhost:8080", allowLoopbackHttp = true).isSuccess)
        assertTrue(PairingUriParser.validateControllerBaseUrl("http://10.0.2.2:8080", allowLoopbackHttp = true).isSuccess)
    }

    @Test
    fun `rejects loopback http when disallowed`() {
        assertFalse(PairingUriParser.validateControllerBaseUrl("http://127.0.0.1:8080", allowLoopbackHttp = false).isSuccess)
    }

    @Test
    fun `rejects http for a non-loopback remote host`() {
        val result = PairingUriParser.validateControllerBaseUrl("http://dgx-spark.local:8443", allowLoopbackHttp = true)
        assertTrue(result.isFailure)
    }

    @Test
    fun `rejects unsupported schemes`() {
        assertTrue(PairingUriParser.validateControllerBaseUrl("ftp://dgx-spark.local").isFailure)
    }

    @Test
    fun `rejects an empty base url`() {
        assertTrue(PairingUriParser.validateControllerBaseUrl("   ").isFailure)
    }
}
