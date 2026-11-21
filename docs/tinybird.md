# Tinybird datasources

`@maple-dev/effect-orm/tinybird` defines Tinybird datasources and materialized views with the
call shapes of `@tinybirdco/sdk` (`defineDatasource`, `column`, `t`, `engine`,
`defineMaterializedView`, `node`, `InferRow`), so a project moves over by changing its import.

What it adds over the SDK: a datasource **is** a ClickHouse `table` with its DDL. The query
builder takes it directly, `renderSchema` writes it for a plain ClickHouse server, and the
datafiles Tinybird deploys come from the same definition.

## A complete project

```ts title="tinybird-project.ts"
import { Effect, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as S from "@maple-dev/effect-orm/schema"
import {
	buildProject,
	column,
	defineDatasource,
	defineMaterializedView,
	engine,
	node,
	t,
	type InferRow,
} from "@maple-dev/effect-orm/tinybird"

const OrgId = Schema.String.pipe(Schema.brand("OrgId"))

export const events = defineDatasource("events", {
	description: "Raw events.",
	schema: {
		OrgId: column(t.string().lowCardinality().brand(OrgId), { jsonPath: "$.org_id" }),
		Timestamp: t.dateTime64(3),
		Kind: t.string().lowCardinality().default("click"),
		DurationMs: t.uint32(),
		Body: t.string().codec("ZSTD(1)"),
	},
	engine: engine.mergeTree({
		partitionKey: "toYYYYMM(Timestamp)",
		sortingKey: ["OrgId", "Timestamp"],
		ttl: "toDate(Timestamp) + INTERVAL 30 DAY",
	}),
	tenantColumn: "OrgId",
})

export const eventsHourly = defineDatasource("events_hourly", {
	jsonPaths: false, // only the view writes it
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		Calls: t.simpleAggregateFunction("sum", t.uint64()),
	},
	engine: engine.aggregatingMergeTree({ sortingKey: ["OrgId", "Hour"] }),
})

export const eventsHourlyMv = defineMaterializedView("events_hourly_mv", {
	datasource: eventsHourly,
	nodes: [
		node({
			name: "rollup",
			sql: "SELECT OrgId, toStartOfHour(Timestamp) AS Hour, count() AS Calls FROM events GROUP BY OrgId, Hour",
		}),
	],
})

// The JSON row Tinybird ingests: { OrgId: string; Timestamp: string; Kind: string; DurationMs: number; Body: string }
export type EventRow = InferRow<typeof events>

// A datasource is a ClickHouse table: query it with the builder.
export const slow = CH.compileUnsafe(
	CH.from(events)
		.select(($) => ({ kind: $.Kind, count: CH.count() }))
		.where(($) => [$.OrgId.eq(CH.param.of(events.columns.OrgId, "orgId")), $.DurationMs.gte(500)])
		.groupBy("kind"),
	{ orgId: OrgId.make("org_1") },
)
// slow.sql: SELECT events.Kind AS kind, count() AS count FROM events
//           WHERE events.OrgId = 'org_1' AND events.DurationMs >= 500 GROUP BY kind

// The datafiles to deploy to Tinybird, one per datasource and view.
export const project = buildProject({ events, eventsHourly, eventsHourlyMv })

// The same definitions as DDL for a plain ClickHouse server.
export const ddl = S.entitiesOf([events, eventsHourly, eventsHourlyMv]).pipe(Effect.map(S.renderSchema))
```

`project` succeeds with `{ datasources, pipes }`, each a list of `{ name, content }`. The
`events` datafile is:

```text
DESCRIPTION >
    Raw events.

SCHEMA >
    OrgId LowCardinality(String) `json:$.org_id`,
    Timestamp DateTime64(3) `json:$.Timestamp`,
    Kind LowCardinality(String) `json:$.Kind` DEFAULT 'click',
    DurationMs UInt32 `json:$.DurationMs`,
    Body String `json:$.Body` CODEC(ZSTD(1))

ENGINE "MergeTree"
ENGINE_PARTITION_KEY "toYYYYMM(Timestamp)"
ENGINE_SORTING_KEY "OrgId, Timestamp"
ENGINE_TTL "toDate(Timestamp) + INTERVAL 30 DAY"
```

and the view's pipe:

```text
NODE rollup
SQL >
    SELECT OrgId, toStartOfHour(Timestamp) AS Hour, count() AS Calls FROM events GROUP BY OrgId, Hour

TYPE MATERIALIZED
DATASOURCE events_hourly
```

The package writes no files. Write them where your Tinybird project keeps them:

