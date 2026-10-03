# Writes: INSERT

Status: phase 1 built (`insertInto(...).values(...)`, see `docs/inserts.md`); phases 2 to 4 not
started. Section 11 lists where the build differs from the plan. UPDATE and DELETE come later and
will reuse what this note sets up (the write-statement state, the `RETURNING` path, value
encoding).

## Goal

Build INSERT statements from the same table definitions the SELECT builder reads, for both
dialects, so that the ~101 Maple insert sites (`design/transactions.md` §5) and ClickHouse
ingest code stop writing SQL by hand. Writes meet the interface §5 of the transactions plan
already fixed: **a write compiles to a `CompiledQuery` whose `decodeRows` decodes the
`RETURNING` list (an empty row schema without one), so `Database.run` runs writes and reads
alike.**

Same rules as the reads: the builder is an immutable value, nothing touches the network, values
are encoded through the column's own codec (the same one that decodes it), and a clause a
dialect lacks fails at compile time with a `QueryBuilderError` instead of producing SQL that
"may run".

## What it looks like

```ts
// Postgres
const insertKey = CH.insertInto(ApiKeys)
	.values({ id: CH.param.string("id"), orgId: CH.param.string("orgId"), name: "default" })
	.returning(($) => ({ id: $.id, createdAt: $.createdAt }))

const [row] = yield* Database.run(insertKey, { id, orgId }) // { id: string; createdAt: DateTime.Utc }

// multi-row, values inline
yield* Database.run(CH.insertInto(Events).values(rows)) // rows: ReadonlyArray<InsertRow<typeof Events>>

// INSERT ... SELECT, output checked against the target's columns
CH.insertInto(DailyRollup).select(CH.from(Traces).select(($) => ({ day: ..., OrgId: $.OrgId, count: CH.count() })))

// upsert (Postgres)
CH.insertInto(Counters)
	.values({ key: "k", count: 1 })
	.onConflict(["key"])
	.doUpdate(($, excluded) => ({ count: $.count.add(excluded.count) }), { where: ($) => $.locked.eq(false) })
```

## 1. Builder and state

New file `src/ch/insert.ts`, beside `query.ts`:

```ts
interface CHInsertState {
	readonly table: Table<string, ColumnDefs>
	readonly source:
		| { readonly _tag: "Values"; readonly rows: ReadonlyArray<Record<string, unknown>> }
		| { readonly _tag: "Select"; readonly query: CHQuery<any, any, any, any> | CHUnionQuery<any> }
	readonly returningFn?: ($: ColumnAccessor<any>) => Record<string, Expr<any>>
	readonly conflict?: ConflictClause // §5
	readonly settings?: Readonly<Record<string, string | number | boolean>> // ClickHouse, §6
}

interface CHInsert<Cols, Returning = never, Route = undefined> {
	readonly _tag: "CHInsert"
	readonly _state: CHInsertState
	values(row: InsertRow<Cols> | ReadonlyArray<InsertRow<Cols>>): CHInsert<...>
	select<Q>(query: Q & FitsTarget<Q, Cols>): CHInsert<...>
	returning<S>(fn: ($: ColumnAccessor<Cols>) => S): CHInsert<Cols, InferOutput<S>, Route>
	onConflict(...), settings(...), route(...)
}
```

`insertInto(table)` returns a `CHInsert` with no source; compiling one without `values` or
`select` is a `QueryBuilderError` (`code: "EmptyInsert"`), as is `values([])`.

## 2. The insert row type

```ts
type InsertRow<Cols, Optional extends keyof Cols = InsertOptional<Cols>> =
	{ readonly [K in Exclude<keyof Cols, Optional | Computed>]: InsertValue<Cols[K]> } &
	{ readonly [K in Optional]?: InsertValue<Cols[K]> }

type InsertValue<T> = Comparable<InferTS<T>> | Expr<Widen<InferTS<T>>> // a value, a param, or an expression
```

- A value is the decoded TS type (`DateTime.Utc`, also `Date`/string where `Comparable` already
  accepts them), a `param.*` marker, or any `Expr` of the column's type (`CH.now()`,
  `rawExpr(...)`). Params make an insert a reusable prepared value, like a SELECT.
- `undefined` (or an absent key) means "use the column's default"; `null` means NULL and only
  type-checks on a `nullable(...)` column.
- **Which columns are optional**: nullable columns, plus columns that declare a default.
  `defineTable` already knows this (`ColumnOptions.default` / `defaultExpr`), but `ColumnsOf`
  throws it away; it must keep a phantom set of defaulted keys on `SchemaTable`. `MATERIALIZED`
  and `ALIAS` columns are `Computed`: not insertable at all, a type error if present.
