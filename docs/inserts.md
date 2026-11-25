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

- `default` or `defaultExpr` (every dialect) or `identity` (Postgres) makes a column optional.
- `defaultFn` or `onUpdate` (Postgres, SQLite, MySQL) makes a column optional too. The client fills it, not the
  database: see [client-side defaults](#client-side-defaults).
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

### Client-side defaults

A `PG.column`, `SQLite.column` or `MySQL.column` can take a default that the client computes: `defaultFn` and
`onUpdate` are Effects, so they can read the `Clock`, `Random` or a service. They write no DDL,
so neither the rendered schema nor a migration from `generate` carries them. ClickHouse columns
do not take them yet.

```ts
import { Context, DateTime, Effect } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

class IdGen extends Context.Service<IdGen, { readonly next: Effect.Effect<string> }>()("IdGen") {}

const Notes = PG.table("notes", {
	columns: {
		id: PG.column(PG.text, { defaultFn: Effect.flatMap(Effect.service(IdGen), (gen) => gen.next) }),
		body: PG.text,
		createdAt: PG.column(PG.timestamptz, { defaultFn: DateTime.now }),
		updatedAt: PG.column(PG.timestamptz, { onUpdate: DateTime.now }),
	},
	primaryKey: ["id"],
})

// Effect<ReadonlyArray<never>, ..., Database | IdGen>
const add = Db.run(PG.insertInto(Notes).values({ body: "hello" }))
```

- `Database.run` runs `defaultFn` once for each row that leaves its column out (or gives
  `undefined`). A value the row gives, `null` included, is kept, and the Effect does not run.
- `onUpdate` runs once for each update that does not set its column (see
  [Updating](./updates-and-deletes.md#set)). An insert that leaves the column out runs it too,
  when the column has no `defaultFn`, `default`, `defaultExpr` or `identity` (Postgres).
- What the Effects need is in the type of the write: the insert above requires `IdGen`, and
  `Db.run` passes the requirement on. `DateTime.now` needs only the `Clock`, which every Effect
  has, so it adds nothing. In a test, `TestClock` and a test `IdGen` layer give exact values.
- The Effects cannot fail: their error type is `never`. A default that can fail should handle
  the failure itself.
- `compile` does not run Effects. To compile such a write yourself, pass it through
  `fillDefaults` first: `Effect.flatMap(PG.fillDefaults(insert), (filled) => PG.compile(filled))`.
  `compile` refuses (`QueryBuilderDefect`) a write that still leaves out a client default.
- An `INSERT ... SELECT` cannot run a client default, since no row exists before the SELECT
  runs: `compile` refuses one that does not select every column with an insert client default.
  `onConflictDoUpdate`'s SET gets none either; set the column there yourself.

_(Backed by `src/database/client-defaults.test.ts`, `src/database/client-defaults.test-d.ts` and
`src/sqlite/client-defaults.test.ts`.)_

## What it compiles to

Columns are written in table order, whatever order the keys are in, so two rows with their keys
in different orders cannot swap values. A column that some rows give and others leave out is
`DEFAULT` in the rows that leave it out:

```ts
const Events = CH.table("events", {
	columns: { OrgId: CH.string, Id: CH.column(CH.uint64, { default: 0 }), At: CH.dateTime },
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "At"],
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
  several rows is bound once.
- **SQLite and MySQL** bind each value as `?`, once per use.

A statement over the dialect's bound-value limit fails to compile instead of being split: 65535
on Postgres and MySQL, 32766 on SQLite, 100 on D1. Send fewer rows per statement.

## Insert ... select

`select(query)` inserts the rows a query (or a `unionAll`) selects, instead of `values`. Each
selected alias names the column it goes into, so select under the target's column names:

```ts
const Spans = CH.table("spans", {
	columns: { OrgId: CH.string, Name: CH.string, Ms: CH.uint64 },
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Name"],
})
const Daily = CH.table("daily", {
	columns: { OrgId: CH.string, Name: CH.string, Total: CH.uint64 },
	engine: CH.engine.summingMergeTree(),
	orderBy: ["OrgId", "Name"],
})

CH.insertInto(Daily).select(
	CH.from(Spans)
		.select(($) => ({ OrgId: $.OrgId, Name: $.Name, Total: CH.sum($.Ms) }))
		.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
		.groupBy("OrgId", "Name"),
)
// INSERT INTO daily (OrgId, Name, Total)
// SELECT spans.OrgId AS OrgId, spans.Name AS Name, sum(spans.Ms) AS Total
// FROM spans WHERE spans.OrgId = 'o1' GROUP BY OrgId, Name
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

`selectNoFrom(() => ({ … }))` is a SELECT of values with no FROM, and its `where` takes
conditions that read no source, such as `exists(…)`. As an insert's source, it inserts one row
only when a condition holds, which is how to make a write conditional on D1, where there is no
transaction to read in first:

```ts
SQLite.insertInto(Credentials).select(
	SQLite.selectNoFrom(() => ({ credentialId: SQLite.param.string("id"), subjectId: SQLite.param.string("subject"), revision: SQLite.lit("initial") }))
		.where(() => [
			SQLite.exists(SQLite.from(Identities).select(() => ({ one: SQLite.lit(1) })).where(($) => [$.identityKey.eq(SQLite.param.string("key"))])),
			SQLite.not(SQLite.exists(SQLite.from(Logins).select(() => ({ one: SQLite.lit(1) })).where(($) => [$.identityKey.eq(SQLite.param.string("key"))]))),
		]),
)
// INSERT INTO "credentials" (…) SELECT ? AS "credentialId", ? AS "subjectId", 'initial' AS "revision"
// WHERE EXISTS (…) AND NOT (EXISTS (…))
```

MySQL writes `FROM DUAL` for it. On SQLite, `jsonRows(rows, columns)` is a query over a JS array
bound as one parameter, the usual source of a bulk `INSERT ... SELECT` there; see
[Rows from a JS array](./sqlite.md#rows-from-a-js-array-jsonrows).

## Returning

On Postgres, SQLite and D1, `returning` adds a RETURNING list and `Database.run` returns the
inserted rows, decoded. With no arguments it returns every column, as Drizzle's bare `.returning()` does; it
also takes column names, or a callback building one expression per alias, as `select` does:

```ts
const created = PG.insertInto(ApiKeys)
	.values({ id: PG.param.string("id"), org_id: PG.param.string("orgId"), name: "default" })
	.returning(($) => ({ id: $.id, createdAt: $.created_at }))

// const [row] = yield* Db.run(created, { id, orgId }) // { id: string; createdAt: DateTime.Utc }
```

The row schema is derived from the list, as it is from a SELECT: an untyped expression
(`untypedExpr`) leaves the insert undecoded, with `rowSchemaSource: "none"` and the alias in
`untypedColumns`. `CompiledQuery.returning` lists the aliases. ClickHouse and MySQL have no
RETURNING, so compiling an insert with `returning` for them is a `QueryBuilderDefect`. On MySQL,
`Db.runWrite` returns the insert's `AUTO_INCREMENT` key and affected rows instead
([Write results](./database.md#write-results)).

## On conflict

On Postgres, SQLite and D1, `onConflictDoNothing` and `onConflictDoUpdate` add an `ON CONFLICT`
clause. Their
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
  `ReplacingMergeTree` instead), and MySQL's `ON DUPLICATE KEY UPDATE` reacts to every unique key
  rather than one target, so compiling one for either is a `QueryBuilderDefect`; on MySQL and
  MariaDB, use [`onDuplicateKeyUpdate`](#on-duplicate-key-update). SQLite does not take
  `{ constraint: "name" }` as a target.

### Set from the proposed row

A sync upsert usually copies the new row over the old one. `excluded(columns)` and
`excludedAll(except?)` build that `set`, so you do not list each column twice:

```ts
// Copy count only.
PG.insertInto(Counters).values({ key: "a", count: 1 }).onConflictDoUpdate({ target: ["key"], set: PG.excluded(["count"]) })

// Copy every column the rows write, but not locked.
PG.insertInto(Counters)
	.values({ key: "a", count: 1, locked: false })
	.onConflictDoUpdate({ target: ["key"], set: PG.excludedAll(["locked"]) })
```

```sql
INSERT INTO "counters" ("key", "count")
VALUES ($1, $2)
ON CONFLICT ("key") DO UPDATE SET "count" = "excluded"."count"

INSERT INTO "counters" ("key", "count", "locked")
VALUES ($1, $2, $3)
ON CONFLICT ("key") DO UPDATE SET "count" = "excluded"."count"
```

- The names are checked against the table, as in a `set` record: a name that is not a column,
  or a computed column, does not type-check.
- `excludedAll` takes the columns the insert writes (the rows' keys, or the SELECT's aliases),
  not every column of the table. A column the rows leave out keeps its old value; on a column
  you do not write, `EXCLUDED` holds the default, and copying it would overwrite real data. It
  also skips the target's columns, which are equal in both rows.
- `col = excluded.col` on the tenant column keeps the rows' tenant scope: it writes the value
  the rows already gave it. It says nothing about the tenant of the existing row it updates;
  put the tenant column in `target` (which also leaves it out of `excludedAll`) so a conflict
  can only match the same tenant's row.
- To mix copied columns with other values (`updatedAt: now()`), use the callback form:
  `set: ($, excluded) => ({ name: excluded.name, updatedAt: PG.now() })`.
- The dialect writes the SQL that reads the proposed row, so the same `set` value works on any
  dialect with an upsert: Postgres, SQLite and D1 all write `"excluded"."col"`, MySQL
  `` `excluded`.`col` `` and MariaDB `` VALUES(`col`) ``.

### On duplicate key update

MySQL and MariaDB have `INSERT ... ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`.
`onDuplicateKeyUpdate({ set })` writes it. `set` takes the same forms as `onConflictDoUpdate`'s:
a record, a callback of the existing row and the proposed one, `excluded(columns)` or
`excludedAll(except?)`.

```ts
const Counters = MySQL.table("counters", {
	columns: { id: MySQL.bigint, key: MySQL.varchar(32), count: MySQL.int, note: MySQL.text },
	primaryKey: ["id"],
})

// Add to the existing count.
MySQL.insertInto(Counters)
	.values({ id: 1, key: "a", count: 1, note: "x" })
	.onDuplicateKeyUpdate({ set: ($, excluded) => ({ count: $.count.add(excluded.count) }) })

// Copy every column the rows write, but not the primary key.
MySQL.insertInto(Counters)
	.values([
		{ id: 1, key: "a", count: 1, note: "x" },
		{ id: 2, key: "b", count: 1, note: "y" },
	])
	.onDuplicateKeyUpdate({ set: MySQL.excludedAll() })
```

```sql
-- MySQL
INSERT INTO `counters` (`id`, `key`, `count`, `note`)
VALUES (?, ?, ?, ?) AS `excluded`
ON DUPLICATE KEY UPDATE `count` = `counters`.`count` + `excluded`.`count`

-- MariaDB
INSERT INTO `counters` (`id`, `key`, `count`, `note`)
VALUES (?, ?, ?, ?)
ON DUPLICATE KEY UPDATE `count` = `counters`.`count` + VALUES(`count`)
```

- It fires when a row conflicts on **any** unique key: the primary key or any UNIQUE index.
  There is no target to name one, and no `where`. A row that conflicts on a key you did not
  expect updates that row.
- MySQL reads the proposed row through a row alias, `VALUES (...) AS excluded`, which needs
  MySQL 8.0.19 or later (it deprecates `VALUES(col)`). MariaDB has no row alias and reads
  `VALUES(col)`. A table named `excluded` cannot take it on MySQL: compiling is a
  `QueryBuilderDefect`.
- `excludedAll` copies the columns the insert writes, except the table's declared
  `primaryKey`: when the conflict is on another unique key, copying the proposed row's key
  would change the existing row's. An `external` table declares no key, so list it in
  `except` yourself: `excludedAll(["id"])`.
- Reading a column of the proposed row that the insert does not write is a
  `QueryBuilderError` `InvalidArguments`: MySQL's row alias has no such column, and MariaDB's
  `VALUES(col)` of one is NULL.
- The assignments run left to right, and a later one reads the existing row as the earlier ones
  left it: in `{ a: excluded.a, b: $.a }`, `b` gets the new `a`.
- MySQL counts an inserted row as 1 affected row, an updated one as 2, and one the update left
  unchanged as 0.
- It takes `values` rows only; with `select` compiling is a `QueryBuilderDefect`. Calling it
  again replaces the clause, as `onConflict*` does. Other dialects refuse it with a
  `QueryBuilderDefect`.
- It is always `"cross-tenant"` on a table with a `tenantColumn`; see [Tenant scope](#tenant-scope).

## Settings

On ClickHouse, `settings` adds a `SETTINGS` clause to the insert, before `VALUES` or the
`SELECT`:

```ts
CH.insertInto(Daily).values(rows).settings({ async_insert: 1, wait_for_async_insert: 1 })
// INSERT INTO daily (OrgId, Name, Total) SETTINGS async_insert = 1, wait_for_async_insert = 1
// VALUES ...
```

Names must be plain identifiers; values (strings, numbers, booleans) are written as literals.
Calling it again replaces them. Only ClickHouse has insert settings; compiling one with
`settings` for another dialect is a `QueryBuilderDefect`.

## Tenant scope

An insert has a `tenantScope` like a query, worked out the same way. On a table with a
`tenantColumn`, it is `"single-tenant"` when every row gives that column the same value or the
same param, and `"cross-tenant"` when rows differ or a row uses another expression. An
`onConflictDoUpdate` that sets the tenant column counts as one more row. It must also prove
that the existing conflict row has that tenant: include the tenant column in the conflict
target, or pin it in the update's `where`, for example
`where: (existing, excluded) => existing.orgId.eq(excluded.orgId)`. A constraint name alone
does not prove its columns. Without this evidence the upsert is `"cross-tenant"`, even if
the inserted values name one tenant. OR conditions do not supply tenant evidence.
`onDuplicateKeyUpdate` has neither a target nor a `where`, and fires on any unique key, so it
is always `"cross-tenant"`: declare it with `.crossTenant()` where every unique key of the
table holds the tenant column.

An `INSERT ... SELECT` into a tenant table is `"single-tenant"` when the SELECT is, and each row
takes its tenant from a tenant column of the source or from the same param that pins the SELECT.
Into a table without a tenant column, the insert has the SELECT's scope: what it reads. A table
without a tenant column gives `"untenanted"`.

A batch that mixes tenants on purpose, such as an ingest flush, declares it with
`insertInto(table).values(rows).crossTenant()`, so a database with `requireTenantScope` runs it.
`update` and `deleteFrom` have `.crossTenant()` too. See [Tenant scoping](./tenant-scoping.md).

## Failures

| Case                                              | Result                                   |
| ------------------------------------------------- | ---------------------------------------- |
| `values([])`, a row with no values                | `QueryBuilderError` `InvalidArguments`   |
| A key that is not a column, or a non-writable one | `QueryBuilderError` `InvalidArguments`   |
| A value the column's codec rejects                | `QueryBuilderError` `InvalidLiteral`     |
| A param with no value                             | `QueryBuilderError` `UnresolvedParam`    |
| Over the dialect's bound-value limit              | `QueryBuilderError` `InvalidArguments`   |
| Compiling without `values`                        | `QueryBuilderDefect`                     |
| Compiling a row that leaves out a client default  | `QueryBuilderDefect`                     |
| `returning` for a dialect without RETURNING       | `QueryBuilderDefect`                     |
| `onConflictDoUpdate` setting no or unknown columns | `QueryBuilderError` `InvalidArguments`  |
| `excluded` / `excludedAll` naming an unknown column | `QueryBuilderError` `InvalidArguments` |
| `onConflict*` without ON CONFLICT, a bad target   | `QueryBuilderDefect`                     |
| `onDuplicateKeyUpdate` on another dialect, with `select`, or into a table named `excluded` on MySQL | `QueryBuilderDefect` |
| `onDuplicateKeyUpdate` reading an unwritten column of the proposed row | `QueryBuilderError` `InvalidArguments` |
| `settings` without insert settings, a bad name    | `QueryBuilderDefect`                     |

_(Backed by `src/ch/insert.test.ts`, `src/mysql/upsert.test.ts`, `src/database/database.test.ts`
and `tests/database.clickhouse.test.ts`.)_

## Large batches on ClickHouse

An insert is SQL text, which suits the batches an application writes per request. For bulk
ingest, prefer your client's own insert with `JSONEachRow`, which streams rows instead of
building one statement.
