---
"@maple-dev/effect-orm": minor
---

A query is now `Pipeable`, and a new `Query` namespace on `/clickhouse`, `/postgres` and `/sqlite` gives a data-last form of every `CHQuery` method (`select`, `where`, `groupBy`, `having`, `orderBy`, `limit`, `offset`, `format`, `distinct`, `distinctOn`, the row locks, `route`, `crossTenant`, the table and subquery joins, `withCTE`), next to `from`, `fromQuery` and `fromUnion`: `CH.Query.from(Events).pipe(CH.Query.select(...), CH.Query.where(...))`. Each function is a `dual` that calls the fluent method, so both styles write the same SQL on every dialect, and each also has a data-first form. `$` in a data-last callback is typed from the query that `pipe` carries.