- Plain `table()` has no defaults information today. Add `TableOptions.defaults?: ReadonlyArray<keyof Columns>`
  (Postgres `serial` / `DEFAULT now()` columns, which the query-side `table()` is what Maple
  uses until Postgres `defineTable` exists). Open question 1.

## 3. Compiling VALUES

New `src/ch/compile-insert.ts`. `compileCH` / `compile` dispatch on `_tag: "CHInsert"`, so every
existing entry point (root `compile`, `postgres` `compile`, `Database.run`) accepts an insert
without a new name.

- **Column list**: the union of keys over all rows, in table-definition order (not object
  order, so two rows with different key order cannot swap values, the same rule unions follow).
  Always written out: `INSERT INTO t (a, b) VALUES ...`, never positional.
- **A key missing from some rows**: Postgres writes `DEFAULT` in that slot. ClickHouse: verify
  on the matrix whether `DEFAULT` is accepted in `VALUES`; if not, fail with
  `code: "RaggedInsert"` and tell the caller to split the batch. Open question 2.
- **Values**: each literal is encoded through the column's codec (`encodeColumnLiteral`
  already does this for DDL defaults). ClickHouse inlines it as a literal; Postgres binds it as
  `$n`, with the column's SQL type as a cast (`$3::timestamptz`) so an untyped param cannot be
  inferred wrong — the problem `placeholderCasts` solves for params today, but here the column
  type is known exactly. Params and expressions go through the existing fragment renderer and
  `renderParams`, so one statement mixes them freely.
- **Bind limit**: Postgres caps a statement at 65535 parameters. Exceeding it is a
  `QueryBuilderError` (`code: "TooManyParameters"`) naming the row count that would fit. No
  automatic chunking: it would silently split one atomic statement into several and reorder
  `RETURNING` across them.
- **Row schema**: none without `returning` (`rowSchemaSource: "derived"`, empty struct, so
  `decodeRows` over the empty result is exact rather than an identity cast).

### Tenant scope

An insert has a scope like a SELECT, derived, never asserted:

- target table has a `tenantColumn`: the type already requires it. `single-tenant` when every row
  gives it the same param or the same literal; `cross-tenant` when rows differ; an `Expr` that
  is not a param or literal makes it `cross-tenant` (the proof cannot see through it).
- no tenant column: `untenanted`.
- `INSERT ... SELECT`: the SELECT's scope, combined with the rule above for the selected tenant
  column.

## 4. `RETURNING` and running writes

- `Dialect.clauses.returning: boolean` (Postgres true, ClickHouse false). `returning` on
  ClickHouse fails at compile, like `.format()` on Postgres.
- The row schema is derived from the returning select exactly as `deriveRowSchema` does for
  SELECT, so `Database.run(insert)` returns typed, decoded rows. `RowOf<CHInsert<..., R>>` is `R`.
- **ClickHouse execution**: `Database.run` sends queries through the client's query path, which
  asks for a JSON result an INSERT does not have. A compiled write without `RETURNING` must go
  through the same `command` wrapper `execute` uses. `CompiledQuery` gains
  `kind: "select" | "write"` so `run` can choose; `run` returns `[]` for a write without
  `RETURNING`.
- `Runnable` widens to include `CHInsert`; `compileFor` gains the third branch.

## 5. `INSERT ... SELECT`

- Typed: the SELECT's output must fit the target columns, checked with the `MisfitColumns` type
  `materializedView` already uses (move it out of `schema/define.ts` into `ch/types.ts`). A
  required target column missing from the output is also a type error.
- The column list is the output's aliases in select order, so ClickHouse's positional matching
  and Postgres's agree.
- ClickHouse backfills over big tables can outlast an HTTP timeout (`design/migrations.md`); that
  stays the caller's concern, but the docs page says so.

## 6. `ON CONFLICT` (Postgres)

Maple: 25 `DO UPDATE`, 43 `DO NOTHING`, 66 `excluded.` references, 6 `setWhere`.

```ts
.onConflict(target)               // ["col", ...] | { constraint: "name" } | omitted (DO NOTHING only)
	.doNothing()
	.doUpdate(($, excluded) => ({ col: expr, ... }), { where?: ($, excluded) => Condition })
```

- `excluded` is a `ColumnAccessor` over the target's columns rendering as `excluded."col"`, so
  `excluded.count` is an `Expr` of the column's type.
- The `set` record is typed like an insert row (values, params, expressions), all keys optional.
- `Dialect.clauses.onConflict: boolean`; ClickHouse fails at compile and the message points at
  `ReplacingMergeTree`.
- `DO NOTHING` with `RETURNING` returns no row for a skipped insert; the docs say so, because it
  is the usual Drizzle surprise.

