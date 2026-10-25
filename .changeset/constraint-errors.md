---
"@maple-dev/effect-orm": minor
---

Constraint violations are typed errors. `refineConstraints(effect)` turns a `DatabaseError` or `TransactionCommitFailed` for a broken constraint into `UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation` or `CheckViolation`, so a caller can `catchTag` a duplicate key. Each carries the `constraint`, `table` and `column` the server named. Postgres maps SQLSTATE 23505, 23503, 23502 and 23514; ClickHouse maps code 469 (`VIOLATED_CONSTRAINT`) to `CheckViolation`. `constraintViolation(error)` reads one without failing. `DatabaseError` and `TransactionCommitFailed` now keep the server's numeric error code as `errorCode`, which ClickHouse reports and `sqlState` dropped. `ClickhouseHttpClient` classifies code 469 as `ConstraintError` instead of `StatementTimeoutError`.
