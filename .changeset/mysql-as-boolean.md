---
"@maple-dev/effect-orm": minor
---

`MySQL.asBoolean(condition)`: a condition as a boolean value, to select it or `set` a column from it, as Postgres's `asBoolean`. It is written `((c) IS TRUE)`, so a condition MySQL evaluates to NULL reads as `false` rather than failing the boolean codec. MySQL and MariaDB only; another dialect refuses it in the type and at compile.
