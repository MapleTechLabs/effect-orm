---
"@maple-dev/effect-orm": minor
---

`Db.runWrite` runs an insert, update or delete and returns a `WriteResult`: `affectedRows`, and for an insert `insertId`, the key of the row it wrote. It is how MySQL, which has no `RETURNING` (and MariaDB, whose `RETURNING` the builder does not write), reads an `AUTO_INCREMENT` key; it reads `@effect/sql-mysql2`, `@effect/sql-pg`, PGlite, node:sqlite and D1 results, and refuses a ClickHouse write before sending it. `layerTest` takes a `TestWriteReply` (`{ affectedRows, insertId? }`) to answer one.

MySQL and MariaDB constraint failures are now refined like the other dialects': `refineConstraints` reads the server's error number, so a foreign key (1451, 1452), NOT NULL (1048, 1364) or CHECK (3819, MariaDB 4025) failure becomes `ForeignKeyViolation`, `NotNullViolation` or `CheckViolation`, with the key, constraint, table or column the message names. Before, only a duplicate key was refined, and without names. A MySQL `DatabaseError` now also carries the server's `sqlState` and its error number as `errorCode`. Names are read from the server's whole message and anchored where the server writes them, so a duplicated value quoted in the message cannot name the key. A Node error name (`EPIPE`, `EBUSY`) is no longer read as a SQLSTATE.
