---
"@maple-dev/effect-orm": minor
---

With effect 4.0.6 or later, `Db.transaction({ isolationLevel, accessMode, deferrable })` puts the settings in the statement that starts the transaction (`BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY`) through Effect's `SqlClient.BeginTransaction`, one round trip less than the `SET TRANSACTION` it sent before. On effect 4.0.0 to 4.0.5, which do not have `BeginTransaction`, it still sends `SET TRANSACTION`. A dialect gives the BEGIN statement with the new optional `DialectTransactions.beginTransaction`; `postgresDialect` has it. `observe` sees the BEGIN statement.
