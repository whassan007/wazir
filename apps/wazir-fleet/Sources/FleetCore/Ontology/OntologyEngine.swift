import Foundation

public struct ProvenanceRecord: Codable, Sendable, Equatable {
    public var source: String
    public var author: String
    public var confidence: Double
    public var timestamp: Date

    public init(source: String, author: String, confidence: Double = 1.0, timestamp: Date = Date()) {
        self.source = source
        self.author = author
        self.confidence = confidence
        self.timestamp = timestamp
    }
}

public struct EntityTypeSchema: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var version: String
    public var requiredProperties: [String]
    public var optionalProperties: [String]

    public init(id: String, version: String = "1.0.0", requiredProperties: [String] = [], optionalProperties: [String] = []) {
        self.id = id
        self.version = version
        self.requiredProperties = requiredProperties
        self.optionalProperties = optionalProperties
    }
}

public struct OntologyEntity: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var typeID: String
    public var label: String
    public var properties: [String: String]
    public var owner: String
    public var provenance: ProvenanceRecord

    public init(id: String, typeID: String, label: String, properties: [String: String] = [:],
                owner: String = "system", provenance: ProvenanceRecord = ProvenanceRecord(source: "manual", author: "system")) {
        self.id = id
        self.typeID = typeID
        self.label = label
        self.properties = properties
        self.owner = owner
        self.provenance = provenance
    }
}

public struct OntologyRelationship: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var type: String
    public var sourceID: String
    public var targetID: String
    public var provenance: ProvenanceRecord

    public init(id: String = UUID().uuidString, type: String, sourceID: String, targetID: String,
                provenance: ProvenanceRecord = ProvenanceRecord(source: "manual", author: "system")) {
        self.id = id
        self.type = type
        self.sourceID = sourceID
        self.targetID = targetID
        self.provenance = provenance
    }
}

/// Domain-agnostic ontology and semantic registry.
public actor OntologyEngine {
    private var schemas: [String: EntityTypeSchema] = [:]
    private var entities: [String: OntologyEntity] = [:]
    private var relationships: [OntologyRelationship] = []

    public init() {}

    public func registerSchema(_ schema: EntityTypeSchema) {
        schemas[schema.id] = schema
    }

    public func upsertEntity(_ entity: OntologyEntity) throws(FleetError) {
        if let schema = schemas[entity.typeID] {
            for req in schema.requiredProperties where entity.properties[req] == nil {
                throw FleetError("Entity '\(entity.id)' missing required property '\(req)' for type '\(entity.typeID)'")
            }
        }
        entities[entity.id] = entity
    }

    public func addRelationship(_ rel: OntologyRelationship) throws(FleetError) {
        guard entities[rel.sourceID] != nil, entities[rel.targetID] != nil else {
            throw FleetError("Dangling relationship '\(rel.type)': source '\(rel.sourceID)' or target '\(rel.targetID)' not found")
        }
        relationships.append(rel)
    }

    /// Returns all downstream entity IDs reachable from `rootID` via BFS.
    public func impactAnalysis(for rootID: String) -> [String] {
        var visited: Set<String> = [rootID]
        var queue: [String] = [rootID]
        var impacted: [String] = []
        while !queue.isEmpty {
            let current = queue.removeFirst()
            for rel in relationships where rel.sourceID == current {
                if visited.insert(rel.targetID).inserted {
                    impacted.append(rel.targetID)
                    queue.append(rel.targetID)
                }
            }
        }
        return impacted
    }

    public func detectPotentialDuplicates() -> [(String, String)] {
        let list = entities.values.sorted { $0.id < $1.id }
        var dupes: [(String, String)] = []
        for i in 0..<list.count {
            for j in (i + 1)..<list.count {
                if list[i].typeID == list[j].typeID &&
                   list[i].label.lowercased() == list[j].label.lowercased() {
                    dupes.append((list[i].id, list[j].id))
                }
            }
        }
        return dupes
    }

    public func allEntities() -> [OntologyEntity] { entities.values.sorted { $0.id < $1.id } }
    public func allSchemas() -> [EntityTypeSchema] { schemas.values.sorted { $0.id < $1.id } }
    public func allRelationships() -> [OntologyRelationship] { relationships }

    public func exportJSON() throws -> Data {
        struct Snapshot: Codable {
            var schemas: [EntityTypeSchema]
            var entities: [OntologyEntity]
            var relationships: [OntologyRelationship]
        }
        return try JSONEncoder().encode(Snapshot(schemas: allSchemas(), entities: allEntities(), relationships: relationships))
    }
}
