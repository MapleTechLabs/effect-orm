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

`Database.run` compiles the insert for its database's dialect and runs it. An insert returns no
rows; `RETURNING` is not built yet (see [`design/writes.md`](../design/writes.md)).

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

## Tenant scope

An insert has a `tenantScope` like a query, worked out the same way. On a table with a
`tenantColumn`, it is `"single-tenant"` when every row gives that column the same value or the
same param, and `"cross-tenant"` when rows differ or a row uses another expression. A table
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

_(Backed by `src/ch/insert.test.ts`, `src/database/database.test.ts` and
`tests/database.clickhouse.test.ts`.)_

## Large batches on ClickHouse

An insert is SQL text, which suits the batches an application writes per request. For bulk
ingest, prefer your client's own insert with `JSONEachRow`, which streams rows instead of
building one statement.
