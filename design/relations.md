# Relational reads: `defineRelations` and `findMany`

Status: first slice built (issue #79; `docs/relations.md`). `one` and `many` relations over
single-column keys, `with` to any depth, `where` and `orderBy` per level, `limit` and `offset` on
the top level. Relation filters and counts (issue #80) are in section 6. Section 5 lists what is
not built.

## 1. Goal

Read a row with its related rows in one call, as Drizzle's relational queries
(`db.query.users.findMany({ with: { posts: true } })`) and Prisma's `include` do. Keep what the
rest of the library gives a query:

- rows decoded through the column codecs, at every level;
- a tenant scope derived for every statement, which `requireTenantScope` checks;
- a result type derived from the `with` tree.

## 2. The API

```ts
const schema = Db.defineRelations({ users: Users, posts: Posts }, (r) => ({
	users: { posts: r.many("posts", { from: "id", to: "authorId" }) },
	posts: { author: r.one("users", { from: "authorId", to: "id" }) },
}))

Db.findMany(schema.users, { where: ($) => [$.orgId.eq(orgId)], with: { posts: { with: { author: true } } } })
```

- **One callback over all tables**, as Drizzle v2 `defineRelations`. A relation names its target
  by key, not by value, so tables that point at each other need no thunks.
- **Relations live beside the tables, not in them.** `table()` stays as it is, and the DDL, the
  diff and the importers do not change. A Prisma importer can write the `defineRelations` call.
- **`findMany` lives in `/database`.** It runs more than one statement, so it needs the
  `Database` service. `defineRelations` sits next to it, so the dialect entries do not change.
- **Checked in the types.** The target must be a table key, `to` a column of the target, `from` a
  column of the source, and both must decode to `string | number | bigint`. A relation name must
  not be a column name.

## 3. One statement per level, not JSON aggregation

The issue proposed one statement with JSON aggregation (`jsonb_agg` / `json_object`), as Drizzle
RQB v2 does. This slice runs **one statement per level** instead:
`SELECT <all columns> FROM <target> WHERE <to> IN (<keys from the level above>) [AND <tenant pin>]
[AND <where>] [ORDER BY ...]`. The loader then groups the rows by key in memory. Prisma does the
same by default.

Why:

1. **Decoding stays correct for free.** Each level is an ordinary builder query, decoded by its
   own derived row codec. With JSON aggregation, every column comes back in its JSON form, not
   its wire form. An `int8` becomes a JSON number and loses precision past 2^53, a `timestamptz`
   becomes an ISO string in a different format, `bytea` becomes hex, and a `numeric` can change.
   Each column type would need a second "from JSON" codec per dialect, or a cast to text in the
   SQL. That is a large change to the type system for one feature.
2. **Tenant scope needs no new analysis.** Each level is a query the existing analysis already
   understands. A nested JSON subquery would need correlated-subquery evidence through
   `jsonb_agg`, which the analysis does not have yet.
3. **Every dialect.** The SQL is only `IN (...)`, so the same code runs on Postgres, on
   ClickHouse, and later on SQLite / D1 and MySQL. JSON aggregation needs a different function
   set per dialect, and ClickHouse has no `jsonb_agg`.
4. **The statement count is fixed.** It is the depth of the `with` tree, not the row count, so
   there is no N+1.

The costs:

- **More round trips.** Three levels are three statements. On a server close to the app this is
  small. JSON aggregation is better on a slow link.
- **No single snapshot.** Outside a transaction, a write can land between two levels. The docs
  say to use `Db.transaction({ isolationLevel: "repeatable read" })`. `findMany` does not open a
  transaction itself: ClickHouse has none, and the caller may already be in one.
- **Long `IN` lists.** All keys of a level are in one list. Postgres has a limit of 65,535 bound
  values. Chunking belongs with #57 (parameter limits).

JSON aggregation can come later as a second strategy behind the same API, per dialect, once the
column types have JSON codecs. The result type and the tenant rule would not change.

## 4. Tenant scope on nested levels

Each level goes through `Database.run`, so it is checked like any other statement. A nested
level filters on the parent keys, which says nothing about the tenant. So the loader adds a pin:

> When the parent table and the target table both declare a `tenantColumn`, and every parent row
> carries the same tenant value `V`, the nested query also gets `<target tenant column> = V`.

This is sound. The pin is an ordinary `eq` on a literal, so the existing analysis proves
`"single-tenant"`. `V` comes from rows the parent query read, so a level never reads a tenant its
parent did not read. The pin also hides bad data: a child row whose tenant differs from its
parent's.

No pin when the parent table is untenanted, or the parent rows carry more than one tenant. The
level is then `"cross-tenant"`, and `requireTenantScope` refuses it, which is the safe default. A
level whose `to` column is the target's tenant column, with one key, is scoped by the one-value
`IN` already. `crossTenant: true` declares every level `.crossTenant()`.

The pin does not pass through an untenanted level: a grandparent's tenant says nothing about a
grandchild reached through a shared table.

## 5. Not built

| What | Why not now |
| --- | --- |
| JSON aggregation strategy | Needs JSON codecs per column type (section 3) |
| `columns` per level | Small, but changes the row type of every level; next slice |
| `limit` per parent on a nested level | Needs `row_number()` over a partition, or a lateral join |
| Composite keys | The loader would match tuples; no issue asks for it yet |
| `findFirst` | `findMany` with `limit: 1`; cardinality helpers are #69 |
| `_count` of a `one` relation | `r.author.some()` says the same; no call site needs a 0/1 count |
| Relation filters in `update` / `delete` | Their accessor is not qualified, so there is no alias to correlate on; refused |
| `orderBy` a relation count | Select `count()` on a builder query and order by its alias |
| Params in nested `where` | `findMany` takes no params; values go in as literals |
| SQLite, MySQL, D1 | Not on main yet; the SQL here is plain `IN`, so no dialect work is expected |

## 6. Relation filters and counts

```ts
Db.findMany(schema.users, {
	where: ($, r) => [$.orgId.eq(orgId), r.posts.some(($) => [$.published.eq(false)])],
	_count: { posts: true },
})
PG.from(Users).select(($) => ({ id: $.id, posts: Db.related(schema.users, $).posts.count() }))
```

- **Filters are correlated subqueries.** `some` is `EXISTS`, `none` is `NOT EXISTS`, `every` is
  `NOT EXISTS (… AND NOT (where))`, as Prisma compiles them. A filter is a condition inside one
  statement, so it cannot be a separate level: the outer rows it filters do not exist yet. The
  subquery reads the target under the alias `<outer alias>__<relation>`, which differs from every
  enclosing alias, so a self-relation needs nothing special.
- **`Db.related(schema.table, $)` is the one entry point.** It builds the filters from the `$` of
  any select over the table, so the builder and `findMany` share one implementation. `findMany`
  passes it as the second argument of every `where`.
- **`_count` in `findMany` is a grouped level, not a subquery.** `SELECT <to>, count(*) …
  WHERE <to> IN (<keys>) GROUP BY <to>`, with the same tenant pin as a loaded level. This keeps
  #79's model: no correlation, so it runs on every dialect and every ClickHouse version, and the
  count decodes through one codec. `r.posts.count()` is the correlated form, for builder queries,
  wrapped in `coalesce(…, 0)` because ClickHouse returns NULL for a correlated count over no rows.

### Tenant scope inside the subquery

A subquery's scope counts as one more source of the outer query (docs/tenant-scoping.md), so a
subquery that pins no tenant made every filter `"cross-tenant"`. Writing the tenant value into
the subquery is not possible: the filter is built before the outer `where` is known, and the
value can be a param.

So when both tables declare a tenant column, the filter writes
`<inner tenant> = <outer tenant>` into the subquery and marks the subquery with the outer column
(`markCorrelatedTenant`, internal). Compiled as a subquery of the outer query, the marked query's
main source starts bound to a token for that outer column. If the subquery is single-tenant on
that token, the outer compile counts it as a source on the outer tenant column, which the outer
`where` binds like any other. Nested filters chain: the inner filter's token resolves against the
middle subquery's own main column.

This is sound because only the filters set the mark, and they always write the equality the mark
claims. A subquery whose own `where` pins a literal tenant is bound to that literal instead, and
the outer query must pin the same one. A marked query compiled alone ignores the mark. The write
paths (insert, update, delete) do not read the mark, so a marked subquery there stays
`"cross-tenant"`.

### ClickHouse

Correlated subqueries run on ClickHouse 25 and later. On 26.8 (CI): `EXISTS` / `NOT EXISTS`,
nested, and a correlated count in `WHERE` work. A correlated scalar subquery in `SELECT` next to a
`WHERE` fails with `NOT_IMPLEMENTED` unless the correlated outer columns are also selected. The
docs say to select them, or to use `_count`, which needs no correlation.
