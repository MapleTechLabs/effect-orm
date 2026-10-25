---
"@maple-dev/effect-orm": minor
---

`Db.stream(query, params?)` and `DatabaseApi.stream` run what `run` takes and return a `Stream`
of its rows. Each row is decoded by the query's row schema when it arrives, so a large result
does not have to fit in memory. A row that does not match fails the stream with
`CompiledQueryDecodeError` and its `rowIndex`. The stream uses the `SqlClient` statement's
`.stream`, reads on the transaction's connection inside `transaction`, and runs in one client
span that counts the rows it emitted.
