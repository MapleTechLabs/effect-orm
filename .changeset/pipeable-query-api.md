---
"@maple-dev/effect-orm": minor
---

A query is now `Pipeable`, and a new `Query` namespace on `/clickhouse` and `/postgres` gives a data-last form of `select`, `where`, `orderBy`, `limit`, `innerJoin`, `leftJoin` and `crossJoin`, next to `from`, `fromQuery` and `fromUnion`: `CH.Query.from(Events).pipe(CH.Query.select(...), CH.Query.where(...))`. Each function is a `dual` that calls the fluent method, so both styles write the same SQL, and each also has a data-first form. `$` in a data-last callback is typed from the query that `pipe` carries.
