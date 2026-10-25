---
"@maple-dev/effect-orm": minor
---

`tableSchemas(table)` derives the Effect Schemas of a table's rows from its columns, on both `/clickhouse` and `/postgres`: `select` (every column, decoded from the wire), `insert` (computed columns left out, defaulted and nullable ones optional), `update` (every writable column optional), and `json`, `jsonCreate` and `jsonUpdate`, the same rows as plain JSON for an HTTP API. The names follow `Model.Class`. A decoded `insert` or `update` row is a row `insertInto(...).values` or `update(...).set` takes, so request bodies and repositories no longer need Schemas written by hand next to the table.
