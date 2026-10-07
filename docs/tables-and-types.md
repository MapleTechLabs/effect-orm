# Tables and column types

A table is declared once, with the dialect entry's `table`. The same value serves the query
builder (its name and columns), inserts (which columns may be left out), and
[migrations](./migrations.md) (its DDL). There is no second, lighter way to declare one: a table
grows options as it needs them.

## `table(name, definition)`

The smallest ClickHouse table is its columns, an engine, and the sorting key the MergeTree family
requires:

```ts
import * as CH from "@maple-dev/effect-orm/clickhouse"

const Events = CH.table("events", {
	columns: {
		OrgId: CH.string,
		Name: CH.string,
		Timestamp: CH.dateTime,
		DurationMs: CH.uint64,
		Attributes: CH.map(CH.string, CH.string),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Timestamp"],
})
```

The `columns` record is what every accessor, output type, and join is inferred from. `name` is
emitted as the FROM target. `orderBy: []` writes `ORDER BY tuple()`.

The value is a plain `Table` with its DDL beside it on `ddl`. It is never checked against a live
server, so a column that does not exist in ClickHouse will typecheck happily and fail at query
time. [`effect-orm generate`](./migrations.md#generating-migrations) keeps the two in step when
this definition is your schema; otherwise treat it as a contract you keep in sync with your
migrations by hand.

A definition that cannot become DDL (a MergeTree table without `orderBy`, a name that is not a
plain identifier, two of `default`/`materialized` on one column) throws `SchemaDefinitionDefect`
when the module loads.

The Postgres table has the same shape, with a primary key in place of an engine:

```ts
import * as PG from "@maple-dev/effect-orm/postgres"

const Users = PG.table("users", {
	columns: {
		id: PG.column(PG.int8, { identity: "always" }),
		email: PG.text,
		name: PG.nullable(PG.text),
		created_at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
})
```

A Postgres column is `NOT NULL` unless its type is `PG.nullable(...)`. See
[Postgres](./postgres.md) for its types and [migrations](./migrations.md#postgres) for its
indexes and foreign keys.

## Keys, defaults, and tenancy

`column(type, options)` wraps a column type with what a bare type cannot say. The options also
decide the insert row type, so it is derived from the DDL rather than declared twice:

| Option (ClickHouse)       | DDL                    | On insert                    |
| ------------------------- | ---------------------- | ---------------------------- |
| `default: 200`            | `DEFAULT 200`          | optional                     |
| `defaultExpr: "now()"`    | `DEFAULT now()`        | optional                     |
| `materialized: "…"`       | `MATERIALIZED …`       | not writable                 |
| `alias: "…"`              | `ALIAS …`              | not writable                 |
| `codec`, `comment`        | `CODEC(…)`, `COMMENT`  | unchanged                    |

Postgres columns take `default`, `defaultExpr`, and `identity` (`"always"` or `"by default"`);
each makes the column optional on insert. Postgres generated columns are not modeled yet.

```ts
const Requests = CH.table("requests", {
	columns: {
		OrgId: CH.string,
		Timestamp: CH.column(CH.dateTime, { defaultExpr: "now()" }),
		Route: CH.string,
		Status: CH.column(CH.uint16, { default: 200 }),
		Hour: CH.column(CH.dateTime, { materialized: "toStartOfHour(Timestamp)" }),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Route", "Timestamp"],
	partitionBy: "toDate(Timestamp)",
	ttl: CH.ttlAfterDays("toDate(Timestamp)", 30),
	tenantColumn: "OrgId",
})

type NewRequest = CH.InsertRowOf<typeof Requests>
// { OrgId: string; Route: string; Timestamp?: …; Status?: number } — Hour cannot be written
```

`tenantColumn` names the column that carries tenancy; see [Tenant scoping](./tenant-scoping.md).
The other table options are `primaryKey`, `settings`, and `comment`. Keys, partitions, and TTLs
are SQL strings or callbacks over the columns (`($) => [$.OrgId, CH.toStartOfHour($.Timestamp)]`).
[Inserting rows](./inserts.md#which-columns-have-defaults) covers how the insert type is used.

## Indexes and materialized views

A data-skipping index is `CH.index(name, expr, type, granularity?)`. A materialized view is
`CH.materializedView(name, { to, as })`, whose body is a query: an output column the target table
lacks, or of another type, is a type error.

```ts
const RequestsIndexed = CH.table("requests", {
	columns: { OrgId: CH.string, Timestamp: CH.dateTime, Route: CH.string, Status: CH.uint16 },
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Timestamp"],
	indexes: [CH.index("idx_status", ($) => $.Status, "set(100)")],
})

const RoutesHourly = CH.table("routes_hourly", {
	columns: { OrgId: CH.string, Hour: CH.dateTime, Route: CH.string, Requests: CH.uint64 },
	engine: CH.engine.summingMergeTree(),
	orderBy: ["OrgId", "Hour", "Route"],
})

const RoutesHourlyMv = CH.materializedView("routes_hourly_mv", {
	to: RoutesHourly,
	as: CH.from(RequestsIndexed)
		.select(($) => ({ OrgId: $.OrgId, Hour: CH.toStartOfHour($.Timestamp), Route: $.Route, Requests: CH.count() }))
		.groupBy("OrgId", "Hour", "Route"),
})
```

Postgres indexes are `PG.index` and `PG.uniqueIndex`, over column names or expressions, with
`where` for a partial index; foreign keys are `PG.foreignKey`. Both are covered in
[Schema and migrations](./migrations.md#postgres).

## External tables

Not every FROM target is a table this schema owns. A system table, a table function, a view, a
CTE, or a table another tool migrates is declared with `external: true`:

```ts
const One = CH.table("system.one", { external: true, columns: {} })
const Numbers = CH.table("numbers(10)", { external: true, columns: { number: CH.uint64 } })
const Stats = PG.table("pg_stat_user_tables", { external: true, columns: { relname: PG.text } })

CH.from(Numbers).select("number")
// SELECT __ch_source.number AS number FROM numbers(10) AS __ch_source
```

An external table carries no DDL, so `generate` never creates, alters, or drops it. Its name is
written verbatim as the FROM target (one that is not a plain identifier, like `numbers(10)`, gets
an alias to qualify its columns), it may have no columns (for a FROM that only anchors
constants), and it takes only `columns` and `tenantColumn`. Column options still drive insert
typing: `CH.column(CH.uint16, { default: 200 })` is optional on insert here too.

## Column types

A column type is an Effect `Schema` plus the database type name it stands for. That schema is
the single source of truth: the TypeScript column type is read off it, and `compile` folds the
selected columns' schemas into the row schema `decodeRows` validates against — see
[Decoding results](./decoding-results.md). Each dialect entry has its own; the ClickHouse ones
are below, the Postgres ones in [Postgres](./postgres.md#column-types).

The constructors are values, not calls (except the parameterised ones):

| Constructor           | ClickHouse type   | Decodes to          | From the wire             |
| --------------------- | ----------------- | ------------------- | ------------------------- |
| `CH.string`           | `String`          | `string`            | `string`                  |
| `CH.uint8`            | `UInt8`           | `number`            | number or quoted number   |
| `CH.uint16`           | `UInt16`          | `number`            | number or quoted number   |
| `CH.uint32`           | `UInt32`          | `number`            | number or quoted number   |
| `CH.uint64`           | `UInt64`          | `number`            | number or quoted number   |
| `CH.int64`            | `Int64`           | `number`            | number or quoted number   |
| `CH.int32`            | `Int32`           | `number`            | number or quoted number   |
| `CH.float64`          | `Float64`         | `number`            | number or quoted number   |
| `CH.bool`             | `Bool`            | `boolean`           | `true`/`false` or `1`/`0` |
| `CH.dateTime`         | `DateTime`        | `DateTime.Utc`      | `YYYY-MM-DD hh:mm:ss`     |
| `CH.dateTime64`       | `DateTime64`      | `DateTime.Utc`      | with a fractional part    |
| `CH.dateTimeString`   | `DateTime`        | `string`            | unparsed, as sent         |
| `CH.dateTime64String` | `DateTime64`      | `string`            | unparsed, as sent         |
| `CH.map(k, v)`        | `Map(K, V)`       | `Record<string, V>` | object                    |
| `CH.array(e)`         | `Array(E)`        | `ReadonlyArray<E>`  | array                     |
| `CH.nullable(t)`      | `Nullable(T)`     | `T \| null`         | value or `null`           |
| `CH.untyped(sql)`     | whatever you name | `unknown`           | unvalidated               |

Three wrappers change only the DDL, never how a column reads back:
`CH.lowCardinality(t)` (`LowCardinality(T)`; inside `nullable` it renders
`LowCardinality(Nullable(T))`), `CH.simpleAggregateFunction("sum", t)`
(`SimpleAggregateFunction(sum, T)`), and `CH.precision(CH.dateTime64String, 9)` (`DateTime64(9)`).

Column types, functions, and the query builder share the one `CH` namespace, so a schema module
and a query module import the same thing.

_(Backed by `docs/tables-and-types.md > Column types come from the dialect entry`.)_

Two of those deserve a note.

**64-bit integers.** ClickHouse's `FORMAT JSON` quotes them, a client that sets
`output_format_json_quote_64bit_integers=0` gets them bare, and a gateway
that refuses `output_format_json_quote_64bit_integers=0` quotes them regardless. Every integer
type accepts both and decodes to a `number` — which also means a `UInt64` above `2^53` cannot
survive: select `CH.toString($.Id)` while leaving the actual table column declared `CH.uint64`.
The resulting expression has a string codec; see the [ID recipe](./recipes.md#preserve-large-integer-ids).

**DateTimes.** The parsed codecs interpret zone-less strings such as `2026-05-24 14:30:00`
as UTC. ClickHouse does **not** guarantee that all timestamp strings are UTC: text output follows
the column/server timezone. Use UTC columns or normalize the selected expression to UTC before
using `CH.dateTime` / `CH.dateTime64`. For an unchanged wire string, use `CH.dateTimeString` /
`CH.dateTime64String`. See [ClickHouse DateTime timezones](https://clickhouse.com/docs/reference/data-types/datetime).

**Numeric validation.** Built-in numeric codecs accept finite numbers and quoted finite numbers.
They do not enforce each ClickHouse integer's sign, bit width, safe-integer range, or integrality.
Use schema checks through `CH.custom` when your application needs those constraints; `param.int`
separately requires a safe integer. A successful decode does not prove an unsafe large number
retained precision.

Arithmetic and aggregation can overflow even when their inputs are finite. ClickHouse JSON
represents infinity and NaN as `null`, so `sum`, `sumIf`, `toFloat64OrZero`, `+`, `-`, and `*`
decode that `null` as `NaN` when the result is not SQL Nullable. `toFloat64OrZero` returns zero for an invalid parse, but strings such as
`Inf`, `NaN`, and `1e400` successfully parse to nonfinite numbers.

When built-in `DateTime` and `DateTime64` codecs are combined by conditionals, arrays, or
unions, result encoding prefers `DateTime64` and retains milliseconds. This also works
through nullable and array wrappers. Custom codecs retain their declared encoding behavior;
provide an explicit result schema when different custom transforms need a particular encoding.

## `InferTS`

`InferTS<ColType>` maps a column type to its TypeScript type. You rarely need it directly —
`select` already infers output rows — but it is exported for writing your own helpers:

```ts
import type { InferTS } from "@maple-dev/effect-orm/clickhouse"

type Ms = InferTS<typeof CH.uint64> // number
```

`InferEncoded<ColType>` is its counterpart — the wire type the schema decodes _from_. For a whole
table, `SelectRowOf<typeof Events>` is the decoded row and `InsertRowOf<typeof Events>` the row an
insert takes.

Related utilities: `ColumnDefs` (the shape of a `columns` record), `OutputToColumnDefs`
(converts a query's output row back into column defs, used by `fromQuery`), and
`NullableColumnDefs` (what `leftJoin` applies to the joined side).

## Map columns

`Map` columns get a `.get(key)` accessor that compiles to ClickHouse's bracket syntax:

```ts
const query = CH.from(Events)
	.select(($) => ({ method: $.Attributes.get("http.method") }))
	.where(($) => [$.OrgId.eq("org_123")])

// SELECT events.Attributes['http.method'] AS method FROM events WHERE events.OrgId = 'org_123'
```

`.get()` yields the map's _value_ type — `Expr<string>` for a `Map(String, String)`, `Expr<number>` for a `Map(String, UInt64)`. For the other map operations — `mapContains`,
`mapKeys`, `mapValues`, `mapGet`, `mapLiteral` — see the
[API reference](./reference.md#map).

_(Backed by `docs/tables-and-types.md > Reading a Map column`.)_

## Aliasing a table

`from()` takes an optional alias, which qualifies every column reference. You need this as
soon as a join introduces ambiguity:

```ts
CH.from(Events, "e") // FROM events AS e, columns emit as e.Name
```

See [Joins and subqueries](./joins-and-subqueries.md).

`CH.dateTime64` preserves milliseconds when encoding `Date`/`DateTime.Utc` comparison bounds
and decoded rows. JavaScript timestamps have millisecond precision; use `CH.dateTime64String`
when forwarding microseconds or nanoseconds unchanged. `CH.dateTime` encodes whole seconds.

## Types not in the built-in list

`CH.custom(sqlType, schema)` models types such as UUID, LowCardinality, enums, or decimals using
their JSON representation. Match your existing database schema rather than redesigning the
physical table to fit this library's constructors. For a `LowCardinality(String)` column, for
example, `CH.custom("LowCardinality(String)", Schema.String)` decodes the ordinary string it emits.

## Branded columns

`brand(type, schema)` narrows a column type with an Effect schema: a branded id, a literal
union, a refined number. It keeps the base type's SQL type and wire codec, so `PG.brand(PG.int8,
Cents)` still reads the string node-postgres sends, and wraps like any type:
`nullable(brand(...))`, `array(brand(...))`. Both entries have it: `CH.brand`, `PG.brand`.

```ts title="branded-columns.ts"
import { Schema } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"

const OrgId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("OrgId"))
const UserId = Schema.String.pipe(Schema.brand("UserId"))

// Declare the column type once; tables and params both use it.
const orgId = PG.brand(PG.text, OrgId)

const Dashboards = PG.table("dashboards", {
	columns: {
		org_id: orgId,
		id: PG.text,
		owner: PG.nullable(PG.brand(PG.text, UserId)),
	},
	primaryKey: ["org_id", "id"],
})

export type Dashboard = PG.SelectRowOf<typeof Dashboards>
// { readonly org_id: OrgId; readonly id: string; readonly owner: UserId | null }

export const byOrg = PG.from(Dashboards)
	.select("id", "owner")
	.where(($) => [$.org_id.eq(PG.param.of(orgId, "orgId"))])

export const compiled = PG.compileUnsafe(byOrg, { orgId: OrgId.make("org_1") })

declare const userId: typeof UserId.Type
// @ts-expect-error a UserId is not an OrgId
PG.from(Dashboards).select("id").where(($) => [$.org_id.eq(userId)])
```

A brand is strict everywhere it is written or compared:

- **Rows** decode to the brand, and `SelectRowOf<typeof table>` names the whole row.
- **Comparisons** (`eq`, `in_`, `between`, joins) take a value of the brand, a column of the same
  brand, or a param declared with the type: `PG.param.of(orgId, "orgId")`, whose value
  `compile` then requires to be an `OrgId`. A plain string, another brand, `param.string`, or an
  unbranded column is a type error.
- **Inserts and updates** take the brand, a param of it, or an expression of it.
- **Checks run both ways.** A row that fails the schema's checks is a decode error; a literal or
  param value that fails them is a `QueryBuilderError` from `compile`.

A literal union (`PG.brand(PG.text, Schema.Literals(["open", "closed"]))`) is not a brand: it
compares against any string, and the database checks the value.

`CH.custom("String", OrgId)` brands the same way, but replaces the wire codec with `OrgId` itself;
prefer `brand` over a built-in type whose codec does work (numbers, timestamps).

`CH.untyped(sqlType)` accepts an unknown field without validating it. Unlike `CH.untypedExpr`, it
supplies a `Schema.Unknown` codec, so other selected fields can still be validated. The unknown
field itself has no guarantee. Prefer a real custom codec where you know the wire representation.

`CH.aggregateState(fn, ...argumentTypes)` describes an opaque aggregate-state value passed from
an inner query into a matching merge function. It is not a decoder for inspecting state bytes.
See [Extending the DSL](./extending.md#a-column-type-of-your-own).
