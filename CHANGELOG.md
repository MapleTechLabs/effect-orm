# Changelog

## Unreleased

- **Breaking:** one entry per database, drizzle style. `@maple-dev/effect-orm/clickhouse` and
  `@maple-dev/effect-orm/postgres` each export the whole query builder plus that database's
  column types, functions, table definitions and `compile`; one import covers a dialect.
  - The root entry (`@maple-dev/effect-orm`) and `/types` are removed. Import from
    `/clickhouse` instead (`CH.string` rather than `T.string`); Postgres code imports only
    `/postgres` (`PG.from`, `PG.param`, `PG.insertInto`).
  - `table` is the only way to declare a table, and it carries its DDL: `CH.table(name,
    { columns, engine, orderBy, ... })` and `PG.table(name, { columns, primaryKey, ... })`.
    The plain `table(name, columns, { tenantColumn, defaults, computed })` is removed; which
    columns an insert may omit or may not write now comes from `column(type, options)`.
  - `S.defineTable`, `S.column`, `S.engine`, `S.index`, `S.materializedView` and
    `S.ttlAfterDays` move to `/clickhouse` (`CH.table`, `CH.column`, ...); `S.pg.*` moves to
    `/postgres` (`PG.table`, `PG.column`, `PG.index`, `PG.uniqueIndex`, `PG.foreignKey`).
    `/schema` keeps the tooling: rendering, snapshots and the diff.
  - Add `external: true` to `table` for what the schema does not own: system tables, table
    functions, subqueries, views, tables another tool migrates. It queries like any table,
    carries no DDL (so `generate` skips it), and its name is written verbatim as the FROM target.
- Postgres `GENERATED ALWAYS AS` columns are not modeled yet; the removed `computed` option was
  the only way to mark one read-only.

- **Breaking:** branded column types compare strictly. A comparison, an insert or update value,
  and an `INSERT ... SELECT` into a column that decodes to a branded type (`Brand<...>`) take
  that brand: a value of it, a column of the same brand, or a param declared with the type
  (`param.of(type, name)`). A plain string, another brand (`UserId` for `OrgId`), `param.string`
  and unbranded columns are type errors. Literal unions still compare against their primitive.
  Migrate `$.OrgId.eq(param.string("orgId"))` to `$.OrgId.eq(param.of(orgIdType, "orgId"))`.
- Add `brand(type, schema)` (root, `/types`, `/postgres`): a column type narrowed by a schema,
  keeping the base type's SQL type and wire codec. Add `SelectRowOf<typeof table>`, the whole row
  a table decodes to.
- Add Postgres schema definitions and migrations. `S.pg.table` (with `S.pg.column`, `S.pg.index`,
  `S.pg.uniqueIndex`, `S.pg.foreignKey`) defines tables with primary keys, partial and expression
  indexes, foreign keys, defaults and identity columns; `dialect: "postgres"` in the kit config
  makes `generate`, `check`, `migrate`, `status` and `verify` work on Postgres. Each migration
  runs in one transaction under an advisory lock, and `verify` compares the catalog with the
  snapshot built in a rolled-back scratch schema.
  - Adopt a drizzle-kit folder with `generate --baseline --from-drizzle` (or `--baseline` from
    the definitions) and record an existing database with `effect-orm baseline <name>` /
    `Migrate.baseline`. drizzle-kit `snapshot.json` files are recognized; migrations before the
    first effect-orm snapshot are legacy and run as they are.
  - `Snapshot` is a union over `dialect` (`ClickHouseSnapshot`, `PgSnapshot`); `MigrationFile`
    over its generated files (`ClickHouseMigrationFile`, `PgMigrationFile`). `MigrationDriver`
    gains an optional `transaction`, which `fromSqlClient` provides. `Drift.problem` adds
    `not_null`, `identity` and `foreign_key`.

