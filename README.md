# @maple-dev/effect-orm

Type-safe ClickHouse and Postgres queries, result decoding, and reproducible benchmarks for Effect and TypeScript.

Formerly `@maple-dev/effect-clickhouse`.

[Read the documentation](https://effect-clickhouse.maple.dev) ·
[Getting started](./docs/getting-started.md) · [Recipes](./docs/recipes.md)

- **Schema-first** — a column type _is_ an Effect `Schema`, so a query compiles
  to its own row schema. `decodeRows` validates without you writing one, and the
  wire quirks (64-bit ints arriving quoted, tz-less DateTimes) are modelled once
  in the types rather than rediscovered per consumer.
- **Type-safe** — define a table once and the query builder infers column types,
  output row shapes, and join accessors. No stringly-typed columns.
- **Immutable & composable** — every builder method returns a new query; share
  and extend base queries without surprises.
- **ClickHouse-native** — first-class helpers for the functions you actually use
  (`quantile`, `toStartOfInterval`, `mapGet`, window functions, …) plus escape
  hatches (`rawExpr`, `rawCompiledQuery`) for anything not yet modeled.
- **Parameterised compilation** — compile to a SQL string with named params
  resolved and string literals escaped. A param with no value, or a value of the
  wrong kind, fails the compile instead of reaching the server.

Built on [Effect](https://effect.website) (peer dependency).

## Install

Install the package with its Effect 4 peer:

```bash
bun add @maple-dev/effect-orm "effect@^4.0.0"
```

See [Getting started](./docs/getting-started.md) for source builds and examples.

`effect` is a peer dependency. The recommended range `^4.0.0` allows
newer Effect 4 releases without opting into Effect 5. Effect 3 and the Effect 4
prereleases are incompatible.

## Quick start

One import per database. Each holds the whole query builder plus that database's column
types, functions, table definitions, and `compile`:

```ts
import * as CH from "@maple-dev/effect-orm/clickhouse"

// 1. Describe a table. The engine and sorting key are its DDL, for migrations.
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
	// Optional: name the column carrying row-level tenancy and every compiled
	// query reports whether it pinned it. See docs/tenant-scoping.md.
	tenantColumn: "OrgId",
})

// 2. Build a query
const query = CH.from(Events)
	.select(($) => ({
		name: $.Name,
		p95: CH.quantile(0.95)($.DurationMs),
		count: CH.count(),
	}))
	.where(($) => [
		$.OrgId.eq(CH.param.string("orgId")),
		$.Timestamp.gte(CH.param.dateTime("startTime")),
		CH.when(true, () => $.Name.like("checkout%")),
	])
	.groupBy("name")
	.orderBy(["count", "desc"])
	.limit(50)

// 3. Compile to SQL (params resolved, literals escaped)
const compiled = CH.compileUnsafe(query, {
	orgId: "org_123",
	startTime: "2026-01-01 00:00:00",
})

compiled.sql // -> SELECT events.Name AS name, quantile(0.95)(events.DurationMs) AS p95, ...
```

The same query against Postgres imports only `PG`. Params become `$1`, `$2`, and the functions
are Postgres's own:

```ts
import * as PG from "@maple-dev/effect-orm/postgres"

const Requests = PG.table("requests", {
	columns: {
		id: PG.column(PG.int8, { identity: "always" }),
		org_id: PG.text,
		route: PG.text,
		duration_ms: PG.int8,
		at: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	tenantColumn: "org_id",
})

const byRoute = PG.from(Requests)
	.select(($) => ({ route: $.route, count: PG.count(), p50: PG.percentileCont(0.5, $.duration_ms) }))
	.where(($) => [$.org_id.eq(PG.param.string("orgId"))])
	.groupBy("route")

PG.compileUnsafe(byRoute, { orgId: "org_123" }).parameters // -> ["org_123"]
```

A table that this schema does not own (a system table, a table function, a view) is declared
with `external: true` and no DDL: `CH.table("system.one", { external: true, columns: {} })`.
See [Tables and column types](./docs/tables-and-types.md).

## Decoding results

Run the SQL with your own ClickHouse client, then hand the rows back to
`decodeRows`. The row schema comes from the query itself — every column type is
a `Schema`, so the SELECT already describes its own rows:

```ts
import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Effect } from "effect"

const program = Effect.gen(function* () {
	const client = yield* ClickhouseClient.ClickhouseClient
	const compiled = yield* CH.compile(query, {
		orgId: "org_123",
		startTime: "2026-01-01 00:00:00",
	})
	compiled.rowSchemaSource // "derived"
	const wire = yield* client.unsafe<Record<string, unknown>>(compiled.sql)
	return yield* compiled.decodeRows(wire)
	// -> ReadonlyArray<{ name: string; p95: number | null; count: number }>
})
```

Provide Effect's `ClickhouseClient` layer when running `program`; the builder brings no client.
[Running a query](./docs/running-queries.md) has the complete setup, resource lifetime, and wire settings.

`count()` is a `UInt64`, which ClickHouse's `FORMAT JSON` quotes and a gateway with
`output_format_json_quote_64bit_integers=0` does not — the
column type accepts either and decodes both to a JavaScript number.

Pass a `rowSchema` explicitly to **narrow** what the builder inferred (a `String`
column as a literal union, say); it wins over the derived one. If any selected
expression has no type to read — an `untypedExpr`, a `defineUntypedFn` —
nothing is derived, `rowSchemaSource` is `"none"`, and `decodeRows` degrades to
a pass-through rather than pretending.

Compilation itself is Effect-returning: a param with no value, or a value the
column cannot hold, is a `QueryBuilderError` in the error channel rather than a
throw, so a route can `catchTag` it instead of crashing. `compileUnsafe` is the
throwing variant, for a fixture or a catalog sweep where a query that will not
compile should fail loudly. A bug inside a callback stays a defect either way.

`decodeFirstRow` is the point-lookup variant, returning `Option<Output>` so you
don't hand-roll `rows[0] ?? null`. Both fail with `CompiledQueryDecodeError`,
which carries the offending `rowIndex`. When a query does derive nothing,
`untypedColumns` names the selected aliases responsible.

`encodeRows` runs the same schema backwards, turning decoded rows into the wire
shape ClickHouse sent. That is what lets a service hold the good value in memory
and still emit the bytes its own clients parse: a `DateTime` column decoded to a
`DateTime.Utc` re-encodes to `'YYYY-MM-DD hh:mm:ss'`, not to ISO-8601, because
the column's codec is the authority on both directions.

## Documentation

Full guides live in [`docs/`](./docs/README.md):

| Guide                                                      | What it covers                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| [Getting started](./docs/getting-started.md)               | Install, define a table, build → compile → decode               |
| [Tables and column types](./docs/tables-and-types.md)      | `table()`, column options, external tables, column types        |
| [Building queries](./docs/queries.md)                      | `select`, `where`, `groupBy`, `orderBy`, `limit`, immutability  |
| [Expressions and conditions](./docs/expressions.md)        | Comparisons, arithmetic, optional predicates, aggregates        |
| [Joins and subqueries](./docs/joins-and-subqueries.md)     | The join family, `fromQuery`, correlated subqueries             |
| [Unions and CTEs](./docs/unions-and-ctes.md)               | `unionAll`, `fromUnion`, `withCTE`                              |
| [Inserting rows](./docs/inserts.md)                        | `insertInto`, the insert row type, `DEFAULT`, binding            |
| [Updating and deleting](./docs/updates-and-deletes.md)     | `update`, `deleteFrom`, `allRows`, ClickHouse mutations         |
| [Params and compilation](./docs/params-and-compilation.md) | `param.*`, how values reach the SQL, `CompiledQuery`            |
| [Decoding results](./docs/decoding-results.md)             | `rowSchema`, `decodeRows`, decode errors                        |
| [Running a query](./docs/running-queries.md)               | Executing the SQL with a real client, wire settings, `SETTINGS` |
| [Tenant scoping](./docs/tenant-scoping.md)                 | `tenantColumn`, what marks a query scoped, `crossTenant()`      |
| [Postgres](./docs/postgres.md)                             | The Postgres dialect, its column types and functions            |
| [Schema and migrations](./docs/migrations.md)              | DDL from `table`, `effect-orm generate`, applying migrations    |
| [Extending the DSL](./docs/extending.md)                   | `defineFn`, raw escape hatches, handwritten SQL                 |
| [API reference](./docs/reference.md)                       | Full export catalog by module, plus error types                 |

Named complete examples are extracted and checked by
[`scripts/check-doc-examples.mjs`](./scripts/check-doc-examples.mjs). Focused query and decoding
regressions live in [`src/docs-examples.test.ts`](./src/docs-examples.test.ts).

## Entry points

| Import                              | Contents                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@maple-dev/effect-orm/clickhouse`  | Everything for ClickHouse: the query builder (`from`, `param`, `insertInto`, …), column types (`string`, `uint64`, `map`, …), functions (`count`, `quantile`, …), `table` with its DDL, and `compile`. |
| `@maple-dev/effect-orm/postgres`    | The same for Postgres: the builder, Postgres column types (`text`, `int8`, `timestamptz`, …) and functions, `table` with keys, indexes and foreign keys, and a `compile` for Postgres. |
| `@maple-dev/effect-orm/expr`        | Kitchen-sink namespace: every expression helper plus all ClickHouse functions under their raw names (`min_`, `toString_`, `toStartOfInterval`, `dynamicColumn`, …). |
| `@maple-dev/effect-orm/sql`         | The low-level `SqlFragment` AST (`raw`, `ident`, `compile`, …) for hand-rolling fragments.                                                                    |
| `@maple-dev/effect-orm/tinybird`    | Tinybird datasources and materialized views, SDK-compatible, that are also query tables; `buildProject` writes the datafiles. See [Tinybird](./docs/tinybird.md). |
| `@maple-dev/effect-orm/schema`      | Migration tooling over `table` values: DDL rendering, snapshots, the schema diff. Pure.                                                                       |
| `@maple-dev/effect-orm/kit`, `/migrate` | `effect-orm generate` and `check`; applying migrations through a driver you provide. See [Schema and migrations](./docs/migrations.md).                  |
| `@maple-dev/effect-orm/database`    | `Database` over your `SqlClient`: `run`, `execute`, `transaction` with retry.                                                                                  |

## Extending with custom functions

```ts
import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"

// Declare any ClickHouse function not already wrapped. The second argument is
// the ClickHouse type it returns — required, because that is what lets a query
// using it still derive its row schema.
const toStartOfFiveMinute = CH.defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>("toStartOfFiveMinute", CH.dateTime)

// When the result type depends on the arguments — `min`, `argMax`, `coalesce`,
// `arrayJoin` all hand back one of their inputs — pass a rule instead:
// `sameAs(i)`, `firstTyped()`, `elementOf(i)`, `arrayOfArg(i)`.
const anyLast = CH.defineFn<[CH.Expr<string>], string>("anyLast", CH.sameAs(0))
```

## Validation

`bun run test` also extracts the named complete Markdown examples, typechecks them against
the public package exports, and runs the offline examples. Set `CLICKHOUSE_DOCS_LIVE=1` to
run the client example too, with `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, and
`CLICKHOUSE_PASSWORD` for its connection. Build the package before running these checks.

Run `bun run build`, `bun run typecheck`, and `bun run test` from this package. Tests include regressions for
nullable results, UNION column alignment, tenant scoping, custom parameters, and DateTime64 precision.
To include the live ClickHouse cases, set `EFFECT_ORM_CLICKHOUSE_URL` and, if needed,
`EFFECT_ORM_CLICKHOUSE_USER` and `EFFECT_ORM_CLICKHOUSE_PASSWORD`. They use only SELECTs and CTEs.

Use `bun run test:release` before publishing: it requires a live endpoint and checks the
build, types, tests, docs, and an isolated tarball consumer. `prepublishOnly` enforces
this check. See [Testing and release checks](./docs/testing.md) for the coverage manifest
and pinned ClickHouse version matrix.

## License

MIT

## Query benchmarks

The optional `@maple-dev/effect-orm/benchmark` entry point and bundled
`ch-bench` CLI measure real queries, compare fixed workloads, and save evidence.
See [Benchmarking](docs/benchmarking.md) and the
[agent playbook](docs/benchmark-agent.md). The `/clickhouse` and `/postgres` builders remain driver-free.
