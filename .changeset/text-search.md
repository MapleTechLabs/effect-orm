---
"@maple-dev/effect-orm": minor
---

String expressions add `.contains(value)`, `.startsWith(value)` and `.endsWith(value)`: text search that treats the value as text, not as a LIKE pattern. `%`, `_` and `\` in the value are escaped with a backslash. A string is escaped before it is bound; a param or expression is escaped in SQL with `replace()`. `{ insensitive: true }` writes `ILIKE`. Postgres gets an explicit `ESCAPE '\'`; ClickHouse already escapes with a backslash. `escapeLike(text)` is the escape step on its own, for a `.like()` pattern. Postgres and ClickHouse.
