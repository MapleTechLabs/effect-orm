---
"@maple-dev/effect-orm": minor
---

A ClickHouse client for Cloudflare Workers and any `fetch` runtime, and OpenTelemetry-shaped spans for every statement.

- `@maple-dev/effect-orm/clickhouse-http` is a ClickHouse `SqlClient` over Effect's `HttpClient`, so `Database` runs where `@effect/sql-clickhouse` (Node only) cannot. Interrupting a statement aborts its request and sends `KILL QUERY` for its `query_id`; failures carry the same `SqlError` reasons as Effect's driver; credentials travel in a header; `asCommand`, `withQueryId` and `withSettings` work as there.
- `Database` opens one client span per statement, named and attributed per the OpenTelemetry database conventions: `db.system.name`, `db.operation.name`, `db.collection.name`, `db.query.summary`, `db.response.returned_rows` and `error.type`. `withQuerySummary(name)` names the statements an effect runs.
- `CompiledQuery.collection` is the table a statement targets: a SELECT's `FROM` table, or the table a write changes.
