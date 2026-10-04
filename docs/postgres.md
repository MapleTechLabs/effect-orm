# Postgres

The same builder writes Postgres SQL. Queries, params, tenant scoping and row decoding work
as they do for ClickHouse; the `/postgres` entry point supplies the parts that differ: column
types whose codecs read what Postgres drivers send, functions spelled the Postgres way, and a
`compile` that defaults to the Postgres dialect.

```ts title="postgres-quickstart.ts"
import { PGlite } from "@electric-sql/pglite"
import { Effect } from "effect"
import * as CH from "@maple-dev/effect-orm"
import * as PG from "@maple-dev/effect-orm/postgres"

const Requests = CH.table(
	"requests",
	{ OrgId: PG.text, Route: PG.text, DurationMs: PG.int8, At: PG.timestamptz },
	{ tenantColumn: "OrgId" },
)

const query = CH.from(Requests)
	.select(($) => ({
		route: $.Route,
		count: PG.count(),
		slow: PG.countIf($.DurationMs.gte(500)),
		p50: PG.percentileCont(0.5, $.DurationMs),
	}))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.At.gte(CH.param.dateTime("since"))])
	.groupBy("route")
	.orderBy(["count", "desc"])

export const compiled = PG.compileUnsafe(query, { orgId: "org_1", since: new Date("2026-01-01T00:00:00Z") })
// compiled.sql:        ... WHERE "requests"."OrgId" = $1 AND "requests"."At" >= $2 ...
// compiled.parameters: ["org_1", "2026-01-01T00:00:00.000Z"]

const db = new PGlite()
await db.exec(`
	CREATE TABLE requests ("OrgId" text, "Route" text, "DurationMs" int8, "At" timestamptz);
	INSERT INTO requests VALUES
		('org_1', '/checkout', 120, '2026-01-01T10:00:00Z'),
		('org_1', '/checkout', 900, '2026-01-01T10:01:00Z'),
		('org_1', '/search', 40, '2026-01-01T10:02:00Z');
`)
const result = await db.query<Record<string, unknown>>(compiled.sql, [...compiled.parameters])
export const rows = await Effect.runPromise(compiled.decodeRows(result.rows))
// [{ route: "/checkout", count: 2, slow: 1, p50: 510 }, { route: "/search", count: 1, slow: 0, p50: 40 }]
await db.close()
```

`PGlite` stands in for any driver that takes `(sql, values)`: node-postgres, postgres.js, or
`@effect/sql-pg`'s `unsafe`. The builder never runs the query.

## What the dialect changes

| | ClickHouse (`clickhouseDialect`) | Postgres (`postgresDialect`) |
| --- | --- | --- |
| Identifiers | Bare: `events.OrgId` | Quoted: `"events"."OrgId"` |
| String literals | Backslash escapes: `'it\'s'` | Doubled quotes: `'it''s'` |
| Params | Written in as literals; `parameters` empty | Bound as `$1`, `$2`, … in `parameters` |
| `param.bool` | `1` / `0` | `true` / `false` |
| `param.dateTime` | `'2026-01-01 00:00:00'` (UTC, zoneless) | `'2026-01-01T00:00:00.000Z'` |
| `GROUP BY` keys | Select aliases | Select-list positions (`GROUP BY 1`) |
| Wrapped union | `SELECT * FROM (…)` | `SELECT * FROM (…) AS "__union"` |
| `.format()` | `FORMAT JSON` | Refused at compile time |

Postgres reads a bare name in `GROUP BY` as an input column before a select alias, so
`select({ Service: lower($.Service) }).groupBy("Service")` would group by the raw column. Writing
the position instead keeps ClickHouse's meaning.

Every string that reaches the SQL as a literal is escaped for Postgres. A value that spells the
param marker `__PARAM_` is written as an `E'…'` string with the marker hex-escaped, and a
literal that still contained it would fail the compile with `InvalidLiteral`.

