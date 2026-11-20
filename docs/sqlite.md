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

`table(name, columns, options?)` is a query schema only: it carries no DDL.

## Declare a table with its DDL

Pass `{ columns, primaryKey, indexes }` to `table` to declare the table's DDL too. The value is
still a query `Table`. `sqliteEntitiesOf` from `/schema` checks a set of tables as one schema,
and `renderSqliteSchema` writes their `CREATE TABLE` and `CREATE INDEX` statements:

```ts title="sqlite-ddl.ts"
import { Effect } from "effect"
import * as S from "@maple-dev/effect-orm/schema"
import * as SQLite from "@maple-dev/effect-orm/sqlite"

export const ShortLinks = SQLite.table("short_link", {
	columns: {
		id: SQLite.text,
		code: SQLite.text,
		orgId: SQLite.column(SQLite.nullable(SQLite.text), { name: "org_id" }),
		clickCount: SQLite.column(SQLite.integer, { name: "click_count", default: 0 }),
		createdAt: SQLite.column(SQLite.text, { name: "created_at", defaultExpr: "(CURRENT_TIMESTAMP)" }),
	},
	primaryKey: ["id"],
	indexes: [SQLite.uniqueIndex("short_link_code", ["code"]), SQLite.index("short_link_org", ["orgId"])],
	tenantColumn: "orgId",
})

export const statements = S.sqliteEntitiesOf([ShortLinks]).pipe(Effect.map(S.renderSqliteSchema))
// CREATE TABLE IF NOT EXISTS "short_link" (
// 	"id" text PRIMARY KEY NOT NULL,
// 	"code" text NOT NULL,
// 	"org_id" text,
// 	"click_count" integer NOT NULL DEFAULT 0,
// 	"created_at" text NOT NULL DEFAULT (CURRENT_TIMESTAMP)
// )
// CREATE UNIQUE INDEX IF NOT EXISTS "short_link_code" ON "short_link" ("code")
// CREATE INDEX IF NOT EXISTS "short_link_org" ON "short_link" ("org_id")
```

- A column is `NOT NULL` unless its type is `nullable(...)`. A primary key column cannot be
  nullable: SQLite would accept NULL keys in it.
- One primary key column is written inline (`PRIMARY KEY`); several become a table constraint
  `PRIMARY KEY ("a", "b")`. SQLite stores no constraint name, so there is none to give.
- `default` takes a literal of the column type. `defaultExpr` takes SQL as written, so add the
  parentheses SQLite requires around an expression, or a DSL callback, which is parenthesized
  for you. Either lets an insert leave the column out.
- `unique: true` writes an inline `UNIQUE` constraint, as drizzle-kit 1.0 does for `.unique()`.
  Its name, `<table>_<column>_unique` or the string you give, is kept in the schema entities;
  SQLite itself names the backing index `sqlite_autoindex_...`.
- Column types declare their SQLite type: `text`, `timestamp` and `json` are `text`; `integer`
  and `boolean` are `integer`; `real` is `real`; `blob` is `blob`. A `custom(sql, schema)` type
  declares `sql`, for example `numeric`.
- `table(name, { external: true, columns })` declares a table another tool owns: no DDL.

The tests apply this DDL and drizzle-kit's SQL for the same tables to real SQLite, and compare
`PRAGMA table_info`, `index_list` and `index_xinfo`. One difference is deliberate: drizzle-kit
1.0 drops `NOT NULL` from a primary key column, so SQLite then accepts a NULL key in a `text`
key column. This entry keeps `NOT NULL`.

