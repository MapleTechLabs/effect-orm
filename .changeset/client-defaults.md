---
"@maple-dev/effect-orm": minor
---

`PG.column` and `SQLite.column` take client-side defaults as Effects: `defaultFn` runs for each row an insert leaves the column out of, and `onUpdate` for each update that does not set it (and for an insert, when the column has no other default). An Effect can read the `Clock`, `Random` or a service, so `TestClock` and a test layer give exact values in tests. Such a column is optional in the insert row type, and the Effect's requirements become the write's: `Db.run(PG.insertInto(Notes).values(...))` requires `IdGen` when `id` is `{ defaultFn: IdGen.next }`. `Database.run` runs them; `fillDefaults(write)` runs them for a write you compile yourself, and `compile` refuses a write that still leaves one out, and an `INSERT ... SELECT` that does not select such a column. They write no DDL and no migration. `Table`, `PgSchemaTable` and `SqliteSchemaTable` gain two type parameters for the requirements; they default to `never`.
