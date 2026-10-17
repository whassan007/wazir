import Foundation
import LocalAuthentication

/// Face ID / Touch ID / passcode gate for sensitive operations (approving a high-risk
/// tool call). Mirrors Android's `BiometricAuthGate` (BIOMETRIC_STRONG | BIOMETRIC_WEAK |
/// DEVICE_CREDENTIAL) — `.deviceOwnerAuthentication` is the closest iOS equivalent: Face
/// ID/Touch ID first, falling back to the device passcode.
enum BiometricAuthGate {
    static func canAuthenticate() -> Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    static func authenticate(reason: String) async -> Result<Bool, Error> {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return .failure(error ?? NSError(domain: "WazirMobile.Biometric", code: -1, userInfo: [NSLocalizedDescriptionKey: "Biometric authentication unavailable"]))
        }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, evalError in
                if success {
                    continuation.resume(returning: .success(true))
                } else {
                    continuation.resume(returning: .failure(evalError ?? NSError(domain: "WazirMobile.Biometric", code: -2, userInfo: [NSLocalizedDescriptionKey: "Authentication cancelled"])))
                }
            }
        }
    }
}
