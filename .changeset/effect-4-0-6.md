---
"@maple-dev/effect-orm": minor
---

Require Effect 4.0.6 (`effect ^4.0.6` peer). Effect now fails a transaction whose COMMIT failed
with a `SqlError` instead of dying; `transaction` still reports it as `TransactionCommitFailed`.
`ClickhouseHttpClient` names its driver `"clickhouse-http"` (`SqlClient.driver`), and Effect's own
statement span is now named after the database (`db.namespace`) rather than `sql.execute`.