- **Breaking:** invalid queries are refused before any SQL is sent: as type errors where the
  type can see them, otherwise as a `QueryBuilderError` / `QueryBuilderDefect` from `compile`.
  - Params are in the query's type. `compile`, `compileUnion` and `Database.run` require every
    `param.*` the query uses, with a value of its type (`CHQuery`, `CHUnionQuery`, `CHInsert`,
    `CHUpdate` and `CHDelete` gain a `Params` type parameter; `Expr` and `Condition` gain `P`).
  - A second `where()` / `having()` ANDs with the first instead of replacing it, on queries and
    on writes.
  - Comparisons refuse `null` (use `isNull()`); an empty `in_()` / `notIn()` is `1 = 0` / `1 = 1`.
    `like` / `ilike` accept a nullable string.
  - `limit` / `offset` refuse negative, fractional or non-finite values instead of rounding them.
  - A query with no `select()` cannot be compiled, run, joined, used in `FROM`, a CTE, `EXISTS`
    or `INSERT ... SELECT`. `unionAll` branches must agree on aliases and column types.
    `inSubquery` / `notInSubquery` need exactly one column of a comparable type.
  - Join aliases must be unique and must not shadow a FROM column or the FROM alias; CTE names
    must be unique.
  - `update().set({})` and a SET or insert row naming a column the table cannot write are type
    errors; an UPDATE or DELETE without `where()` or `allRows()` cannot be compiled or run.
  - An aggregate in WHERE or a join's ON, a column that is neither grouped nor aggregated, and
    grouping by an aggregate fail to compile. SQL the builder did not write (`rawExpr`,
    `CH.sql`, windows, `makeExpr`) is not looked inside.
  - Built-in functions belong to a dialect: a ClickHouse function (such as `count()`) in a
    Postgres compile fails, and the reverse. `coalesce`, `nullIf` and `lower` are portable.
    `Dialect.functions` names a dialect's function set.
  - `makeExpr`, `makeUntypedExpr` and `makeCond` take the expressions they interpolate as
    `uses`, whose params the result carries; a param in the SQL that no `uses` entry carries
    fails to compile. Their value type comes from the schema: explicit type arguments
    (`makeExpr<T>`, `subqueryExpr<T>`, `compileTypedFnCall<R>`) are errors, so they cannot
    silently drop params. `untypedSubqueryExpr` returns `Expr<unknown>`.
  - `inSubquery` / `notInSubquery` check at compile time that the subquery selects one column.
- Add `CH.sql`: SQL templates inside expressions and conditions. `CH.sql(type)\`…\`` is a typed
  `Expr`, ``CH.sql`…` `` an untyped one, `CH.sql.cond` a `Condition`; with `sql.ident`, `sql.raw`
  and `sql.join`. Interpolated columns and params render as SQL and placeholders, a builder
  query as a subquery compiled with the outer one, and a plain value as an escaped literal.
- Add `Db.sql.join`, `Db.sql.raw` and `Db.sql.empty` to statement templates.
- Add `isNull()`, `isNotNull()`, `between()` and `notBetween()` on every expression, and
  variadic `CH.and(...)` / `CH.or(...)` that skip `undefined` and write one flat group.
- Add `distinct()` and `distinctOn(...aliases)` to queries, on both dialects.
- Add Postgres row locks: `forUpdate`, `forNoKeyUpdate`, `forShare`, `forKeyShare`, with
  `skipLocked`, `noWait` and `of` (`LockOptions`). Add `DialectClauses.locking`; ClickHouse
  refuses them. `SqlQuery` gains `distinct`, `distinctOn` and `lock`.
- `compile(query)` no longer needs a params argument when the query has no params.
- Add `update(table).set(...).where(...)` and `deleteFrom(table).where(...)` (see
  `docs/updates-and-deletes.md`), with `returning` on Postgres and `settings` on ClickHouse,
  where they compile to an `ALTER TABLE ... UPDATE` mutation and a lightweight `DELETE`. A write
  with no `where()` is refused unless `allRows()` says so, and one whose conditions all came out
  `undefined` fails. Tenant scope is derived from the WHERE. `CompiledQuery.kind` gains `update`
  and `delete`; `DialectClauses.insertSettings` is renamed `writeSettings` (unreleased), and
  `DialectClauses.alterTableUpdate` is added.
- `returning()` with no arguments returns every column, as in Drizzle. `insertInto(table)` now
  returns `CHInsertStart`, which offers only `values` and `select`, so an insert without rows
  no longer type-checks. Add `TableOptions.computed` for generated columns. `INSERT ... SELECT`
  accepts a plain primitive into a branded column, as comparisons do.
