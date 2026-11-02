---
"@maple-dev/effect-orm": minor
---

`Db.transaction({ isolationLevel, accessMode, deferrable })` on Postgres puts the settings in the statement that starts the transaction (`BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY`) through Effect's `SqlClient.BeginTransaction`, one round trip less than the `SET TRANSACTION` it sent before. A dialect gives the BEGIN statement with the new optional `DialectTransactions.beginTransaction`; `postgresDialect` has it, and a dialect without it still sends `SET TRANSACTION`. SQLite keeps its client's own BEGIN. `observe` sees the BEGIN statement, and a failed BEGIN reports it as `DatabaseError.sql`.
