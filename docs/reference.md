# API reference

The package has one entry per database, each self-contained:

```ts
import * as CH from "@maple-dev/effect-orm/clickhouse"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as SQLite from "@maple-dev/effect-orm/sqlite"
import * as MySQL from "@maple-dev/effect-orm/mysql"
```

All carry the whole [query builder](#query-builder-every-entry). Each adds its own column
types, functions, table definitions and a `compile` that defaults to its dialect:
[`/clickhouse`](#clickhouse), [`/postgres`](#postgres), [`/sqlite`](#sqlite-and-d1) and
[`/mysql`](#mysql-and-mariadb). Everything else is on a [subpath](#other-subpaths) for a
narrower job.

The builder's own types keep the `CH` prefix they had when it was a ClickHouse builder
(`CHQuery`, `CHInsert`, `CHUpdate`, `CHDelete`, `CHUnionQuery`, `CHType`): they are the same
types in every entry, so a Postgres query is a `PG.CHQuery`.

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

## Query builder (every entry)

Everything in this section is exported, identically, from `/clickhouse`, `/postgres`, `/sqlite` and `/mysql`.

### Query construction

| Export      | Signature                                 |
| ----------- | ----------------------------------------- |
| `from`      | `(table, alias?) => CHQuery`; the table may be a `TableFunction`, such as `SQLite.jsonEach(…)` |
| `selectNoFrom` | `(fn) => CHQuery`: a SELECT of values with no FROM; MySQL writes `FROM DUAL`. See [Insert ... select](./inserts.md#insert--select) |
| `fromQuery` | `(query, alias) => CHQuery`               |
| `fromUnion` | `(union, alias) => CHQuery`               |
| `unionAll`  | `(...queries) => CHUnionQuery`            |
| `update`     | `(table) => CHUpdateStart`, then `CHUpdate`: `.from(source, alias)` (before `set`, once, giving a `CHUpdateFromStart`; Postgres and SQLite, `UpdateFromClause` elsewhere), `.set(record \| fn)`, `.where(fn)` or `.allRows()`, `.returning(...)`, `.settings(record)`. See [Updating and deleting](./updates-and-deletes.md) |
| `deleteFrom` | `(table) => CHDelete`: `.where(fn)` or `.allRows()`, `.returning(...)`, `.settings(record)` |
| `tableSchemas` | `(table) => TableSchemas`: the `select`, `insert`, `update`, `json`, `jsonCreate` and `jsonUpdate` row Schemas. See [Row Schemas](./tables-and-types.md#row-schemas) |
| `insertInto` | `(table) => CHInsertStart`, then `CHInsert`; `.values(row \| rows)` or `.select(query)` sets its rows, `.settings(record)` ClickHouse `SETTINGS`, `.returning(...)` the RETURNING list, `.onConflictDoNothing(options?)` / `.onConflictDoUpdate(options)` the ON CONFLICT clause (Postgres and SQLite), `.onDuplicateKeyUpdate({ set })` the ON DUPLICATE KEY UPDATE clause (MySQL and MariaDB). See [Inserting rows](./inserts.md) |
| `fillDefaults` | `(write) => Effect<write, never, RequirementsOf<write>>`: runs the `defaultFn` / `onUpdate` Effects of an insert's or update's table into its rows or SET. `Database.run` calls it; call it before `compile` when you compile a write yourself. See [client-side defaults](./inserts.md#client-side-defaults) |
| `excluded`    | `(columns) => ExcludedColumns`: an `onConflictDoUpdate` or `onDuplicateKeyUpdate` `set` that copies the named columns from the proposed row. See [On conflict](./inserts.md#on-conflict) |
| `excludedAll` | `(except?) => ExcludedAll`: an `onConflictDoUpdate` or `onDuplicateKeyUpdate` `set` that copies every column the insert writes, except these and the target's (`onDuplicateKeyUpdate`: the declared primary key's) |

Tables come from the dialect's `table`: [`CH.table`](#tables-and-ddl),
[`PG.table`](#tables-and-ddl-1), [`SQLite.table`](#tables-and-ddl-2) or
[`MySQL.table`](#tables-and-ddl-3). [Recipes](./recipes.md) has complete examples of reads,
upserts, pagination and transactions.

### `CHQuery` methods

| Method                                                  | Notes                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `select(...names)` / `select(fn)`                       | Required before compiling                                             |
| `where(fn)`                                             | Returns `Array<Condition \| undefined>`; AND-joined. Narrows a column (of the FROM source or a join) it proves not NULL for a later `select` ([joins](./joins-and-subqueries.md#narrowing-a-column-with-where)) |
| `groupBy(...outputKeys)`                                | Takes select aliases, not column names                                |
| `having(fn)`                                            | Post-aggregation filter; input accessor or `dynamicColumn` aliases    |
| `orderBy(...[col, dir])`                                | **Tuples**, not two strings                                           |
| `limit(n)` / `offset(n)`                                | Rounded before emission                                               |
| `format(fmt)`                                           | `"JSON"` \| `"JSONEachRow"`                                           |
| `distinct()` / `distinctOn(...aliases)`                 | `SELECT DISTINCT` / `SELECT DISTINCT ON (…)`                          |
| `forUpdate` / `forNoKeyUpdate` / `forShare` / `forKeyShare` | Row locks; options `LockOptions` (`skipLocked`, `noWait`, `of`). Postgres writes all four, MySQL and MariaDB `forUpdate` and `forShare`; refused in the type when compiled or run for another dialect |
| `innerJoin` / `leftJoin` / `crossJoin`                  | `(source, alias, on?)`: a table, a `TableFunction` (`SQLite.jsonEach(…)`), or a callback building one from the earlier sources' columns. `on`'s first argument also reads the earlier joins under their aliases |
| `innerJoinQuery` / `leftJoinQuery` / `crossJoinQuery`   | `(query, alias, on?)`                                                 |
| `withCTE(name, query)` / `withCTE(name, sql, options?)` | Typed query derives scope; SQL form can declare `options.tenantScope` |
| `route("ingest")`                                       | Metadata only                                                         |
| `crossTenant()`                                         | Forces `tenantScope: "cross-tenant"`                                  |

`CHUnionQuery` offers only `orderBy`, `limit`, `offset`, `format`.

A `CHQuery` is `Pipeable`: `query.pipe(f, g)` is `g(f(query))`.

### `Query` (data-last)

`Query` is a namespace of `dual` functions over the `CHQuery` methods above. Each one is
data-last (`query.pipe(Query.where(fn))`) and data-first (`Query.where(query, fn)`), calls the
fluent method, and writes the same SQL. See [Pipeable, data-last queries](./queries.md#pipeable-data-last-queries).

| Export                                                    | Same as                         |
| --------------------------------------------------------- | ------------------------------- |
| `Query.from` / `Query.fromQuery` / `Query.fromUnion`      | `from` / `fromQuery` / `fromUnion` |
| `Query.select()` / `Query.select(...names)` / `Query.select(fn)` | `select`                 |
| `Query.where(fn)`                                         | `where`                         |
| `Query.orderBy(...[key, dir])` / `Query.orderBy(fn)`      | `orderBy`                       |
| `Query.limit(n)` / `Query.offset(n)`                      | `limit` / `offset`              |
| `Query.groupBy(...keys)` / `Query.having(fn)`             | `groupBy` / `having`            |
| `Query.distinct()` / `Query.distinctOn(...keys)`          | `distinct` / `distinctOn`       |
| `Query.format(fmt)`                                       | `format`                        |
| `Query.forUpdate` / `Query.forNoKeyUpdate` / `Query.forShare` / `Query.forKeyShare` | `(options?)`, the row locks |
| `Query.route(route)` / `Query.crossTenant()`              | `route` / `crossTenant`         |
| `Query.innerJoin` / `Query.leftJoin` / `Query.crossJoin`  | `(table, alias, on?)`           |
| `Query.innerJoinQuery` / `Query.leftJoinQuery` / `Query.crossJoinQuery` | `(query, alias, on?)` |
| `Query.withCTE(name, query)` / `Query.withCTE(name, sql, options?)` | `withCTE`             |

`CHUnionQuery` and the writes are not `Pipeable`; use their methods.

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
are written, how params reach the server, and which clauses exist (`LockingSupport`: which row
locks). Pass one as
`options.dialect`, or provide it as `CurrentDialect`, a `Context.Reference<Dialect | undefined>`
that `compile` reads when no `options.dialect` is given. `Compile<Default>`, `CompileUnsafe<Default>`,
`CompileUnion<Default>` and `CompileUnionUnsafe<Default>` are the types of the four compile
functions, with `Default` the function set of the entry's dialect; their options are
`QueryCompileOptions`, `InsertCompileOptions` and `UnionCompileOptions`. `TableFunction` is a row source that is not a table (`SQLite.jsonEach`), which `from`, the joins
and `update(...).from` take. `DialectTransactions` (with `IsolationLevel` and `TransactionSettings`) says
which transactions the database supports, and how settings are written: `beginTransaction`
(optional) for a BEGIN that carries them, `setTransaction` for a statement run after BEGIN;
see [Database](./database.md#settings). See [Params and compilation](./params-and-compilation.md#dialects) and
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
| `undecoded(column)`       | the column as the driver sends it, typed as its wire form  |
| `inExprList(expr, exprs)` | Same for expression lists                                  |
| `notInList(expr, values)` | `expr NOT IN ('a', 'b')`                                   |
| `escapeLike(text)`        | `text` with `%`, `_` and `\` escaped, for a `.like()` pattern |
| `not(condition)`          | `NOT (…)`                                                  |
| `and(...conds)` / `or(...conds)` | One flat `(… AND …)` / `(… OR …)`; skips `undefined`, returns `undefined` when none are left |
| `dynamicColumn(name, t?)` | An `Expr` from a runtime column name — a `GROUP BY` alias  |
| `exists(q)`               | `EXISTS (…)` from a query or pre-compiled SQL              |
| `inSubquery(expr, q)`     | `expr IN (…)` from a query or pre-compiled SQL             |
| `notInSubquery(expr, q)`  | `expr NOT IN (…)`; note the NULL semantics                 |
| `scalar(q)`               | `(SELECT …)` of a one-column query as an `Expr` of its column, `\| null` ([a subquery as a value](./joins-and-subqueries.md#a-subquery-as-a-value-scalar)) |
| `outerRef<T>(name)`       | Reference an outer column in a correlated subquery         |

`Expr<T>` methods: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in_`, `notIn`, `between`, `notBetween`,
`isNull`, `isNotNull`, `like`, `notLike`,
`ilike`, `contains`, `startsWith`, `endsWith` (string-only; the last three escape `%`, `_` and `\`
in the value and take `TextMatchOptions`, `{ insensitive?: boolean }`, see
[Text search](./expressions.md#text-search)), and `add`, `sub`, `mul`, `div`, `mod` (number-only, **no parentheses**). `div` and `mod` decode
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

`Condition` methods: `and`, `or` (both parenthesise; both drop the tenant marker). `and`
keeps the not-NULL facts of both sides; `or` keeps none.

On a joined column, `isNotNull()` and `eq(…)` return a `Condition` that proves the column not
NULL. Its second type parameter holds that fact.

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
`InsertRow`, `InsertRowOf`, `UpdateSet`, `UpdateSetOf`, `TableSchemas` (what `tableSchemas`
returns for a table).

**Client-side defaults** — `RequirementsOf<W>` (what a write's client defaults need; `never` for
anything else), `ClientDefaults` (the `insert` and `update` Effects per column, on
`Table.clientDefaults`).

**What `compile` checks** — `NeedsSelect<Output>` (the query has a SELECT list),
`ParamsSatisfied<Params, Given>` (the params object fills every required param),
`DialectSatisfied<Params, Functions>` (no built-in function of another dialect, and not two
dialects in one query) and `SourcesSatisfied<Params>` (no column of a source that is not in the
query's FROM or JOIN). See [Params and compilation](./params-and-compilation.md#checked-in-the-type). A helper generic
over a query's output takes `CHQuery<…, Output> & NeedsSelect<Output>` so it can pass the query on
to `compile`.

**Params a query carries** — `ParamEntry<Name, Value>` (one `param.*` a query needs, in its type),
`OptionalParamEntry<Name, Value>` and `OptionalParams<P>` (the same for a param under `when` /
`whenTrue`, or one whose name is a union, which the params object may leave out) and
`ParamsIn<X>` (the params an expression or argument list carries). Beside the params, the same
channel carries `DialectEntry<Set>` (a built-in function of one dialect: `ClickHouseOnly`,
`PostgresOnly`, `SqliteOnly` or `MysqlOnly`; `DialectsIn<P>` reads the sets), `ClauseEntry<Clause, Sets>` (a
clause only some dialects write: `RowLock<Clause>` for the row locks) and `SourceEntry<Name>` (a column of source
`Name`; `SourceOf<Name>` is the entry of a ref, `BindSources<P, Sources>` removes the ones a query
provides). You rarely write them, but `tsc --declaration` names them when a package exports a
query with a param or a `defineFn` helper, so they are public.

**Everything else** — `Table` (what `from` and the write builders accept; every `table` value is
one), `Expr`, `ColumnRef`, `Condition`, `Comparable` (what a value of a type may be compared
against), `MapValueOf`, `Subquery`, `ParamMarker`, `ParamKind`, `CHQuery`, `CHUnionQuery`,
`CHInsert`, `CHInsertStart`, `CHUpdate`, `CHUpdateStart`, `CHDelete`, `CHWrite`, `InsertValue`,
`InsertSelectMisfits`, `InsertSelectMissing`, `InsertSettingValue`, `ConflictTarget`,
`ConflictSet`, `ExcludedSet`, `ExcludedColumns`, `ExcludedAll`, `OnConflictDoNothing`, `OnConflictDoUpdate`, `OnDuplicateKeyUpdate`, `ColumnAccessor`,
`JoinedColumnAccessor`, `JoinOnCallback`, `LockOptions`, `CompiledQuery`, `CompiledQueryInput`,
`CompiledQueryRowSchema`, `RowSchemaMismatch`, `TenantScope`, `Dialect`, `DialectClauses`,
`DialectTransactions`, `IsolationLevel`, `TransactionSettings`, `ParamStyle`, `FnResult`.

### Errors

These errors are Effect `Schema.TaggedError` classes. Expected failures can be caught by
their full namespaced tag; `QueryBuilderDefect` remains a defect rather than a typed failure.

#### `QueryBuilderError`

Tag `"@maple-dev/effect-orm/QueryBuilderError"`. Recorded while compiling and surfaced in
`compile`'s error channel; `compileUnsafe` runs `compile` with `Effect.runSync`, which throws it.

| `code`             | Cause                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `UnresolvedParam`  | A param the params bag has no value for                                  |
| `InvalidLiteral`   | A param value, or a comparison operand, the column's codec rejects; or a literal or name that would spell the reserved param marker `__PARAM_` (Postgres, SQLite and MySQL refuse such a name; ClickHouse escapes it) |
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
`decodeFirstRow` Effect and `Db.query` with a row schema. Fields: `message`, `rowIndex`,
`dialect?`, `collection?`, `column?` (the column alias of the first issue) and `issues`
(`DecodeIssue[]`). None of them holds a row value, so the error is safe to log. The Schema
error is on the non-enumerable `schemaError` property, not on `cause`, because it can hold row
values. See [Logging a decode failure](./decoding-results.md#logging-a-decode-failure).

#### `DecodeIssue`

`{ path, kind, expected? }`: one issue of a `CompiledQueryDecodeError`. `path` is the Schema
path from the row (its first segment is the column alias), `kind` the Schema issue tag
(`InvalidType`, `MissingKey`, `Filter`, `Encoding`, …), `expected` what the schema AST expects.

#### `formatDecodeError(error, options?)`

A one-line summary of a `CompiledQueryDecodeError` for a log: dialect, table, row index, and
the path and expected type of each issue. `FormatDecodeErrorOptions.verbose: true` appends the
raw Schema error message, which can hold row values.

#### `SchemaDefinitionError`

Tag `"@maple-dev/effect-orm/SchemaDefinitionError"`. Fails `S.entitiesOf`, `S.pgEntitiesOf`, `S.sqliteEntitiesOf`,
`S.mysqlEntitiesOf` and `TB.buildProject` when a definition cannot render: a name that is not a plain identifier, a
MergeTree-family engine with no `orderBy`, a view reading from a union, a view writing to a table
outside the schema. Fields: `problems` (every `DefinitionProblem`, `{ object, message }`) and
`message`. Definitions never throw; each records its own on `problems`.

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
`indexes`, `comment`, `tenantColumn`, `casing`. Key and expression options are `DdlKey` / `DdlExpr`: SQL
text, or a callback building it from the column accessor.

**`Casing`** — `"snake_case"` or `"camelCase"`, the `casing` table option: the database name of
each column that gives no `name`, derived from its key by drizzle-orm's rule (`orgId` and
`HTTPStatus` become `org_id` and `http_status`). See
[Column names](./tables-and-types.md#column-names).

**`ExternalTableDefinition`** — `{ external: true, columns, tenantColumn?, casing? }`. A table the schema
does not own: a system table, a table function, a subquery, a CTE name, a table another tool
migrates. No DDL, so `generate` never sees it; the name is written verbatim as the FROM target;
`columns` may be empty.

```ts
const One = CH.table("system.one", { external: true, columns: {} })
const Numbers = CH.table("numbers(10)", { external: true, columns: { number: CH.uint64 } })
```

**`ColumnOptions`** — at most one of `default` (a literal, encoded through the column's type),
`defaultExpr`, `materialized`, `alias`; plus `name` (the column's name in SQL), `codec` and
`comment`. They type inserts: a column
with `default` or `defaultExpr` may be left out (`DefaultedColumnsOf`), a `materialized` or
`alias` column may not be written (`ComputedColumnsOf`).

**Types** — `ColumnInput` (a type or a `ColumnSpec`), `ColumnsOf` (the query-side column types
of a `columns` record), `TableDdl`, `SchemaTable`, `MaterializedView`, `IndexSpec`. A definition
that cannot render records a `DefinitionProblem` on `problems`; `S.entitiesOf` fails with them.

### Column types

**Constructors** — `string`, `bool`, `uint8`, `uint16`, `uint32`, `uint64`, `int32`,
`int64`, `float64`, `dateTime`, `dateTime64`, `dateTimeString`, `dateTime64String`, `map`,
`array`, `nullable`, `lowCardinality(type)`, `simpleAggregateFunction(fn, type)`,
`precision(dateTime64Type, digits)`, `aggregateState(fn, ...args)`, `custom(sql, schema, literalSchema?)`,
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
`rowsBetween(start, end)`, `rangeBetween(start, end)`, `lagInFrame(expr, offset, defaultValue)` _(all three arguments
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
SQL as ClickHouse literals. A `CurrentDialect` in context, or `options.dialect`, overrides
the default.

`clickhouseDialect` writes a plain name (letters, digits, `_`, dots) bare and any other in
backticks, so a select key such as `"p-95"` or one built from input is always one name. A select
key, alias or CTE name that ClickHouse reads as something else (`all`, `null`, `select`, `top`, …)
is quoted too. A table name is written as given (`rawTableNames`), since an external table's name
can be a table function or a subquery. See [Names](./params-and-compilation.md#names).

---

## `/postgres`

`import * as PG from "@maple-dev/effect-orm/postgres"`: the query builder above, plus the
following. See [Postgres](./postgres.md).

### Tables and DDL

```ts
const Role = PG.enumType("user_role", ["owner", "member"])

const Users = PG.table("users", {
	columns: {
		id: PG.column(PG.int8, { identity: "always" }),
		orgId: PG.text,
		email: PG.text,
		handle: PG.column(PG.text, { unique: true }),
		role: PG.column(Role, { default: "member" }),
		createdAt: PG.column(PG.timestamptz, { defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("users_org_email_idx", ["orgId", "email"])],
	uniqueConstraints: [PG.unique("users_org_handle_unique", ["orgId", "handle"])],
	tenantColumn: "orgId",
})
```

| Export                  | Signature                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `table`                 | `(name, TableDefinition) => PgSchemaTable`, or `(name, ExternalTableDefinition) => Table` |
| `column`                | `(type, ColumnOptions) => ColumnSpec`                                              |
| `index`                 | `(name, on, IndexOptions?) => IndexSpec`: columns, or a callback building expressions |
| `uniqueIndex`           | The same, `UNIQUE`; with `where`, a partial unique index                           |
| `unique`                | `(name, columns, UniqueOptions?) => UniqueSpec`: a `UNIQUE` constraint, for `uniqueConstraints` |
| `enumType`              | `(name, labels, EnumOptions?) => PgEnum`: an enum type, both a column type and a schema object |
| `foreignKey`            | `({ columns, references, foreignColumns, onDelete?, onUpdate?, name? }) => ForeignKeySpec`; `references` is a `Table` (its columns are checked) or a name |
| `defaultForeignKeyName` | `(table, columns, foreignTable, foreignColumns) => string`: the name drizzle-kit gives, shortened past 63 characters as drizzle-kit does |

**`TableDefinition`** — `columns` (required), `primaryKey` (column names, or
`{ columns, name? }`), `indexes`, `uniqueConstraints`, `foreignKeys`, `tenantColumn`, `casing`
(a `Casing`, as on `/clickhouse`).

**`ExternalTableDefinition`** — `{ external: true, columns, tenantColumn?, casing? }`, as on
`/clickhouse`: a view, a catalog table, one another tool migrates. No DDL.

**`ColumnOptions`** — one of `default`, `defaultExpr`, `identity` (`"always"` or
`"by default"`); any of them lets an insert leave the column out (`DefaultedColumnsOf`).
`defaultFn` and `onUpdate` are client-side defaults: an `Effect` of a value of the column's type
that cannot fail, run by `Database.run` for an insert that leaves the column out and an update
that does not set it. Either one lets an insert leave the column out, and its requirements
become the write's ([client-side defaults](./inserts.md#client-side-defaults)). Also
`name` (the column's name in SQL) and `unique` (`true`, a constraint name, or
`UniqueColumnOptions`: `{ name?, nullsNotDistinct? }`), which names a one-column constraint
`<table>_<column>_unique` by default.

**`UniqueOptions`** — `nullsNotDistinct` (Postgres 15+).

**`PgEnum`** — a `PgType` whose rows decode to its labels, with `name`, `values` (the labels),
and the `ddl` and `problems` `generate` reads. **`EnumOptions`** — `schema`, for a type outside
the schema migrations run in.

**`IndexOptions`** — `where` (a `DdlPredicate`: SQL text or a callback returning a condition),
`using` (the access method; default `btree`).

**Types** — `ColumnInput`, `ColumnSpec`, `ColumnsOf`, `IndexSpec`, `UniqueSpec`, `ForeignKeySpec`,
`ReferentialAction` (drizzle's lowercase spelling or the catalog's), `TableDdl`, `PgSchemaTable`,
`DdlExpr`, `DdlKey`. A definition that cannot render records a problem; `S.pgEntitiesOf` fails with it.

### Column types

`text`, `uuid`, `bool`, `int2`, `int4`, `int8`, `float4`, `float8`, `numeric`, `timestamptz`,
`timestamptzMillis` (a timestamptz read as epoch milliseconds), `jsonb(schema?)`, `array(type)`, `nullable(type)`, `custom(sql, schema, literalSchema?)`,
`brand(type, schema)`, and `enumType(name, labels)` above. See [Postgres column types](./postgres.md#column-types).

Types: `PgType` (a Postgres column type; a `CHType`), `PgArray`, `PgNullable`. Codecs:
`PgNumber` (a number, numeric string or `bigint`), `PgTimestampLiteral` (an instant written as
ISO-8601), `timestampLiteral(format)` (the same with another format), and `pgTimestampToIso`,
which normalizes Postgres timestamp text to ISO-8601. `parsePgArrayLiteral` reads a
one-dimensional array literal (`{a,"b c",NULL}`), the form enum arrays arrive in.

### Functions

`count()`, `countDistinct(x)`, `countIf(c)`, `sum(x)`, `sumIf(x, c)`, `avg(x)`, `min(x)`,
`max(x)`, `percentileCont(f, x)`, `arrayAgg(x)`, `dateTrunc(unit, ts)` (`DateTruncUnit` is the
unit union), `dateBin(seconds, ts)`, `now()`, `lower(x)`, `upper(x)`, `length(x)`,
`coalesce(x, fallback)`, `nullIf(x, value)`, `jsonText(x, key)`, `greatest(a, ...)`, `least(a, ...)`,
`jsonPath(x, ...keys)`, `jsonPathText(x, ...keys)`, `jsonContains(x, part)`, `jsonSet(x, keys, value)`
(typed jsonb paths; the types `JsonKey`, `JsonKeyOf`, `JsonStep`, `JsonPath`, `JsonPathValue` and
`JsonContained` spell them, and `jsonPathSchema` reads a path's schema off a document schema, as a `JsonPathSchema`),
`caseWhen([[c, v], ...], otherwise)`, `asBoolean(c)` (a condition as a value) and
`typedValue(type, value)` (a value bound as a column type writes it). Window functions:
`over(expr, spec)`, `lead(x, offset?, fallback?)`, `lag(x, offset?, fallback?)`, `rowNumber()`,
`rank()`, `denseRank()`, `firstValue(x)`, `lastValue(x)`, with `windowSpec`, `rowsBetween`,
`rangeBetween` and the frame bounds `currentRow`, `unboundedPreceding`, `unboundedFollowing`,
`preceding(n)`, `following(n)` (and the types `WindowSpec`, `CompiledWindowSpec`,
`WindowFrameBound`, `WindowRowsFrame`, `WindowOrderDirection`); see
[window functions](./postgres.md#window-functions). See
[Postgres functions](./postgres.md#functions) and [JSON paths](./postgres.md#json-paths) for the SQL each writes.

### Dialect

`compile` and the other compile functions default to `postgresDialect`: numbered `$n`
placeholders, double-quoted identifiers. A `CurrentDialect` in context, or `options.dialect`, overrides
the default.

---

## Other subpaths

| Symbol                                                                                           | Subpath           |
| ------------------------------------------------------------------------------------------------ | ----------------- |
| The ClickHouse functions under their raw underscored names, the expression helpers and function factories, and `toFragment` — value → `SqlFragment`, for hand-rolled function wrappers | `/expr`           |
| `match_` (the RE2 test as a `UInt8` value, for aggregating or selecting as a flag) and `multiSearchAnyCaseInsensitive` (true when the text holds any of the needles, ignoring case), which `/clickhouse` does not re-export | `/expr` |
| `raw`, `str`, `ident`, `int`, `join`, `as_`, `lazy`, `when`, `compile`, `escapeClickHouseString` | `/sql`            |
| `SqlQuery`, `compileQuery`                                                                       | `/sql`            |
| `ClickHouseStatement`, `parseStatement`, `renderStatement`, `withSettings`, `withFormat`         | `/sql`            |
| `ClickHouseStatementFromString`, `splitTerminalClauses`, `maskLiteralsAndComments`               | `/sql`            |
| `ClickHouseStatementFields` (the `body`, `settings` and `format` that `renderStatement` takes) and `TerminalClauses` (what `splitTerminalClauses` returns) | `/sql` |
| Schema tooling: `isSchemaObject`, `makeSnapshot`, `renderSchema`, `diffSchemas`, `diffPgSchemas`, `fromDrizzleSnapshot`, snapshot and entity schemas (`PgEnumEntity`, `PgUniqueEntity`, …), `Hint`; for SQLite, `sqliteEntitiesOf`, `renderSqliteSchema`, `renderSqliteCreateTable`, `renderSqliteCreateIndex`, `diffSqliteSchemas`, `fromDrizzleSqliteSnapshot`, `SqliteMigrationOp`, `renderSqliteOp`, `renderSqliteMigrationSql`, `labelOfSqlite`, `rebuildName`, the `SqliteSnapshot` schema and the `SqliteTableEntity`, `SqliteColumnEntity`, `SqliteIndexEntity`, `SqliteUniqueEntity` schemas; for MySQL, `mysqlEntitiesOf`, `renderMysqlSchema`, `renderMysqlCreateTable`, `renderMysqlCreateIndex`, `renderMysqlColumnDefinition`, `renderMysqlUnique`, `mysqlIdent`, `canonicalMysqlType`, `diffMysqlSchemas`, `MysqlMigrationOp`, `renderMysqlOp`, `renderMysqlMigrationSql`, `labelOfMysql`, `MysqlOpLabel`, `MysqlSchemaTable`, the `MysqlSnapshot` schema and the `MysqlTableEntity`, `MysqlColumnEntity`, `MysqlIndexEntity`, `MysqlUniqueEntity`, `MysqlSchemaEntity` schemas | `/schema`         |
| ClickHouse entities and snapshots, as Effect schemas: `TableEntity`, `ColumnEntity`, `IndexEntity`, `MaterializedViewEntity`, `SchemaEntity` (their union), `EngineSpec`, `ColumnDefault`, the `Snapshot` schema with `ClickHouseSnapshot` and `PgSnapshot`, `SNAPSHOT_VERSION`, `ORIGIN_ID` (the parent id of a first migration), `serializeSnapshot`, and the types `AnySchemaEntity`, `SchemaObject`, `SchemaDialect` | `/schema` |
| ClickHouse migration ops and their SQL: `MigrationOp`, `MigrationFile`, `ClickHouseMigrationFile`, `renderOp`, `labelOf` and `OpLabel`, `renderCreateTable`, `renderCreateMaterializedView`, `renderColumnDefinition`, `renderEngine`, `renderAlter`, `renderDropTable`, `renderDropView`, `RenderOptions`; backfills: `BackfillSpec`, `backfillWindows`, `renderBackfill`, `renderBackfillBounds` | `/schema` |
| The diff's result and inputs: `DiffResult`, `UnsupportedChange`, `Hints` (the schema of a `--hints` array), `DrizzleImport`, `DrizzleSqliteImport` | `/schema` |
| Postgres: the entity schemas `PgTableEntity`, `PgColumnEntity`, `PgIndexEntity`, `PgForeignKeyEntity`, `PgSchemaEntity`, `PgIdentity`, `PgReferentialAction`; `PgMigrationOp`, `PgMigrationFile`, `renderPgOp`, `renderPgSchema`, `renderPgCreateEnum`, `renderPgAddUnique`, `labelOfPg` and `PgOpLabel`; `pgIdent`, `pgTypeName`, `canonicalPgType` | `/schema` |
| SQLite: `SqliteSchemaEntity`, `SqliteOpLabel`, `renderSqliteColumnDefinition`, `sqliteIdent`, `canonicalSqliteType` | `/schema` |
| Shared helpers: `entityKey`, `sortEntities`, `dialectOfObject`, `canonicalJson`, `sha256Hex` | `/schema` |
| `defineDatasource`, `defineMaterializedView`, `node`, `column`, `t`, `engine`, `buildProject`, `InferRow` — the `@tinybirdco/sdk` call shapes, whose results are also query tables ([Tinybird](./tinybird.md)) | `/tinybird` |
| Definition types: `Datasource`, `AnyDatasource`, `DatasourceOptions`, `DatasourceIndex`, `SchemaDefinition`, `ColumnDefinition`, `EngineConfig`, `MaterializedViewDefinition`, `NodeDefinition`, `TinybirdType`, `AnyTinybirdType`, `TypeModifiers`, `ColumnsOfSchema`, `DefaultedColumnsOfSchema`, `RowOf` | `/tinybird` |
| Datafiles: `TinybirdProject` and `Datafile` (what `buildProject` returns), `generateDatasource`, `generatePipe`, `formatDefaultValue`; and the readers `getColumnType`, `getColumnJsonPath`, `getModifiers`, `getTinybirdType`, `isTinybirdType`, `isDatasourceDefinition`, `isPipeDefinition` | `/tinybird` |
| `run` (apply pending migrations), `status` (each migration's state), `verify` and `verifySnapshot` (compare the database with the last snapshot), `baseline` (record migrations as applied without running them), `MigrationDriver` (the service they run through) and the migrate errors; ClickHouse and Postgres ([Applying migrations](./migrations.md#applying-migrations)) | `/migrate`        |
| The driver: `MigrationDriverApi` (`execute`, `query`, optional `transaction`), `fromSqlClient` and `layerSqlClient` to build one from an Effect `SqlClient`, `FromSqlClientOptions` | `/migrate` |
| Migration sources: `fromFileSystem`, `fromRecord`, `MigrationInput`, `LoadedMigration`, `MigrationStep`, `orderMigrations`, `stepsOf`, `dialectOf`, `isStagingName`, `STATEMENT_BREAKPOINT` | `/migrate` |
| Running a migration a step at a time, for an orchestrator: `pendingMigrations`, `planMigration`, `planSteps`, `applyStep`, `completeMigration`, `resolveStep`, with `MigrationPlan`, `PlannedStep`, `ResolveStepOptions` | `/migrate` |
| Options and results: `RunOptions`, `BaselineOptions`, `VerifyOptions`, `VerifyResult`, `Drift`, `AppliedMigration`, `MigrationStatus`, `MigrationState`; `LEDGER_TABLES` names the three ledger tables | `/migrate` |
| The errors, each a tagged error, and their union `MigrateError`: `MigrateSqlError`, `MigrateSourceError`, `MigrateHashMismatch`, `MigrateLeaseHeld`, `MigrateStepFailed`, `MigrateStepChanged`, `MigrateStepUncertain` | `/migrate` |
| `Database` (the service), `run` (compile, run and decode a query or write), `runOne`, `runOption`, `runNonEmpty` (the same with a row-count check), `runWrite` (a write's `WriteResult`: its affected rows and generated key, for a `Write`; [Write results](./database.md#write-results)), `stream` (rows as a `Stream`), `batch` (several statements, `BatchCheck`, `BatchRows`; [Batches](./database.md#batches)), `paginate` (a keyset page; [Pagination](./database.md#pagination), [recipe](./recipes.md#page-through-rows-with-a-cursor)), `sql` (a template with bound values), `query`, `execute` (run a statement, with or without rows), `transaction`, `requireTransaction`, `afterCommit`, `retryContention`, `Transaction` ([Transactions](./database.md#transactions), [recipe](./recipes.md#several-writes-in-one-transaction)). See [Running statements and transactions](./database.md) | `/database` |
| `DatabaseError` (a failed statement, with the driver's `reason`), `ResultCardinalityError` (`runOne` and friends got the wrong number of rows), `InvalidCursor` (a `paginate` cursor that does not decode), `TransactionCommitFailed`, `TransactionRollbackFailed` and the other transaction errors ([Errors](./database.md#errors)) | `/database` |
| Building one: `fromSqlClient`, `layerSqlClient`, `FromSqlClientOptions`, `DatabaseApi` | `/database` |
| What statements are: `Runnable` and `RowOf` (for `run`), `Statement` and `StatementInput` (for `query` and `execute`), `RowSchema` (the row codec `query` takes), and the `sql` template's `SqlTemplate`, `SqlIdentifier`, `SqlRawText` | `/database` |
| Transactions: `TransactionOptions`, `TransactionInfo`, `RetryOptions`, `isContention`, the union `TransactionError`, and `TransactionUnsupported`, `TransactionOptionsRejected`, `TransactionClosed`; `TenantScopeViolation`, the defect a `requireTenantScope` database raises | `/database` |
| Keyset pages: `Page`, `PaginateOptions`, `KeysetOrder`, `KeysetColumn`, `KeysetDirection` | `/database` |
| `refineConstraints`, `constraintViolation`, and the `ConstraintViolation` errors `UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`, `CheckViolation` | `/database` |
| `makeRepository`, `Repository`, `TenantRepository`, `RepositoryOf`, `RepositoryOptions`, `RepositoryError` — CRUD derived from a table, tenant-pinned | `/database` |
| `findById`, `findAllBy`, `FindById`, `FindAllBy`, `LookupOptions`, `LookupError` — batched lookups by a key, one `IN` statement per batch | `/database` |
| `defineRelations`, `findMany`, `Relation`, `RelationBuilder`, `RelationsConfig`, `RelationTables`, `RelationalSchema`, `RelationalTable`, `RelationOptions`, `FindManyOptions`, `FindManyRow`, `WithOf`, `KeyColumn` — relational reads, one statement per level ([Relational reads](./relations.md)) | `/database` |
| `related`, `Related`, `RelationFilter`, `RelationWhere`, `CountOf` — relation filters `some` / `none` / `every`, relation counts, and `_count` in `findMany` ([Filter by relations](./relations.md#filter-by-relations)) | `/database` |
| `withQuerySummary`, `QuerySummary` — the `db.query.summary` of the statements an effect runs, for spans | `/database` |
| `layerTest`, `TestDatabase`, `TestDatabaseApi`, `TestDatabaseOptions`, `TestReply`, `TestWriteReply`, `TestStatement` — a `Database` with no server, for unit tests | `/database` |
| `rows`, `insert`, `arbitrary`, `pick`, `SeedError`, `SeedRow`, `SeedRowOf`, `ColumnOverride`, `RowsOptions`, `InsertOptions`, `ArbitraryOptions` — rows from the column Schemas; see [Seeding](./seeding.md) | `/seed` |
| `StatementObservation` — what `observeExit` gets for each statement: names, duration, rows, `error.type` | `/database` |
| `ClickhouseHttpClient` (the service: a `SqlClient` plus `asCommand`, `withQueryId`, `withSettings`), `layer` and `make` (build one from a `ClickhouseHttpClientConfig`: `url`, `username`, `password`, `database`, `settings`, `spanAttributes`), `ClickhouseSetting` (a setting value) — a ClickHouse `SqlClient` over `fetch`, for Workers. Needs ClickHouse 23.9+; a query that fails after its first rows fails, and values bind as typed server-side params ([On Workers and other fetch runtimes](./running-queries.md#on-workers-and-other-fetch-runtimes)) | `/clickhouse-http` |
| `defineConfig` (type an `effect-orm.config.ts`), `generate` (write the next migration), `check` (validate the folder), `pull` (definitions from a ClickHouse database), `verifySchema` (compare a database with the definitions), `loadSchema` (import the schema modules), `readMigrations` (read the folder), `analyze` (the folder's snapshot graph), `KitError` (their failure, with a `code`); the functions behind the `effect-orm` commands ([Schema and migrations](./migrations.md)) | `/kit`            |
| `KitConfig` (the shape of `effect-orm.config.ts`), and the option and result types of the functions above: `GenerateOptions`, `GenerateResult`, `PullOptions`, `PullResult`, `VerifySchemaResult`, `GraphAnalysis`, `GraphProblem` | `/kit` |
| `defineSuite`, `query`, `caseFromCompiled` (declare a suite and its cases), `runSuite` (measure it), `compareRuns`, `compareBudgets` (compare a baseline and a candidate); see [Benchmarking](./benchmarking.md) | `/benchmark`      |
| `Suite`, `RunOutput`, `BenchmarkError` and benchmark contracts                                   | `/benchmark`      |
| The contracts by name: `Sample`, `SampleResult`, `RunMetrics`, `Aggregates`, `BenchmarkInput`, `RunOptions`, `BenchmarkTransport`, `BenchmarkResponse`, `BenchmarkProgress`, `LogMetrics`, `ComparisonOptions`, `ComparisonMetric`, `ComparisonRow`, `Verdict` | `/benchmark` |
| Helpers the runner is built from: `validateSuite`, `sampleId`, `benchmarkSql`, `explainSql`, `validateReplaySql`, `mean`, `percentile`, `metricNumber`, `canonicalJson` | `/benchmark` |
| `makeHttpClient`, `makeHttpTransport`, `httpConfigFromEnv`                                       | `/benchmark/http` |
| `HttpConfig`, `decodeJson`, `decodeJsonLines` | `/benchmark/http` |
| `runCli(args)` — the `ch-bench` command as a function returning its exit code                    | `/benchmark/cli`  |

Every export of every entry is named on this page; `bun run test` fails when one is not. The
check reads the built declarations (`dist/*.d.mts`), so run `bun run build` after adding an
export; `bun run test:release`, which CI runs, builds first. The
dialect entries, `/database`, `/migrate`, `/seed` and `/clickhouse-http` are the application API.
`/schema`, `/kit`, `/sql`, `/tinybird` and `/benchmark` also export the pieces their own tools
are built from (entity schemas, renderers, op labels), for tools built on top of them; those
follow the same versioning.

`/schema` reads tables; it does not declare them. Declare tables with `table` from `/clickhouse`,
`/postgres`, `/sqlite` or `/mysql`. See [Schema and migrations](./migrations.md), [Database](./database.md),
[Running a query](./running-queries.md) for what the `/sql` statement helpers are for, and
[Benchmarking](./benchmarking.md) for the complete benchmark API, command workflow, result
verification, and JSON protocol.

Note `/sql` exports a `compile` (fragment → string) distinct from the dialect entries' `compile`
(query → `CompiledQuery`), and a `when` distinct from the query builder's `when` (optional
conditions).

## Command-line tools

The package installs two commands. Both take `--help` (the commands and flags), `--version` (the
installed package version) and `--json` (machine-readable output).

**`effect-orm`** reads `effect-orm.config.ts` (or `--config <path>`), whose shape is `KitConfig`.
A name that is not a command fails with `unknown command "..."` before the config is read. See
[Schema and migrations](./migrations.md).

| Command | What it does |
| --- | --- |
| `generate [--name x] [--custom] [--hints <json>] [--hints-file <path>]` | Diff the schema against the folder and write the next migration, for any of the four databases. `--baseline [--from-drizzle]` starts the history of a folder another tool wrote |
| `pull [--out <path>] [--tables a,b] [--force]` | Write table definitions from a ClickHouse database |
| `check` | Validate the folder: snapshot chain, branch conflicts |
| `migrate [--strict]` | Apply pending migrations (ClickHouse and Postgres) |
| `status` | Applied, pending, partial or changed, per migration |
| `verify [--schema]` | Compare the database with the last applied snapshot, or with `--schema` with the definitions |
| `baseline <migration>` | Record a migration and every one before it as applied, without running them |
| `resolve <migration> <step> --ran \| --not-ran` | Record what a step left "started" did |

Exit codes: 0 ok, 1 error, 2 missing hints (a change that loses data, or an enum label rename),
3 drift found.

**`ch-bench`** measures ClickHouse queries: `doctor`, `export`, `run`, `compare`, `inspect` and
`schema`. It reads `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` and
`CLICKHOUSE_DATABASE`. Exit codes: 0 pass, 1 regression, 2 invalid or error, 3 inconclusive. See
[Benchmarking](./benchmarking.md).

## SQLite and D1

`@maple-dev/effect-orm/sqlite` exports the shared query builder and the four compile functions.
`sqliteDialect` is the default; a `CurrentDialect` in context, or `options.dialect`, overrides it.
`d1Dialect` uses the same SQL with a 100-binding limit and no interactive transactions. See [SQLite and D1](./sqlite.md) for driver wiring and limits.

| Export | Purpose |
| --- | --- |
| `SqliteType` | A SQLite SQL type with its Effect codec |
| `text`, `integer`, `real` | Text, safe integer and finite number codecs |
| `boolean` | A boolean encoded as 0/1; other integers fail decoding |
| `timestamp` | An instant stored as SQLite's `YYYY-MM-DD HH:MM:SS.SSS` UTC text; reads ISO-8601 too |
| `sqliteTimestampText(epochMillis)` | That text for an instant, for raw SQL and seeds |
| `timestampNow` | A `defaultExpr` for a `timestamp` column: the current time in that text form |
| `blob` | Bytes from a Uint8Array or D1's array wire representation |
| `json(schema)` | JSON text decoded through the supplied schema |
| `nullable(type)`, `custom`, `brand` | Type composition |
| `count`, `countDistinct`, `countIf`, `sum`, `avg`, `min`, `max` | SQLite aggregates; the last four can return SQL NULL |
| `jsonGroupArray(x, type?)`, `jsonGroupObject(key, value, type?)` | JSON aggregates, decoded as an array / record of `x`'s type, or as `type` |
| `lower`, `upper`, `length`, `coalesce`, `ifnull`, `nullif` | SQLite scalar functions; `coalesce` and `ifnull` take an expression or plain fallback |
| `iif(c, then, otherwise)`, `caseWhen([[c, v], ...], otherwise?)` | Conditionals, decoded as any branch can; `ScalarArg` (an expression or plain value) and `ValueOfArg` type their arguments |
| `trim`, `ltrim`, `rtrim`, `substr`, `replace`, `instr`, `concat` | Text functions; `concat(a, b, ...)` writes `(a \|\| b)` |
| `abs`, `round`, `greatest`, `least` | Numbers; `greatest` / `least` are SQLite's multi-argument `max` / `min` |
| `cast(x, type)` | `CAST(x AS <type's SQL>)`, decoded as `type` |
| `jsonExtract(x, path, type)`, `json_(x)`, `jsonSet(x, path, value)` | JSON functions; `json_` is SQLite's `json()` |
| `julianday`, `date`, `datetime`, `strftime`, `unixepoch` | Date functions over a `TimeValue`, with modifiers; nullable |
| `over`, `lead`, `lag`, `rowNumber`, `rank`, `denseRank`, `firstValue`, `lastValue`, `windowSpec`, `rowsBetween`, `rangeBetween`, `currentRow`, `unboundedPreceding`, `unboundedFollowing`, `preceding`, `following` | Window functions ([window functions](./sqlite.md#window-functions)); types `WindowSpec`, `CompiledWindowSpec`, `WindowFrameBound`, `WindowRowsFrame`, `WindowOrderDirection` |
| `jsonEach(json, { value?, key?, path? })`, `jsonTree(…)` | `json_each` / `json_tree` as a `TableFunction` row source, columns `JsonEachColumns`, types `JsonEachTypes`; the JSON is a `JsonSource` ([table-valued sources](./sqlite.md#table-valued-sources-json_each-and-json_tree)) |
| `jsonRows(rows, columns)` | A query over a JS array bound as one JSON parameter, one typed column per field (`JsonRowsOutput`) |
| `fts5Table(name, columns)` | An FTS5 virtual table for queries, with a `Fts5Rowid` (`Fts5Columns`) |
| `fts5.match`, `fts5.snippet`, `fts5.highlight`, `fts5.bm25` | FTS5 functions over the table's accessor, an `Fts5Source` ([FTS5](./sqlite.md#fts5)) |
| `runSync(storage, query, params?, options?)` | Compile, run and decode synchronously on a `SqlStorageLike` (Durable Object storage), in a client span; `RunSyncOptions` (`context`, `observeExit`, `spanParameters`); `SyncDefaults` refuses client defaults that need services ([runSync](./sqlite.md#durable-object-storage-runsync)) |

### Tables and DDL

```ts
const Links = SQLite.table("short_link", {
	columns: {
		id: SQLite.text,
		code: SQLite.column(SQLite.text, { unique: true }),
		orgId: SQLite.column(SQLite.nullable(SQLite.text), { name: "org_id" }),
		clickCount: SQLite.column(SQLite.integer, { name: "click_count", default: 0 }),
		createdAt: SQLite.column(SQLite.text, { name: "created_at", defaultExpr: "(CURRENT_TIMESTAMP)" }),
	},
	primaryKey: ["id"],
	indexes: [SQLite.index("short_link_org", ["orgId"])],
	tenantColumn: "orgId",
})
```

| Export | Signature |
| --- | --- |
| `table` | `(name, TableDefinition) => SqliteSchemaTable`, `(name, ExternalTableDefinition) => Table`, or `(name, columns, TableOptions?) => Table`, a query schema with no DDL |
| `column` | `(type, ColumnOptions) => ColumnSpec` |
| `index` | `(name, on) => IndexSpec`: columns, or a callback building expressions |
| `uniqueIndex` | The same, `UNIQUE` |

**`TableDefinition`** — `columns` (required), `primaryKey` (column names: one is written inline,
several as a table constraint), `indexes`, `tenantColumn`. A column is `NOT NULL` unless its
type is `nullable(...)`; a primary key column cannot be nullable.

**`ExternalTableDefinition`** — `{ external: true, columns, tenantColumn? }`: a view, or a table
another tool migrates. No DDL. **`TableOptions`** — `tenantColumn`, `defaults`, `computed`, for
the bare-columns form.

**`ColumnOptions`** — one of `default` (a literal, encoded through the column type; a boolean
is written `true` / `false`) or `defaultExpr` (SQL as written, so add SQLite's parentheses, or a
DSL callback, parenthesized for you); either lets an insert leave the column out
(`DefaultedColumnsOf`). `defaultFn` and `onUpdate` are client-side defaults, as on `/postgres`:
Effects `Database.run` runs, with no DDL ([client-side defaults](./inserts.md#client-side-defaults)).
Also `name` (the column's name in SQL) and `unique` (`true` or a
constraint name), an inline `UNIQUE` constraint named `<table>_<column>_unique` by default, as
drizzle-kit 1.0 writes and names it.

**Types** — `ColumnInput`, `ColumnSpec`, `ColumnsOf`, `IndexSpec`, `TableDdl`, `SqliteSchemaTable`,
`DdlExpr`, `DdlKey`, `DefinitionProblem`. A definition that cannot render records a problem;
`S.sqliteEntitiesOf` fails with a `SchemaDefinitionError`, and `S.renderSqliteSchema` writes
the `CREATE TABLE` and `CREATE INDEX` statements. `effect-orm generate` with `dialect: "sqlite"`
writes migrations for them; see [SQLite migrations](./migrations.md#sqlite). The `/migrate`
runner does not apply SQLite migrations yet.

## MySQL and MariaDB

`@maple-dev/effect-orm/mysql` exports the shared query builder and the four compile functions.
`mysqlDialect` is the default; a `CurrentDialect` in context, or `options.dialect`, overrides it.
`mariadbDialect` writes MariaDB's row locks and union branches. See [MySQL and MariaDB](./mysql.md)
for driver wiring, collations and what differs.

| Export | Purpose |
| --- | --- |
| `MysqlType` | A MySQL SQL type with its Effect codec |
| `text`, `longtext`, `varchar(n)` | Text |
| `tinyint`, `smallint`, `int`, `intUnsigned`, `bigint` | Integers in the type's range; `bigint` within 2^53 |
| `double` | A finite number |
| `decimal(p, s)` | Exact decimal text |
| `boolean` | A boolean stored as 0/1 |
| `datetime` | `DATETIME(3)`, an instant in UTC, years 1000-9999 |
| `date` | `YYYY-MM-DD` text |
| `blob`, `varbinary(n)` | Bytes |
| `json(schema)` | JSON decoded through the supplied schema |
| `mysqlDateTimeText(epochMillis)` | `DATETIME(3)` text for an instant |
| `dateTimeNow` | A `defaultExpr` for a `datetime` column |
| `nullable(type)`, `custom`, `brand` | Type composition |
| `count`, `countDistinct`, `countIf`, `sum`, `avg`, `min`, `max` | MySQL aggregates; the last four can return SQL NULL |
| `lower`, `upper`, `length`, `coalesce` | MySQL scalar functions |
| `table`, `column`, `index`, `uniqueIndex` | Tables with their DDL; see below |
| `mysqlDialect`, `mariadbDialect` | The dialects |
| `MysqlInteger` | The integer wire codec: a number, or the numeric string mysql2 sends for a wide one |

### Tables and DDL

```ts
const Tours = MySQL.table("tours", {
	casing: "snake_case",
	columns: {
		id: MySQL.bigint,
		orgId: MySQL.varchar(36),
		code: MySQL.column(MySQL.varchar(16), { unique: true }),
		seats: MySQL.column(MySQL.int, { default: 10 }),
		startsAt: MySQL.column(MySQL.datetime, { defaultExpr: MySQL.dateTimeNow }),
	},
	primaryKey: ["orgId", "id"],
	indexes: [MySQL.index("tours_starts", ["orgId", "startsAt"])],
	tenantColumn: "orgId",
})
```

| Export | Signature |
| --- | --- |
| `table` | `(name, TableDefinition) => MysqlSchemaTable`, `(name, ExternalTableDefinition) => Table`, or `(name, columns, TableOptions?) => Table`, a query schema with no DDL |
| `column` | `(type, ColumnOptions) => ColumnSpec` |
| `index` | `(name, columns) => IndexSpec`: column names only |
| `uniqueIndex` | The same, `UNIQUE` |

**`TableDefinition`** — `columns` (required), `primaryKey` (column names, written as a
`PRIMARY KEY (...)` table constraint), `indexes`, `tenantColumn`, `casing`. A column is
`NOT NULL` unless its type is `nullable(...)`; a primary key column cannot be nullable. A `TEXT`,
`BLOB` or `JSON` column cannot be in a key, an index or a UNIQUE constraint, and every name is at
most 64 characters.

**`ExternalTableDefinition`** — `{ external: true, columns, tenantColumn? }`: a view, or a table
another tool migrates. No DDL. **`TableOptions`** — `tenantColumn`, `defaults`, `computed`, for
the bare-columns form.

**`ColumnOptions`** — one of `default` (a literal, encoded through the column type; written
`DEFAULT ('…')` on a `TEXT`, `BLOB` or `JSON` column) or `defaultExpr` (SQL as written, in the
parentheses MySQL requires, or a DSL callback, parenthesized for you; `dateTimeNow` for a
`datetime`); either lets an insert leave the column out (`DefaultedColumnsOf`). `defaultFn` and
`onUpdate` are client-side defaults, as on `/postgres`, with no DDL. Also `name` (the column's
name in SQL) and `unique` (`true` or a constraint name), `CONSTRAINT <table>_<column>_unique
UNIQUE (...)` by default.

**Types** — `ColumnInput`, `ColumnSpec`, `ColumnsOf`, `IndexSpec`, `TableDdl`, `MysqlSchemaTable`,
`DdlExpr`, `DefinitionProblem`, `SchemaDefinitionError`. A definition that cannot render records a
problem; `S.mysqlEntitiesOf` fails with a `SchemaDefinitionError`, and `S.renderMysqlSchema`
writes the `CREATE TABLE` and `CREATE INDEX` statements. `effect-orm generate` with
`dialect: "mysql"` writes migrations for them; see [MySQL migrations](./migrations.md#mysql). The
`/migrate` runner does not apply MySQL migrations yet.
