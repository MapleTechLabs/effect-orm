# Dialects: one builder, several databases

Status: done. ClickHouse and Postgres both compile from the same builder; see
[`docs/postgres.md`](../docs/postgres.md). Steps 4 and 5 landed differently from the plan, as
noted below.

## Goal

Keep one query builder, one tenant-scope analysis, and one row-decoding model, and let the
database-specific parts (SQL syntax, literals, param binding, column wire formats, the
function catalog) vary per dialect. ClickHouse output stays byte-identical at every step; the
exact-SQL tests in `src/ch/compile.test.ts` are the guard.

## What we took from Kysely and Drizzle

Both were read from source (Kysely 0.28.17, Drizzle 1.0.0-rc.5).

| Idea | Where it comes from | How it lands here |
| --- | --- | --- |
| Builders produce a config object; a dialect turns it into SQL | Drizzle `PgDialect.buildSelectQuery(config)` | `CHQueryState` already is that config; `compile.ts` reads the dialect where clauses differ (step 5) |
| SQL as a chunk tree rendered at the end with `escapeName` / `escapeParam` / `escapeString` | Drizzle `SQL` chunks + `BuildQueryConfig` | `Str` and `Ident` render through the installed dialect; params stay text placeholders resolved once per statement |
| Inline vs bound params as a switch | Drizzle `inlineParams` | `ParamStyle`: `inline` (ClickHouse today) or `bind` |
| A small override surface per dialect | Kysely `DefaultQueryCompiler` hooks (MySQL overrides ~10 methods) | The `Dialect` interface grows hook by hook, never a copy of the compiler |
| Capability flags instead of dialect checks | Kysely `DialectAdapter` (`supportsReturning`, ...) | `Dialect.clauses`: `format`, `derivedTableAlias`, `groupByAlias` |
| A compiled query that keeps its structure | Kysely `CompiledQuery.query` | `CompiledQuery` already carries tenant scope and row schema; `parameters` added in step 1 |
| Rewrites as passes over the tree | Kysely plugins (`transformQuery` / `transformResult`) | Not adopted yet; tenant scope is still derived inside `compile` |
| Logical type separate from how a driver sends it | Drizzle v1 codecs, `refineGenericPgCodecs` per driver | Per-dialect type sets on the shared descriptor, codecs tolerant of every common driver (step 4); `Dialect.paramCodecs` for params |
| Shared operators, per-dialect function catalogs | Drizzle `sql/expressions` vs `pg-core` / `mysql-core` | `eq`, `and`, `in_` in core; `countIf`, `percentileCont` per dialect |

What we deliberately do not copy:

- Kysely decodes nothing at runtime; its row types are a promise. Our schema-backed
  `decodeRows` stays.
- Drizzle copies the whole query builder per dialect package. We share the builder and vary
  only types and functions.
- Tenant scoping stays a proof, not a plugin that injects `OrgId = ...`. Injection would hide a
  missing tenant condition instead of reporting it.

## Steps

1. **Params through a dialect (done).** `renderParams` resolves placeholders once, at the top
   of the statement, so a binding dialect can number them across unions and subqueries.
   `CompiledQuery.parameters` holds the bound values. Tenant bounds still render as ClickHouse
   literals, since they are compared as text and never sent.
2. **Literals behind the dialect (done).** `Dialect.quoteString` and `Dialect.literal` write
   every `Str` fragment, column literal, and inline param. `compile` installs the dialect for
   the length of the compile (`withDialect`, the same save/restore pattern as
   `withSubqueryCompiler`), because literals are written inside the query callbacks, which
   have no dialect argument. The installed values live in the compiling fiber's context
   (`src/sql/fiber-local.ts`), not in module state, so two compiles in two fibers cannot see
   each other's dialect. The dialect is `CurrentDialect`, a `Context.Reference` a caller can
   also provide. The `__PARAM_` safety is now enforced rather than assumed: a
   literal that contains the marker fails with `InvalidLiteral`, so a dialect with weaker
   escaping cannot turn a value into a placeholder.
3. **Identifier quoting (done).** Column refs are `Ident` fragments carrying their qualifier
   (`ident(column, "alias")`), so a ClickHouse `Nested` column such as `Events.Name` is never
   split while `db.table` qualifiers are quoted per segment. Tables, aliases, CTE names, and
   group/order keys go through `Dialect.quoteIdent` too. Untyped boolean and DateTime
   literals moved behind the dialect in the same step (`dateTimeLiteral`).
4. **Column types (done, differently).** The plan was to split `CHType` into a logical type
   plus a transport codec. Postgres turned out not to need the split: its types reuse the
   `CHType` descriptor (`PgType` is an alias) with codecs that accept every wire form a common
   driver sends (int8 as number, string or `bigint`; timestamptz as `Date` or text), the same
   approach `CHNumber` already takes for quoted 64-bit integers. Portable param kinds that
   must encode differently (`param.bool`, `param.dateTime`) are re-encoded per dialect by
   `Dialect.paramCodecs`. A per-driver codec axis can come later if a consumer needs one.
5. **Clauses (done, differently).** The plan was to move `compile.ts` into a
   `ClickHouseDialect.buildSelect(state)`. The clauses Postgres needed to differ were few:
   no `FORMAT`, an alias on a wrapped union, and GROUP BY by position (Postgres reads a bare
   name as an input column before a select alias). Those are `Dialect.clauses` flags read at
   three places in `compile.ts`, which kept ClickHouse output byte-identical without
   relocating ~1100 lines. A dialect that needs a structurally different statement is the
   point to revisit this.
6. **Postgres dialect (done).** `@maple-dev/effect-orm/postgres`: `postgresDialect`
   (double-quoted identifiers, standard strings with `E'…'` only to escape the param marker,
   `$n` binding), column types, a function catalog (`count(*)`, `FILTER (WHERE …)`,
   `percentile_cont`, `date_trunc(…, 'UTC')`, `date_bin`, `array_agg`, `->>`), and a
   `compile` that defaults to Postgres. `src/pg/postgres.test.ts` runs every query on PGlite
   (Postgres 17 in WASM), so a test passes only if Postgres accepts the SQL and the rows decode.

## Open questions

- ClickHouse also supports server-side binding (`{name:Type}` with `query_params`). Adding it
  needs the param kind to name a ClickHouse type, which `param.of` already has.
- The package is still named for ClickHouse and the root entry still exports the ClickHouse
  function catalog. Renaming, or a `core` entry without ClickHouse functions, is a packaging
  decision for a later release.
- The ClickHouse function catalog writes ClickHouse SQL whatever the dialect. A built-in
  function now refuses to compile under another dialect, and is a type error there too: its
  result carries a `DialectEntry` beside its params, which `compile` and
  `DatabaseApi<Functions>.run` check against the target. The `Database` in context has no
  dialect in its type, so it checks only that a query does not mix two. A `CompiledQuery` does
  not carry its dialect in the type yet.
- MySQL or SQLite would need `?` placeholders (`reuse: false` already exists) and their own
  types and functions; nothing in the core should need to change.
