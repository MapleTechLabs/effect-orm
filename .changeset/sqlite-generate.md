---
"@maple-dev/effect-orm": minor
---

`effect-orm generate` supports `dialect: "sqlite"`. It diffs `SQLite.table` definitions against
the migrations folder and writes `<timestamp>_<name>/migration.sql` plus `snapshot.json`, the
drizzle-kit 1.0 layout that Alchemy's D1 resource applies. `ALTER TABLE` adds, drops and renames
where SQLite allows it; other column, primary key and UNIQUE changes rebuild the table. Renames
need a `confirm_rename` hint. `generate --baseline --from-drizzle` adopts a drizzle-kit 1.0
SQLite folder. Snapshots gain a `sqlite` dialect. `/migrate` refuses SQLite folders for now.
