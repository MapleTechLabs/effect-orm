---
"@maple-dev/effect-orm": minor
---

String expressions add `.contains(value)`, `.startsWith(value)` and `.endsWith(value)`: text search that treats the value as text, not as a LIKE pattern. `%`, `_` and `\` in the value are escaped with a backslash. A string is escaped before it is bound; a param or expression is escaped in SQL with `replace()`. Matching is case-sensitive by default and `{ insensitive: true }` ignores case, on every dialect: ClickHouse and Postgres write `LIKE` / `ILIKE`; SQLite and D1, whose `LIKE` ignores ASCII case and which have no `ILIKE`, write `GLOB` (with `*`, `?` and `[` escaped) / `lower(x) LIKE lower(pattern) ESCAPE '\'`. `escapeLike(text)` is the escape step on its own, for a `.like()` pattern.
