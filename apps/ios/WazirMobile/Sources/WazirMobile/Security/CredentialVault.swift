import Foundation
import Security

struct StoredDeviceCredential: Codable {
    var controllerId: String
    var deviceId: String
    var accessToken: String
    var refreshToken: String
    var expiresAt: Int64
    var scopes: [String]
}

protocol CredentialVault {
    func getOrCreateDeviceIdentity() -> (deviceId: String, fingerprint: String)
    func saveCredential(_ credential: StoredDeviceCredential)
    func getCredential(controllerId: String) -> StoredDeviceCredential?
    func removeCredential(controllerId: String)
    func clearAll()
}

/// Keychain-backed credential vault. Unlike Android (where `SharedPreferences` is
/// plaintext and needs an explicit AndroidKeystore AES wrap), iOS Keychain items are
/// encrypted at rest by the Secure Enclave-derived class key, so each field is stored
/// directly — no extra crypto layer is needed here.
final class KeychainCredentialVault: CredentialVault {
    private let service = "ai.wazir.mobile.keychain"
    private let deviceIdKey = "device_identity_id"
    private let deviceFpKey = "device_identity_fingerprint"

    private func read(_ key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private func write(_ key: String, data: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        if status == errSecSuccess {
            SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        } else {
            var insert = query
            attributes.forEach { insert[$0.key] = $0.value }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    private func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    func getOrCreateDeviceIdentity() -> (deviceId: String, fingerprint: String) {
        if let idData = read(deviceIdKey), let fpData = read(deviceFpKey),
           let id = String(data: idData, encoding: .utf8), !id.isEmpty,
           let fp = String(data: fpData, encoding: .utf8), !fp.isEmpty {
            return (id, fp)
        }
        let newId = "ios-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12)
        var randomBytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
        let digest = sha256(Data(randomBytes))
        let fp = "SHA256:" + digest.prefix(12).map { String(format: "%02X", $0) }.joined(separator: ":")
        write(deviceIdKey, data: Data(newId.utf8))
        write(deviceFpKey, data: Data(fp.utf8))
        return (newId, fp)
    }

    func saveCredential(_ credential: StoredDeviceCredential) {
        guard let data = try? JSONEncoder().encode(credential) else { return }
        write("cred:\(credential.controllerId)", data: data)
    }

    func getCredential(controllerId: String) -> StoredDeviceCredential? {
        guard let data = read("cred:\(controllerId)") else { return nil }
        return try? JSONDecoder().decode(StoredDeviceCredential.self, from: data)
    }

    func removeCredential(controllerId: String) {
        delete("cred:\(controllerId)")
    }

    func clearAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// In-memory vault for previews/tests.
final class InMemoryCredentialVault: CredentialVault {
    private var map: [String: StoredDeviceCredential] = [:]
    private let identity = ("ios-test-device", "SHA256:AA:BB:CC:DD:EE:FF")

    func getOrCreateDeviceIdentity() -> (deviceId: String, fingerprint: String) { identity }
    func saveCredential(_ credential: StoredDeviceCredential) { map[credential.controllerId] = credential }
    func getCredential(controllerId: String) -> StoredDeviceCredential? { map[controllerId] }
    func removeCredential(controllerId: String) { map.removeValue(forKey: controllerId) }
    func clearAll() { map.removeAll() }
}

import CryptoKit

func sha256(_ data: Data) -> Data {
    Data(SHA256.hash(data: data))
}