## 7. ClickHouse specifics

- `.settings({ async_insert: 1, wait_for_async_insert: 1 })` renders
  `INSERT INTO t (...) SETTINGS ... VALUES ...`. Keys are checked as identifiers, values as
  literals. Postgres fails at compile. Note: an insert inside a ClickHouse transaction needs
  `async_insert=0` (`design/transactions.md` §3), irrelevant while ClickHouse transactions are
  `none`.
- **Bulk ingest**: large batches should not be SQL text. Add `encodeInsertRows(table, rows)`
  returning wire-shaped JSON objects (the column codecs run backwards, the way `encodeRows`
  works) for `client.insert({ format: "JSONEachRow" })`. Same row type and validation as
  `values`, no SQL. Phase 4; skipped if no consumer wants it.

## 8. Tests

- **Exact SQL** (`src/ch/insert.test.ts`, snapshot in `tests/core-sql.test.ts`): single and
  multi-row, column order independent of key order, defaults omitted, `DEFAULT` slots, NULL,
  params, expressions, every column type's literal for both dialects, `TooManyParameters`,
  `EmptyInsert`, unsupported clauses per dialect, tenant scope cases.
- **Types** (`src/ch/insert.test-d.ts`): required vs optional keys, `null` only on nullable,
  `MATERIALIZED` / `ALIAS` rejected, branded columns accept plain params, `returning` infers
  `RowOf`, `INSERT ... SELECT` misfit and missing-column errors.
- **PGlite** (`src/pg/postgres.test.ts`): insert then select round-trips every type;
  `RETURNING` decodes; `ON CONFLICT` both forms with `excluded` and `where`; insert inside
  `Database.transaction` rolls back.
- **ClickHouse matrix** (`tests/*.clickhouse.test.ts`): `Database.run(insert)` goes through
  the command path on every server; round-trip of every column type incl. `Map`, `Array`,
  `Nullable`, `DateTime64`; `DEFAULT` in `VALUES` (answers open question 2); `SETTINGS`;
  `INSERT ... SELECT`.
- **Docs**: `docs/inserts.md` with examples extracted by `check-doc-examples.mjs`, citations to
  `src/docs-examples.test.ts`; update `docs/database.md` ("the builder compiles SELECTs only"),
  `docs/README.md` ("does not ... insert rows"), `docs/reference.md`, and the exports check.

## 9. Phases

1. **VALUES on both dialects.** `insertInto`, `values`, the row type with defaults (§2),
   compile dispatch, value encoding and binding, tenant scope, `CompiledQuery.kind`,
   `Database.run` command path. Unblocks most Maple sites that do not read back.
2. **`RETURNING`.** `Dialect.clauses.returning`, derived row schema, `RowOf`.
3. **`ON CONFLICT`.** `doNothing`, `doUpdate` with `excluded` and `where`.
4. **`INSERT ... SELECT`** and ClickHouse `SETTINGS`; `encodeInsertRows` if wanted.

Each phase lands with its tests and docs. UPDATE and DELETE follow as their own phases in this
note, reusing `kind: "write"`, the returning path and the `set` record type from §6.

## 10. Decisions

1. **Defaults on plain `table()`**: `TableOptions.defaults`, a list of column names.
   `defineTable` derives the same from `default` / `defaultExpr`, and records `materialized` /
   `alias` columns as computed. `column()` infers which option names were given, so this needs
   no change at its call sites.
2. **Ragged multi-row batches on ClickHouse**: `DEFAULT` in `VALUES` works on both matrix
   servers (26.2.19.43 and 26.8.2.7), including for an expression default, so both dialects
   write `DEFAULT`.
3. **One name**: `compile` / `compileUnsafe` are overloaded for an insert; `Database.run` takes
   one unchanged.
4. **Tenant scope for writes**: derived and reported as for reads; nothing is refused.

## 11. Where the build differs

- **Values are bound without a cast.** §3 planned `$3::timestamptz`. Postgres coerces a
  placeholder in `INSERT ... VALUES` to the target column already, so the cast adds nothing.
  Each value is encoded through its column's `literalSchema` (so a failure names the row and
  column), then passed as an internal param of an identity type: ClickHouse inlines it,
  Postgres binds it, through the same `renderParams` every query uses.
- **`CompiledQuery.kind`** is `"select" | "insert"`, not `"select" | "write"`. `rawCompiledQuery`
  takes it as an option, so a handwritten INSERT can say so too.
- **The bound-value limit is a dialect field**, `ParamStyle.maxParameters`, so it applies to
  queries as well and to a later dialect. The error is `InvalidArguments`; no new error code.
- **An insert's row schema** is an empty struct with `rowSchemaSource: "derived"`.
