# API reference

The package has one entry per database, each self-contained:

```ts
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
```

Both carry the whole [query builder](#query-builder-both-entries). Each adds its own column
types, functions, table definitions and a `compile` that defaults to its dialect:
[`/clickhouse`](#clickhouse) and [`/postgres`](#postgres). Everything else is on a
[subpath](#other-subpaths) for a narrower job.

## Naming conventions

Some ClickHouse functions collide with JavaScript reserved words or globals. The source defines
those with a trailing underscore, and **`/clickhouse` drops it**: `min_`, `max_`, `any_`,
`toString_`, `length_`, `left_`, `extract_`, `least_`, `greatest_`, `position_`, `lower_`,
`round_`, `path_` and `domain_` are all exported from `/clickhouse` under their bare names.

One exception, because it cannot be anything else:

| `/clickhouse` name | Also on `/expr` as | Note                             |
| ------------------ | ------------------ | -------------------------------- |
| `if_`              | `if_`              | `if` is a reserved word          |
| `in_` / `notIn`    | —                  | `Expr` methods; `in` is reserved |

Importing the kitchen-sink namespace
(`import * as CH from "@maple-dev/effect-orm/expr"`) gives you the raw underscored names
uniformly, which some codebases prefer for exactly this reason.

---

## Query builder (both entries)

Everything in this section is exported, identically, from both `/clickhouse` and `/postgres`.

### Query construction

| Export      | Signature                                 |
| ----------- | ----------------------------------------- |
| `from`      | `(table, alias?) => CHQuery`              |
| `fromQuery` | `(query, alias) => CHQuery`               |
| `fromUnion` | `(union, alias) => CHQuery`               |
| `unionAll`  | `(...queries) => CHUnionQuery`            |
| `update`     | `(table) => CHUpdateStart`, then `CHUpdate`: `.set(record \| fn)`, `.where(fn)` or `.allRows()`, `.returning(...)`, `.settings(record)`. See [Updating and deleting](./updates-and-deletes.md) |
| `deleteFrom` | `(table) => CHDelete`: `.where(fn)` or `.allRows()`, `.returning(...)`, `.settings(record)` |
| `insertInto` | `(table) => CHInsertStart`, then `CHInsert`; `.values(row \| rows)` or `.select(query)` sets its rows, `.settings(record)` ClickHouse `SETTINGS`, `.returning(...)` the RETURNING list, `.onConflictDoNothing(options?)` / `.onConflictDoUpdate(options)` the ON CONFLICT clause (Postgres). See [Inserting rows](./inserts.md) |

Tables come from the dialect's `table`: [`CH.table`](#tables-and-ddl) or
[`PG.table`](#tables-and-ddl-1).

### `CHQuery` methods

| Method                                                  | Notes                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `select(...names)` / `select(fn)`                       | Required before compiling                                             |
| `where(fn)`                                             | Returns `Array<Condition \| undefined>`; AND-joined                   |
| `groupBy(...outputKeys)`                                | Takes select aliases, not column names                                |
| `having(fn)`                                            | Post-aggregation filter; input accessor or `dynamicColumn` aliases    |
| `orderBy(...[col, dir])`                                | **Tuples**, not two strings                                           |
| `limit(n)` / `offset(n)`                                | Rounded before emission                                               |
| `format(fmt)`                                           | `"JSON"` \| `"JSONEachRow"`                                           |
| `distinct()` / `distinctOn(...aliases)`                 | `SELECT DISTINCT` / `SELECT DISTINCT ON (…)`                          |
| `forUpdate` / `forNoKeyUpdate` / `forShare` / `forKeyShare` | Postgres row locks; options `LockOptions` (`skipLocked`, `noWait`, `of`) |
| `innerJoin` / `leftJoin` / `crossJoin`                  | `(table, alias, on?)`                                                 |
| `innerJoinQuery` / `leftJoinQuery` / `crossJoinQuery`   | `(query, alias, on?)`                                                 |
| `withCTE(name, query)` / `withCTE(name, sql, options?)` | Typed query derives scope; SQL form can declare `options.tenantScope` |
| `route("ingest")`                                       | Metadata only                                                         |
| `crossTenant()`                                         | Forces `tenantScope: "cross-tenant"`                                  |

`CHUnionQuery` offers only `orderBy`, `limit`, `offset`, `format`.

### Compilation

Each entry exports `compile`, `compileUnsafe`, `compileUnion` and `compileUnionUnsafe`, defaulting
to its own dialect; `options.dialect` overrides it.

| Export               | Signature                                                                            |
| -------------------- | ------------------------------------------------------------------------------------ |
| `compile`            | `(query, params?, options?) => Effect<CompiledQuery<Output>, QueryBuilderError>`; also `(insert, params?, options?)`, whose options (`InsertCompileOptions`) are only `dialect` |
| `compileUnsafe`      | The same, returning `CompiledQuery<Output>` and throwing instead                     |
| `compileUnion`       | `(union, params, options?) => Effect<CompiledQuery<Output>, QueryBuilderError>`      |
| `compileUnionUnsafe` | The same, throwing instead                                                           |
| `rawCompiledQuery`   | `({ sql, tenantScope, reason, justification, rowSchema?, route?, dialect?, kind? }) => CompiledQuery` |

`Dialect`, `DialectClauses` and `ParamStyle` describe a database: how identifiers and literals
are written, how params reach the server, and which clauses exist. Pass one as
`options.dialect`. `DialectTransactions` (with `IsolationLevel` and `TransactionSettings`) says
which transactions the database supports; see [Database](./database.md). See [Params and compilation](./params-and-compilation.md#dialects) and
[Postgres](./postgres.md).

### Params

`param.string(name)`, `param.int(name)`, `param.float(name)`, `param.bool(name)`,
`param.dateTime(name)`, `param.dateTimeString(name)`, `param.dateTimeSeconds(name)`, and `param.of(type, name)` for any column
type. Each checks the value it is handed at compile
time; see [Params and compilation](./params-and-compilation.md#what-each-kind-accepts).

### Expressions

| Export                    | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `lit(value)`              | Literal `Expr` from a `string` or `number`                 |
| `sql(type)\`…\`` / `sql\`…\`` / `sql.cond\`…\`` | A template `Expr` (typed or untyped) or `Condition`; `sql.ident`, `sql.raw`, `sql.join`. See [Extending](./extending.md#chsql--sql-templates-inside-a-query). Types `SqlTag`, `SqlTemplateValue`, `SqlRaw`, `SqlIdent` |
| `rawExpr(sql, type)`      | Unescaped `Expr` from SQL text, with a declared type       |
| `untypedExpr<T>(sql)`     | Unescaped `Expr` with no type — costs the row schema       |
| `rawCond(sql)`            | Unescaped `Condition` from SQL text                        |
| `when(value, fn)`         | `Condition \| undefined`; skips `undefined`/`null`/`false` |
| `whenTrue(flag, fn)`      | Boolean-gated variant                                      |
| `inList(expr, values)`    | `expr IN ('a', 'b')`                                       |
| `inExprList(expr, exprs)` | Same for expression lists                                  |
| `notInList(expr, values)` | `expr NOT IN ('a', 'b')`                                   |
| `not(condition)`          | `NOT (…)`                                                  |
| `and(...conds)` / `or(...conds)` | One flat `(… AND …)` / `(… OR …)`; skips `undefined`, returns `undefined` when none are left |
| `dynamicColumn(name, t?)` | An `Expr` from a runtime column name — a `GROUP BY` alias  |
| `exists(q)`               | `EXISTS (…)` from a query or pre-compiled SQL              |
| `inSubquery(expr, q)`     | `expr IN (…)` from a query or pre-compiled SQL             |
| `notInSubquery(expr, q)`  | `expr NOT IN (…)`; note the NULL semantics                 |
| `outerRef<T>(name)`       | Reference an outer column in a correlated subquery         |

`Expr<T>` methods: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in_`, `notIn`, `between`, `notBetween`,
`isNull`, `isNotNull`, `like`, `notLike`,
`ilike` (string-only), and `add`, `sub`, `mul`, `div`, `mod` (number-only, **no parentheses**). `div` and `mod` decode
as `number | null` — ClickHouse sends `inf`/`nan` as JSON `null` — except by a numeric literal of
magnitude ≥ 1 (`Quotient<L, R>`), which keeps the dividend's nullability; use
`ifNull(ifNotFinite(expr, 0), lit(0))` for a guaranteed number otherwise.

#### Spliced sub-SELECTs

For SQL the builder has no syntax for — an inner query's text inside an aggregate or a tuple
comparison. The inner query is compiled by the **outer** `compile`, so its params resolve from the
outer set and its failures land in the outer error channel. See
[Joins and subqueries](./joins-and-subqueries.md#splicing-a-subquery-where-there-is-no-syntax-for-one).

| Export                             | Purpose                                   |
| ---------------------------------- | ----------------------------------------- |
| `subqueryExpr(q, type, wrap?)`     | Inner SQL as an `Expr` of a declared type |
| `untypedSubqueryExpr(q, wrap?)`    | Same with no type — costs the row schema  |
| `subqueryCond(q, wrap)`            | Inner SQL as a `Condition`                |

`wrap` receives the inner SQL and returns the text to emit. It defaults to wrapping the SQL in
parentheses, which is the plain "this value is a sub-SELECT" case.

`Condition` methods: `and`, `or` (both parenthesise; both drop the tenant marker).

`ColumnRef` adds `.get(key)` for `Map` columns; the result decodes as the map's value type.

### Extensibility

| Export                                 | Purpose                                            |
| -------------------------------------- | -------------------------------------------------- |
| `defineFn<Args, R>(name, result)`      | Declare a standard `fn(args…)` returning `Expr<R>` |
| `defineUntypedFn<Args, R>(name)`       | Same, for a result with no type to declare         |
| `defineCondFn<Args>(name)`             | Same, returning `Condition`                        |
| `sameAs(i)`                            | Result rule: decodes as argument `i`               |
| `firstTyped()`                         | Result rule: the first argument that has a type    |
| `firstTypedNonNull()`                  | Same, minus `\| null` — `coalesce`, `ifNull`       |
| `elementOf(i)`                         | Result rule: one element of argument `i`'s array   |
| `arrayOfArg(i)`                        | Result rule: an array of argument `i`              |
| `compileFnCall<R>(name, ...args)`      | Variadic/generic wrapper (untyped result)          |
| `compileTypedFnCall<R>(name, schema,)` | Same, with the result codec                        |
| `compileFnCallCond(name, ...args)`     | Same, returning `Condition`                        |
| `makeExpr(fragment, schema, literal?, uses?)` | Build an `Expr` from a fragment and its codec; `uses` carries params |
| `makeUntypedExpr(fragment, literal?, uses?)`  | Same with no codec — costs the row schema          |
| `makeCond(fragment, uses?)`            | Build a `Condition` from a fragment                |
| `schemaOf(expr)`                       | An expression's codec, or `undefined`              |
| `schemaOfAny(...exprs)`                | The first codec among several                      |
| `elementSchema(expr)`                  | The element codec of an array expression           |
| `withoutNull(schema)`                  | A codec minus its `null` arm, or `undefined`       |
| `paramPlaceholder(kind, name)`         | The `__PARAM_…__` text, for handwritten fragments  |

### Types

**Column plumbing** — `CHType` (every column type, on either dialect, is one), `InferTS` (the
decoded type of a column), `InferEncoded` (its wire type), `ColumnDefs`, `NullableColumnDefs`,
`OutputToColumnDefs`.

**Inference** — `InferOutput`, `InferQueryOutput`, `InferUnionOutput`, `SelectRowOf`,
`InsertRow`, `InsertRowOf`, `UpdateSet`, `UpdateSetOf`.

**Everything else** — `Table` (what `from` and the write builders accept; every `table` value is
one), `Expr`, `ColumnRef`, `Condition`, `Comparable` (what a value of a type may be compared
against), `MapValueOf`, `Subquery`, `ParamMarker`, `ParamKind`, `CHQuery`, `CHUnionQuery`,
`CHInsert`, `CHInsertStart`, `CHUpdate`, `CHUpdateStart`, `CHDelete`, `CHWrite`, `InsertValue`,
`InsertSelectMisfits`, `InsertSelectMissing`, `InsertSettingValue`, `ConflictTarget`,
`ConflictSet`, `OnConflictDoNothing`, `OnConflictDoUpdate`, `ColumnAccessor`,
`JoinedColumnAccessor`, `JoinOnCallback`, `LockOptions`, `CompiledQuery`, `CompiledQueryInput`,
`CompiledQueryRowSchema`, `RowSchemaMismatch`, `TenantScope`, `Dialect`, `DialectClauses`,
`DialectTransactions`, `IsolationLevel`, `TransactionSettings`, `ParamStyle`, `FnResult`.

### Errors

These errors are Effect `Schema.TaggedError` classes. Expected failures can be caught by
their full namespaced tag; `QueryBuilderDefect` remains a defect rather than a typed failure.

#### `QueryBuilderError`

Tag `"@maple-dev/effect-orm/QueryBuilderError"`. Raised while compiling, and surfaced in
`compile`'s error channel (thrown by `compileUnsafe`).

| `code`             | Cause                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `UnresolvedParam`  | A param the params bag has no value for                                  |
| `InvalidLiteral`   | A param value, or a comparison operand, the column's codec rejects       |
| `InvalidArguments` | Arguments a function cannot use — an empty condition list, a bad pattern, an insert with no rows or an unknown column, more bound values than the dialect allows |

#### `QueryBuilderDefect`

Tag `"@maple-dev/effect-orm/QueryBuilderDefect"`. A DSL misuse no runtime value can cause
— a query with no `select()`, an `orderBy` entry that is not a tuple, a bad param name, a
comparison called on a param marker. Always
a defect: `compile` maps only `QueryBuilderError` into the error channel. See
[Failures and defects](./params-and-compilation.md#failures-and-defects).

#### `CompiledQueryEncodeError`

Tag `"@maple-dev/effect-orm/CompiledQueryEncodeError"`. Fails the `encodeRows` Effect
when a decoded row cannot be written back to its wire shape. Fields: `message`, `rowIndex`,
`cause`.

#### `CompiledQueryDecodeError`

Tag `"@maple-dev/effect-orm/CompiledQueryDecodeError"`. Fails the `decodeRows` /
`decodeFirstRow` Effect. Fields: `message`, `rowIndex`, `cause`.

#### `SchemaDefinitionDefect`

Tag `"@maple-dev/effect-orm/SchemaDefinitionDefect"`. Thrown by `table` (either dialect) and
`CH.materializedView` for a definition that cannot render: a name that is not a plain
identifier, a MergeTree-family engine with no `orderBy`, a view reading from a union.

---

## `/clickhouse`

`import * as CH from "@maple-dev/effect-orm/clickhouse"`: the query builder above, plus the
following.

### Tables and DDL

`table` is the only way to declare a table. A managed table carries the DDL
`effect-orm generate` diffs; see [Schema and migrations](./migrations.md).

```ts
const Events = CH.table("events", {
	columns: {
		OrgId: CH.string,
		Name: CH.string,
		Timestamp: CH.dateTime,
		DurationMs: CH.uint64,
		Status: CH.column(CH.uint16, { default: 200 }),
	},
	engine: CH.engine.mergeTree(),
	orderBy: ["OrgId", "Timestamp"],
	tenantColumn: "OrgId",
})
```

| Export             | Signature                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `table`            | `(name, TableDefinition) => SchemaTable`, or `(name, ExternalTableDefinition) => Table`  |
| `column`           | `(type, ColumnOptions) => ColumnSpec`: a column with options; a bare type works where none are needed |
| `engine`           | `mergeTree()`, `replacingMergeTree({ version?, isDeleted? })`, `summingMergeTree({ columns? })`, `aggregatingMergeTree()`, `collapsingMergeTree(sign)`, `versionedCollapsingMergeTree(sign, version)`, `null()`, `memory()` |
| `index`            | `(name, expr, type, granularity = 1) => IndexSpec`: a data-skipping index                |
| `ttlAfterDays`     | `(expr, days) => DdlExpr`: `<expr> + toIntervalDay(days)`, the usual row TTL             |
| `materializedView` | `(name, { to, as }) => MaterializedView`: `as` is a DSL query; its output is checked against `to`'s columns (`MisfitColumns`). Never `POPULATE` |

**`TableDefinition`** — `columns` (required), `engine` (required), `orderBy` (required for the
MergeTree family; `[]` for `ORDER BY tuple()`), `partitionBy`, `primaryKey`, `ttl`, `settings`,
`indexes`, `comment`, `tenantColumn`. Key and expression options are `DdlKey` / `DdlExpr`: SQL
text, or a callback building it from the column accessor.

**`ExternalTableDefinition`** — `{ external: true, columns, tenantColumn? }`. A table the schema
does not own: a system table, a table function, a subquery, a CTE name, a table another tool
migrates. No DDL, so `generate` never sees it; the name is written verbatim as the FROM target;
`columns` may be empty.

```ts
const One = CH.table("system.one", { external: true, columns: {} })
const Numbers = CH.table("numbers(10)", { external: true, columns: { number: CH.uint64 } })
```

**`ColumnOptions`** — at most one of `default` (a literal, encoded through the column's type),
`defaultExpr`, `materialized`, `alias`; plus `codec` and `comment`. They type inserts: a column
with `default` or `defaultExpr` may be left out (`DefaultedColumnsOf`), a `materialized` or
`alias` column may not be written (`ComputedColumnsOf`).

**Types** — `ColumnInput` (a type or a `ColumnSpec`), `ColumnsOf` (the query-side column types
of a `columns` record), `TableDdl`, `SchemaTable`, `MaterializedView`, `IndexSpec`. A definition
that cannot render throws `SchemaDefinitionDefect` while the module loads.

### Column types

**Constructors** — `string`, `bool`, `uint8`, `uint16`, `uint32`, `uint64`, `int32`,
`int64`, `float64`, `dateTime`, `dateTime64`, `dateTimeString`, `dateTime64String`, `map`,
`array`, `nullable`, `aggregateState(fn, ...args)`, `custom(sql, schema, literalSchema?)`,
`brand(type, schema)` (the type narrowed by `schema`: a branded id, a literal union; see
[Branded columns](./tables-and-types.md#branded-columns)), and `untyped(sql)` for a wire value
passed through unvalidated. See [Tables and column types](./tables-and-types.md).

**Type descriptors** — `CHString`, `CHBool`, `CHUInt8`, `CHUInt16`, `CHUInt32`,
`CHUInt64`, `CHInt32`, `CHInt64`, `CHFloat64`, `CHDateTime`, `CHDateTime64`, `CHDateTimeString`,
`CHDateTime64String`, `CHMap`, `CHArray`, `CHNullable`, and `CHStringLike` (any `String` column,
branded or not, for a helper that accepts either).

`CHNumber` is the codec the 64-bit integer types decode with: a JSON number, or the same value
quoted.

### Functions

#### Aggregate

`count()`, `countIf(cond)`, `avg(e)`, `sum(e)`, `min(e)`, `max(e)`, `any(e)`, `uniq(e)`,
`sumIf(e, cond)`, `avgIf(e, cond)`, `minIf(e, cond)`, `maxIf(e, cond)`, `anyIf(e, cond)`,
`groupUniqArray(e)`, `groupUniqArrayIf(e, cond)`, `groupUniqArrayArray(e)`, `uniqIf(e, cond)`, `uniqExact(e)`,
`argMin(value, order)`, `argMax(value, order)`, `argMaxMerge(e)`, `quantile(q)(e)` _(curried)_,
`windowFunnel(window, mode?)(ts, ...conds)` and `sequenceMatch(pattern)(ts, ...conds)`
_(both curried; `WindowFunnelMode` is the mode union)_.

`min`/`max` return `Expr<NonNullable<T>>`; `groupUniqArray` returns `Expr<ReadonlyArray<T>>`.

#### String

`toString(e)`, `length(e)`, `lower(e)`, `hex(e)`, `match(e, pattern)`, `matchCond(e, pattern)`
→ `Condition`, `domain(url)`, `path(url)`, `cutQueryString(url)`, `position(haystack, needle)`,
`positionCaseInsensitive(a, b)`, `left(e, n)`, `extract(e, pattern)`,
`replaceOne(haystack, pattern, replacement)`, `concat(...exprs)`, `hasToken(haystack, token)`,
`hasAllTokens(haystack, tokens)`.

`hasToken` and `hasAllTokens` return `Condition`.

#### Numeric

`toFloat64(e)`, `toFloat64OrZero(e)`, `toUInt16OrZero(e)`, `toUInt64(e)`, `toInt64(e)`,
`intDiv(a, b)`, `round(e, decimals?)`, `least(...exprs)`, `greatest(...exprs)`,
`cityHash64(...exprs)`.

#### Date/time

`toStartOfInterval(col, seconds)`, `toStartOfHour(col)`, `toUnixTimestamp(col)`,
`toUnixTimestamp64Nano(col)`, `intervalSub(col, seconds)`, `intervalAdd(col, seconds)`,
`formatDateTime(col, format)`, `toDateTime(col)`, `toStartOfMinute(col)`, `toHour(col)`.

#### Conditional

`if_(cond, then, else)`, `multiIf([[cond, value], …], fallback)`, `coalesce(...exprs)`,
`ifNull(expr, fallback)`, `nullIf(expr, value)`, `ifNotFinite(expr, fallback)` (`expr` unless it
is `nan`/`inf` — the SQL-side guard for division; preserves SQL NULL). `nullIf` returns
`Expr<T | null>`. `avg`, `avgIf`, and `quantile` return `Expr<number | null>` for empty input.

#### Array

`arrayOf(...exprs)`, `arrayStringConcat(arr, sep)`, `arrayFilter(fn, arr)`, `arrayJoin(arr)`,
`arraySort(arr)`, `arrayReverseSort(arr)`, `arrayDistinct(arr)`, `arrayPushFront(arr, value)`,
`arrayElement(arr, index)`, `has(arr, value)` → `Condition`.

#### Map

`mapContains(map, key)` → `Condition`, `mapGet(map, key)`, `mapKeys(map)`, `mapValues(map)`,
`mapLiteral(...[key, expr])`. Prefer `$.Column.get(key)` for a declared `Map` column.

#### JSON

`toJSONString(e)`.

#### Window

`over(expr, spec)`, `windowSpec({ partitionBy?, orderBy?, frame? })`,
`rowsBetween(start, end)`, `lagInFrame(expr, offset, defaultValue)` _(all three arguments
required)_, and the frame bounds `currentRow`, `unboundedPreceding`, `unboundedFollowing`,
`preceding(n)`, `following(n)`.

```ts
CH.over(
	CH.lagInFrame($.DurationMs, 1, 0),
	CH.windowSpec({
		partitionBy: [$.Name],
		orderBy: [[$.Timestamp, "asc"]],
		frame: CH.rowsBetween(CH.unboundedPreceding, CH.currentRow),
	}),
)
```

Types: `WindowSpec`, `CompiledWindowSpec`, `WindowFrameBound`, `WindowRowsFrame`,
`WindowOrderDirection`.

### Dialect

`compile` and the other compile functions default to `clickhouseDialect`: params written into the
SQL as ClickHouse literals.

---

## `/postgres`

`import * as PG from "@maple-dev/effect-orm/postgres"`: the query builder above, plus the
following. See [Postgres](./postgres.md).

### Tables and DDL

```ts
const Users = PG.table("users", {
	columns: {
		id: PG.column(PG.int8, { identity: "always" }),
		orgId: PG.text,
		email: PG.text,
		createdAt: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("users_org_email_idx", ["orgId", "email"])],
	tenantColumn: "orgId",
})
```

| Export                  | Signature                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `table`                 | `(name, TableDefinition) => PgSchemaTable`, or `(name, ExternalTableDefinition) => Table` |
| `column`                | `(type, ColumnOptions) => ColumnSpec`                                              |
| `index`                 | `(name, on, IndexOptions?) => IndexSpec`: columns, or a callback building expressions |
| `uniqueIndex`           | The same, `UNIQUE`; with `where`, a partial unique index                           |
| `foreignKey`            | `({ columns, references, foreignColumns, onDelete?, onUpdate?, name? }) => ForeignKeySpec`; `references` is a `Table` (its columns are checked) or a name |
| `defaultForeignKeyName` | `(table, columns, foreignTable, foreignColumns) => string`: the name drizzle-kit gives, shortened past 63 characters as drizzle-kit does |

**`TableDefinition`** — `columns` (required), `primaryKey` (column names, or
`{ columns, name? }`), `indexes`, `foreignKeys`, `tenantColumn`.

**`ExternalTableDefinition`** — `{ external: true, columns, tenantColumn? }`, as on
`/clickhouse`: a view, a catalog table, one another tool migrates. No DDL.

**`ColumnOptions`** — one of `default`, `defaultExpr`, `identity` (`"always"` or
`"by default"`); any of them lets an insert leave the column out (`DefaultedColumnsOf`).

**`IndexOptions`** — `where` (a `DdlPredicate`: SQL text or a callback returning a condition),
`using` (the access method; default `btree`).

**Types** — `ColumnInput`, `ColumnSpec`, `ColumnsOf`, `IndexSpec`, `ForeignKeySpec`,
`ReferentialAction` (drizzle's lowercase spelling or the catalog's), `TableDdl`, `PgSchemaTable`,
`DdlExpr`, `DdlKey`. A definition that cannot render throws `SchemaDefinitionDefect`.

### Column types

`text`, `uuid`, `bool`, `int2`, `int4`, `int8`, `float4`, `float8`, `numeric`, `timestamptz`,
`jsonb(schema?)`, `array(type)`, `nullable(type)`, `custom(sql, schema, literalSchema?)`,
`brand(type, schema)`. See [Postgres column types](./postgres.md#column-types).

Types: `PgType` (a Postgres column type; a `CHType`), `PgArray`, `PgNullable`. Codecs:
`PgNumber` (a number, numeric string or `bigint`), `PgTimestampLiteral` (an instant written as
ISO-8601), `timestampLiteral(format)` (the same with another format), and `pgTimestampToIso`,
which normalizes Postgres timestamp text to ISO-8601.

### Functions

`count()`, `countDistinct(x)`, `countIf(c)`, `sum(x)`, `sumIf(x, c)`, `avg(x)`, `min(x)`,
`max(x)`, `percentileCont(f, x)`, `arrayAgg(x)`, `dateTrunc(unit, ts)` (`DateTruncUnit` is the
unit union), `dateBin(seconds, ts)`, `now()`, `lower(x)`, `upper(x)`, `length(x)`,
`coalesce(x, fallback)`, `nullIf(x, value)`, `jsonText(x, key)`. See
[Postgres functions](./postgres.md#functions) for the SQL each writes.

### Dialect

`compile` and the other compile functions default to `postgresDialect`: numbered `$n`
placeholders, double-quoted identifiers.

---

## Other subpaths

| Symbol                                                                                           | Subpath           |
| ------------------------------------------------------------------------------------------------ | ----------------- |
| The ClickHouse functions under their raw underscored names, the expression helpers and function factories, and `toFragment` — value → `SqlFragment`, for hand-rolled function wrappers | `/expr`           |
| `raw`, `str`, `ident`, `int`, `join`, `as_`, `lazy`, `when`, `compile`, `escapeClickHouseString` | `/sql`            |
| `SqlQuery`, `compileQuery`                                                                       | `/sql`            |
| `ClickHouseStatement`, `parseStatement`, `renderStatement`, `withSettings`, `withFormat`         | `/sql`            |
| `ClickHouseStatementFromString`, `splitTerminalClauses`, `maskLiteralsAndComments`               | `/sql`            |
| Schema tooling: `isSchemaObject`, `makeSnapshot`, `renderSchema`, `diffSchemas`, `diffPgSchemas`, `fromDrizzleSnapshot`, snapshot and entity schemas | `/schema`         |
| `run`, `status`, `verify`, `baseline`, `MigrationDriver` and the migrate errors                  | `/migrate`        |
| `Database`, `run`, `sql`, `query`, `execute`, `transaction`, `requireTransaction`, `retryContention`, `Transaction` | `/database` |
| `DatabaseError`, `TransactionCommitFailed`, `TransactionRollbackFailed` and the other transaction errors | `/database` |
| `defineConfig`, `generate`, `check`, `loadSchema`, `readMigrations`, `analyze`, `KitError`       | `/kit`            |
| `defineSuite`, `query`, `caseFromCompiled`, `runSuite`, `compareRuns`, `compareBudgets`          | `/benchmark`      |
| `Suite`, `RunOutput`, `BenchmarkError` and benchmark contracts                                   | `/benchmark`      |
| `makeHttpClient`, `makeHttpTransport`, `httpConfigFromEnv`                                       | `/benchmark/http` |
| `runCli`                                                                                         | `/benchmark/cli`  |

`/schema` reads tables; it does not declare them. Declare tables with `table` from `/clickhouse`
or `/postgres`. See [Schema and migrations](./migrations.md), [Database](./database.md),
[Running a query](./running-queries.md) for what the `/sql` statement helpers are for, and
[Benchmarking](./benchmarking.md) for the complete benchmark API, command workflow, result
verification, and JSON protocol.

Note `/sql` exports a `compile` (fragment → string) distinct from the dialect entries' `compile`
(query → `CompiledQuery`), and a `when` distinct from the query builder's `when` (optional
conditions).
