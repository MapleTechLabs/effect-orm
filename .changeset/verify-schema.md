---
"@maple-dev/effect-orm": minor
---

`effect-orm verify --schema` compares the table definitions with a live database, with no migrations folder and no ledger. It exits 3 on drift and prints one line per difference (`--json` for machines), so CI fails on a missing column, a type or nullability change, or a missing index. It reads the config's `schema` and `driver` and runs the same comparison as `verify`, for ClickHouse and Postgres. In code: `verifySchema(config, cwd)` from `/kit`, and `Migrate.verifySnapshot(snapshot)` to compare a database with any snapshot.
