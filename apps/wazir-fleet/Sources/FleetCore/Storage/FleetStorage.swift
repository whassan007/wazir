import Foundation
import SQLite3

/// Versioned local storage engine for Fleet Core.
/// Uses atomic JSON files for configuration/manifests and native SQLite3 (`sqlite3`)
/// for transactional persistence of ontology, policies, findings, evidence, and execution intelligence.
public final class FleetStorage: @unchecked Sendable {
    public enum Location: Sendable {
        case inMemory
        case directory(URL)
    }

    public let location: Location
    private var db: OpaquePointer?
    private let lock = NSLock()

    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Fleet", isDirectory: true)
    }

    public init(location: Location = .directory(FleetStorage.defaultDirectory)) throws {
        self.location = location
        try openAndMigrate()
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    private func openAndMigrate() throws {
        let path: String
        switch location {
        case .inMemory:
            path = ":memory:"
        case .directory(let dir):
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            path = dir.appendingPathComponent("fleet-core.sqlite").path
        }

        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let handle else {
            let msg = handle.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
            if let handle { sqlite3_close(handle) }
            throw FleetError("Failed to open SQLite store at \(path): \(msg)")
        }
        self.db = handle

        let schema = """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS kv_records (
            namespace TEXT NOT NULL,
            id TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            payload BLOB NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY (namespace, id)
        );
        CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv_records(namespace, updated_at DESC);
        """
        try executeSQL(schema)
    }

    public func executeSQL(_ sql: String) throws {
        try lock.withLock {
            guard let db else { throw FleetError("Database is closed") }
            var errMsg: UnsafeMutablePointer<CChar>?
            if sqlite3_exec(db, sql, nil, nil, &errMsg) != SQLITE_OK {
                let msg = errMsg.map { String(cString: $0) } ?? "SQLite error"
                sqlite3_free(errMsg)
                throw FleetError(msg)
            }
        }
    }

    public func save<T: Encodable>(_ value: T, namespace: String, id: String, version: Int = 1) throws {
        let data = try JSONEncoder().encode(value)
        let now = Date().timeIntervalSince1970
        try lock.withLock {
            guard let db else { throw FleetError("Database is closed") }
            let sql = """
            INSERT INTO kv_records (namespace, id, version, payload, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(namespace, id) DO UPDATE SET
                version = excluded.version,
                payload = excluded.payload,
                updated_at = excluded.updated_at;
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
                throw FleetError(String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(stmt) }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            sqlite3_bind_text(stmt, 1, namespace, -1, transient)
            sqlite3_bind_text(stmt, 2, id, -1, transient)
            sqlite3_bind_int(stmt, 3, Int32(version))
            _ = data.withUnsafeBytes { buf in
                sqlite3_bind_blob(stmt, 4, buf.baseAddress, Int32(data.count), transient)
            }
            sqlite3_bind_double(stmt, 5, now)
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                throw FleetError(String(cString: sqlite3_errmsg(db)))
            }
        }
    }

    public func load<T: Decodable>(_ type: T.Type, namespace: String, id: String) throws -> T? {
        let raw: Data? = try lock.withLock {
            guard let db else { throw FleetError("Database is closed") }
            let sql = "SELECT payload FROM kv_records WHERE namespace = ? AND id = ? LIMIT 1;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
                throw FleetError(String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(stmt) }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            sqlite3_bind_text(stmt, 1, namespace, -1, transient)
            sqlite3_bind_text(stmt, 2, id, -1, transient)
            if sqlite3_step(stmt) == SQLITE_ROW {
                if let bytes = sqlite3_column_blob(stmt, 0) {
                    let count = Int(sqlite3_column_bytes(stmt, 0))
                    return Data(bytes: bytes, count: count)
                }
            }
            return nil
        }
        guard let raw else { return nil }
        return try JSONDecoder().decode(T.self, from: raw)
    }

    public func loadAll<T: Decodable>(_ type: T.Type, namespace: String) throws -> [T] {
        let blobs: [Data] = try lock.withLock {
            guard let db else { throw FleetError("Database is closed") }
            let sql = "SELECT payload FROM kv_records WHERE namespace = ? ORDER BY updated_at DESC;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
                throw FleetError(String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(stmt) }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            sqlite3_bind_text(stmt, 1, namespace, -1, transient)
            var out: [Data] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let bytes = sqlite3_column_blob(stmt, 0) {
                    let count = Int(sqlite3_column_bytes(stmt, 0))
                    out.append(Data(bytes: bytes, count: count))
                }
            }
            return out
        }
        let decoder = JSONDecoder()
        return try blobs.map { try decoder.decode(T.self, from: $0) }
    }

    public func delete(namespace: String, id: String) throws {
        try lock.withLock {
            guard let db else { throw FleetError("Database is closed") }
            let sql = "DELETE FROM kv_records WHERE namespace = ? AND id = ?;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
                throw FleetError(String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(stmt) }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            sqlite3_bind_text(stmt, 1, namespace, -1, transient)
            sqlite3_bind_text(stmt, 2, id, -1, transient)
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                throw FleetError(String(cString: sqlite3_errmsg(db)))
            }
        }
    }
}