- Add `insertInto(table).values(rows)` (see `docs/inserts.md`): INSERT ... VALUES from the same
  table definitions, for ClickHouse and Postgres. The row type requires every column that is not
  nullable and has no default; values are encoded through the column codecs, written as literals
  on ClickHouse and bound on Postgres; a key some rows leave out is `DEFAULT`; tenant scope is
  derived as for queries. `compile` and `Database.run` accept an insert; `run` sends it through
  `command` and returns no rows.
- Add `TableOptions.defaults` for the columns an insert may leave out. `defineTable` works them
  out from its column options and records `MATERIALIZED` / `ALIAS` columns as not insertable.
- Add `returning` to an insert (Postgres): column names or a callback, as in `select`. `run`
  returns the inserted rows decoded through the derived row schema; `CompiledQuery.returning`
  lists the aliases. Add `DialectClauses.returning`, optional, absent meaning no.
- Add `onConflictDoNothing` and `onConflictDoUpdate` to an insert (Postgres), with Drizzle's
  options: `target` (columns or `{ constraint }`), `targetWhere`, `set` (a record, or a callback
  over the existing row and `excluded`) and `where`. Add `DialectClauses.onConflict`, optional.
- Add `select(query)` to an insert: `INSERT ... SELECT` from a query or union, its row checked
  against the table at the type level. Tenant scope follows the read and where the written
  tenant comes from.
- Add `settings(record)` to an insert (ClickHouse): `INSERT ... SETTINGS name = value`. Add
  `DialectClauses.writeSettings`, optional.
- Add `CompiledQuery.kind` (`"select"` or `"insert"`); `rawCompiledQuery` takes it as an option.
- Add `ParamStyle.maxParameters`; Postgres sets 65535, and a statement over it fails to compile.
- Add `@maple-dev/effect-orm/database`, opt-in (see `docs/database.md`): a `Database` over the
  Effect `SqlClient` you already use. `run(query, params?)` compiles a query for the database's
  dialect, runs it and decodes its rows; `sql\`...\`` writes the other statements with every
  value bound (and `sql.identifier` for names); `query` decodes rows through an optional schema.
  `transaction` runs Effect's own `withTransaction`, nesting as savepoints, and adds isolation
  level, access mode and deferrable settings; typed `TransactionCommitFailed` /
  `TransactionRollbackFailed` where Effect 4.0.0 dies; `retryContention` for SQLSTATE 40001 /
  40P01; `requireTransaction` to mark helpers that must be atomic, checked at compile time; and
  a `TransactionClosed` defect for statements that outlive their transaction. ClickHouse
  declares no transactions and fails with `TransactionUnsupported` before sending anything.
- Add `Dialect.transactions` (`DialectTransactions`, `IsolationLevel`, `TransactionSettings`):
  what transactions a dialect supports. Optional; absent means none.
- Add `CompiledQuery.dialect`: the name of the dialect a query was compiled for, so an executor
  can refuse one compiled for another database. `rawCompiledQuery` takes it as an option.
- Dev: PGlite 0.5. It takes the session time zone from the host, so tests pin it to UTC.

- Add schema-as-code and migrations for ClickHouse, all opt-in (see `docs/migrations.md`):
  - `./schema`: `defineTable` (a `Table` that also carries its DDL), `materializedView` (its
    body is a DSL query, type-checked against the target table), DDL rendering with replicated
    engines and `ON CLUSTER` as render options, content-hashed snapshots, and an offline diff.
  - `./kit` and the `effect-orm` command: `generate` writes the next migration from the schema
    modules, asks before dropping data (or takes `--hints`, exiting 2 without them), and
    refuses changes that need a table rebuild; `check` validates the snapshot chain and
    branch conflicts.
  - `./migrate`: `run`, `status`, and `verify` through a `MigrationDriver` you build from
    your `SqlClient`. Statements are journaled one by one so a failed run resumes, applied
    migrations have their hash checked, and `verify` compares the database with the last
    applied snapshot.
- Postgres: wrap each `UNION ALL` branch in parentheses (`DialectClauses.parenthesizeUnionBranches`).
  A branch with its own `WITH`, `ORDER BY` or `LIMIT` was a syntax error.
