# Inserting rows

`insertInto(table).values(rows)` builds an INSERT from the same table definition your queries
read. Like a query, it is an immutable value: nothing is sent until you run it, and `compile`
writes it for the dialect you compile with.

```ts
import * as CH from "@maple-dev/effect-orm"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const ApiKeys = CH.table(
	"api_keys",
	{
		id: PG.uuid,
		org_id: PG.text,
		name: PG.text,
		created_at: PG.timestamptz,
		revoked: PG.bool,
		note: PG.nullable(PG.text),
	},
	{ tenantColumn: "org_id", defaults: ["created_at", "revoked"] },
)

const insertKey = CH.insertInto(ApiKeys).values({
	id: CH.param.string("id"),
	org_id: CH.param.string("orgId"),
	name: "default",
})

// yield* Db.run(insertKey, { id, orgId })
```

`Database.run` compiles the insert for its database's dialect and runs it. Without
[`returning`](#returning) an insert returns no rows.

## The row type

Each row is typed from the table:

- A column is **required** unless it is nullable or listed in `defaults`.
- Leaving an optional column out, or passing `undefined`, writes the column's default.
- `null` writes NULL, and only type-checks on a nullable column.
- A value can be a plain value of the column's type, a `param.*` of it, or any expression of it,
  such as `CH.rawExpr("now()", CH.dateTime)`. A `DateTime` column also takes a `Date` or the
  `'YYYY-MM-DD hh:mm:ss'` string, as in a comparison.

`InsertRowOf<typeof ApiKeys>` names the row type, for a function that builds rows.

### Which columns have defaults

`table()` cannot see your DDL, so you list the columns the database fills in with
`defaults`: a Postgres `serial` or `DEFAULT now()`, a ClickHouse `DEFAULT`. A table declared
with [`defineTable`](./migrations.md) works this out from its column options: a column with
`default` or `defaultExpr` is optional, and a `materialized` or `alias` column cannot be inserted
at all (it is not in the row type, and a row that names it anyway fails to compile).

ClickHouse fills every column it is not given with a default, even without a `DEFAULT` clause:
`0` for a number, `''` for a string. The row type still requires those columns unless you list
them, so a forgotten value is a type error rather than a silent zero.

## What it compiles to

Columns are written in table order, whatever order the keys are in, so two rows with their keys
in different orders cannot swap values. A column that some rows give and others leave out is
`DEFAULT` in the rows that leave it out:

```ts
const Events = CH.table(
	"events",
	{ OrgId: CH.string, Id: CH.uint64, At: CH.dateTime },
	{ tenantColumn: "OrgId", defaults: ["Id"] },
)

CH.compileUnsafe(
	CH.insertInto(Events).values([
		{ At: new Date(0), OrgId: "o1" },
		{ OrgId: "o1", Id: 5, At: "2026-01-01 00:00:00" },
	]),
).sql
// INSERT INTO events (OrgId, Id, At)
// VALUES ('o1', DEFAULT, '1970-01-01 00:00:00'), ('o1', 5, '2026-01-01 00:00:00')
```

Every value is encoded through its column's codec, the same one that decodes the column. A value
the codec rejects fails to compile with a `QueryBuilderError` that names the row and column.

- **ClickHouse** writes each value into the SQL as an escaped literal, as it does for params.
- **Postgres** binds each value as `$1, $2, ...` and returns them in `parameters`. A param used in
  several rows is bound once. A statement over 65535 bound values (Postgres's limit) fails to
  compile instead of being split: send fewer rows per statement.

## Returning

On Postgres, `returning` adds a RETURNING list and `Database.run` returns the inserted rows,
decoded. It takes column names, or a callback building one expression per alias, as `select`
does:

```ts
const created = CH.insertInto(ApiKeys)
	.values({ id: CH.param.string("id"), org_id: CH.param.string("orgId"), name: "default" })
	.returning(($) => ({ id: $.id, createdAt: $.created_at }))

// const [row] = yield* Db.run(created, { id, orgId }) // { id: string; createdAt: DateTime.Utc }
```

The row schema is derived from the list, as it is from a SELECT: an untyped expression
(`untypedExpr`) leaves the insert undecoded, with `rowSchemaSource: "none"` and the alias in
`untypedColumns`. `CompiledQuery.returning` lists the aliases. ClickHouse has no RETURNING, so
compiling an insert with `returning` for it is a `QueryBuilderDefect`.

## On conflict

On Postgres, `onConflictDoNothing` and `onConflictDoUpdate` add an `ON CONFLICT` clause. Their
options follow Drizzle's, so code moving from Drizzle changes little.

```ts
const Counters = CH.table("counters", { key: PG.text, count: PG.int8, locked: PG.bool }, { defaults: ["locked"] })

// Skip a row whose key exists. Without `target`, any unique index or constraint counts.
CH.insertInto(Counters).values({ key: "a", count: 1 }).onConflictDoNothing({ target: ["key"] })

// Upsert: add to the existing count, unless the row is locked.
CH.insertInto(Counters)
	.values({ key: "a", count: 1 })
	.onConflictDoUpdate({
		target: ["key"],
		set: ($, excluded) => ({ count: $.count.add(excluded.count) }),
		where: ($) => $.locked.eq(false),
	})
	.returning("key", "count")
```

```sql
INSERT INTO "counters" ("key", "count")
VALUES ($1, $2)
ON CONFLICT ("key") DO UPDATE SET "count" = "counters"."count" + "excluded"."count" WHERE "counters"."locked" = FALSE
RETURNING "key" AS "key", "count" AS "count"
```

- `target` is column names, or `{ constraint: "name" }`. `targetWhere` gives a partial unique
  index's predicate. `onConflictDoUpdate` requires a `target`; `onConflictDoNothing` does not.
- `set` is a record of values, params or expressions, or a callback that gets `$` (the existing
  row) and `excluded` (the row proposed for insertion). `$` is qualified with the table name,
  because an unqualified column would be ambiguous with `excluded`. A key left out keeps the
  existing value.
- `where` limits the update to existing rows it holds for. A row it skips is not updated and,
  with `returning`, returns nothing; the same goes for a row `onConflictDoNothing` skips.
- Calling either again replaces the clause. ClickHouse has no `ON CONFLICT` (deduplicate with a
  `ReplacingMergeTree` instead), so compiling one for it is a `QueryBuilderDefect`.

## Tenant scope

An insert has a `tenantScope` like a query, worked out the same way. On a table with a
`tenantColumn`, it is `"single-tenant"` when every row gives that column the same value or the
same param, and `"cross-tenant"` when rows differ or a row uses another expression. An
`onConflictDoUpdate` that sets the tenant column counts as one more row. A table
without a tenant column gives `"untenanted"`.

## Failures

| Case                                              | Result                                   |
| ------------------------------------------------- | ---------------------------------------- |
| `values([])`, a row with no values                | `QueryBuilderError` `InvalidArguments`   |
| A key that is not a column, or a computed column  | `QueryBuilderError` `InvalidArguments`   |
| A value the column's codec rejects                | `QueryBuilderError` `InvalidLiteral`     |
| A param with no value                             | `QueryBuilderError` `UnresolvedParam`    |
| Over the dialect's bound-value limit              | `QueryBuilderError` `InvalidArguments`   |
| Compiling without `values`                        | `QueryBuilderDefect`                     |
| `returning` for a dialect without RETURNING       | `QueryBuilderDefect`                     |
| `onConflictDoUpdate` setting no or unknown columns | `QueryBuilderError` `InvalidArguments`  |
| `onConflict*` without ON CONFLICT, a bad target   | `QueryBuilderDefect`                     |

_(Backed by `src/ch/insert.test.ts`, `src/database/database.test.ts` and
`tests/database.clickhouse.test.ts`.)_

## Large batches on ClickHouse

An insert is SQL text, which suits the batches an application writes per request. For bulk
ingest, prefer your client's own insert with `JSONEachRow`, which streams rows instead of
building one statement.