## Column types

| Constructor | Postgres type | Decodes to | Accepts on the wire |
| --- | --- | --- | --- |
| `text`, `uuid` | `text`, `uuid` | `string` | string |
| `bool` | `boolean` | `boolean` | boolean |
| `int2`, `int4`, `int8`, `float4`, `float8`, `numeric` | same | `number` | number, numeric string, `bigint` |
| `timestamptz` | `timestamptz` | `DateTime.Utc` | `Date`, or text such as `2026-01-01 00:00:00+00` |
| `jsonb(schema?)` | `jsonb` | the schema's type (`unknown` by default) | a parsed value |
| `array(type)` | `type[]` | `ReadonlyArray` | array |
| `nullable(type)` | the same type | `T \| null` | the same, or `null` |
| `custom(sql, schema, literalSchema?)` | anything | the schema's type | whatever the schema reads |

`int8` and `numeric` decode to `number`, so values beyond 2^53 or a double's precision lose
digits. Where exact digits matter, declare
`PG.custom("int8", Schema.Union([Schema.BigInt, Schema.BigIntFromString]))`: drivers send int8 as a
`bigint` (PGlite, postgres.js with `types.bigint`) or as a string (node-postgres), and this reads
both as a `bigint`. A `timestamptz`
compared against a `Date`, a `DateTime.Utc` or a string is written as an ISO-8601 instant,
which no session time zone can reinterpret; a zoneless string is read as UTC.

## Functions

| Function | SQL | Notes |
| --- | --- | --- |
| `count()`, `countDistinct(x)` | `count(*)`, `count(DISTINCT x)` | |
| `countIf(c)`, `sumIf(x, c)` | `count(*) FILTER (WHERE c)`, `sum(x) FILTER (WHERE c)` | ClickHouse's `-If` combinators |
| `sum`, `avg`, `min`, `max` | same | `null` over no rows, where ClickHouse returns `0` for `sum` |
| `percentileCont(f, x)` | `percentile_cont(f) WITHIN GROUP (ORDER BY x)` | Interpolated |
| `arrayAgg(x)` | `array_agg(x)` | |
| `dateTrunc(unit, ts)` | `date_trunc(unit, ts, 'UTC')` | UTC buckets; Postgres 12+ |
| `dateBin(seconds, ts)` | `date_bin(…, ts, epoch)` | Epoch-aligned buckets; Postgres 14+ |
| `now()` | `now()` | |
| `lower`, `upper`, `length` | same | |
| `coalesce(x, fallback)` | `coalesce(x, fallback)` | No longer nullable |
| `jsonText(x, key)` | `(x ->> key)` | `null` when absent |

The shared operators (`eq`, `in_`, `like`, `ilike`, `and`, `or`, `not`, arithmetic, `lit`) work
unchanged. The ClickHouse function catalog on the root entry (`quantile`, `toStartOfInterval`,
`count()`, …) writes ClickHouse SQL, so compiling a query that uses one for Postgres is a
`QueryBuilderDefect` naming the function; the Postgres functions above fail the same way on
ClickHouse. `coalesce`, `nullIf` and `lower` from the root entry render the same on both and
are allowed on either. A custom `Dialect` opts in with `functions: "clickhouse"` or
`"postgres"`; without it, nothing is checked.

## Known differences

- Integer division truncates in Postgres (`7 / 2` is `3`) and promotes to a float in ClickHouse.
- `rawExpr`, `untypedExpr`, `dynamicColumn` and `outerRef` take SQL as written; quote
  identifiers yourself (`"OrgId"`) when targeting Postgres.
- An outer join fills missing columns with `NULL` in Postgres and with type defaults in
  ClickHouse (unless `join_use_nulls` is set). Joined columns are typed nullable either way.

See [`design/dialects.md`](../design/dialects.md) for how dialects are built and what a new one
needs to provide.
