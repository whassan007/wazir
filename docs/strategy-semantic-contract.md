# Worker 7 / Worker 10 semantic retrieval contract

Worker 10 owns similarity, hybrid ranking, confidence weighting, clustering, and
the final retrieval API. This adapter deliberately supplies unranked candidates.
Worker 10 was not reachable through the session's agent tools; this file records
the implemented handoff contract for review.

`StrategyLearningService` accepts the existing `EmbeddingProvider` abstraction,
an optional stable `embeddingProviderId`, an `embeddingVersion`, and `store`.
Call `await service.initialize()` at startup to restore structured strategies and
their semantic index. Successful strategy extraction and anti-strategy recording
automatically update the index. `recordAntiStrategy()` now returns a promise;
await it when persistence completion matters (its in-memory update is immediate).

`await service.semanticIndex.getCandidates(query: StrategyMatchQuery)` returns:

- `queryEmbedding?: number[]`
- `documents: SemanticIndexUnit[]` (unranked, cloned snapshot)
- `embeddingProvider?: string`, `embeddingModel?: string`, `embeddingVersion: string`

Each document has `kind: engineering_strategy | anti_strategy`, `content`, a
SHA-256 `contentHash` (the semantic content digest), `embedding`, provider/model/
version identity, and `metadata.sourceStrategyId`. Positive IDs join to
`service.getStrategy(id)`. Anti-warning IDs use `strategyId` if supplied, otherwise
a stable digest of category and anti-pattern name. Synthetic paths and the fixed
`engineering-strategies` scope are not repository paths or repository filters.
The query's repository scope remains a concern for the ranking layer.

Unavailable/invalid embeddings produce `{ documents: [], embeddingVersion }`.
Use the existing synchronous `queryStrategies(query)` for structured fallback.
The adapter does not merge structured and semantic results. A candidate is past
experience, never evidence satisfying current verification.

The shared `SemanticIndexService.indexUnit()` implements persistence and cache
validation, using `strategy-semantic/` for this adapter. Refresh uses content
digest, provider/model identity, dimensions, and embedding/document version.
Strategy confidence, counters, timestamps, evidence IDs, and strategy version do
not trigger re-embedding. Changed content invalidates the persisted old vector
before a refresh, including when the provider fails. Startup builds documents
from persisted source records and reuses compatible vectors; it does not hydrate
orphaned index rows. An explicit `semanticIndex.indexStrategy(strategy)` can
refresh a source after a caller changes its semantic fields.

Documents use abstract strategy actions, intents, signatures, languages, domain
tags (including frameworks), architecture traits, and known failures. Raw task
transcripts, tool payloads, verification criteria, and anti-warning descriptions
(which may contain raw errors) are excluded. Free-text fields strip paths, common
literal code identifiers, quoted values, and marked hidden oracle information.
Callers must provide abstract strategy fields; the normalizer is not a general
secret detector for arbitrary unlabeled prose.
