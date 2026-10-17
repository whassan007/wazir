import Foundation

/// Intercepts every request made by a `URLSession` configured with this protocol class
/// and records it, so tests can assert the exact path/method/headers a client call
/// produced — the same thing MockWebServer does for the Android test suite. Responses
/// are served in enqueue order.
final class StubURLProtocol: URLProtocol {
    struct Stubbed {
        var statusCode: Int = 200
        var body: Data = Data("{}".utf8)
    }

    static let lock = NSLock()
    nonisolated(unsafe) static var queue: [Stubbed] = []
    nonisolated(unsafe) static var recorded: [URLRequest] = []

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        queue = []
        recorded = []
    }

    static func enqueue(statusCode: Int = 200, body: String = "{}") {
        lock.lock(); defer { lock.unlock() }
        queue.append(Stubbed(statusCode: statusCode, body: Data(body.utf8)))
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.recorded.append(request)
        let stub = Self.queue.isEmpty ? Stubbed() : Self.queue.removeFirst()
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "http://stub.invalid")!,
            statusCode: stub.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }
}
