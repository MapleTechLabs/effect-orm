# SQLite and Cloudflare D1

Import `@maple-dev/effect-orm/sqlite` for the shared query builder, SQLite codecs and functions.
Compilation uses positional `?` bindings. Each occurrence of a parameter gets its own binding.
The package opens no connection: use the Effect `SqlClient` you already provide.

## Define and compile a query

```ts title="sqlite-quickstart.ts"
import * as SQLite from "@maple-dev/effect-orm/sqlite"

export const Acks = SQLite.table("acknowledgments", {
	id: SQLite.text,
	org_id: SQLite.text,
	entry_id: SQLite.text,
}, { tenantColumn: "org_id" })

export const byOrg = SQLite.from(Acks)
	.select("entry_id")
	.where(($) => [$.org_id.eq(SQLite.param.string("orgId"))])
	.orderBy(["entry_id", "asc"])

export const compiled = SQLite.compileUnsafe(byOrg, { orgId: "org_1" })
// compiled.parameters is ["org_1"]; compiled.tenantScope is "single-tenant".
```

`table` describes the query schema. Manage its actual DDL and migrations outside this package.
Unlike the ClickHouse and Postgres entries, SQLite has no schema diff, introspection, migration
ledger or kit dialect yet. A `table` value here cannot be passed to the DDL generators.

The entry exports `text`, `integer` (a safe JavaScript integer), `real` (finite numbers),
`boolean` (0/1), `blob`, `timestamp`, `json(schema)`, `nullable`, `custom` and `brand`.

`integer` refuses a stored value past 2^53 with a decode error: as a JavaScript number it would
no longer be the stored integer (D1 rounds it; node:sqlite refuses it). Use `custom` with a
bigint codec for such columns.

`timestamp` stores an instant as SQLite's own text form, `YYYY-MM-DD HH:MM:SS.SSS` in UTC, the
form `strftime('%Y-%m-%d %H:%M:%f')` and `datetime(..., 'subsec')` write. It reads that form
and ISO-8601; text without a zone is UTC. SQLite compares text by bytes, so a timestamp column
orders by time only when every value in it has one form: write them through the builder or with
`strftime('%Y-%m-%d %H:%M:%f', ...)`. `CURRENT_TIMESTAMP` writes no milliseconds
(`2026-01-01 00:00:00`), which compares as earlier than the same instant written with them.
`blob` accepts the Uint8Array wire form from Node and the array-of-bytes form from D1.
`json` always uses the supplied schema to validate decoded JSON.
Use `text` when a stored date/time must remain a string.

SQLite aggregates include `count`, `countDistinct`, `countIf`, `sum`, `avg`, `min` and `max`.
The last four return NULL over an empty input. Scalar helpers include `lower`, `upper`,
`length` and `coalesce`. SQLite's own text and case rules apply. Foreign built-in function
sets, such as ClickHouse's `count()`, fail compilation instead of producing invalid SQL.

## Execute on SQLite

Install a compatible Effect SQL driver, for example `@effect/sql-sqlite-node` on Node 24+.
No driver is a runtime dependency of this package. Use current SQLite with RETURNING support.

```ts title="sqlite-node.ts"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Layer } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import { sqliteDialect } from "@maple-dev/effect-orm/sqlite"

export const SQLiteLive = Db.layerSqlClient({
	dialect: sqliteDialect,
	requireTenantScope: true,
}).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })))
```

`Db.run(query, params)` compiles for the database dialect and decodes the selected rows.
SQLite transactions and nested savepoints use the supplied client's `withTransaction`.
`serializable` is the only accepted explicit isolation level. Per-transaction access modes
and deferrable settings are refused. The driver must support the declared transaction behavior;
use the D1 profile for a D1 client.

## Execute on D1

Install `@effect/sql-d1` with a compatible Effect version. Provide the Worker's D1 binding:

```ts title="sqlite-d-one.ts"
import * as D1Client from "@effect/sql-d1/D1Client"
import { Layer } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import { d1Dialect } from "@maple-dev/effect-orm/sqlite"

export const d1DatabaseLayer = (db: D1Client.D1ClientConfig["db"]) =>
	Db.layerSqlClient({ dialect: d1Dialect, requireTenantScope: true }).pipe(
		Layer.provide(D1Client.layer({ db })),
	)
```

Use `d1Dialect` when compiling a query separately as well:
`SQLite.compile(query, params, { dialect: SQLite.d1Dialect })`. A query compiled for `sqlite`
cannot later run on a database configured as `d1`; pass the builder to `Db.run` instead.

D1 compilation refuses more than [100 bound parameters per statement](https://developers.cloudflare.com/d1/platform/limits/).
It never splits a write implicitly. Chunk an import explicitly if needed; several chunks do
not make one atomic write. SQLite compilation uses its modern default limit of 32766; a driver
with a lower limit needs a custom dialect profile.

`Database.transaction` on D1 returns `TransactionUnsupported` before executing its body.
D1's [atomic batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
executes a fixed list of statements. It cannot run an arbitrary Effect transaction body with
reads that determine later writes. There is no ORM batch API in this first implementation.

## Safety and syntax limits

Derived schemas validate returned rows. A row with the wrong type returns
`CompiledQueryDecodeError`. Input values use each column's encoder before binding.

Tenant enforcement is **opt-in**, through `requireTenantScope: true`. A compiled query over a
tenant table must pin its `tenantColumn` to one value, or explicitly use `.crossTenant()` for
an administrative read/write. Raw SQL passed to `query` or `execute` has no tenant proof and
bypasses this guard. It is not a replacement for an application's authorization checks.

The dialect handles OFFSET without LIMIT, branch-local ordering/limits in UNION ALL, and
INSERT SELECT with ON CONFLICT. `LIKE` patterns escape `%`, `_` and `\` with `\` as on every
dialect: the builder writes `ESCAPE '\'`, which SQLite needs. A fraction is bound rather than
written as decimal text, because SQLite reads some decimals as a neighbouring double, and a
fraction compared with an `integer` column (`Amount > 9.75`) compiles as on Postgres. It refuses these unsupported forms at compile time:

- `DISTINCT ON`, row locks and `ILIKE`. Use `LIKE`, which on SQLite ignores ASCII case
  (`'acme' LIKE 'ACME'` is true, unlike Postgres and ClickHouse).
- Text containing U+0000. SQLite stores it, but its drivers end text there, so the value would
  read back cut short; the builder refuses it in literals and bound params.
- `ON CONSTRAINT` conflict targets. Name the indexed columns instead.
- Per-cell `DEFAULT` in a VALUES tuple. Omit a defaulted column from every row in the statement,
  or group rows by their present columns. All-default rows are not supported by the builder.
- ClickHouse FORMAT/SETTINGS and built-in functions from another dialect.

The tests run real SQLite through `@effect/sql-sqlite-node` and local workerd/D1 through
Miniflare. They require no deployed database or Cloudflare credentials. Both run the shared core
builder suite (`tests/core.sqlite.test.ts`) and every fuzz property (`tests/fuzz`).
