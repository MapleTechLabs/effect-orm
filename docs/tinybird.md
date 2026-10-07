# Tinybird datasources

`@maple-dev/effect-orm/tinybird` defines Tinybird datasources and materialized views with the
call shapes of `@tinybirdco/sdk` (`defineDatasource`, `column`, `t`, `engine`,
`defineMaterializedView`, `node`, `InferRow`), so a project moves over by changing its import.

What it adds over the SDK: a datasource **is** a ClickHouse `table` with its DDL. The query
builder takes it directly, `renderSchema` writes it for a plain ClickHouse server, and the
datafiles Tinybird deploys come from the same definition.

```ts
import * as CH from "@maple-dev/effect-orm/clickhouse"
import { buildProject, column, defineDatasource, engine, t } from "@maple-dev/effect-orm/tinybird"

export const events = defineDatasource("events", {
	schema: {
		OrgId: column(t.string().lowCardinality().brand(OrgId), { jsonPath: "$.org_id" }),
		Timestamp: t.dateTime64(9),
		Kind: t.string().lowCardinality().default("click"),
	},
	engine: engine.mergeTree({ sortingKey: ["OrgId", "Timestamp"], ttl: "toDate(Timestamp) + INTERVAL 30 DAY" }),
	tenantColumn: "OrgId",
})

CH.from(events).select("Kind").where(($) => [$.OrgId.eq(CH.param.of(events.columns.OrgId, "orgId"))])

const { datasources, pipes } = buildProject(await import("./datasources"), await import("./views"))
```

- `t.*` builds a ClickHouse column type plus its datafile modifiers. `.lowCardinality()`,
  `.nullable()`, `.default(v)`, `.defaultExpr(sql)`, `.codec(c)` and `.jsonPath(p)` behave as in
  the SDK; `.brand(schema)` narrows the query column and leaves the ingested row alone.
- `DateTime` and `DateTime64` columns read back as the string ClickHouse sends, which is also
  what `InferRow` types them as. `InferRow` types a `Map` as a `Record`, the JSON Tinybird ingests.
- `buildProject(...modules)` writes every datasource and view a module exports, in export order.
  Its output matches `@tinybirdco/sdk` 0.0.84 byte for byte for the features here: schemas with
  json paths, defaults and codecs, the MergeTree family and `Null` engines, indexes, forward
  queries, and materialized views. Kafka, S3, tokens, endpoints and copy pipes are not ported.
- Materialized view SQL is a string. For a view checked against its target's columns, use
  `CH.materializedView` from `/clickhouse`.
- A materialized view is also a schema view, so `effect-orm generate` migrates it with the
  datasources. It takes exactly one node, without template syntax (`{{ }}`, `{% %}`): that node's
  SQL is the view body on a plain ClickHouse server.
