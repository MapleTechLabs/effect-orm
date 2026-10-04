# Inserting rows

`insertInto(table).values(rows)` builds an INSERT from the same table definition your queries
read. Like a query, it is an immutable value: nothing is sent until you run it, and `compile`
writes it for the dialect you compile with.

```ts
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const ApiKeys = PG.table("api_keys", {
	columns: {
		id: PG.uuid,
		org_id: PG.text,
		name: PG.text,
		created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
		revoked: PG.column(PG.bool, { default: false }),
		note: PG.nullable(PG.text),
	},
	primaryKey: ["id"],
	tenantColumn: "org_id",
})

const insertKey = PG.insertInto(ApiKeys).values({
	id: PG.param.string("id"),
	org_id: PG.param.string("orgId"),
	name: "default",
})

// yield* Db.run(insertKey, { id, orgId })
```

`Database.run` compiles the insert for its database's dialect and runs it. Without
[`returning`](#returning) an insert returns no rows.

## The row type

Each row is typed from the table:

- A column is **required** unless it is nullable or its column options give it a default.
- Leaving an optional column out, or passing `undefined`, writes the column's default.
- `null` writes NULL, and only type-checks on a nullable column.
- A value can be a plain value of the column's type, a `param.*` of it, or any expression of it,
  such as `PG.now()`. A `DateTime` column also takes a `Date` or the
  `'YYYY-MM-DD hh:mm:ss'` string, as in a comparison.

`InsertRowOf<typeof ApiKeys>` names the row type, for a function that builds rows.

### Which columns have defaults

The row type is derived from the column options that also write the [DDL](./migrations.md), so
it cannot drift from what the database fills in:

- `default` or `defaultExpr` (both dialects) or `identity` (Postgres) makes a column optional.
- `materialized` or `alias` (ClickHouse) makes a column not writable: it is not in the row type,
  and a row that names it anyway fails to compile. It stays readable.

Postgres `GENERATED ALWAYS AS (...) STORED` columns are not modeled yet: there is no column
option for them, so such a column reads as an ordinary required column.

An [external table](./migrations.md) (`external: true`, for a table another tool migrates) has
no DDL, but its column options still drive the row type the same way.

`insertInto(table)` offers only `values` and `select` until it has rows (its type is
`CHInsertStart`), so an insert cannot be compiled or run before it says what to insert.

ClickHouse fills every column it is not given with a default, even without a `DEFAULT` clause:
`0` for a number, `''` for a string. The row type still requires those columns unless they
declare a default, so a forgotten value is a type error rather than a silent zero.

## What it compiles to

Columns are written in table order, whatever order the keys are in, so two rows with their keys
in different orders cannot swap values. A column that some rows give and others leave out is
`DEFAULT` in the rows that leave it out:

```ts
const Events = CH.table("events", {
	columns: { OrgId: CH.string, Id: CH.column(CH.uint64, { default: 0 }), At: CH.dateTime },
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "At"],
	tenantColumn: "OrgId",
})

CH.compileUnsafe(
	CH.insertInto(Events).values([
		{ At: new Date(0), OrgId: "o1" },
		{ OrgId: "o1", Id: 5, At: "2026-01-01 00:00:00" },
	]),
).sql
// INSERT INTO events (OrgId, Id, At)
// VALUES ('o1', DEFAULT, '1970-01-01 00:00:00'), ('o1', 5, '2026-01-01 00:00:00')
```

Every value is encoded through its column's codec, the same one that decodes the column. A value
the codec rejects fails to compile with a `QueryBuilderError` that names the row and column.

- **ClickHouse** writes each value into the SQL as an escaped literal, as it does for params.
- **Postgres** binds each value as `$1, $2, ...` and returns them in `parameters`. A param used in
  several rows is bound once. A statement over 65535 bound values (Postgres's limit) fails to
  compile instead of being split: send fewer rows per statement.

## Insert ... select

`select(query)` inserts the rows a query (or a `unionAll`) selects, instead of `values`. Each
selected alias names the column it goes into, so select under the target's column names:

```ts
const Spans = CH.table("spans", {
	columns: { OrgId: CH.string, Name: CH.string, Ms: CH.uint64 },
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Name"],
	tenantColumn: "OrgId",
})
const Daily = CH.table("daily", {
	columns: { OrgId: CH.string, Name: CH.string, Total: CH.uint64 },
	engine: CH.engine.summingMergeTree(),
	orderBy: ["OrgId", "Name"],
	tenantColumn: "OrgId",
})

CH.insertInto(Daily).select(
	CH.from(Spans)
		.select(($) => ({ OrgId: $.OrgId, Name: $.Name, Total: CH.sum($.Ms) }))
		.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
		.groupBy("OrgId", "Name"),
)
// INSERT INTO daily (OrgId, Name, Total)
// SELECT ... FROM spans WHERE spans.OrgId = 'o1' GROUP BY OrgId, Name
```

The selected row is checked against the table: selecting a column the table does not have (or
a `materialized` or `alias` one), selecting a value of another type, or leaving out a required column is a type
error naming the columns (`targetCannotTake`, `missingColumns`). A nullable result, such as a
Postgres `sum`, does not fit a NOT NULL column; wrap it in `coalesce`.

The column list is the aliases in select order, which is the order the SELECT writes them, so
ClickHouse and Postgres agree. `returning` and `onConflict*` work with `select` as with
`values`. `select` and `values` replace each other.

A long `INSERT ... SELECT` on ClickHouse (a backfill over a big table) can outlast an HTTP
timeout; run those in slices.

## Returning

On Postgres, `returning` adds a RETURNING list and `Database.run` returns the inserted rows,
decoded. With no arguments it returns every column, as Drizzle's bare `.returning()` does; it
also takes column names, or a callback building one expression per alias, as `select` does:

```ts
const created = PG.insertInto(ApiKeys)
	.values({ id: PG.param.string("id"), org_id: PG.param.string("orgId"), name: "default" })
	.returning(($) => ({ id: $.id, createdAt: $.created_at }))

// const [row] = yield* Db.run(created, { id, orgId }) // { id: string; createdAt: DateTime.Utc }
```

The row schema is derived from the list, as it is from a SELECT: an untyped expression
(`untypedExpr`) leaves the insert undecoded, with `rowSchemaSource: "none"` and the alias in
`untypedColumns`. `CompiledQuery.returning` lists the aliases. ClickHouse has no RETURNING, so
compiling an insert with `returning` for it is a `QueryBuilderDefect`.

## On conflict

On Postgres, `onConflictDoNothing` and `onConflictDoUpdate` add an `ON CONFLICT` clause. Their
options follow Drizzle's, so code moving from Drizzle changes little.

```ts
const Counters = PG.table("counters", {
	columns: { key: PG.text, count: PG.int8, locked: PG.column(PG.bool, { default: false }) },
	primaryKey: ["key"],
})

// Skip a row whose key exists. Without `target`, any unique index or constraint counts.
PG.insertInto(Counters).values({ key: "a", count: 1 }).onConflictDoNothing({ target: ["key"] })

// Upsert: add to the existing count, unless the row is locked.
PG.insertInto(Counters)
	.values({ key: "a", count: 1 })
	.onConflictDoUpdate({
		target: ["key"],
		set: ($, excluded) => ({ count: $.count.add(excluded.count) }),
		where: ($) => $.locked.eq(false),
	})
	.returning("key", "count")
```

```sql
INSERT INTO "counters" ("key", "count")
VALUES ($1, $2)
ON CONFLICT ("key") DO UPDATE SET "count" = "counters"."count" + "excluded"."count" WHERE "counters"."locked" = FALSE
RETURNING "key" AS "key", "count" AS "count"
```

- `target` is column names, or `{ constraint: "name" }`. `targetWhere` gives a partial unique
  index's predicate. `onConflictDoUpdate` requires a `target`; `onConflictDoNothing` does not.
- `set` is a record of values, params or expressions, or a callback that gets `$` (the existing
  row) and `excluded` (the row proposed for insertion). `$` is qualified with the table name,
  because an unqualified column would be ambiguous with `excluded`. A key left out keeps the
  existing value.
- `where` limits the update to existing rows it holds for. A row it skips is not updated and,
  with `returning`, returns nothing; the same goes for a row `onConflictDoNothing` skips.
- Calling either again replaces the clause. ClickHouse has no `ON CONFLICT` (deduplicate with a
  `ReplacingMergeTree` instead), so compiling one for it is a `QueryBuilderDefect`.

## Settings

On ClickHouse, `settings` adds a `SETTINGS` clause to the insert, before `VALUES` or the
`SELECT`:

```ts
CH.insertInto(Daily).values(rows).settings({ async_insert: 1, wait_for_async_insert: 1 })
// INSERT INTO daily (OrgId, Name, Total) SETTINGS async_insert = 1, wait_for_async_insert = 1
// VALUES ...
```

Names must be plain identifiers; values (strings, numbers, booleans) are written as literals.
Calling it again replaces them. Postgres has no insert settings, so compiling one with
`settings` for it is a `QueryBuilderDefect`.

## Tenant scope

An insert has a `tenantScope` like a query, worked out the same way. On a table with a
`tenantColumn`, it is `"single-tenant"` when every row gives that column the same value or the
same param, and `"cross-tenant"` when rows differ or a row uses another expression. An
`onConflictDoUpdate` that sets the tenant column counts as one more row.

An `INSERT ... SELECT` into a tenant table is `"single-tenant"` when the SELECT is, and each row
takes its tenant from a tenant column of the source or from the same param that pins the SELECT.
Into a table without a tenant column, the insert has the SELECT's scope: what it reads. A table
without a tenant column gives `"untenanted"`.

## Failures

| Case                                              | Result                                   |
| ------------------------------------------------- | ---------------------------------------- |
| `values([])`, a row with no values                | `QueryBuilderError` `InvalidArguments`   |
| A key that is not a column, or a non-writable one | `QueryBuilderError` `InvalidArguments`   |
| A value the column's codec rejects                | `QueryBuilderError` `InvalidLiteral`     |
| A param with no value                             | `QueryBuilderError` `UnresolvedParam`    |
| Over the dialect's bound-value limit              | `QueryBuilderError` `InvalidArguments`   |
| Compiling without `values`                        | `QueryBuilderDefect`                     |
| `returning` for a dialect without RETURNING       | `QueryBuilderDefect`                     |
| `onConflictDoUpdate` setting no or unknown columns | `QueryBuilderError` `InvalidArguments`  |
| `onConflict*` without ON CONFLICT, a bad target   | `QueryBuilderDefect`                     |
| `settings` without insert settings, a bad name    | `QueryBuilderDefect`                     |

_(Backed by `src/ch/insert.test.ts`, `src/database/database.test.ts` and
`tests/database.clickhouse.test.ts`.)_

## Large batches on ClickHouse

An insert is SQL text, which suits the batches an application writes per request. For bulk
ingest, prefer your client's own insert with `JSONEachRow`, which streams rows instead of
building one statement.
