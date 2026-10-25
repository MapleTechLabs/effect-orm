---
"@maple-dev/effect-orm": minor
---

`SQLite.table(name, { columns, primaryKey, indexes })` declares a SQLite table with its DDL:
`NOT NULL` from the column type, single and composite primary keys, literal and expression
defaults (`SQLite.timestampNow` for a `timestamp` column), unique columns, and named indexes and
unique indexes. `sqliteEntitiesOf` and
`renderSqliteSchema` from `/schema` check a schema and write its `CREATE TABLE` and
`CREATE INDEX` statements. `table(name, columns, options?)` and
`table(name, { external: true, columns })` stay query-only. SQLite migrations are not generated yet.
