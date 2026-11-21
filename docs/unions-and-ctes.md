# Unions and CTEs

## `unionAll`

`unionAll` combines queries that share an output shape. TypeScript enforces the shape match,
and compilation also rejects mismatched keys at runtime. Each branch is emitted in the first
branch's alias order, so object insertion order cannot swap values. Nullable codecs are merged
across every branch, including when selecting through `fromUnion`.

```ts
const recent = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.gte("2026-01-01 00:00:00")])

const archived = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.lt("2026-01-01 00:00:00")])

const combined = CH.unionAll(recent, archived).orderBy(["name", "asc"]).limit(100)

const compiled = CH.compileUnionUnsafe(combined, {})
// SELECT * FROM ( … UNION ALL … ) ORDER BY name ASC LIMIT 100
```

A `CHUnionQuery` is deliberately narrower than a `CHQuery` — it offers only `orderBy`, `limit`,
`offset`, and `format`. Those wrap the union in an outer `SELECT * FROM (…)`; the branches
themselves keep whatever ordering they declared.

Unions compile with **`compileUnion`**, not `compile`.

Each dialect writes the union the way its server needs it. An outer `orderBy`, `limit` or
`offset` goes on `SELECT * FROM (…) AS "__union"` everywhere but ClickHouse, which needs no alias.

- **Postgres and MySQL** put each branch in parentheses, so a branch keeps its own ORDER BY and
  LIMIT.
- **SQLite and MariaDB** write each branch as `SELECT * FROM (…) AS "__union_branch"`.
- **MariaDB** writes a selected integer literal as `CAST(n AS SIGNED) + 0`, in a union or not. MariaDB 11.4 sizes
  an integer literal in such a branch one digit short and cuts it to fit a DECIMAL that another
  branch has in the same column: `lit(97)` beside a `DECIMAL(5,4)` came back as `9.9999`. MySQL
  writes `CAST(n AS SIGNED)`.

```ts
MySQL.compileUnionUnsafe(MySQL.unionAll(withLiteral, withDecimal), {}, { dialect: MySQL.mariadbDialect })
// SELECT * FROM (SELECT CAST(97 AS SIGNED) + 0 AS `v` FROM `prices`) AS `__union_branch`
// UNION ALL
// SELECT * FROM (SELECT `prices`.`amount` AS `v` FROM `prices`) AS `__union_branch`
```

> **Numeric branch types.** ClickHouse has no common type for some numeric pairs (`UInt64` and
> `Int64`, `Int64` and `Float64`): it makes the column a `Variant`, which ORDER BY refuses, or,
> with `use_variant_as_common_type = 0`, rejects the union. So on ClickHouse the union's `orderBy`
> sorts a numeric column whose branches may differ in type (different declared types, or different
> arithmetic: `Id + 1` is `UInt64`, `Id - 1` is `Int64`) by `CAST(x AS Nullable(Float64))` and then
> `accurateCastOrNull(x, 'Int128')`, which keeps integers past 2^53 in exact order. The values
> themselves are not converted, so an `INSERT ... SELECT` or an `IN` over the union keeps them
> exact. A query over the union (`fromUnion`) that orders by such a column, or any other use that
> needs one type, should cast it in each branch.

_(Backed by `docs/unions-and-ctes.md > unionAll with an outer ORDER BY`.)_

## `fromUnion`

To aggregate _across_ a union, wrap it as the FROM source:

```ts
const outer = CH.fromUnion(combined, "branches")
	.select(($) => ({ name: $.name, total: CH.count() }))
	.groupBy("name")
```

Like [`fromQuery`](./joins-and-subqueries.md#subquery-in-from), accessors are flat (`$.name`),
and the outer query inherits the union's tenant scope — a union of branches bound to the same tenant stays
scoped.

The classic use is stitching a sealed hourly rollup onto a live raw-table branch for the
in-progress hour, then re-aggregating over both.

## CTEs

`withCTE(name, query)` prepends a `WITH` clause. Pass the query itself — it is compiled at
`compile` time and its tenant scope is **derived**, so nobody has to assert it:

```ts
const Recent = CH.table("recent", { external: true, columns: { Name: CH.string } })

const cte = CH.from(Events)
	.select(($) => ({ Name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])

const query = CH.from(Recent)
	.withCTE("recent", cte)
	.select(($) => ({ name: $.Name }))

const compiled = CH.compileUnsafe(query, {})
// WITH recent AS ( SELECT events.Name AS Name FROM events WHERE events.OrgId = 'org_123' )
// SELECT recent.Name AS name FROM recent
compiled.tenantScope // "single-tenant" — read off the CTE, not declared
```

To _read_ a CTE, declare an external table (`external: true`) whose name matches it and start the
query there. That is what gives you typed accessors over the CTE's columns; being external, it
carries no DDL, so `effect-orm generate` never tries to create it.

A CTE name is quoted like a select key: always on Postgres, SQLite and MySQL, and on ClickHouse
when it is not a plain name or is one of the words ClickHouse reads as something else (see
[Names](./params-and-compilation.md#names)). Give the CTE a plain name on ClickHouse: the external
table's name is written as given, so a CTE called `by service` would need the table declared as
``CH.table("`by service`", …)``.

_(Backed by `docs/unions-and-ctes.md > Selecting from a CTE`.)_

### The string form declares its own scope

`withCTE(name, sql, { tenantScope })` takes a pre-compiled body, for the rare case where that is
all you have:

```ts
const cteSql = "SELECT Name FROM events WHERE OrgId = 'org_123'"

CH.from(CH.table("recent", { external: true, columns: { Name: CH.string } }))
	.withCTE("recent", cteSql, { tenantScope: "single-tenant" })
	.select(($) => ({ name: $.Name }))
```

The body is opaque here, so the builder cannot see the `OrgId` filter inside it. If the CTE is
the query's row source and you omit `tenantScope`, the compiled query reads as `"cross-tenant"`
even though its SQL is perfectly well filtered.

Two caveats worth internalising:

- The declaration is an **assertion you are making**, not something that gets verified. Passing
  `tenantScope: "single-tenant"` for a CTE that does not filter by tenant defeats the mechanism. This is
  the reason to prefer the query form.
- It only takes effect when the query's `FROM` **names that CTE**. A CTE attached to a query
  that reads from a different table contributes nothing to the scope.

_(Backed by `docs/unions-and-ctes.md > A CTE needs its tenantScope declared`.)_

See [Tenant scoping](./tenant-scoping.md) for what `tenantScope` is for.
