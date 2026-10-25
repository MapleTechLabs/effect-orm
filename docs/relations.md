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
`with` names, plus `_count` when the level counts relations. `with` takes `true`, or the options
of that level:

| Option | Levels | Meaning |
| --- | --- | --- |
| `where` | All | More conditions, ANDed with the relation's key match |
| `orderBy` | All | The order of the rows; nested rows keep it within each parent |
| `with` | All | Relations to load under each row of this level |
| `_count` | All | `many` relations to count under each row of this level |
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

## Filter by relations

A `where` gets a second argument, `r`, with the relations of its table. Each relation has three
filters, as Prisma's `some`, `none` and `every`:

| Filter | True when | SQL |
| --- | --- | --- |
| `r.posts.some(where?)` | At least one related row matches (with no `where`: there is one) | `EXISTS (…)` |
| `r.posts.none(where?)` | No related row matches (with no `where`: there is none) | `NOT EXISTS (…)` |
| `r.posts.every(where)` | Every related row matches; also true when there is none | `NOT EXISTS (… AND NOT (where))` |

```ts title="relations-filters.ts"
import { Effect } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Users = PG.table("users", { columns: { id: PG.int4, name: PG.text }, primaryKey: ["id"] })
const Posts = PG.table("posts", {
	columns: { id: PG.int4, authorId: PG.column(PG.int4, { name: "author_id" }), published: PG.bool },
	primaryKey: ["id"],
})
const schema = Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
	posts: { author: r.one("users", { from: "authorId", to: "id" }) },
}))

// Users with a draft, and users whose posts are all published.
export const withDrafts = Db.findMany(schema.users, { where: (_, r) => [r.posts.some(($) => [$.published.eq(false)])] })
export const allPublished = Db.findMany(schema.users, { where: (_, r) => [r.posts.every(($) => [$.published.eq(true)])] })

// The same filters on a builder query: `Db.related` takes the query's `$`.
export const query = PG.from(Users)
	.select(($) => ({ id: $.id, posts: Db.related(schema.users, $).posts.count() }))
	.where(($) => [Db.related(schema.users, $).posts.none()])
export const rows: Effect.Effect<ReadonlyArray<{ readonly id: number; readonly posts: number }>, unknown, Db.Database> =
	Db.run(query)
```

Each filter is one correlated subquery in the statement that holds it. It reads the target
table under its own alias, `<outer alias>__<relation>`, so a table related to itself works. The
`where` of a filter gets its own `r`, so filters nest: `r.posts.some((_, r) => [r.comments.some()])`.
A `one` relation has the same filters: `some` is "the related row exists and matches", `none` is
"it does not".

`every` negates the condition, so a related row where the condition is NULL passes it. Use a
condition that cannot be NULL, or say what NULL means with `isNull` / `isNotNull`.

_(Backed by `src/database/relation-filters.test.ts`, and `tests/relation-filters.clickhouse.test.ts` on ClickHouse.)_

## Count relations

Two ways, for two shapes of read:

- **`_count` in `findMany`**, as Prisma's `_count`. `_count: { posts: true }` adds
  `_count: { posts: number }` to each row of that level. `_count: { posts: { where } }` counts
  only the rows that match. Only a `many` relation can be counted. It runs one statement per
  counted relation, the same way as a level of `with`:
  `SELECT <to>, count(*) FROM <target> WHERE <to> IN (<keys>) [AND <tenant pin>] GROUP BY <to>`.
  A row with no related rows gets `0`.
- **`r.posts.count(where?)` on a query**, an `Expr<number>`: a correlated
  `coalesce((SELECT count(*) …), 0)`. Use it in a builder `select`, or in a `where` such as
  `Db.related(schema.users, $).posts.count().gte(2)`.

_(Backed by `src/database/relation-filters.test.ts`.)_

## Tenant scope in filters and counts

When both tables declare a `tenantColumn`, a filter's subquery also gets
`<target tenant column> = <outer tenant column>`. The compiler then gives the subquery the
tenant the outer query is bound to: a filter under `$.orgId.eq("a")` is `"single-tenant"`. The
equality also hides a related row whose tenant differs from the outer row's.

A filter does not scope the query that holds it. Without a tenant filter of its own, the outer
query stays `"cross-tenant"`. A filter from an untenanted table into a tenanted one has no outer
tenant to match, so it is `"cross-tenant"` too, unless its own `where` pins the tenant
(`r.units.some(($) => [$.orgId.eq("a")])`). A filter whose `where` pins a different tenant from the
outer query makes the query `"cross-tenant"`.

`_count` uses the same pin as a level of `with` (see above).

_(Backed by `src/database/relation-filters.test.ts`.)_

## On ClickHouse

ClickHouse 25 and later run correlated subqueries (`allow_experimental_correlated_subqueries`,
on by default in 26.8). On 26.8:

- `some`, `none`, `every`, and filters nested in filters work.
- `count()` in a `where` works.
- `count()` in a `select` works when the outer columns it correlates on are selected too, or the
  query has no `where`. Otherwise ClickHouse refuses the query with `NOT_IMPLEMENTED`
  ("can't find correlated column"). Select the relation's `from` column and the tenant column
  next to the count, or use `_count` in `findMany`.
- A correlated `count()` over no rows returns NULL on ClickHouse, not 0. The `coalesce` in
  `count()` turns it into 0.
- `_count` needs no correlation, so it works on every version.

_(Backed by `tests/relation-filters.clickhouse.test.ts`.)_

## Not yet

- Choosing columns per level (`columns: { id: true }`). Every level reads every column.
- A `limit` per parent on a nested level. That needs a window function or a lateral join.
- Composite keys (`from` and `to` with more than one column).
- `findFirst`. Use `findMany` with `limit: 1`.
- `_count` of a `one` relation. Test for the row with `r.author.some()`.
- Relation filters in `update` and `delete`. Their `$` has no alias to correlate on, so the
  compile dies with a `QueryBuilderDefect`. Select the keys first, then write by key.
- Ordering by a relation count (`orderBy: { posts: { _count: "desc" } }`). On a builder query,
  select the count and order by its alias.
- `param.*` markers in a `where`: `findMany` takes no params, so write values in.

See [design/relations.md](../design/relations.md) for the design and the alternatives.
