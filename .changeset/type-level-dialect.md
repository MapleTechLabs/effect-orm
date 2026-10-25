---
"@maple-dev/effect-orm": minor
---

A query that cannot compile for its target is now a type error, not only a failure at compile time. A built-in function of one dialect (`CH.countIf`, `PG.countIf`, ...) marks its result with `ClickHouseOnly` or `PostgresOnly`, and `compile`, `compileUnion` and `run` refuse a query with a function of another dialect (`wrongDialect`), or with functions of both (`mixedDialects`). The target is `options.dialect`, else the entry's dialect; `fromSqlClient` now returns a `DatabaseApi<"postgres">` or `DatabaseApi<"clickhouse">` whose `run` checks it. A column ref now names its source (`SourceEntry`), and a query refuses a column of a source that is not in its FROM or JOIN (`sourceNotInQuery`); a correlated subquery can use the outer query's accessor. The runtime checks stay. Also, `orderBy(($) => [...])` now carries the params of every sort key, not only the first.
