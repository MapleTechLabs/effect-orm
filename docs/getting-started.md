# Getting started

Build and decode your first query without connecting to a database. Then follow
[Running a query](./running-queries.md) to execute one against ClickHouse.

## Installation and compatibility

This is an ESM-only TypeScript package built on **Effect 4**. You do not need an
Effect application: `Effect.runPromise` lets you use it from ordinary async code.
These examples are checked against Effect `4.0.0` and the builder in this repository.
The package declares `effect ^4.0.0` as a peer dependency; Effect 3 is incompatible.

Install from npm with its Effect 4 peer dependency:

```sh
npm install @maple-dev/effect-orm "effect@^4.0.0"
```

The recommended range accepts stable Effect 4 releases. It excludes Effect 3, the
Effect 4 prereleases (which used `effect/unstable/*` module paths), and Effect 5. The exact version above records the
version used to check these examples; it is not an installation pin.

To build from source instead:

```sh
git clone https://github.com/MapleTechLabs/effect-orm.git
cd effect-orm
bun install --frozen-lockfile
bun run build
bun pm pack
```

Install the resulting `.tgz` into your own project with its peer dependency:

```sh
npm install /absolute/path/to/the-generated-package.tgz "effect@^4.0.0"
```

Keep the Effect 4 range explicit when installing. Use an ESM project
(`"type": "module"` in `package.json`)
and a TypeScript runner such as Bun for the `.ts` files below. A database client is a
separate dependency, needed only when you execute SQL.

## Pick your database

Each database has one entry that holds everything for it: the query builder, its column types,
its functions, table definitions, and a `compile` that writes its dialect.

```ts
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
```

The builder (`from`, `param`, `and`, `insertInto`, …) is the same in both. Import the one for the
database you query; the examples below use ClickHouse, and [Postgres](./postgres.md) shows the
same flow with `PG`.

## A complete first example

Save this as `quick-start.ts` and run `bun quick-start.ts`. It builds SQL and decodes a sample
wire response; it does not need a server, credentials, or an existing table.

```ts title="quick-start.ts"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"

const Events = CH.table("events", {
	columns: {
		Name: CH.string,
		DurationMs: CH.uint64,
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["Name"],
})

const query = CH.from(Events)
	.select(($) => ({
		name: $.Name,
		p95: CH.quantile(0.95)($.DurationMs),
		count: CH.count(),
	}))
	.where(($) => [$.DurationMs.gte(CH.param.int("minDurationMs"))])
	.groupBy("name")
	.orderBy(["count", "desc"], ["name", "asc"])
	.limit(50)

export const compiled = await Effect.runPromise(CH.compile(query, { minDurationMs: 100 }))
console.log(compiled.sql)
console.log(compiled.rowSchemaSource) // "derived"

export const rows = await Effect.runPromise(compiled.decodeRows([{ name: "checkout", p95: 420, count: "3" }]))
console.log(rows) // [{ name: "checkout", p95: 420, count: 3 }]
```

The generated SQL is:

```sql
SELECT events.Name AS name, quantile(0.95)(events.DurationMs) AS p95, count() AS count
FROM events
WHERE events.DurationMs >= 100
GROUP BY name
ORDER BY count DESC, name ASC
LIMIT 50
```

`table()` describes a table; compiling a query does not create it or check that the database has
those columns. The `engine` and `orderBy` are what [migrations](./migrations.md) turn into
`CREATE TABLE`; the query builder only reads the name and `columns`. A MergeTree table must
declare `orderBy` (`[]` for `ORDER BY tuple()`), so a definition that could not become DDL fails
when the module loads, not at deploy time.

The keys returned by `select` become both SQL aliases and result properties. This query infers
`{ name: string; p95: number | null; count: number }`: ClickHouse can return JSON `null` for an
aggregate with a non-finite result.

`compile` returns an Effect that must be run. Its parameters are validated and escaped into
the SQL string at compilation time. They are **not** ClickHouse server-side placeholders.
Use `compileUnsafe(query, params)` if synchronous throwing fits your caller instead.

The result schema is derived from the typed SELECT, so you do not need to write a second schema.
`count: "3"` becomes `count: 3`. Selecting an untyped expression can disable that derivation;
[Decoding results](./decoding-results.md) explains how to detect and repair it.

## Shared tables used by the guides

The later guides use `CH`, `Effect`, and these illustrative tables. Save this as `schema.ts`
when trying their query snippets. Their table and column names are case-sensitive contracts
with your own database. Replace them with your real schema before executing.

```ts title="schema.ts"
import * as CH from "@maple-dev/effect-orm/clickhouse"

export const Events = CH.table("events", {
	columns: {
		OrgId: CH.string,
		Name: CH.string,
		Timestamp: CH.dateTime,
		DurationMs: CH.uint64,
		Attributes: CH.map(CH.string, CH.string),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Timestamp"],
	tenantColumn: "OrgId",
})

export const Services = CH.table("services", {
	columns: {
		OrgId: CH.string,
		Name: CH.string,
		Team: CH.string,
	},
	engine: CH.engine.replacingMergeTree(),
	orderBy: ["OrgId", "Name"],
	tenantColumn: "OrgId",
})
```

Tenant scoping is optional. The first example has no tenant column; the shared tables do.
Declaring `tenantColumn` adds scope analysis, not a WHERE clause or an authorization policy.
Always supply the tenant from your trusted application context. See [Tenant scoping](./tenant-scoping.md).

## Where to next

- [Running a query](./running-queries.md): a complete client example using `system.numbers`, with no table setup.
- [Recipes](./recipes.md): time buckets, optional filters, aggregate filters, pagination, and lossless IDs.
- [Tables and column types](./tables-and-types.md): model your actual schema and wire formats.
- [Postgres](./postgres.md): the same builder against Postgres, from `@maple-dev/effect-orm/postgres`.
- [Troubleshooting](./troubleshooting.md): installation, compilation, decoding, and unexpected results.
