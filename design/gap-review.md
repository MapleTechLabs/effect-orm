# Gap review: effect-orm against Drizzle and Kysely

Status: review of `main` after the INSERT builder landed (PRs #9 to #12). Four reviews, one per
area, each read the installed sources (Drizzle ORM 1.0.0-rc.5, Kysely 0.28.17) and checked every
claim against this repository. Maple call-site counts come from `design/transactions.md` §5.

Priority: **P0** blocks Maple replacing Drizzle on Postgres, or is table-stakes for a query
builder; **P1** commonly used; **P2** niche.

## Found in the INSERT builder (fixed alongside this note)

1. `returning()` with no arguments type-checked and then failed to compile. It now returns every
   column, as Drizzle's bare `.returning()` does.
2. `insertInto(table)` could be compiled and run before it had rows. It now returns
   `CHInsertStart`, with only `values` and `select`.
3. `INSERT ... SELECT` rejected a plain primitive into a branded column, which `values` and every
   comparison accept. It now uses the comparison rule.
4. A Postgres `GENERATED ALWAYS` column could not be marked on `table()`. `TableOptions.computed`
   does that.
5. jsonb and array values in `onConflictDoUpdate`'s SET were untested. They now have a PGlite
   round trip.

## P0

| Gap | Maple | Effort |
| --- | --- | --- |
| ~~UPDATE builder: SET values and expressions, WHERE, RETURNING~~ (built) | ~120 | M |
| ~~DELETE builder: WHERE, RETURNING~~ (built) | ~79 | S |
| A typed, value-binding `sql` template usable inside expressions; `sql.join` / `raw` / `empty` on `Db.sql` | ~163 | M |
| Postgres column types: `timestamptz` as `Date`, `timestamp`, `date`, `interval`, `varchar(n)`, serial / identity | 226 timestamp columns | S |
| DISTINCT (and DISTINCT ON) | ~10 | S |
| `FOR UPDATE` / `FOR SHARE` / `SKIP LOCKED` / `NOWAIT` | 7 | S |
| jsonb and array operators (`@>`, `->`, `?`, `&&`, `ANY`) | ~12 | M |
| `isNull` / `isNotNull` / `between`; variadic `and` / `or` that skip `undefined` | everywhere | S |
| Constraint error helpers (unique, foreign key, not null); keep ClickHouse's numeric error codes, which `sqlStateOf` drops today | all upserts | S |
| Tenant-scope enforcement in `Database`, opt in, with an explicit cross-tenant entry point | safety | S |
| Postgres `defineTable` (indexes, unique, FKs), Postgres migrations, a drizzle-kit importer | 68 tables, 90 indexes, 47 unique, 75 folders | L; can wait, drizzle-kit can keep migrating |

## P1

- Queries: ORDER BY an expression with NULLS FIRST/LAST; GROUP BY an expression; right and full
  joins; ON callbacks that see earlier joins; UNION, INTERSECT, EXCEPT; `row_number`, `rank`,
  `lag`, `lead` and RANGE frames; portable `case` and `cast` (`if_` / `multiIf` emit ClickHouse
  function names, which Postgres does not have); `select *`.
- ClickHouse: FINAL, PREWHERE, LIMIT BY, SETTINGS on SELECT, the ARRAY JOIN clause.
- Writes: UPDATE ... FROM with a typed VALUES source; ClickHouse `ALTER TABLE ... UPDATE/DELETE`
  and lightweight DELETE; JSONEachRow bulk insert (`encodeInsertRows`); a set-all-from-`excluded`
  helper; client-side default hooks like `$defaultFn` / `$onUpdate`.
- Runtime: `runFirst` / `runSingle` / `stream`; `observe` with duration, rows and error; replica
  routing for `route()`; a `SET LOCAL` helper for RLS; a mock `Database` for users' tests.
- Types: select, insert and update row types and Schemas per table.
- Tooling: `pull` (introspect to `defineTable`) and `push`, ClickHouse first.

## P2

Lateral joins, recursive and materialized CTEs, ROLLUP / CUBE, FETCH, MERGE, `db.batch`,
TRUNCATE, DELETE USING, `DEFAULT VALUES`, expression conflict targets, schemas / namespaces, enums,
views, relations and a relational query API, casing (has to live in the builder: decoding reads
aliases exactly), a query cache, EXPLAIN on `Database`, controlled transactions, seeding, a studio,
more dialects.

## Where effect-orm is ahead

- Tenant scope derived at compile time, through joins, CTEs, subqueries, unions and inserts.
- Row decoding derived from each query, reversible (`encodeRows`), with `rowSchemaSource`,
  `untypedColumns` and `rowSchemaMismatch` saying where typing was lost.
- Transactions: typed COMMIT and ROLLBACK failures, `TransactionClosed`, contention retry,
  `requireTransaction` in the type.
- Dialects refuse unsupported clauses before sending SQL, and a query compiled for another one.
- The ClickHouse migration runner: per-statement journal and resume, cluster and replication as
  render options, drift checked against the last applied snapshot.
- Columns are codecs: `jsonb(schema)` validates at runtime; wire quirks are absorbed once.

Drizzle 1.0 now ships Effect drivers (`effect-postgres`, `effect-pglite`) and Effect Schema
validators, which narrows the lead on Effect integration.

## Order of work

1. The INSERT fixes above.
2. UPDATE and DELETE with RETURNING, reusing the insert's SET record, value encoding and
   RETURNING path.
3. The expression-level `sql` template, null and range predicates, variadic `and` / `or`,
   DISTINCT and locking.
4. Postgres column types and modes, jsonb operators, constraint error helpers.
5. Tenant enforcement and observability in `Database`.
6. Postgres schema-as-code and migrations.