- Postgres: bind `param.float` as `$n::float8`, `param.bool` as `$n::boolean`, and the
  `dateTime` kinds as `$n::timestamptz`. A float compared with an int8 column was bound as
  int8 and rejected, and a param in a select list was bound as text.
- `ParamStyle.placeholder` receives the param kind as a second argument.
- Docs: exact int8 needs a codec that reads a `bigint` as well as a string; PGlite and
  postgres.js send `bigint`, so the documented `custom("int8", Schema.String)` failed there.
- Rename the package to `@maple-dev/effect-orm` and the repository to `MapleTechLabs/effect-orm`.
  Imports, error `_tag` prefixes (`@maple-dev/effect-orm/QueryBuilderError`, ...) and the live-test
  variables (`EFFECT_ORM_CLICKHOUSE_URL`, `_USER`, `_PASSWORD`) change with it.
- Add `Dialect`: how a compiled query writes identifiers and literals, binds params, and
  which clauses exist. `compile` and friends take `options.dialect`; `clickhouseDialect` is the
  default and its output is unchanged.
- Add `CompiledQuery.parameters`: the values a binding dialect sends beside `sql`, empty for
  ClickHouse. Code that builds a `CompiledQuery` by hand must now supply it.
- Add the `./postgres` entry point: `postgresDialect` (quoted identifiers, `$n` binding),
  Postgres column types and functions, and a `compile` that defaults to Postgres.
- A literal that would contain the param marker `__PARAM_` now fails the compile with
  `InvalidLiteral` instead of relying on each dialect's escaping.
- `compileUnionUnsafe` no longer accepts the internal `enclosingCtes` option.

## 0.2.0

- Require Effect `^4.0.0`. Effect 4.0.0 moved `effect/unstable/*` to `effect/*`
  with no compatibility exports. The benchmark entries (`./benchmark/http`,
  `./benchmark/cli`, `ch-bench`) now import `effect/http`, so 0.1.x fails there on
  stable Effect 4 and 0.2.0 fails there on the prereleases; the builder entries
  are unaffected either way.

## 0.1.4

- Restore the non-null result types of `sum`, `sumIf`, `toFloat64OrZero`, `.add()`,
  `.sub()`, and `.mul()` that 0.1.1 widened to `number | null`. A non-finite result, which
  ClickHouse JSON sends as `null`, now decodes as `NaN` instead. Results over SQL Nullable
  inputs still decode `null` as `null`.

## 0.1.3

- Require Effect `>=4.0.0-rc.113`. The benchmark HTTP config uses the renamed
  `Config.String` / `Config.Redacted` constructors; on rc.113+ the old
  lowercase names threw `Config.string is not a function` at import.

## 0.1.2 — unreleased

- Preserve `arrayFilter` element types and nullability through selected rows,
  and reject non-array inputs at compile time.
- Reject array and boolean timestamp expressions in `windowFunnel` and
  `sequenceMatch`.
- Expose unspecified codec representations as `unknown` instead of `any`.
  Consumers must narrow encoded values before using them; concrete column
  codecs retain their known wire types.

## 0.1.1 — unreleased

- Include scalar and predicate subqueries in tenant-scope inference, preserving
  scope through expression composition. Handwritten subquery strings are
  conservatively classified as cross-tenant.
- Derive `arrayOf` codecs from every element, preserving nullable values and
  leaving arrays with untyped elements unvalidated.

- Qualify source columns to prevent SELECT aliases from changing tenant filters.
- Preserve column literal codecs through derived sources and evaluate join callbacks
  during compilation with both sources' codecs.
- Preserve nullable array insertions, string conversions, conditional fallbacks, and
  DateTime64 precision when combining built-in result codecs.
- Decode numeric overflow as JSON `null`; arithmetic, sums, and floating-point string
  conversion now expose nullable result types where needed.
- Normalize timezone offsets before flooring DateTime parameters to seconds.
- Compare benchmark results with lossless numeric hashes. Regenerate saved baselines
  to use the new `json-exact-v1` hash format.
- Correct FORMAT-clause detection around identifiers and remove statement terminators
  followed by comments before rewriting SQL.

## 0.1.0 — unreleased

First public release.

- Type-safe table definitions, immutable query builder, joins, subqueries,
  unions, and CTEs.
