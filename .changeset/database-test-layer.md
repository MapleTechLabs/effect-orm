---
"@maple-dev/effect-orm": minor
---

`Db.layerTest({ dialect })` from `/database` is a `Database` with no server, for unit tests. It also gives `TestDatabase`: `statements` holds each statement it was sent (SQL and parameters, transaction control included), and `reply(...)` queues the rows, or the driver `SqlError`, the next statements get. With no reply queued, a statement gets `respond(statement)` from the options, or no rows. The layer is `fromSqlClient` over a fake `SqlClient`, so compiling, row decoding by the query's own schema, `requireTenantScope` and transactions run as they do against a server.