```ts
const { datasources, pipes } = await Effect.runPromise(buildProject(await import("./datasources"), await import("./views")))
for (const file of datasources) await writeFile(`tinybird/datasources/${file.name}.datasource`, file.content + "\n")
for (const file of pipes) await writeFile(`tinybird/pipes/${file.name}.pipe`, file.content + "\n")
```

## Column types

`t.*` builds a ClickHouse column type plus its datafile modifiers:

| Builder | ClickHouse type | `InferRow` type |
| --- | --- | --- |
| `t.string()` | `String` | `string` |
| `t.bool()` | `Bool` | `boolean` |
| `t.uint8()`, `t.uint16()`, `t.uint32()`, `t.uint64()`, `t.int32()`, `t.int64()`, `t.float64()` | the same | `number` |
| `t.dateTime()`, `t.dateTime64(precision = 3)` | `DateTime`, `DateTime64(p)` | `string` |
| `t.array(type)` | `Array(T)` | an array of the element's row type |
| `t.map(key, value)` | `Map(K, V)` | a `Record`, the JSON Tinybird ingests |
| `t.simpleAggregateFunction(fn, type)` | `SimpleAggregateFunction(fn, T)` | the type's row type |
| `t.aggregateFunction(fn, ...types)` | `AggregateFunction(fn, T, ...)`; `fn` is written as given, so it may carry parameters | the first type's row type |

Other SDK types are not ported; a schema that needs one does not typecheck.

- `.lowCardinality()`, `.nullable()`, `.default(v)`, `.defaultExpr(sql)`, `.codec(c)` and
  `.jsonPath(p)` behave as in the SDK. `.default` and `.defaultExpr` let an insert leave the
  column out.
- `.brand(schema)` narrows the query column and leaves the ingested row alone: `OrgId` above is
  a branded string in queries and a plain `string` in `InferRow`.
- `column(type, { jsonPath })` sets the JSON path beside the type, as the SDK does. Without one,
  a column reads `$.<name>`.
- `DateTime` and `DateTime64` columns read back as the string ClickHouse sends, which is also
  what `InferRow` types them as.

## Datasource options

| Option | |
| --- | --- |
| `schema` | The columns, each a `t.*` type or a `column(...)` |
| `engine` | One of `engine.mergeTree`, `replacingMergeTree` (`ver`, `isDeleted`), `summingMergeTree` (`columns`), `aggregatingMergeTree`, `collapsingMergeTree` (`sign`), `versionedCollapsingMergeTree` (`sign`, `version`), each with `sortingKey` and optional `partitionKey`, `primaryKey`, `ttl` and `settings`; or `engine.null()`. Defaults to a `MergeTree` ordered by `tuple()` |
| `indexes` | `[{ name, expr, type, granularity }]`, data-skipping indexes |
| `tenantColumn` | The column that carries row-level tenancy; see [Tenant scoping](./tenant-scoping.md) |
| `description`, `forwardQuery` | Written to the datafile only |
| `jsonPaths: false` | Leaves the `json:` paths out, for a datasource only views write to |

A key is a column list or one string; `"OrgId, toStartOfHour(Timestamp)"` is split at its
top-level commas for the ClickHouse DDL and written as given in the datafile.

## Materialized views

`defineMaterializedView(name, { datasource, nodes, description?, deploymentMethod? })` writes a
pipe with `TYPE MATERIALIZED` into `datasource`. `deploymentMethod: "alter"` adds
`DEPLOYMENT_METHOD alter`, which changes the view in place. Its SQL is a string. For a view
checked against its target's columns, use `CH.materializedView` from `/clickhouse`.

A materialized view is also a schema view, so `effect-orm generate` migrates it with the
datasources. It takes exactly one node, without template syntax (`{{ }}`, `{% %}`): that node's
SQL is the view body on a plain ClickHouse server. Pipe and node names must be plain
identifiers.

## Building the project

`buildProject(...modules)` writes every datasource and view a module exports, in export order,
as an Effect that fails with a `SchemaDefinitionError` when any definition recorded a problem
(a bad index granularity, a view with two nodes). A module is any record, so a module namespace
(`await import("./datasources")`) and a plain object both work; other values in it are skipped,
and a definition exported twice is written once. `generateDatasource` and `generatePipe` write
one datafile without the checks.

The output matches `@tinybirdco/sdk` 0.0.84 byte for byte for the features here: schemas with
json paths, defaults and codecs, the MergeTree family and `Null` engines, indexes, forward
queries, and materialized views. Kafka, S3, tokens, endpoints and copy pipes are not ported.