- Parameterised compilation: `param.string` / `int` / `float` / `bool` /
  `dateTime`. Values are checked against the declared kind at compile time — a
  param with no value, a `Date` where a string was declared, or a fraction where
  an integer was, throws `QueryBuilderError` instead of becoming SQL text.
- Optional per-table tenant scoping: declare `{ tenantColumn }` on a table and
  every compiled query reports whether it pinned a single tenant. Reported,
  never enforced; tables that declare nothing compile `"untenanted"`.
- `route(tag)` carries an opaque execution tag through to the compiled query
  as a type-level fact.
- Schema-first column types: `T.uint64` and friends are Effect `Schema`s, not
  phantom tags, so `compile` derives each query's row schema from its SELECT and
  `decodeRows` validates without a hand-written schema. `rowSchemaSource` says
  whether it was `"derived"`, `"declared"`, or `"none"` (some selected
  expression had no type to read). A declared schema still wins, and can narrow.
- Wire quirks modelled once in the types: 64-bit integers accept ClickHouse's
  quoted form and Tinybird's bare numbers; `T.dateTime` parses the tz-less
  `YYYY-MM-DD hh:mm:ss` shape as UTC into a `DateTime.Utc`, with
  `T.dateTimeString` for consumers that need the string exactly as sent.
- The encode direction of those same schemas writes every literal: comparing a
  column against a value encodes it through the column's type, so a `Map` writes
  as `map('k', 'v')`, an `Array` as `['a', 'b']`, a `Bool` as `1`/`0`, and a
  value the column cannot hold fails while the SQL is being built. Params
  resolve through the same path, and `param.of(type, name)` accepts any column
  type — including one declared with `T.custom(sql, schema)`.
- Compilation is Effect-returning. `compile` / `compileUnion` fail with a typed
  `QueryBuilderError` — a missing param value, a value the column cannot encode —
  instead of throwing, so a caller can handle one rather than crash. A throw that
  is not a `QueryBuilderError` stays a defect: it is a bug, not a condition.
  `compileUnsafe` / `compileUnionUnsafe` keep the throwing behaviour for fixtures
  and catalogs, where failing loudly is the contract.
- Schema-checked row decoding (`decodeRows` / `decodeFirstRow`). No `castRows`.
  When nothing could be derived, `untypedColumns` names the selected aliases
  responsible, so "this query decodes nothing" is not a dead end.
- `encodeRows` runs the row schema backwards, turning decoded rows into the wire
  shape ClickHouse sent. A service can hold the value worth computing with and
  still emit the exact bytes its own clients parse, rather than choosing.
- Every expression the package produces carries its type. Literals, the
  arithmetic operators, `Map` subscripts (`$.Attrs.get(k)` decodes as the map's
  value type), and every wrapped function declare what they return, so a query
  built from typed pieces derives a schema for the whole row rather than losing
  it to one untyped field.
- The escape hatches say so in their names. `rawExpr(sql, type)` requires the
  column type its SQL produces; `untypedExpr(sql)` is the version with no type,
  and `defineUntypedFn` the same for functions. `defineFn`'s result type is
  required, and may be a rule reading the type off the arguments — `sameAs(i)`,
  `firstTyped()`, `elementOf(i)`, `arrayOfArg(i)` — for the many ClickHouse
  functions that hand back one of their inputs.
- `T.aggregateState(fn, …args)` names an `AggregateFunction` state column: an
  opaque value an outer `-Merge` reads, never a row anyone decodes. Declaring
  one no longer costs its query the rest of its row schema.
- `T.int64`, and `arraySort` / `arrayReverseSort` / `arrayDistinct` /
  `arrayPushFront` / `arrayElement` / `hex` join the wrapped catalog.
- Requires Effect 4 (`effect@rc`) as a peer dependency.

## Unreleased

- Ship the reusable benchmark engine, HTTP transport and `ch-bench` CLI.
- Add Effect suite definitions, JSON protocol, capability checks, result verification,
  schema provenance, and multi-metric comparison gates.
- Include benchmark documentation and an agent playbook in the published package.

- Rename the public package and library directory to `@maple-dev/effect-clickhouse`
  and `lib/effect-clickhouse`; retain the `ch-bench` executable.
