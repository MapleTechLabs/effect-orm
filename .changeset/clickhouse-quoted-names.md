---
"@maple-dev/effect-orm": minor
---

ClickHouse names are quoted when they need to be. The ClickHouse dialect wrote every identifier bare, so a select key such as `"p-95"` or `"by service"` was a syntax error, a key named `null` ordered by the literal, and a key built from input was SQL: `{ "x FROM system.users --": $.Name }` compiled to `events.Name AS x FROM system.users --`. A plain name (letters, digits, `_`, dots for a Nested column) is still bare, so existing SQL does not change; any other is written in backticks with `` ` `` and `\` escaped, as are the words ClickHouse reads as something else where a name goes (`all`, `cube`, `distinct`, `false`, `inf`, `infinity`, `nan`, `not`, `null`, `recursive`, `rollup`, `select`, `top`, `true`). That covers select keys, GROUP BY and ORDER BY keys, column names of an external table, source and join aliases, and CTE names. A select key with a dot is quoted too, so selecting a Nested column by name (`.select("Events.Name")`) works: it used to write `AS Events.Name`, a syntax error. A ClickHouse table name is still written as given, since an external table's name may be a table function or a subquery; `Dialect.rawTableNames` says so.

A name that spells the reserved param marker `__PARAM_` is escaped on ClickHouse and refused with `InvalidLiteral` on the other dialects. On Postgres it used to be rewritten into the placeholder's text (`AS "$1"`).

`contains("")` is written with one wildcard (`LIKE '%'`) instead of two. It means the same, and ClickHouse 26.2 turns a `LEFT JOIN` filtered by `LIKE '%%'` on the joined table into an inner join, losing the unmatched rows.
