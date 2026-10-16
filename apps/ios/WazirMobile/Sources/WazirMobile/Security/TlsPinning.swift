import Foundation
import Security
import CryptoKit

/// Builds `URLSession`s that never disable certificate validation. Standard system CAs
/// are tried first; a self-hosted controller's certificate is accepted only if its exact
/// SHA-256 leaf digest matches the fingerprint pinned during QR/manual pairing. Mirrors
/// the Android `TlsPinningClientFactory` / `FingerprintPinnedTrustManager` pair.
enum TlsPinningSessionFactory {
    static func normalizeFingerprint(_ raw: String) -> String? {
        let hex = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "SHA256:", with: "", options: [.caseInsensitive])
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: " ", with: "")
            .lowercased()
        guard hex.count == 64, hex.allSatisfy({ $0.isHexDigit }) else { return nil }
        return hex
    }

    static func makeSession(tlsCertFingerprint: String?, timeoutSeconds: TimeInterval = 30) -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeoutSeconds
        config.timeoutIntervalForResource = timeoutSeconds + 15

        guard let fp = tlsCertFingerprint, let expectedHex = normalizeFingerprint(fp) else {
            return URLSession(configuration: config)
        }
        let delegate = FingerprintPinningDelegate(expectedHex: expectedHex)
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }
}

private final class FingerprintPinningDelegate: NSObject, URLSessionDelegate {
    let expectedHex: String

    init(expectedHex: String) {
        self.expectedHex = expectedHex
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // Try standard system trust first (covers a real CA-signed cert even on a pinned profile).
        var error: CFError?
        if SecTrustEvaluateWithError(serverTrust, &error) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
            return
        }

        // Fall back to an exact SHA-256 leaf-certificate match for a self-signed controller
        // cert whose fingerprint the operator verified out-of-band during pairing.
        guard let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
              let leaf = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let leafData = SecCertificateCopyData(leaf) as Data
        let actualHex = Data(SHA256.hash(data: leafData)).map { String(format: "%02x", $0) }.joined()
        if actualHex == expectedHex {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