`effect-orm generate` with `dialect: "sqlite"` diffs these tables against the migrations folder
and writes the next migration, in the drizzle-kit 1.0 folder layout. See
[SQLite migrations](./migrations.md#sqlite). effect-orm does not apply SQLite migrations yet,
and has no SQLite introspection or drift check: apply the folder with a tool that reads
drizzle-kit folders, such as Alchemy's D1 resource. `WITHOUT ROWID`,
`STRICT`, `AUTOINCREMENT`, partial indexes, foreign keys and `CHECK` constraints are not
declared yet.

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
(`2026-01-01 00:00:00`), which compares as earlier than the same instant written with them, so
a `timestamp` column refuses it as a `defaultExpr`; use `defaultExpr: SQLite.timestampNow`.
`blob` accepts the Uint8Array wire form from Node and the array-of-bytes form from D1.
`json` always uses the supplied schema to validate decoded JSON.
Use `text` when a stored date/time must remain a string.

## Functions

Every function below writes SQLite's own SQL and carries `SqliteOnly`: a query that uses one
does not typecheck for `PG.compile` or a Postgres `Database`, and refuses to compile for another
dialect at run time. Foreign built-in function sets, such as ClickHouse's `count()`, fail
compilation instead of producing invalid SQL. Where an argument is "a value", it is an expression
or a plain string, number, boolean or `null`.

| Group | Functions |
| --- | --- |
| Aggregates | `count()`, `countDistinct(x)`, `countIf(cond)`, `sum(x)`, `avg(x)`, `min(x)`, `max(x)` (the last four NULL over no rows), `jsonGroupArray(x, type?)`, `jsonGroupObject(key, value, type?)` |
| Conditionals | `iif(cond, then, otherwise)`, `caseWhen([[cond, value], …], otherwise?)` (no `otherwise`: NULL), `coalesce(x, fallback)`, `ifnull(x, fallback)`, `nullif(x, value)` |
| Numbers | `abs(x)`, `round(x, digits?)`, `greatest(a, b, …)` and `least(a, b, …)` (SQLite's multi-argument `max` / `min`: NULL as soon as one argument is) |
| Text | `lower`, `upper`, `length`, `trim(x, chars?)`, `ltrim`, `rtrim`, `substr(x, start, length?)`, `replace(x, search, replacement)`, `instr(x, needle)`, `concat(a, b, …)` (`(a \|\| b)`) |
| Types | `cast(x, type)`: `CAST(x AS <type's SQL>)`, decoded as `type` |
| JSON | `jsonExtract(x, path, type)` (decoded as `type`; pass `nullable(type)` for a path that can be missing), `json_(x)` (SQLite's `json()`; `json` is the column type), `jsonSet(x, path, value)` |
| Dates | `julianday(v, ...modifiers)`, `date`, `datetime`, `strftime(format, v, ...modifiers)`, `unixepoch` (all NULL for text SQLite cannot read) |

A scalar function decodes NULL where an argument can be NULL, so `trim($.email)` over a
nullable column is `string | null` and over a `text` column `string`. `iif`, `caseWhen`,
`greatest` and `least` decode as any of their branches can: `iif(c, $.planName, "none")` is
`string | null`.

```ts title="sqlite-functions.ts"
import { Schema } from "effect"
import * as SQLite from "@maple-dev/effect-orm/sqlite"

const Contacts = SQLite.table("contacts", {
	external: true,
	columns: { id: SQLite.text, email: SQLite.nullable(SQLite.text), deletedAt: SQLite.nullable(SQLite.text) },
})
const Messages = SQLite.table("messages", {
	external: true,
	columns: { id: SQLite.text, embeds: SQLite.json(Schema.Array(Schema.Struct({ url: Schema.String }))) },
})

// count(DISTINCT CASE WHEN … THEN lower(trim("email")) ELSE "id" END)
export const people = SQLite.from(Contacts).select(($) => ({
	people: SQLite.countDistinct(
		SQLite.caseWhen(
			[[$.deletedAt.isNull().and(SQLite.trim(SQLite.coalesce($.email, "")).neq("")), SQLite.lower(SQLite.trim($.email))]],
			$.id,
		),
	),
}))

// A JSON column searched as text: CAST("embeds" AS text) GLOB '*x.dev*'
export const linking = SQLite.from(Messages)
	.select("id")
	.where(($) => [SQLite.cast($.embeds, SQLite.text).contains("x.dev")])
```

## Window functions

`over(expr, windowSpec({ partitionBy, orderBy, frame }))` writes `expr OVER (…)`, as on
ClickHouse; the spec and its frames (`rowsBetween`, `rangeBetween`, `currentRow`,
`unboundedPreceding`, `unboundedFollowing`, `preceding(n)`, `following(n)`) are shared. The
window functions are `lead(x, offset?, fallback?)`, `lag(x, offset?, fallback?)`, `rowNumber()`,
`rank()`, `denseRank()`, `firstValue(x)` and `lastValue(x)`; an aggregate (`count()`, `sum(x)`)
works in `over` too. `lead` and `lag` decode NULL past the partition's edge, so `lead($.day)`
over a `text` column is `string | null`, unless a fallback fills it: a plain fallback is written
and decoded as the column, an expression fallback decodes by its own codec as well (with its
NULL). `firstValue` and `lastValue` are nullable too, as a frame can be empty
(`rowsBetween(preceding(1), preceding(1))` on a partition's first row). `/postgres` exports the same
functions, writing the same SQL.

```ts title="sqlite-window.ts"
import * as SQLite from "@maple-dev/effect-orm/sqlite"

const Activity = SQLite.table("activity", {
	external: true,
	columns: { contactId: SQLite.text, day: SQLite.text },
})

// LEAD("day") OVER (PARTITION BY "contactId" ORDER BY "day" ASC) AS "next"
const days = SQLite.from(Activity).select(($) => ({
	day: $.day,
	next: SQLite.over(SQLite.lead($.day), SQLite.windowSpec({ partitionBy: [$.contactId], orderBy: [[$.day, "asc"]] })),
}))

// Days to the next active day, capped at 30, counted per gap.
export const gaps = SQLite.fromQuery(days, "g")
	.select(($) => ({
		gap: SQLite.least(SQLite.coalesce(SQLite.cast(SQLite.julianday($.next).sub(SQLite.julianday($.day)), SQLite.integer), 30), 30),
		n: SQLite.count(),
	}))
	.groupBy("gap")
// SELECT min(coalesce(CAST(julianday("g"."next") - julianday("g"."day") AS integer), 30), 30) AS "gap", count(*) AS "n" …
```

_(Backed by `docs/sqlite.md > Window functions and a capped gap`.)_

## Table-valued sources: `json_each` and `json_tree`

`jsonEach(json, { value?, key?, path? })` is SQLite's `json_each(json)` as a row source. Pass
it to `from`, `innerJoin`, `leftJoin`, `crossJoin` or `update(...).from`, like a table. Its
columns are `key`, `value`, `type`, `atom`, `id`, `parent`, `fullkey` and `path`; `value` and
`key` decode as the column types you give (`{ value: SQLite.text }`, or `SQLite.json(schema)` for
objects), and are `unknown` and `string | number | null` otherwise. `jsonTree` is the same for
`json_tree`, which recurses into nested values.

The JSON is one of:

- a JS value, an array or an object, bound as **one** JSON text parameter;
- a param of a JSON column type: `SQLite.param.of(SQLite.json(schema), "ids")`;
- an expression of JSON text: a `json(schema)` column of an earlier or outer source, or a
  `jsonExtract`.

A JS string is a JSON string value, not JSON text; pass JSON text as an expression.

One parameter for a list of any length matters on D1 and Durable Object storage, which bind at
most 100 values per statement:

```ts title="sqlite-json-each.ts"
import * as SQLite from "@maple-dev/effect-orm/sqlite"
import { Schema } from "effect"

const Activity = SQLite.table("activity", {
	external: true,
	columns: { contactId: SQLite.text, accountId: SQLite.text, day: SQLite.text },
})
const Accounts = SQLite.table("accounts", {
	external: true,
	columns: { id: SQLite.text, domains: SQLite.json(Schema.Array(Schema.String)), createdAt: SQLite.text },
})

// WHERE "accountId" IN (SELECT "json_each"."value" FROM json_each(?) AS "json_each")
export const byAccounts = (ids: ReadonlyArray<string>) =>
	SQLite.from(Activity)
		.select("contactId")
		.where(($) => [SQLite.inSubquery($.accountId, SQLite.from(SQLite.jsonEach(ids, { value: SQLite.text })).select(($) => ({ value: $.value })))])

// FROM "accounts" AS "a" CROSS JOIN json_each("a"."domains") AS "d"
export const byDomain = SQLite.from(Accounts, "a")
	.crossJoin(($) => SQLite.jsonEach($.domains, { value: SQLite.text }), "d")
	.where(($) => [$.d.value.in_("acme.com", "globex.com")])
	.select(($) => ({ id: $.id }))
	.distinct()

// FROM json_each(?) AS "j" INNER JOIN "activity" AS "a" ON "a"."accountId" = "j"."key" AND "a"."day" > "j"."value"
export const since = SQLite.from(
	SQLite.jsonEach(SQLite.param.of(SQLite.json(Schema.Record(Schema.String, Schema.String)), "after"), { key: SQLite.text, value: SQLite.text }),
	"j",
)
	.innerJoin(Activity, "a", (j, a) => a.accountId.eq(j.key).and(a.day.gt(j.value)))
	.select(($) => ({ accountId: $.a.accountId, contacts: SQLite.countDistinct($.a.contactId) }))
	.groupBy("accountId")
```

A join's source can be a callback that builds the table-valued function from the earlier
sources' columns, as `byDomain` does (SQLite reads them as a lateral join). An ON callback's
first argument sees the earlier joins too, under their aliases: `(g, a) => a.accountId.eq(g.m.value)`.
A correlated subquery reads an outer column the same way:
`exists(from(jsonEach($.blockedBy, { value: SQLite.text })).select(…).where((j) => [j.value.eq(userId)]))`.

_(Backed by `docs/sqlite.md > json_each passes a list as one parameter`.)_

### Rows from a JS array: `jsonRows`

`jsonRows(rows, columns)` is a query over one bound JSON parameter, with a column per field:
`json_extract("value", '$.<field>')`, decoded by the column type you give. Each row is encoded
through those types first, so a boolean is written as 0/1 and a `timestamp` as SQLite text, as
an insert writes them. Use it where a query goes: `insertInto(t).select(...)`, `fromQuery`,
`innerJoinQuery`, or `update(t).from(...)`.

```ts title="sqlite-json-rows.ts"
import * as SQLite from "@maple-dev/effect-orm/sqlite"

const OrgDaily = SQLite.table("org_daily", {
	external: true,
	columns: { day: SQLite.text, dau: SQLite.integer, mrrMinor: SQLite.integer, payingAccounts: SQLite.integer },
})

export const upsert = (days: ReadonlyArray<{ day: string; dau: number; mrrMinor: number; payingAccounts: number }>) =>
	SQLite.insertInto(OrgDaily)
		.select(SQLite.jsonRows(days, { day: SQLite.text, dau: SQLite.integer, mrrMinor: SQLite.integer, payingAccounts: SQLite.integer }))
		.onConflictDoUpdate({
			target: ["day"],
			set: ($, excluded) => ({
				dau: excluded.dau,
				mrrMinor: SQLite.iif($.mrrMinor.eq(0).and($.payingAccounts.eq(0)), excluded.mrrMinor, $.mrrMinor),
			}),
		})
// INSERT INTO "org_daily" (…) SELECT * FROM (SELECT json_extract("json_each"."value", '$.day') AS "day", …
//   FROM json_each(?) AS "json_each") AS "__insert_source" WHERE 1
// ON CONFLICT ("day") DO UPDATE SET "dau" = "excluded"."dau", "mrrMinor" = iif((…), "excluded"."mrrMinor", "org_daily"."mrrMinor")
```

The `WHERE 1` and the wrapping SELECT are how the dialect resolves SQLite's parsing ambiguity of
an `ON CONFLICT` after an `INSERT ... SELECT`. In `onConflictDoUpdate`'s `set` and `where`
callbacks, `$` is the existing row (written `"table"."col"`) and `excluded` the proposed one.

## UPDATE ... FROM

`update(table).from(source, alias)` writes `UPDATE … SET … FROM source AS alias WHERE …`
(SQLite 3.33+, Postgres). The source is a table, a table-valued function or a query (`jsonRows`
included). `set` and `where` read its columns as `$.<alias>.<column>`, and the target's columns
are written qualified. ClickHouse and MySQL refuse it in the type and when compiling.

```ts
SQLite.update(OrgDaily)
	.from(SQLite.jsonRows(days, { day: SQLite.text, dau: SQLite.integer }), "r")
	.set(($) => ({ dau: $.r.dau }))
	.where(($) => [$.day.eq($.r.day)])
// UPDATE "org_daily" SET "dau" = "r"."dau" FROM (SELECT json_extract(…) AS "day", … FROM json_each(?) AS "json_each") AS "r"
// WHERE "org_daily"."day" = "r"."day"
```

See [Updating and deleting](./updates-and-deletes.md#update--from) for a SET from a correlated
subquery.

## FTS5

`fts5Table(name, columns)` declares an FTS5 virtual table for queries: its columns and an
integer `rowid`, with no DDL (create it with `CREATE VIRTUAL TABLE … USING fts5(…)`). The
`fts5` functions take the table's accessor, `$` when it is the FROM source or `$.alias` when it is
joined, and write the hidden column SQLite searches under the name the query gives the table:

| Function | SQL | Result |
| --- | --- | --- |
| `fts5.match(source, query)` | `"fts"."fts" MATCH ?` | a `Condition`; a string query is bound |
| `fts5.snippet(source, column, start, end, ellipsis, tokens)` | `snippet(…)` | `string` |
| `fts5.highlight(source, column, start, end)` | `highlight(…)` | `string \| null` |
| `fts5.bm25(source, ...weights)` | `bm25(…)` | `number`, lower is better |

`column` is a column name of the FTS5 table or its 0-based position.

```ts title="sqlite-fts5.ts"
import * as SQLite from "@maple-dev/effect-orm/sqlite"

const SearchFts = SQLite.fts5Table("message_search_fts", { content: SQLite.text })
const Search = SQLite.table("message_search", {
	external: true,
	columns: { id: SQLite.integer, messageId: SQLite.text, createdAt: SQLite.text },
})

export const search = SQLite.from(SearchFts)
	.innerJoin(Search, "s", (fts, s) => s.id.eq(fts.rowid))
	.select(($) => ({ messageId: $.s.messageId, snippet: SQLite.fts5.snippet($, "content", "\u0002", "\u0003", "…", 24) }))
	.where(($) => [SQLite.fts5.match($, SQLite.param.string("q"))])
	.orderBy(($) => [[$.s.createdAt, "desc"], [$.s.messageId, "desc"]])
	.limit(20)
// SELECT "s"."messageId", snippet("message_search_fts"."message_search_fts", 0, …, 24) AS "snippet"
// FROM "message_search_fts" INNER JOIN "message_search" AS "s" ON "s"."id" = "message_search_fts"."rowid"
// WHERE "message_search_fts"."message_search_fts" MATCH ? …
```

_(Backed by `docs/sqlite.md > FTS5 search joined to its content table`.)_

## rowid

A table with an implicit `rowid` declares it as a column, `rowid: SQLite.integer`, in an
external table or the bare-columns form. It then reads and compares like any column, in a
subquery too: `from(Outbox).select(($) => ({ key: $.key, head: min($.rowid) })).groupBy("key")`,
joined back with `innerJoinQuery(heads, "h", (o, h) => o.rowid.eq(h.head))`. An insert then needs
a `rowid` value unless the column is listed in `defaults`. A comparison with a nullable
expression, such as `h.head` (an aggregate over a group), type-checks as it does in SQL.

## Durable Object storage: `runSync`

Cloudflare Durable Object storage (`ctx.storage.sql`) is synchronous and no Effect `SqlClient`.
`runSync(storage, query, params?)` compiles for SQLite, binds, runs and decodes, without an
Effect: what `Database.run` does. It takes what `run` takes (a query, union, insert, update,
delete or a query compiled for SQLite) with the same checks in the type: params, the SQLite
function set, a SELECT list. A write returns its RETURNING rows, or none. Its client defaults
(`defaultFn` / `onUpdate`) run first and must be synchronous Effects that need no service; one
that needs a service is a type error. A failure throws: the `QueryBuilderError`, the
`CompiledQueryDecodeError` or the storage's own error.

Each statement runs in a client span, as `Database.run`'s do, with the failure recorded on it
before it is thrown. `runSync(storage, query, params, { context, observeExit, spanParameters })`
says where: `context` is the services the span runs with (a `Tracer`, a parent span). It
defaults to the context of the Effect fiber calling `runSync`, so a call inside `Effect.sync`
nests under the caller's span; outside any fiber, pass a context captured with
`yield* Effect.context()`, or the span goes to Effect's default tracer. `observeExit` and
`spanParameters` are as on `fromSqlClient`.

```ts
const rows = SQLite.runSync(ctx.storage.sql, SQLite.from(Jobs).select().where(($) => [$.id.eq(SQLite.param.string("id"))]), { id })
```

`SqlStorageLike` is the shape it needs, `exec(sql, ...bindings).toArray()`; a `node:sqlite`
database wraps into it for tests (`exec` must run the statement when called, as workerd's does).
`requireTenantScope` does not apply: there is no `Database` to configure.

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
`SQLite.compile(query, params, { dialect: SQLite.d1Dialect })`, or provide it once for an Effect
with `Effect.provideService(SQLite.CurrentDialect, SQLite.d1Dialect)`. A query compiled for `sqlite`
cannot later run on a database configured as `d1`; pass the builder to `Db.run` instead.

D1 compilation refuses more than [100 bound parameters per statement](https://developers.cloudflare.com/d1/platform/limits/).
It never splits a write implicitly. Chunk an import explicitly if needed; several chunks do
not make one atomic write. SQLite compilation uses its modern default limit of 32766; a driver
with a lower limit needs a custom dialect profile.

`Database.transaction` on D1 returns `TransactionUnsupported` before executing its body.
D1's [atomic batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
executes a fixed list of statements; it cannot run an arbitrary Effect transaction body with
reads that determine later writes. `Database.batch([...])` sends such a list as one D1 batch, and
returns each statement's decoded rows; see [Batches](./database.md#batches). A write that should
happen only when a condition holds is one statement: `insertInto(t).select(selectNoFrom(…).where(…))`
(see [Insert ... select](./inserts.md#insert--select)).

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
  (`'acme' LIKE 'ACME'` is true, unlike Postgres and ClickHouse). For text search,
  `.contains()`, `.startsWith()` and `.endsWith()` match case as on the other dialects (they
  write `GLOB`), and `{ insensitive: true }` compares `lower()` of both sides; see
  [Text search](./expressions.md#text-search). A row lock is refused in the
  type as well: `SQLite.compile(q.forUpdate())` and `run` on a SQLite or D1 `Database` do not
  typecheck. Claim a row with a conditional `update(…).where(…).returning(…)` instead. A
  Postgres or ClickHouse function in a SQLite query, and a SQLite function in a Postgres or
  ClickHouse one, are type errors too; see
  [Checked in the type](./params-and-compilation.md#checked-in-the-type).
- Text containing U+0000. SQLite stores it, but its drivers end text there, so the value would
  read back cut short; the builder refuses it in literals and bound params.
- `ON CONSTRAINT` conflict targets. Name the indexed columns instead.
- Per-cell `DEFAULT` in a VALUES tuple. Omit a defaulted column from every row in the statement,
  or group rows by their present columns. All-default rows are not supported by the builder.
- ClickHouse FORMAT/SETTINGS and built-in functions from another dialect.

The tests run real SQLite through `@effect/sql-sqlite-node` and local workerd/D1 through
Miniflare. They require no deployed database or Cloudflare credentials. Both run the shared core
builder suite (`tests/core.sqlite.test.ts`) and every fuzz property (`tests/fuzz`).
