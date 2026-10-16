import XCTest
@testable import WazirMobile

final class PairingUriParserTests: XCTestCase {
    let validSecret = String(repeating: "a", count: 24)

    func testParsesWellFormedUri() throws {
        let uri = "wazir://pair?sessionId=pair-123456&secret=\(validSecret)&name=My%20Mac&url=https%3A%2F%2F10.0.0.5%3A8443&fp=SHA256%3AAA%3ABB&v=1.0.0"
        let parsed = try PairingUriParser.parse(uri).get()
        XCTAssertEqual(parsed.sessionId, "pair-123456")
        XCTAssertEqual(parsed.pairingSecret, validSecret)
        XCTAssertEqual(parsed.controllerName, "My Mac")
        XCTAssertEqual(parsed.controllerUrl, "https://10.0.0.5:8443")
        XCTAssertEqual(parsed.tlsCertFingerprint, "SHA256:AA:BB")
        XCTAssertEqual(parsed.apiVersion, "1.0.0")
    }

    func testDefaultsNameAndVersionWhenAbsent() throws {
        let parsed = try PairingUriParser.parse("wazir://pair?sessionId=pair-123456&secret=\(validSecret)").get()
        XCTAssertEqual(parsed.controllerName, "Wazir Controller")
        XCTAssertEqual(parsed.apiVersion, "1.0.0")
        XCTAssertNil(parsed.controllerUrl)
        XCTAssertNil(parsed.tlsCertFingerprint)
    }

    func testRejectsWrongScheme() {
        let result = PairingUriParser.parse("https://pair?sessionId=pair-123456&secret=\(validSecret)")
        XCTAssertThrowsResult(result)
    }

    func testRejectsWrongHost() {
        let result = PairingUriParser.parse("wazir://unpair?sessionId=pair-123456&secret=\(validSecret)")
        XCTAssertThrowsResult(result)
    }

    func testRejectsPermanentOperatorToken() {
        let result = PairingUriParser.parse("wazir://pair?sessionId=pair-123456&secret=\(validSecret)&operatorToken=mob_at_deadbeef")
        XCTAssertThrowsResult(result)
    }

    func testRejectsApiKeyField() {
        let result = PairingUriParser.parse("wazir://pair?sessionId=pair-123456&secret=\(validSecret)&apiKey=sk-abcdef123456")
        XCTAssertThrowsResult(result)
    }

    func testRejectsShortSessionId() {
        let result = PairingUriParser.parse("wazir://pair?sessionId=abc&secret=\(validSecret)")
        XCTAssertThrowsResult(result)
    }

    func testRejectsShortSecret() {
        let result = PairingUriParser.parse("wazir://pair?sessionId=pair-123456&secret=tooshort")
        XCTAssertThrowsResult(result)
    }

    func testRejectsEmptyInput() {
        XCTAssertThrowsResult(PairingUriParser.parse(""))
        XCTAssertThrowsResult(PairingUriParser.parse("   "))
    }

    func testAcceptsHttpsUrl() throws {
        let result = try PairingUriParser.validateControllerBaseUrl("https://dgx-spark.local:8443/").get()
        XCTAssertEqual(result, "https://dgx-spark.local:8443")
    }

    func testAcceptsLoopbackHttpWhenAllowed() {
        XCTAssertNoThrow(try PairingUriParser.validateControllerBaseUrl("http://127.0.0.1:8080", allowLoopbackHttp: true).get())
        XCTAssertNoThrow(try PairingUriParser.validateControllerBaseUrl("http://localhost:8080", allowLoopbackHttp: true).get())
    }

    func testRejectsLoopbackHttpWhenDisallowed() {
        XCTAssertThrowsResult(PairingUriParser.validateControllerBaseUrl("http://127.0.0.1:8080", allowLoopbackHttp: false))
    }

    func testRejectsHttpForRemoteHost() {
        XCTAssertThrowsResult(PairingUriParser.validateControllerBaseUrl("http://dgx-spark.local:8443", allowLoopbackHttp: true))
    }

    func testRejectsUnsupportedScheme() {
        XCTAssertThrowsResult(PairingUriParser.validateControllerBaseUrl("ftp://dgx-spark.local"))
    }
}

private extension Result {
    func get() throws -> Success {
        switch self {
        case .success(let v): return v
        case .failure(let e): throw e
        }
    }
}

private func XCTAssertThrowsResult<T>(_ result: Result<T, Error>, file: StaticString = #filePath, line: UInt = #line) {
    switch result {
    case .success: XCTFail("expected failure but got success", file: file, line: line)
    case .failure: break
    }
}
