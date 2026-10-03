# Running a compiled query

This package never touches the network. `compile` gives you a `CompiledQuery`: a SQL string, the
tenant scope it derived, and a decoder for the rows. Executing it is your client's job, and this
page is the missing half — the twenty lines that close the loop, with the two wire details the
column types already assume.

## A complete client example

For Node.js or Bun, install Effect's ClickHouse client separately. Use the same Effect 4
release as your `effect` dependency; this example is checked against `4.0.0`:

```sh
npm install effect@4.0.0 @effect/sql-clickhouse@4.0.0
```

This example reads five rows from ClickHouse's built-in `system.numbers` table. It creates no
schema and writes no data. Set `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, and
`CLICKHOUSE_PASSWORD` for your server; the defaults target a local server.

```ts title="run-query.ts"
import { ClickhouseClient } from "@effect/sql-clickhouse"
import { Config, Effect, Redacted } from "effect"
import * as CH from "@maple-dev/effect-orm"
import * as T from "@maple-dev/effect-orm/types"

const ClickHouseLive = ClickhouseClient.layerConfig({
	url: Config.String("CLICKHOUSE_URL").pipe(Config.withDefault("http://localhost:8123")),
	username: Config.String("CLICKHOUSE_USERNAME").pipe(Config.withDefault("default")),
	password: Config.Redacted("CLICKHOUSE_PASSWORD").pipe(
		Config.withDefault(Redacted.make("")),
		Config.map(Redacted.value),
	),
})

const program = Effect.gen(function* () {
	const client = yield* ClickhouseClient.ClickhouseClient
	const Numbers = CH.table("system.numbers", { number: T.uint64 })
	const query = CH.from(Numbers).select("number").limit(5)
	const compiled = yield* CH.compile(query, {})
	const wire = yield* client.unsafe<Record<string, unknown>>(compiled.sql).pipe(
		client.withClickhouseSettings({ max_execution_time: 30 }),
	)
	const rows = yield* compiled.decodeRows(wire)
	yield* Effect.log(rows) // [{ number: 0 }, ..., { number: 4 }]
})

Effect.runPromise(program.pipe(Effect.provide(ClickHouseLive)))
```

Run it with `bun run-query.ts` or your project's TypeScript runner. A connection failure here
is a client/server configuration issue; the offline example in [Getting started](./getting-started.md)
can still compile and decode without a server.

`Effect.runPromise` runs once at the script boundary. The client layer owns connection setup
and cleanup, including failure paths. In a long-running service, provide the layer at the
application boundary so requests share the client. The driver handles interruption and reports
SQL failures as `SqlError`.

`client.unsafe(compiled.sql)` executes the SQL string already produced by the builder. It does
not validate or escape arbitrary SQL; keep untrusted values in `CH.param` bindings. Leave result
name transforms disabled so aliases still match the compiled decoder.

`@effect/sql-clickhouse` wraps the official Node.js client. For Workers or other fetch-based
runtimes, use a runtime-compatible adapter such as `@clickhouse/client-web` with an Effect
integration. Keep database credentials on your server.
See the [Effect ClickHouse driver source](https://github.com/Effect-TS/effect/blob/main/packages/sql/clickhouse/src/ClickhouseClient.ts).

For a client that implements Effect's `SqlClient`, the opt-in
[`@maple-dev/effect-orm/database`](./database.md) entry point does this loop for you
(`Db.run(compiled)`), and adds transactions on Postgres.

## Formats and numeric precision

Leave `.format()` off the builder query. Effect's ClickHouse client requests `FORMAT JSON`
and unwraps its `data` array, so `yield* client.unsafe<Record<string, unknown>>(compiled.sql)` gives the rows directly.
There is no separate `result.json()` step.

If you use the official JavaScript client directly, request `format: "JSONEachRow"` and pass
its parsed row array to the decoder. A raw `FORMAT JSON` response is an envelope: pass its
`data` array, not the whole envelope. Consume each result body once.

You do not need `output_format_json_quote_64bit_integers: 0` for decoding: the numeric codecs
accept both quoted and unquoted numbers. Both decode into JavaScript `number`, so **neither
choice preserves arbitrary 64-bit integers**. For IDs, hashes, or exact large counters, select
`CH.toString($.Id)` and keep the result as a string. Do not relabel a numeric database column as
`T.string` without converting its SELECT expression. See the [lossless ID recipe](./recipes.md#preserve-large-integer-ids).

## Error boundaries

There are three independent failure stages:

| Stage                          | What failed                                                     | What to do                                                |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- |
| `CH.compile`                   | Missing or invalid parameter (`QueryBuilderError`)              | Validate inputs or fix the param bag.                     |
| `client.unsafe` | Connection, credentials, server SQL error, or response parsing  | Inspect the client error and server query ID.             |
| `compiled.decodeRows`          | Wire rows disagree with the schema (`CompiledQueryDecodeError`) | Inspect `rowIndex`, aliases, nullability, and wire types. |

Inside the program, compilation, execution, and decoding all use `yield*`, preserving their
typed errors. Handle them with Effect before the outer `Effect.runPromise` converts unhandled
failures to Promise rejections. Layer configuration can also fail with `ConfigError`.
See [handling compilation failures](./params-and-compilation.md#handling-compilation-failures).

`compiled.tenantScope` is metadata, not an execution gate. For tenant-scoped endpoints, check
it before sending SQL and derive tenant values from authenticated context. A correctly scoped
query for the wrong tenant is still unauthorized.

## Attaching `SETTINGS`

The query DSL has no `.settings()` method: query settings are an execution
concern, and the builder does not execute. Most clients take them out of band, which is what the
example above does.

When they have to travel _in the SQL_ — a gateway that forwards a statement verbatim, an endpoint that accepts one SQL string — the `/sql` subpath has the two functions for it:

```ts
import { parseStatement, withSettings } from "@maple-dev/effect-orm/sql"

const statement = withSettings(
	parseStatement(compiled.sql),
	"SETTINGS max_execution_time = 30, max_threads = 4",
)
statement.text // the body, then SETTINGS, then FORMAT
```

`parseStatement` splits a statement into `body` / `settings` / `format` and `renderStatement` (or
`.text`) puts it back together **in that order** — `SETTINGS` before `FORMAT`, which is the order
ClickHouse accepts and the inverse of what string concatenation gives you. It is total: any string
has a body, so a statement with no terminal clauses round-trips unchanged. `withFormat` is the
same edit for the format clause, and `ClickHouseStatementFromString` is the pair as a codec, for a
boundary that stores a statement as text but wants the parsed shape in hand.

Appending `SETTINGS …` to `compiled.sql` by hand is the thing to avoid: a query that already ends
in `FORMAT JSON` — anything built with `.format(…)` — produces a syntax error, and a body ending in
a `--` comment swallows whatever you appended.

_(Backed by `docs/running-queries.md > SETTINGS precede FORMAT whatever order you add them in`.)_

## Cost profiles, retries, tenancy

None of that is here on purpose. A `CompiledQuery` is a value: it can be cached, logged,
fingerprinted, or handed to a different executor per tenant, and every one of those policies
belongs to the application rather than the builder. What the builder guarantees is that the value
describes itself — its SQL, its tenant scope, and how its rows decode.

## Benchmark a query change

Use the [benchmarking guide](./benchmarking.md) to turn a query into a repeatable
workload, record a baseline, verify results, and compare read volume, memory, and
latency. The bundled `ch-bench` CLI handles execution and saved evidence. For an
automated optimization workflow, follow the [agent playbook](./benchmark-agent.md).
