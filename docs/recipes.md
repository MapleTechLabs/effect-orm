# Recipes

Each recipe is a complete file. The ClickHouse ones use the `Events` and `Services` declarations
from [Getting started](./getting-started.md#shared-tables-used-by-the-guides): save that block as
`schema.ts` and place a recipe next to it. They compile SQL without a database; execute
`compiled.sql` using [your client](./running-queries.md), or hand the query to
[`Db.run`](./database.md). The recipes that write rows, page with a cursor or open a transaction
run on PGlite (Postgres compiled to WASM, `@effect/sql-pglite`), so they need no server either.

## Time buckets over a bounded interval

Use a half-open range (`start <= Timestamp < end`) so adjacent windows do not overlap.
Filter the raw timestamp and group by its bucket, rather than filtering only a transformed date.
These examples assume UTC timestamps.

```ts title="time-buckets.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { Events } from "./schema"

const query = CH.from(Events)
	.select(($) => ({
		bucket: CH.toStartOfInterval($.Timestamp, 300),
		count: CH.count(),
		p95: CH.quantile(0.95)($.DurationMs),
	}))
	.where(($) => [
		$.OrgId.eq(CH.param.string("orgId")),
		$.Timestamp.gte(CH.param.dateTime("startTime")),
		$.Timestamp.lt(CH.param.dateTime("endTime")),
	])
	.groupBy("bucket")
	.orderBy(["bucket", "asc"])

export const compiled = await Effect.runPromise(
	CH.compile(query, {
		orgId: "org_123",
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 01:00:00",
	}),
)
console.log(compiled.sql)
```

The interval is in seconds: `300` produces five-minute buckets. Empty buckets are absent;
fill gaps in your application if the chart needs zeros. A decoded bucket is `DateTime.Utc`,
not a native `Date`; use Effect's `DateTime` utilities or a string timestamp type to serialize it.
Validate a user-selected bucket size as a positive integer and cap the number of buckets.

Performance depends on whether the real table's sorting key
supports these filters. Declaring a TypeScript table does not create an index or make a scan cheap.
See [ClickHouse query optimization](https://clickhouse.com/docs/optimize/query-optimization).

## Optional filters and empty lists

Keep all predicates in one WHERE callback. This example treats an empty name list as “no name
filter” and preserves the mandatory tenant/time filters. If an empty selection means “no results”
in your product, return an empty result before executing instead.

```ts title="optional-filters.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { Events } from "./schema"

export const buildQuery = (names: readonly string[], minDurationMs?: number) =>
	CH.from(Events)
		.select(($) => ({ name: $.Name, durationMs: $.DurationMs }))
		.where(($) => [
			$.OrgId.eq(CH.param.string("orgId")),
			$.Timestamp.gte(CH.param.dateTime("startTime")),
			$.Timestamp.lt(CH.param.dateTime("endTime")),
			CH.whenTrue(names.length > 0, () => $.Name.in_(...names)),
			CH.when(minDurationMs, (minimum) => $.DurationMs.gte(minimum)),
		])
		.orderBy(["durationMs", "desc"])
		.limit(50)

export const compiled = await Effect.runPromise(
	CH.compile(buildQuery(["checkout"], 0), {
		orgId: "org_123",
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-02 00:00:00",
	}),
)
console.log(compiled.sql)
```

`CH.when(0, ...)` includes the predicate; it skips `undefined`, `null`, and `false`, not every
falsy value. Values passed to `.in_()` are escaped. Check range and allowed-value constraints
at your input boundary before calling `buildQuery`.

## Filter aggregates with HAVING

Use `where` to choose events, then `having` to choose groups by their aggregated count.

```ts title="aggregate-filter.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { Events } from "./schema"

const query = CH.from(Events)
	.select(($) => ({ name: $.Name, count: CH.count() }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
	.groupBy("name")
	.having(() => [CH.dynamicColumn("count", CH.uint64).gte(CH.param.int("minimumCount"))])
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(20)

export const compiled = await Effect.runPromise(
	CH.compile(query, {
		orgId: "org_123",
		minimumCount: 10,
	}),
)
console.log(compiled.sql) // ... GROUP BY name HAVING count >= 10 ORDER BY ...
```

`count` is an output alias, so it is not on the input accessor `$`. Keep the string passed to
`dynamicColumn` under application control. Add time bounds when the endpoint needs a bounded scan.

## Top values per tenant, on each database

The builder is the same on every database; the entry, the column types and the functions change.
Each version below counts events per name for one tenant and keeps the 20 most frequent. The
ClickHouse one reads the shared `schema.ts`; the others declare their own table.

```ts title="top-names.ts" dialect="clickhouse"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { Events } from "./schema"

const query = CH.from(Events)
	.select(($) => ({ name: $.Name, count: CH.count(), p95: CH.quantile(0.95)($.DurationMs) }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(20)

export const compiled = await Effect.runPromise(CH.compile(query, { orgId: "org_123" }))
console.log(compiled.sql) // ... WHERE events.OrgId = 'org_123' GROUP BY name ...
```

```ts title="top-names.pg.ts" dialect="postgres"
import { Effect } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"

const Events = PG.table("events", {
	columns: {
		orgId: PG.column(PG.text, { name: "org_id" }),
		name: PG.text,
		durationMs: PG.column(PG.int8, { name: "duration_ms" }),
	},
	tenantColumn: "orgId",
})

const query = PG.from(Events)
	.select(($) => ({ name: $.name, count: PG.count(), p95: PG.percentileCont(0.95, $.durationMs) }))
	.where(($) => [$.orgId.eq(PG.param.string("orgId"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(20)

export const compiled = await Effect.runPromise(PG.compile(query, { orgId: "org_123" }))
console.log(compiled.sql, compiled.parameters) // ... WHERE "events"."org_id" = $1 ... ["org_123"]
```

```ts title="top-names.sqlite.ts" dialect="sqlite"
import { Effect } from "effect"
import * as SQLite from "@maple-dev/effect-orm/sqlite"

const Events = SQLite.table("events", {
	columns: {
		orgId: SQLite.column(SQLite.text, { name: "org_id" }),
		name: SQLite.text,
		durationMs: SQLite.column(SQLite.integer, { name: "duration_ms" }),
	},
	tenantColumn: "orgId",
})

const query = SQLite.from(Events)
	.select(($) => ({ name: $.name, count: SQLite.count(), avg: SQLite.avg($.durationMs) }))
	.where(($) => [$.orgId.eq(SQLite.param.string("orgId"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(20)

export const compiled = await Effect.runPromise(SQLite.compile(query, { orgId: "org_123" }))
console.log(compiled.sql, compiled.parameters) // ... WHERE "events"."org_id" = ? ... ["org_123"]
```

```ts title="top-names.mysql.ts" dialect="mysql"
import { Effect } from "effect"
import * as MySQL from "@maple-dev/effect-orm/mysql"

const Events = MySQL.table("events", {
	casing: "snake_case",
	columns: { orgId: MySQL.varchar(36), name: MySQL.varchar(255), durationMs: MySQL.int },
	tenantColumn: "orgId",
})

const query = MySQL.from(Events)
	.select(($) => ({ name: $.name, count: MySQL.count(), avg: MySQL.avg($.durationMs) }))
	.where(($) => [$.orgId.eq(MySQL.param.string("orgId"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(20)

export const compiled = await Effect.runPromise(MySQL.compile(query, { orgId: "org_123" }))
console.log(compiled.sql, compiled.parameters) // ... WHERE `events`.`org_id` = ? ... ["org_123"]
```

ClickHouse writes the param into the SQL as an escaped literal; Postgres, SQLite and MySQL send it
as a bound value (`$1` or `?`) in `compiled.parameters`. Postgres, SQLite and MySQL group by the
select position (`GROUP BY 1`). SQLite and MySQL have no percentile function, so their versions
select an average.

## Paginate a grouped result

For a small grouped result, a deterministic ordering and offset are straightforward. Grouping
makes `name` unique in this result, so it breaks ties between equal counts.

```ts title="pagination.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { Events } from "./schema"

const pageSize = 25
const pageIndex = 1 // zero-based: the second page
const query = CH.from(Events)
	.select(($) => ({ name: $.Name, count: CH.count() }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(pageSize)
	.offset(pageIndex * pageSize)

export const compiled = await Effect.runPromise(CH.compile(query, { orgId: "org_123" }))
console.log(compiled.sql) // ... LIMIT 25 OFFSET 25
```

Validate page sizes and indices as bounded non-negative integers before constructing a query.
An offset is not a cursor: concurrent inserts can shift pages, and large offsets still require
work. For a raw event feed, use a fixed time range and a cursor over a unique, stable sort key
(such as timestamp plus event ID). `Db.paginate` does this for a query that is not grouped; see
the next recipe.

## Page through rows with a cursor

`Db.paginate` pages a query by keyset: it adds a seek on the sort key after the cursor, and
returns the rows with the cursor for the next page. It works on every dialect. The sort key must
be unique, so end it with the primary key.

```ts title="keyset-pages.ts"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Option } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Notes = PG.table("notes", {
	columns: { id: PG.int4, orgId: PG.column(PG.text, { name: "org_id" }), title: PG.text },
	primaryKey: ["id"],
	tenantColumn: "orgId",
})

const notesOf = PG.from(Notes)
	.select("id", "title")
	.where(($) => [$.orgId.eq(PG.param.string("orgId"))])

// One page: `after` is the cursor the previous page returned, undefined for the first.
const page = (orgId: string, after: string | undefined) =>
	Db.paginate(notesOf, { orderBy: [["id", "asc"]], limit: 2, after }, { orgId })

const DatabaseLive = Db.layerSqlClient({ dialect: PG.postgresDialect, requireTenantScope: true }).pipe(
	Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })),
)

export const pages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Db.execute(Db.sql`CREATE TABLE notes (id int4 PRIMARY KEY, org_id text NOT NULL, title text NOT NULL)`)
		yield* Db.execute(Db.sql`INSERT INTO notes VALUES (1, 'org_1', 'a'), (2, 'org_1', 'b'), (3, 'org_2', 'x'), (4, 'org_1', 'c')`)

		const titles: Array<ReadonlyArray<string>> = []
		let after: string | undefined
		do {
			const next = yield* page("org_1", after)
			titles.push(next.rows.map((row) => row.title))
			after = Option.getOrUndefined(next.nextCursor)
		} while (after !== undefined)
		return titles
	}).pipe(Effect.provide(DatabaseLive)),
)
console.log(pages) // [["a", "b"], ["c"]]
```

In an API, return `nextCursor` to the client and take it back as `after` on the next request. A
cursor that does not decode, or was written for another `orderBy`, fails with `InvalidCursor`:
answer it as a bad request. [Pagination](./database.md#pagination) has the options and the SQL.

<!-- dialect: postgres,sqlite -->
## Insert or update a row

`onConflictDoUpdate` writes `INSERT ... ON CONFLICT (...) DO UPDATE`. The callback form of `set`
gets the existing row and `excluded`, the row proposed for insertion. Put the tenant column in
`target`, so a conflict can only match the same tenant's row.

```ts title="upsert.ts"
import { Effect } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"

const Settings = PG.table("settings", {
	columns: {
		orgId: PG.column(PG.text, { name: "org_id" }),
		key: PG.text,
		value: PG.text,
		updatedAt: PG.column(PG.timestamptz, { name: "updated_at", defaultExpr: "now()" }),
	},
	primaryKey: ["orgId", "key"],
	tenantColumn: "orgId",
})

const save = PG.insertInto(Settings)
	.values({ orgId: PG.param.string("orgId"), key: PG.param.string("key"), value: PG.param.string("value") })
	.onConflictDoUpdate({
		target: ["orgId", "key"],
		set: (_, excluded) => ({ value: excluded.value, updatedAt: PG.now() }),
	})
	.returning("key", "value", "updatedAt")

export const compiled = await Effect.runPromise(PG.compile(save, { orgId: "org_123", key: "theme", value: "dark" }))
console.log(compiled.sql)
// INSERT INTO "settings" ("org_id", "key", "value")
// VALUES ($1, $2, $3)
// ON CONFLICT ("org_id", "key") DO UPDATE SET "value" = "excluded"."value", "updated_at" = now()
// RETURNING "key" AS "key", "value" AS "value", "updated_at" AS "updatedAt"
```

Run it with `Db.run(save, params)` to get the written row back, decoded. SQLite and D1 accept the
same clause and `returning`. MySQL and ClickHouse have no `ON CONFLICT`, and compiling one for
them is a defect: on MySQL and MariaDB, use `onDuplicateKeyUpdate({ set })`
([On duplicate key update](./inserts.md#on-duplicate-key-update)); on ClickHouse, deduplicate
with a `ReplacingMergeTree`. `PG.excluded([...])`
and `PG.excludedAll()` copy columns from the proposed row without listing each one; see
[On conflict](./inserts.md#on-conflict).
<!-- /dialect -->

<!-- dialect: postgres,sqlite,mysql -->
## Several writes in one transaction

Pipe an effect through `Db.transaction()` and every statement in it runs on one connection, in
one transaction. Any failure rolls all of them back, including a failure of your own.

```ts title="transaction-writes.ts"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Schema } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as S from "@maple-dev/effect-orm/schema"

const Stock = PG.table("stock", { columns: { sku: PG.text, quantity: PG.int4 }, primaryKey: ["sku"] })
const Orders = PG.table("orders", {
	columns: { id: PG.int4, sku: PG.text, quantity: PG.int4 },
	primaryKey: ["id"],
})

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", { sku: Schema.String }) {}

// Both writes land, or neither does: a failure anywhere in the body rolls back.
const placeOrder = (id: number, sku: string, quantity: number) =>
	Effect.gen(function* () {
		yield* Db.run(PG.insertInto(Orders).values({ id, sku, quantity }))
		const [left] = yield* Db.run(
			PG.update(Stock)
				.set(($) => ({ quantity: $.quantity.sub(quantity) }))
				.where(($) => [$.sku.eq(sku)])
				.returning("quantity"),
		)
		if (left === undefined || left.quantity < 0) return yield* new OutOfStock({ sku })
	}).pipe(Db.transaction())

const DatabaseLive = Db.layerSqlClient({ dialect: PG.postgresDialect }).pipe(
	Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })),
)

export const result = await Effect.runPromise(
	Effect.gen(function* () {
		for (const statement of S.renderPgSchema(yield* S.pgEntitiesOf([Stock, Orders])))
			yield* Db.execute({ sql: statement, parameters: [] })
		yield* Db.run(PG.insertInto(Stock).values({ sku: "tea", quantity: 5 }))

		yield* placeOrder(1, "tea", 2)
		const refused = yield* Effect.flip(placeOrder(2, "tea", 10))

		const orders = yield* Db.run(PG.from(Orders).select("id").orderBy(["id", "asc"]))
		const stock = yield* Db.runOne(PG.from(Stock).select("quantity").where(($) => [$.sku.eq("tea")]))
		return { refused: refused._tag, orders: orders.map((row) => row.id), stock: stock.quantity }
	}).pipe(Effect.provide(DatabaseLive)),
)
console.log(result)
// { refused: "OutOfStock", orders: [1], stock: 3 }
```

The second order inserts its row, then finds the stock would go negative and fails; the
transaction rolls back that insert too. There is no `tx` handle: `Db.run` inside the body uses the
transaction's connection. A nested `Db.transaction` is a savepoint. MySQL has no `RETURNING`, so
there read the row with a `SELECT ... FOR UPDATE` (`.forUpdate()`) before the update instead.
D1 has no interactive transactions, and ClickHouse none at all. Isolation levels, contention
retry and `requireTransaction` are in [Transactions](./database.md#transactions).
<!-- /dialect -->

## Preserve large integer IDs

Keep a numeric column numeric in its table declaration. Convert its projection to text before
JSON parsing could lose precision. This also works for IDs produced by numeric hash functions.

```ts title="large-ids.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"

const Records = CH.table("records", {
	columns: { Id: CH.uint64, Name: CH.string },
	engine: CH.engine.mergeTree(),
	orderBy: ["Id"],
})
const query = CH.from(Records)
	.select(($) => ({ id: CH.toString($.Id), name: $.Name }))
	.limit(1)

export const compiled = await Effect.runPromise(CH.compile(query, {}))
export const rows = await Effect.runPromise(
	compiled.decodeRows([{ id: "18446744073709551615", name: "checkout" }]),
)
console.log(rows[0]?.id) // "18446744073709551615", preserved as a string
```

Do not convert that string back to `number`. Use `BigInt(id)` for exact integer arithmetic
outside JSON, or leave it as a string for identity and transport. Do not use `param.int` for an
unsafe integer value; it deliberately accepts only safe JavaScript integers.
