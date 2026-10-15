---
"@maple-dev/effect-orm": minor
---

`effect-orm pull` writes table definitions from an existing ClickHouse database, so adopting effect-orm on a database that already has tables no longer means writing every `CH.table` by hand.

- It reads the database the config's `driver` connects to and writes one `CH.table` per table: engine and arguments, keys as declared, partition key, TTL, settings, comments, column defaults, codecs and skipping indexes. The definitions yield exactly what the database holds, so `generate --baseline` adopts them and the next `generate` has nothing to do.
- Column types map to the built-ins that write the same SQL; others become `CH.custom` with a fitting schema (`UUID`, `Date`, `Decimal`, `Enum8`, …) or `CH.untyped`. Views and non-MergeTree tables are written as `external: true`. Materialized views, `SAMPLE BY` and `EPHEMERAL` columns are listed for review in the file's header.
- `pull` is also exported from `/kit`.

`verify` reads a table's sorting and primary keys as declared. It had compared `system.tables.sorting_key`, which has a `VersionedCollapsingMergeTree`'s version column appended, so such a table always showed drift.
