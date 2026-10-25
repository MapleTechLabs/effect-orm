---
"@maple-dev/effect-orm": minor
---

`Db.findById(query, { key })` and `Db.findAllBy(query, { key })` in `/database` batch lookups by a key with Effect's `RequestResolver`: N concurrent calls send one statement, the query with `key IN (...)` added to its WHERE, and each row decodes through the query's row schema. A batch never mixes `Database`s, transactions or params, so a tenant filter in the query (a value or a `param.*`, given with `.with(params)`) keeps each statement to one tenant, and `requireTenantScope` checks it.
