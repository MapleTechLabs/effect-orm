# Updating and deleting rows

`update(table)` and `deleteFrom(table)` build UPDATE and DELETE from the same table definitions,
like [`insertInto`](./inserts.md). They are immutable values; `Database.run` compiles them for
its database's dialect and runs them.

```ts
import * as CH from "@maple-dev/effect-orm"
import * as PG from "@maple-dev/effect-orm/postgres"

const Tickets = CH.table(
	"tickets",
	{ id: PG.int4, org: PG.text, seats: PG.int4, tags: PG.array(PG.text) },
	{ tenantColumn: "org" },
)

const bump = CH.update(Tickets)
	.set(($) => ({ seats: $.seats.add(1) }))
	.where(($) => [$.org.eq(CH.param.string("org")), $.seats.lt(5)])
	.returning("id", "seats")

const revoke = CH.deleteFrom(Tickets).where(($) => [$.id.eq(CH.param.int("id"))])

// yield* Db.run(bump, { org })   // [{ id, seats }]
// yield* Db.run(revoke, { id })  // []
```

## SET

`set` takes a record of values, params or expressions, or a callback that gets the row's
columns as `$`. A key left out (or `undefined`) keeps the existing value. Values are encoded
through the column's codec and bound on Postgres, as in an insert. A computed column (see
[`computed`](./inserts.md#which-columns-have-defaults)) cannot be set. `UpdateSetOf<typeof T>`
names the record type.

`update(table)` offers only `set` until it has one (its type is `CHUpdateStart`).

## WHERE, and writing every row

`where` works as in a query: a list of conditions, AND-joined, with an `undefined` one skipped,
so optional filters compose. A write with no `where` would change every row, so:

- compiling an UPDATE or DELETE with no `where()` is a `QueryBuilderDefect`;
- a `where()` whose conditions all came out `undefined` is a `QueryBuilderError`, because that
  happens with data (every optional filter absent) and would otherwise widen a filtered write to
  the whole table;
- `allRows()` says a write over every row is meant.

## RETURNING

On Postgres, `returning` works as on an insert: no arguments for every column, column names, or
a callback. `Database.run` returns the changed or deleted rows, decoded. Without it, a write
returns no rows.

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
(`QueryBuilderDefect`), and `settings` on Postgres.

## Tenant scope

An UPDATE or DELETE has the scope a query over the table with the same WHERE would have:
`"single-tenant"` when the WHERE pins the tenant column, `"cross-tenant"` otherwise (including
`allRows()`). An UPDATE that sets the tenant column to another value moves rows out of the
tenant, so it is `"cross-tenant"` too.

_(Backed by `src/ch/update.test.ts`, `src/database/database.test.ts` and
`tests/database.clickhouse.test.ts`.)_
