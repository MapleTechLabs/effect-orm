# Relational reads

`Db.defineRelations` declares how tables relate. `Db.findMany` reads rows of one table with the
related rows under them, nested to any depth, as Drizzle's relational queries and Prisma's
`include` do. Both are in `@maple-dev/effect-orm/database`.

```ts title="relations-find-many.ts"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Users = PG.table("users", { columns: { id: PG.int4, name: PG.text }, primaryKey: ["id"] })
const Posts = PG.table("posts", {
	columns: { id: PG.int4, authorId: PG.column(PG.int4, { name: "author_id" }), title: PG.text },
	primaryKey: ["id"],
})

export const schema = Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
	posts: { author: r.one("users", { from: "authorId", to: "id" }) },
}))

const DatabaseLive = Db.layerSqlClient({ dialect: PG.postgresDialect }).pipe(
	Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })),
)

export const users = Effect.gen(function* () {
	yield* Db.execute(Db.sql`CREATE TABLE users (id int4 PRIMARY KEY, name text NOT NULL)`)
	yield* Db.execute(Db.sql`CREATE TABLE posts (id int4 PRIMARY KEY, author_id int4 NOT NULL, title text NOT NULL)`)
	yield* Db.execute(Db.sql`INSERT INTO users VALUES (1, 'ada'), (2, 'bob')`)
	yield* Db.execute(Db.sql`INSERT INTO posts VALUES (10, 1, 'hello')`)
	return yield* Db.findMany(schema.users, {
		orderBy: ($) => [[$.id, "asc"]],
		with: { posts: { with: { author: true } } },
	})
}).pipe(Effect.provide(DatabaseLive))
// [
//   { id: 1, name: "ada", posts: [{ id: 10, authorId: 1, title: "hello", author: { id: 1, name: "ada" } }] },
//   { id: 2, name: "bob", posts: [] },
// ]
```

## Declare relations

`defineRelations(tables, build)` takes the tables by key, and a callback that returns the
relations of each table by name. A relation names its target by that key, so two tables can point
at each other, and a table can point at itself.

| Builder | Loads | Result |
| --- | --- | --- |
| `r.many(target, { from, to })` | Every `target` row whose `to` column equals this row's `from` column | `ReadonlyArray<Row>` |
| `r.one(target, { from, to })` | The first such row | `Row \| null` |

The types check each declaration. The target must be a key of `tables`. `from` must be a column of
the source table and `to` a column of the target. Both must decode to a `string`, `number` or
`bigint`, because the loader matches keys by value. A relation name must not be a column name of
its table, because the loaded row carries both.

A `one` relation is always `| null`. A row can be missing even when a foreign key says it cannot:
another statement can delete it between two levels.

Relations are metadata only. They do not need a foreign key in the database, so they work on
ClickHouse too.

_(Backed by `src/database/relations.test-d.ts`, and `tests/relations.clickhouse.test.ts` on ClickHouse.)_

## Read with `findMany`

`findMany(schema.table, options?)` returns every column of the table, plus each relation that
`with` names. `with` takes `true`, or the options of that level:

| Option | Levels | Meaning |
| --- | --- | --- |
| `where` | All | More conditions, ANDed with the relation's key match |
| `orderBy` | All | The order of the rows; nested rows keep it within each parent |
| `with` | All | Relations to load under each row of this level |
| `limit`, `offset` | Top only | Paging of the top level |
| `crossTenant` | Top only | Declare every level `.crossTenant()` |

Rows come back decoded through the codecs of their columns at every level. A `timestamptz` in a
nested row is a `DateTime.Utc`, not a string.

## One statement per level

Each level of `with` is one ordinary builder query: every column of the target table,
`WHERE <to> IN (<the from values of the level above>)`, plus the level's own `where` and
`orderBy`. The loader groups the rows by key and puts them under their parents. A level with no
keys sends no statement. A tree with three levels sends three statements, whatever the number of
rows.

The levels are separate statements. Outside a transaction, a write from another connection can
land between two of them. Run `findMany` inside [`Db.transaction`](./database.md#transactions)
with `isolationLevel: "repeatable read"` for one snapshot across all levels.

All keys of a level go into one `IN` list. Postgres allows at most 65,535 bound values in one
statement, so keep the top level paged with `limit`.

## Tenant scope on every level

Each level runs through `run`, so each level has its own
[`tenantScope`](./tenant-scoping.md), and `requireTenantScope` checks each one.

When the parent rows all carry one tenant, and both tables declare a `tenantColumn`, the nested
query also gets `<tenant column> = <that tenant>`. That pins the level the same way a hand-written
filter does. It also hides a child row whose tenant differs from its parent's.

A level gets no pin when:

- the parent table has no `tenantColumn`;
- the parent rows carry more than one tenant.

That level is then `"cross-tenant"`, and `requireTenantScope` refuses it. There is one exception:
if the relation's `to` column is the target's tenant column and the level has one key, the
one-value `IN` scopes it already. With `crossTenant: true`, every level is declared
cross-tenant and runs.

_(Backed by `src/database/relations.test.ts`.)_

## Not yet

- Choosing columns per level (`columns: { id: true }`). Every level reads every column.
- A `limit` per parent on a nested level. That needs a window function or a lateral join.
- Composite keys (`from` and `to` with more than one column).
- `findFirst`. Use `findMany` with `limit: 1`.
- Filters and counts over relations (`_count`, `some`, `every`, `none`).
- `param.*` markers in a `where`: `findMany` takes no params, so write values in.

See [design/relations.md](../design/relations.md) for the design and the alternatives.
