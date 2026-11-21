# Updating and deleting rows

`update(table)` and `deleteFrom(table)` build UPDATE and DELETE from the same table definitions,
like [`insertInto`](./inserts.md). They are immutable values; `Database.run` compiles them for
its database's dialect and runs them.

```ts
import * as PG from "@maple-dev/effect-orm/postgres"

const Tickets = PG.table("tickets", {
	columns: { id: PG.int4, org: PG.text, seats: PG.int4, tags: PG.array(PG.text) },
	primaryKey: ["id"],
	tenantColumn: "org",
})

const bump = PG.update(Tickets)
	.set(($) => ({ seats: $.seats.add(1) }))
	.where(($) => [$.org.eq(PG.param.string("org")), $.seats.lt(5)])
	.returning("id", "seats")

const revoke = PG.deleteFrom(Tickets).where(($) => [$.id.eq(PG.param.int("id"))])

// yield* Db.run(bump, { org })   // [{ id, seats }]
// yield* Db.run(revoke, { id })  // []
```

## SET

`set` takes a record of values, params or expressions, or a callback that gets the row's
columns as `$`. A key left out (or `undefined`) keeps the existing value. Values are encoded
through the column's codec and bound on Postgres, SQLite and MySQL, as in an insert. A column that is not
writable (a ClickHouse `materialized` or `alias` column, see
[the row type](./inserts.md#which-columns-have-defaults)) cannot be set. `UpdateSetOf<typeof T>`
names the record type.

`update(table)` offers only `set` until it has one (its type is `CHUpdateStart`).

A Postgres, SQLite or MySQL column with `onUpdate` (an Effect, see
[client-side defaults](./inserts.md#client-side-defaults)) is set by every update that does not
set it: `Database.run` runs the Effect once and adds the value to the SET. With a SET callback,
the Effect runs before the callback, and a value the callback gives wins. The update requires
what the Effect needs. `compile` refuses an update that does not set the column, unless it went
through `fillDefaults` first.

### A SET from a correlated subquery

`scalar(query)` turns a one-column query into a value of its column's type, `| null` because a
subquery that finds no row is NULL. Build the query inside the `set` callback and it can read the
target's columns from `$`:

```ts
const Bots = SQLite.table("bots", { external: true, columns: { id: SQLite.text, userId: SQLite.text, installCount: SQLite.integer } })
const Members = SQLite.table("membership_index", { external: true, columns: { userId: SQLite.text, deletedAt: SQLite.nullable(SQLite.text) } })

SQLite.update(Bots)
	.set(($) => ({
		installCount: SQLite.coalesce(
			SQLite.scalar(SQLite.from(Members, "mi").select(() => ({ n: SQLite.count() })).where((mi) => [mi.userId.eq($.userId), mi.deletedAt.isNull()])),
			0,
		),
	}))
	.where(($) => [$.id.eq(SQLite.param.string("id"))])
// UPDATE "bots" SET "installCount" = coalesce((SELECT count(*) AS "n" FROM "membership_index" AS "mi"
//   WHERE "mi"."userId" = "bots"."userId" AND "mi"."deletedAt" IS NULL), 0) WHERE "id" = ?
```

The target's columns are written bare in an UPDATE or DELETE, except inside a subquery, where
they are qualified with the table name: a bare `"userId"` there would name the subquery's own
column, and the condition would always hold. The same holds for a subquery in `where`, and in a
DELETE. `subqueryExpr(query, type)` is the older form of `scalar`, with a declared type and no
NULL in it.

_(Backed by `docs/updates-and-deletes.md > A SET from a correlated scalar subquery`.)_

## UPDATE ... FROM

`from(source, alias)`, before `set`, adds a `FROM` to the UPDATE (Postgres, SQLite 3.33+). The
source is a table, a table-valued function such as `SQLite.jsonEach`, or a query. `set` and
`where` read its columns as `$.<alias>.<column>`; the target's columns are then always written
qualified, `"table"."col"`. ClickHouse and MySQL have no UPDATE ... FROM: the type refuses it
(`UpdateFromClause`) and so does the compile.

```ts
const Daily = SQLite.table("daily", { external: true, columns: { day: SQLite.text, dau: SQLite.integer } })

SQLite.update(Daily)
	.from(SQLite.jsonEach([{ day: "2026-01-01", dau: 9 }]), "j")
	.set(($) => ({ dau: SQLite.jsonExtract($.j.value, "$.dau", SQLite.integer) }))
	.where(($) => [$.day.eq(SQLite.jsonExtract($.j.value, "$.day", SQLite.text))])
// UPDATE "daily" SET "dau" = json_extract("j"."value", '$.dau') FROM json_each(?) AS "j"
// WHERE "daily"."day" = json_extract("j"."value", '$.day')
```

A FROM table with a tenant column is a source of the update's tenant scope: the WHERE has to tie
it to the target's tenant, or pin it, as a join would.

_(Backed by `docs/updates-and-deletes.md > UPDATE ... FROM reads the source in SET and WHERE`.)_

## WHERE, and writing every row

`where` works as in a query: a list of conditions, AND-joined, with an `undefined` one skipped,
so optional filters compose. A write with no `where` would change every row, so:

- an UPDATE or DELETE with no `where()` or `allRows()` is a type error, and compiling one
  that slipped past the types is a `QueryBuilderDefect`;
- calling `where` again ANDs the new conditions with the earlier ones;
- a `where()` whose conditions all came out `undefined` (or render to nothing) is a
  `QueryBuilderError`, because that happens with data (every optional filter absent) and would
  otherwise widen a filtered write to the whole table;
- `allRows()` says a write over every row is meant.

## RETURNING

On Postgres, SQLite and D1, `returning` works as on an insert: no arguments for every column,
column names, or a callback. `Database.run` returns the changed or deleted rows, decoded.
Without it, a write returns no rows. ClickHouse and MySQL have no RETURNING; compiling a write
with `returning` for them is a `QueryBuilderDefect`.

```ts
SQLite.deleteFrom(Sessions).where(($) => [$.expiresAt.lt(SQLite.param.string("now"))]).returning("id")
// DELETE FROM "sessions" WHERE "expiresAt" < ? RETURNING "id" AS "id"
```

## ClickHouse

ClickHouse has no `UPDATE ... SET` on every server, so `update` compiles to a mutation, and
`deleteFrom` to a lightweight delete. Both need a WHERE, so `allRows()` writes `WHERE 1`:

```sql
ALTER TABLE spans UPDATE Name = 'x'
WHERE OrgId = 'o' SETTINGS mutations_sync = 2

DELETE FROM spans
WHERE OrgId = 'o' SETTINGS lightweight_deletes_sync = 2
```

A mutation runs in the background: without `mutations_sync`, `Database.run` returns before the
rows change. Pass `settings({ mutations_sync: 2 })` when the caller reads its own write.
Mutations rewrite whole parts, so they suit occasional corrections, not per-request updates;
model frequently changing state with a `ReplacingMergeTree` and inserts instead. ClickHouse
cannot update a column of the sorting key. `returning` is refused on ClickHouse
(`QueryBuilderDefect`), and `settings` on every other dialect.

## Tenant scope

An UPDATE or DELETE has the scope a query over the table with the same WHERE would have:
`"single-tenant"` when the WHERE pins the tenant column, `"cross-tenant"` otherwise (including
`allRows()`). An UPDATE that sets the tenant column to another value moves rows out of the
tenant, so it is `"cross-tenant"` too. A subquery in the SET or WHERE counts as it would in a
query: one that reads another tenant (or every tenant) makes the write `"cross-tenant"`, and a
write into a table without a tenant column takes the scope of what its subqueries read. The
same holds for a subquery in an insert's values or `onConflictDoUpdate`.

_(Backed by `src/ch/update.test.ts`, `src/database/database.test.ts` and
`tests/database.clickhouse.test.ts`.)_
