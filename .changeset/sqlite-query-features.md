---
"@maple-dev/effect-orm": minor
---

SQLite query features, typed end to end, so hand-written SQLite statements can move to the builder:

- Window functions on SQLite and Postgres: `over(expr, windowSpec(...))` with `lead`, `lag` (offset and fallback), `rowNumber`, `rank`, `denseRank`, `firstValue`, `lastValue`, and a new `rangeBetween` frame (also on ClickHouse). `lead` and `lag` decode NULL past the partition's edge.
- Table-valued sources: `SQLite.jsonEach` and `SQLite.jsonTree` in `from`, `innerJoin` / `leftJoin` / `crossJoin` (also as a callback over the earlier sources' columns) and `update(...).from`, with typed `key` / `value` columns and the JSON bound as one parameter. `SQLite.jsonRows(rows, columns)` is a typed query over a JS array, for `insertInto(...).select(...)` and `update(...).from(...)`. A join's ON callback now also reads the earlier joins under their aliases.
- `update(table).from(source, alias)`: `UPDATE ... FROM` on SQLite and Postgres, refused in the type elsewhere.
- `scalar(query)`: a one-column query as a value, for a correlated SET or a select.
- `selectNoFrom(fn)`: a SELECT of values with no FROM, for a conditional `INSERT ... SELECT`.
- SQLite functions: `iif`, `caseWhen`, `ifnull`, `nullif`, `cast`, `concat`, `trim` / `ltrim` / `rtrim`, `substr`, `replace`, `instr`, `abs`, `round`, `greatest` / `least`, `jsonExtract`, `json_`, `jsonSet`, `jsonGroupArray`, `jsonGroupObject`, `julianday`, `date`, `datetime`, `strftime`, `unixepoch`; `coalesce` takes a plain fallback.
- FTS5: `SQLite.fts5Table` and `SQLite.fts5.match` / `snippet` / `highlight` / `bm25`.
- `SQLite.runSync(storage, query, params?)` runs a query or write synchronously on Durable Object storage (`ctx.storage.sql`).
- `Database.batch([...])` (and `Db.batch`) runs a list of statements atomically: one D1 batch on D1, a transaction elsewhere, returning each statement's rows.
- A `where` that proves a FROM column not NULL now narrows it for a later `select`, as it did for joined columns.
- A comparison accepts a nullable expression on its right (`o.rowid.eq(h.head)` with `h.head` an aggregate).

Fix: in an UPDATE or DELETE, a target column used inside a subquery (a correlated `subqueryExpr`, `scalar` or `exists`) is now qualified with the table name. It was written bare, so it bound to the subquery's own column of the same name and the condition always held.

`firstValue` and `lastValue` decode as nullable (a frame can be empty). `runSync` takes an optional fourth argument, `RunSyncOptions`.
