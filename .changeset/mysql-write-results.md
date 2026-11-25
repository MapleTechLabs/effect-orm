---
"@maple-dev/effect-orm": minor
---

`Db.runWrite` runs an insert, update or delete and returns a `WriteResult`: `affectedRows`, and for an insert `insertId`, the key it generated. It is how MySQL and MariaDB, which have no `RETURNING`, read an `AUTO_INCREMENT` key; it reads mysql2, node-postgres, PGlite, node:sqlite and D1 results, and refuses a ClickHouse write before sending it. `layerTest` takes a `TestWriteReply` (`{ affectedRows, insertId? }`) to answer one.

MySQL and MariaDB constraint failures are now refined like the other dialects': `refineConstraints` reads the server's error number, so a foreign key (1451, 1452), NOT NULL (1048, 1364) or CHECK (3819, MariaDB 4025) failure becomes `ForeignKeyViolation`, `NotNullViolation` or `CheckViolation`, with the key, constraint, table or column the message names. Before, only a duplicate key was refined, and without names. A MySQL `DatabaseError` now also carries the server's `sqlState` and its error number as `errorCode`.
