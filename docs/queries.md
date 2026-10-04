# Building queries

A query starts with `from`, `fromQuery`, or `fromUnion` and is refined by chaining. Every
method returns a **new** query — nothing mutates.

```ts
const base = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])

const limited = base.limit(10) // `base` still has no LIMIT
```

That makes shared base queries safe to hand around and specialise per caller.

_(Backed by `docs/queries.md > Queries are immutable`.)_

## `select`

Two forms.

**By column name** — output keys match the column names:

```ts
CH.from(Events).select("Name", "DurationMs")
// SELECT Name AS Name, DurationMs AS DurationMs FROM events
```

**By callback** — for computed expressions, aliases, and aggregates:

```ts
CH.from(Events).select(($) => ({
	name: $.Name,
	p95: CH.quantile(0.95)($.DurationMs),
	count: CH.count(),
}))
```

The object keys become the SQL aliases _and_ the keys of the output row type. `select` is
required: compiling without one raises `QueryBuilderDefect`, which stays a defect — no request
value can remove a `select()`.

Calling `select` again replaces the previous projection rather than adding to it.

_(Backed by `docs/queries.md > select by column name`.)_

## `where`

`where` takes a callback returning an **array** of conditions, AND-joined together:

```ts
.where(($) => [
	$.OrgId.eq("org_123"),
	$.DurationMs.gt(1000),
])
```

Entries may be `undefined`, which drops them — that is what makes optional filters clean. See
[`when` / `whenTrue`](./expressions.md#optional-predicates).

**Calling `where` again adds conditions**, ANDed with the earlier ones, as in Kysely. A shared
base that filters by tenant keeps that filter however many `.where(...)` calls follow. Both flat
conditions and `.and()` preserve [tenant scoping](./tenant-scoping.md); `.or()` does not.
`having` accumulates the same way.

`select`, `groupBy`, `orderBy`, `limit`, `offset`, and `format` replace the previous value. Joins
and CTEs accumulate.

## `groupBy`

Takes **output keys** (the aliases from `select`), not raw column names:

```ts
.select(($) => ({ name: $.Name, count: CH.count() }))
.groupBy("name")
```

Once a query groups or aggregates, every column it reads outside an aggregate must be a
`groupBy` key, as both databases require. Compiling one that breaks the rule is a
`QueryBuilderDefect` naming the alias and column, instead of a server error:

- `select(($) => ({ name: $.Name, n: CH.count() }))` with no `groupBy("name")`;
- an aggregate in `where` or a join's `on` (filter on it in `having`);
- `groupBy` naming an aggregate alias.

An expression over a grouped column (`CH.lower($.Name)` with `Name` grouped) and a repeat of a
grouped expression are fine. Only SQL the builder writes is checked: a window (`CH.over`), a
`CH.sql` template, `rawExpr` and functions declared with `defineFn` / `makeExpr` are not looked
inside, so they can hide a mistake from this check but never trigger a false one.

## `having`

Filter groups after aggregation. The callback has the input-column accessor, so either repeat
an aggregate expression or reference an output alias with `CH.dynamicColumn("alias", type)`:

```ts
const query = CH.from(Events)
	.select(($) => ({ name: $.Name, count: CH.count() }))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
	.groupBy("name")
	.having(() => [CH.dynamicColumn("count", T.uint64).gte(CH.param.int("minimumCount"))])
```

Compile with `{ orgId: "org_123", minimumCount: 10 }` to emit `HAVING count >= 10`.
Use WHERE for row filters and HAVING for aggregate filters. A tenant predicate in HAVING
does not establish tenant scope.

The complete [HAVING recipe](./recipes.md#filter-aggregates-with-having) is checked directly from Markdown.

## `orderBy`

Takes `[column, direction]` tuples, one per sort key:

```ts
.orderBy(["count", "desc"], ["name", "asc"])
// ORDER BY count DESC, name ASC
```

Passing two bare strings, `.orderBy("count", "desc")`, is a type error.
Untyped callers receive `QueryBuilderDefect`; use a tuple for each sort key.

_(Backed by `docs/queries.md > orderBy takes tuples` and `> orderBy rejects a bare string`.)_

## `distinct` / `distinctOn`

```ts
.select("ServiceName").distinct()
// SELECT DISTINCT ServiceName …

.select(($) => ({ org: $.OrgId, id: $.Id })).distinctOn("org").orderBy(["org", "asc"], ["id", "desc"])
// SELECT DISTINCT ON (org) … — the newest row per org
```

`distinctOn` takes selected aliases and keeps the first row of each group in ORDER BY order;
Postgres wants those keys to lead the ORDER BY. Both ClickHouse and Postgres support it.

## `limit` / `offset`

```ts
.limit(50).offset(100)
```

Both take non-negative integers, not `param.*` expressions. A negative or fractional literal is
a type error; a value that arrives at runtime (`NaN`, `-1`, `1.5`) fails compilation with a
`QueryBuilderError` instead of being rounded. Still enforce an application maximum at your
request boundary. Use a stable `orderBy` when paging;
[Recipes](./recipes.md#paginate-a-grouped-result) shows where an offset is appropriate.

## `format`

```ts
.format("JSON") // appends `FORMAT JSON`
```

Accepts `"JSON"` or `"JSONEachRow"`. Most clients set the format themselves; use this only
when you are sending raw SQL somewhere that does not.

## Row locks

On Postgres, `forUpdate`, `forNoKeyUpdate`, `forShare` and `forKeyShare` add a locking clause
after LIMIT. Each takes `{ skipLocked?, noWait?, of? }`. The usual job-queue claim:

```ts
CH.from(Jobs)
	.select("id")
	.where(($) => [$.state.eq("queued")])
	.orderBy(["id", "asc"])
	.limit(1)
	.forUpdate({ skipLocked: true })
// … LIMIT 1 FOR UPDATE SKIP LOCKED
```

A lock lasts until the transaction ends, so run the query inside `Database.transaction`. These
are a `QueryBuilderDefect`, refused before anything is sent: `skipLocked` and `noWait` together;
a qualified name in `of` (use the alias or `jobs`, not `public.jobs`); a lock on a query with
DISTINCT, GROUP BY or HAVING, or on a `unionAll` branch, which Postgres refuses; and any lock on
ClickHouse, which has no row locks.

## `withCTE`

See [Unions and CTEs](./unions-and-ctes.md#ctes).

## Route and scope declarations

`.route("ingest")` and `.crossTenant()` attach metadata to the compiled result rather than
changing the SQL. Both are covered in [Tenant scoping](./tenant-scoping.md).

## Compiling

```ts
const compiled = CH.compileUnsafe(query, params)
```

`compile` is an alias of `compileCH`; both are exported. Unions compile with `compileUnion`.
See [Params and compilation](./params-and-compilation.md).
