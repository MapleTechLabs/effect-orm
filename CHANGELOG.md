# @maple-dev/effect-orm

## 0.10.1

### Patch Changes

- eccc9c2: The package homepage and README now link to the new docs site at https://effect-orm.maple.dev.
- 7b01f01: Tested against Effect 4.1.2. The peer range stays `effect ^4.0.6`, and the docs' pinned install examples now use 4.1.2.

## 0.10.0

### Minor Changes

- 28ee8b8: A new `/mysql` entry compiles the shared query builder for MySQL 8.0.17+ (`mysqlDialect`) and MariaDB 10.6+ (`mariadbDialect`), for `@effect/sql-mysql2` (#53). It writes backtick identifiers and positional `?` bindings (up to 65,535 per statement), escapes `\` in string literals, and writes `OFFSET` without `LIMIT` with MySQL's largest row count. It has MySQL column types and codecs for what mysql2 sends (`text`, `longtext`, `varchar(n)`, the integer types, `bigint` within 2^53, `double`, `decimal(p, s)` as exact text, `boolean`, `datetime` as `DATETIME(3)` in UTC, `date`, `blob`, `varbinary(n)`, `json(schema)`) and MySQL functions (`count`, `countDistinct`, `countIf`, `sum`, `avg`, `min`, `max`, `lower`, `upper`, `length`, `coalesce`), refused for another dialect in the type. `forUpdate` and `forShare` compile for MySQL, with MariaDB's `LOCK IN SHARE MODE`; the type refuses `forNoKeyUpdate` and `forKeyShare` there. RETURNING, ON CONFLICT, DISTINCT ON and ILIKE are refused at compile time. A transaction's isolation level and access mode go in the statement that starts it (`SET TRANSACTION …; START TRANSACTION READ ONLY`). `contains`, `startsWith` and `endsWith` compare bytes, so they stay case-sensitive under a case-insensitive collation. A JSON column is compared with `CAST(? AS JSON)` on MySQL. A selected small integer or numeric param is cast, as MySQL 8.4 can read it as an ORDER BY position inside a derived table. The fuzzer runs every property on MySQL 8.4 and MariaDB 11.4, over prepared statements and the text protocol Cloudflare Hyperdrive uses; see docs/mysql.md for what MySQL does differently.
  
  Breaking, for a custom `Dialect`:
  
  - `clauses.offsetRequiresLimit: true` is now `clauses.limitForOffset: "-1"`: the LIMIT to write, which MySQL needs to be its largest row count.
  - `clauses.locking` is a `LockingSupport` (`{ strengths, of, shareSyntax? }`), not `true`: Postgres's is every strength with `of`.
  - `likeIgnoresCase: true` is now `likeCase: "ascii-insensitive"`, beside `"sensitive"` (the default) and MySQL's `"collation"`.
  - `integerComparesFraction: true` is now `fractionComparableIntegers`, the integer column types that compare with a fraction (SQLite's is `["integer"]`).
  
  New optional `Dialect` fields: `castType` (the CAST target for a selected param's column type), `concat`, `comparisonCast` and `clauses.selectedNumberCast`. `MysqlOnly` and `LockingSupport` are exported from every dialect entry.
- 91c6ee5: `MySQL.table(name, { columns, primaryKey, indexes, tenantColumn, casing })` declares a MySQL or MariaDB table with its DDL, as `SQLite.table` does: the value is still a query `Table`, with `ddl` and `problems` beside it. `MySQL.column(type, { name, default, defaultExpr, unique, defaultFn, onUpdate })`, `MySQL.index` and `MySQL.uniqueIndex` go with it, and `{ external: true, columns }` declares a table another tool owns. A literal default on a `TEXT`, `BLOB` or `JSON` column is written as an expression, `DEFAULT ('…')`; `MySQL.dateTimeNow` is the `defaultExpr` for a `datetime`. A definition records a problem for a `TEXT`, `BLOB` or `JSON` column in a key, index or UNIQUE constraint, a nullable primary key column, a key past InnoDB's 3072 bytes, a name past 64 characters, and index names that collide.
  
  `/schema` adds `mysqlEntitiesOf`, `renderMysqlSchema` (`CREATE TABLE IF NOT EXISTS … ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` and `CREATE [UNIQUE] INDEX`), `diffMysqlSchemas`, `MysqlMigrationOp`, `renderMysqlOp`, `renderMysqlMigrationSql`, the MySQL entity schemas and `MysqlSnapshot`. `effect-orm generate` with `dialect: "mysql"` writes the next migration in the drizzle-kit 1.0 folder layout, one statement per `--> statement-breakpoint`, altering tables in place: `ADD`, `DROP`, `MODIFY` and `CHANGE COLUMN`, `DROP` / `ADD PRIMARY KEY`, `RENAME TABLE`, and index and UNIQUE changes. effect-orm does not apply MySQL migrations yet: `/migrate` refuses a MySQL folder, `verify --schema` a MySQL config, and `--from-drizzle` a MySQL snapshot. A new fuzzer applies migrations between random schemas to seeded rows on MySQL 8.4 and MariaDB 11.4 and compares `information_schema` with a fresh create.

## 0.9.0

### Minor Changes

- 3407bad: `Db.findById(query, { key })` and `Db.findAllBy(query, { key })` in `/database` batch lookups by a key with Effect's `RequestResolver`: N concurrent calls send one statement, the query with `key IN (...)` added to its WHERE, and each row decodes through the query's row schema. A batch never mixes `Database`s, transactions or params, so a tenant filter in the query (a value or a `param.*`, given with `.with(params)`) keeps each statement to one tenant, and `requireTenantScope` checks it. On a dialect with a bound-parameter limit (D1: 100) a large batch is split into statements that each fit.
- 4391d05: `Db.transaction({ isolationLevel, accessMode, deferrable })` on Postgres puts the settings in the statement that starts the transaction (`BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY`) through Effect's `SqlClient.BeginTransaction`, one round trip less than the `SET TRANSACTION` it sent before. A dialect gives the BEGIN statement with the new optional `DialectTransactions.beginTransaction`; `postgresDialect` has it, and a dialect without it still sends `SET TRANSACTION`. SQLite keeps its client's own BEGIN. `observe` sees the BEGIN statement, and a failed BEGIN reports it as `DatabaseError.sql`.
- 0315f9e: `/database` adds `runOne`, `runOption` and `runNonEmpty`: `run` with a check on how many rows came back. `runOne` wants exactly one row, `runOption` returns an `Option` and wants at most one, and `runNonEmpty` returns a `NonEmptyReadonlyArray` and wants at least one. A wrong count fails with `ResultCardinalityError` (`expected`, `rows`) in the error channel. The query runs as written, with no `LIMIT` added, so a duplicate row is found, not hidden.
- 8588e88: `PG.column` and `SQLite.column` take client-side defaults as Effects: `defaultFn` runs for each row an insert leaves the column out of, and `onUpdate` for each update that does not set it (and for an insert, when the column has no other default). An Effect can read the `Clock`, `Random` or a service, so `TestClock` and a test layer give exact values in tests. Such a column is optional in the insert row type, and the Effect's requirements become the write's: `Db.run(PG.insertInto(Notes).values(...))` requires `IdGen` when `id` is `{ defaultFn: IdGen.next }`. `Database.run` runs them; `fillDefaults(write)` runs them for a write you compile yourself, and `compile` refuses a write that still leaves one out, and an `INSERT ... SELECT` that does not select such a column. They write no DDL and no migration. `Table`, `PgSchemaTable` and `SqliteSchemaTable` gain two type parameters for the requirements; they default to `never`.
- 24aff1d: Column names apart from keys, on every dialect. `CH.column(type, { name: "org_id" })` now does
  what `PG.column` already did: the column is stored as `org_id` and read, written, filtered and
  indexed as its key. A new `casing` table option (`"snake_case"` or `"camelCase"`, the `Casing`
  type), on `CH.table`, `PG.table` and `SQLite.table`, names every column that gives no `name` from its key, by drizzle-orm's rule: `orgId` is
  `org_id`, `HTTPStatus` is `http_status`. The DDL, migrations, inserts, updates, upsert targets,
  `returning` and tenant scope use the database name; rows decode under the key. A ClickHouse
  materialized view whose target renames a column records a problem, since ClickHouse fills the
  target by database name. Two keys that map to one database name are a definition problem.
- d0efaaf: Constraint violations are typed errors. `refineConstraints(effect)` turns a `DatabaseError` or `TransactionCommitFailed` for a broken constraint into `UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation` or `CheckViolation`, so a caller can `catchTag` a duplicate key. Each carries the `constraint`, `table` and `column` the server named. Postgres maps SQLSTATE 23505, 23503, 23502 and 23514; ClickHouse maps code 469 (`VIOLATED_CONSTRAINT`) to `CheckViolation`. SQLite and D1 map the `SQLITE_CONSTRAINT_UNIQUE`, `_PRIMARYKEY`, `_FOREIGNKEY`, `_NOTNULL` and `_CHECK` extended codes, with the table and column SQLite names. `constraintViolation(error)` reads one without failing. `DatabaseError` and `TransactionCommitFailed` now keep the server's numeric error code as `errorCode`, which ClickHouse reports and `sqlState` dropped. `ClickhouseHttpClient` classifies code 469 as `ConstraintError` instead of `StatementTimeoutError`.
- d855cd8: `Db.layerTest({ dialect })` from `/database` is a `Database` with no server, for unit tests. It also gives `TestDatabase`: `statements` holds each statement it was sent (SQL and parameters, transaction control included), and `reply(...)` queues the rows, or the driver `SqlError`, the next statements get. With no reply queued, a statement gets `respond(statement)` from the options, or no rows. The layer is `fromSqlClient` over a fake `SqlClient`, so compiling, row decoding by the query's own schema, `requireTenantScope` and transactions run as they do against a server.
- 9cdbb38: `Db.stream(query, params?)` and `DatabaseApi.stream` run what `run` takes and return a `Stream`
  of its rows. Each row is decoded by the query's row schema when it arrives, so a large result
  does not have to fit in memory. A row that does not match fails the stream with
  `CompiledQueryDecodeError` and its `rowIndex`. The stream uses the `SqlClient` statement's
  `.stream`, reads on the transaction's connection inside `transaction`, and runs in one client
  span that counts the rows it emitted. On `sqliteDialect` and `d1Dialect`, whose Effect drivers
  have no streaming read, the whole result is read first and then emitted row by row.
- 046e378: `CurrentDialect`, a `Context.Reference`, sets the dialect a `compile` writes for when no `options.dialect` is given: `CH.compile(query, params).pipe(Effect.provideService(CH.CurrentDialect, postgresDialect))`. The order is `options.dialect`, then `CurrentDialect`, then the entry's dialect. A compile's state (its dialect, syntax, bound values and failures) is now kept in the context of the fiber that runs it, not in module state, so compiles for two dialects in concurrent fibers stay independent.
- f525d26: `/database` adds `paginate(query, { orderBy, after, limit }, params?)`: keyset (cursor) pagination over a built query. It adds a seek on the sort key, the `ORDER BY` and `LIMIT limit + 1`, and returns `{ rows, nextCursor }`, with no `OFFSET`. With one direction the seek is a row comparison, `(a, b) < (?, ?)`; with mixed directions it is the expanded `OR` form, bounded on the first key. The key is one or more selected, non-null aliases; end it with a unique column. The cursor is base64url text, encoded through the key columns' schemas. A cursor that does not decode, or that was written for another sort key, fails with the new `InvalidCursor` error. Postgres, ClickHouse, SQLite and D1. A nullable key is refused at run time too, since dialects sort NULLs differently.
- b4f5c51: `makeRepository(table, { idColumn, tenantColumn })` in `/database` builds the plain CRUD of a table on the `Database` in context, as `SqlModel.makeRepository` does for a `Model.Class`: `insert`, `insertVoid`, `update`, `updateVoid`, `findById` and `delete`. `findById` and `update` return an `Option`. Inserts take the `tableSchemas(table).insert` row and updates its `update` row. A table with a tenant column gets a `TenantRepository`: every method takes the tenant first, writes or filters the tenant column from it, and compiles as `"single-tenant"`, so a call cannot read or write another tenant's rows. A patch cannot change the id or the tenant column. On ClickHouse, which has no `RETURNING`, use `insertVoid`, `updateVoid` (a mutation that waits), `findById` and `delete` (a lightweight delete that waits). SQLite and D1 support every method.
- ba92520: Statement observation and parameter redaction for `Database`.
  
  - `observeExit` on `fromSqlClient` is called with every statement once it ends: its `db.*` names, tenant scope, route, duration, row count, or `error.type`.
  - `spanParameters: true` puts the bound values on the statement span as `db.query.parameter.<index>`. It is off by default, so spans carry no values.
  - A value given as `Redacted` (for example in a column typed `brand(text, Schema.RedactedFromValue(Schema.String))`) is marked in `CompiledQuery.sensitiveParameters`. Spans write it as `<redacted>`, and `observeExit` gets it still `Redacted`. The driver gets the plain value. This covers every dialect that binds values: Postgres, SQLite and D1.
  - `sql\`...\`` binds a `Redacted` value as its plain value. It used to bind the `Redacted` object, which the driver wrote as the text `<redacted>`. On ClickHouse, which writes values into the statement text, it refuses one.
- 9e8fa2c: Typed jsonb paths on Postgres, read off the column's schema. `PG.jsonPath($.payload, "profile", "city")` on a `PG.jsonb(Schema.Struct({ profile: Schema.Struct({ city: Schema.String }) }))` column is an `Expr<string | null>` that compiles to `("payload" -> 'profile' -> 'city')` and decodes with the field's own schema; only paths the schema has type-check, and a number key indexes an array. `jsonPathText` reads with `->>`, `jsonContains` filters with `@>` (bound as `$n::jsonb`), and `jsonSet` writes one path with `jsonb_set` inside an UPDATE's `set`, without reading the row first. Values compared with a path, and the value of a `jsonSet`, are encoded by the field's schema and bound as JSON. A path the schema does not have, or one through a field whose stored form differs from its type, is a defect at compile time. The path types (`JsonPath`, `JsonPathValue`, `JsonContained`, …) and `jsonPathSchema` are exported for helpers. Postgres only: compiled for ClickHouse, SQLite or D1 these are a defect; SQLite JSON paths are not built yet.
- 6aeaecb: A query is now `Pipeable`, and a new `Query` namespace on `/clickhouse`, `/postgres` and `/sqlite` gives a data-last form of every `CHQuery` method (`select`, `where`, `groupBy`, `having`, `orderBy`, `limit`, `offset`, `format`, `distinct`, `distinctOn`, the row locks, `route`, `crossTenant`, the table and subquery joins, `withCTE`), next to `from`, `fromQuery` and `fromUnion`: `CH.Query.from(Events).pipe(CH.Query.select(...), CH.Query.where(...))`. Each function is a `dual` that calls the fluent method, so both styles write the same SQL on every dialect, and each also has a data-first form. `$` in a data-last callback is typed from the query that `pipe` carries.
- 26a90c7: A `where` that proves a joined column not NULL now narrows that column for a later `select`. `$.l.Id.isNotNull()` and `$.l.Id.eq(…)` prove it, alone or under `.and(…)`, `and(…)` or the `where` list. The row type and the derived row schema both drop `| null`, so `leftJoin(…).where(($) => [$.l.Id.isNotNull()]).select(($) => ({ id: $.l.Id }))` reads `id: string`, and a NULL in that column fails to decode. `or`, `not`, `when` and a `select` made before the `where` keep `| null`. `Condition` has a second type parameter for these facts; it defaults to none, so existing code does not change.
- 8be9e66: Relation filters and counts in `/database`, as Prisma's `some` / `none` / `every` and `_count`. `findMany`'s `where` gets the relations of its level as a second argument: `where: ($, r) => [r.posts.some(($) => [$.published.eq(false)])]`. `Db.related(schema.users, $)` gives the same filters on a builder query, and `r.posts.count(where?)`, an `Expr<number>` for a `select` or a `where`. The filters are correlated `EXISTS` / `NOT EXISTS` subqueries. `_count: { posts: true }` in `findMany` adds `_count: { posts: number }` to each row, with one grouped statement per level. When both tables declare a tenant column, the subquery matches the outer row's tenant, and a filter under a scoped query stays `"single-tenant"`. Works on Postgres, ClickHouse 25+, SQLite and D1; a `_count` level is split to the dialect's bound-value limit like a level of `with`. See docs/relations.md.
- 1311ae8: `Db.defineRelations(tables, (r) => ...)` and `Db.findMany(schema.table, { where, orderBy, limit, with })` in `/database` read rows with their related rows, nested to any depth, as Drizzle's relational queries and Prisma's `include` do. `r.one` and `r.many` are checked against the tables. Each level of `with` is one statement, `WHERE <key> IN (...)` over the keys of the level above, decoded through its own row codec, so a nested `timestamptz` is a `DateTime.Utc`. A level whose parent rows carry one tenant is pinned to it, and `requireTenantScope` checks every level. A level whose keys pass the dialect's bound-value limit (D1: 100) is split into several `IN` statements. Works on Postgres, ClickHouse, SQLite and D1. See docs/relations.md and design/relations.md.
- 46828b3: `CompiledQueryDecodeError` is safe to log. It carries `dialect`, `collection`, `column` and `issues` (the Schema path, issue kind and expected type of each issue), and its `message` names them: `Compiled query row 0 did not match its declared output schema: at ["phone"] expected number`. No field holds a row value, so `toString()`, `JSON.stringify`, `util.inspect` and `Cause.pretty` print none. The Schema error moves from `cause` to the non-enumerable `schemaError` property, because it can quote the value (the ClickHouse `DateTime` codec did). New `formatDecodeError(error, { verbose? })` gives a one-line summary for a log; `verbose: true` appends the raw Schema message. Breaking for code that read `error.cause` or built the error by hand: read `error.schemaError`, and pass `issues`.
- e3cb32d: A new `/seed` entry makes test and demo rows from a table's column Schemas, through Effect's `Schema` → `Arbitrary`, with no dependency beyond `effect`. `rows(table, { count, seed })` returns decoded rows: the same seed gives the same rows, and each column samples from its own seed, so a new column does not change the others. The built-in column types add the range their SQL type stores (integer widths and safe `SQLite.integer`s, `float4`, `DateTime`, `timestamptz` and `SQLite.timestamp` years, `uuid`, no U+0000 in `text`), and a branded column gets only values of its brand. `columns` overrides a column with a value, an `Arbitrary` (`pick(ids)` for a foreign key) or a function of the row index. `unique` columns, and a Postgres or SQLite table's one-column primary key and `unique` columns, get distinct values. A table with a tenant column needs `tenant` (every row in one tenant, so the insert is `"single-tenant"`) or `crossTenant: true`. `insert(table, options)` writes the rows through `insertInto` on the `Database` in context, `batchSize` rows per statement, and `arbitrary(table)` gives whole rows to `Arbitrary.checkEffect` for property tests. Defaulted and computed columns are left to the database. Failures are a `SeedError`.
- 472cdef: A statement's client span is now the only span it gets. It carries `db.query.text` (the statement as sent), and on failure `db.response.status_code` (the SQLSTATE) beside `error.type`, so the SQL driver's own span, which repeated the query text under the database name, runs untraced. Pass `driverSpans: true` to `fromSqlClient` to keep it as a child for what only the driver records, such as `server.address` or connection waits. `observe` runs inside the statement span, so attributes it annotates land there. Plain SQL (`Db.sql`) spans are named after the statement's leading operation and first table (`UPDATE items`) instead of the database system, with `db.operation.name` and `db.collection.name` to match.
- 79084ae: `tableSchemas(table)` derives the Effect Schemas of a table's rows from its columns, on `/clickhouse`, `/postgres` and `/sqlite`: `select` (every column, decoded from the wire), `insert` (computed columns left out, defaulted and nullable ones optional), `update` (every writable column optional), and `json`, `jsonCreate` and `jsonUpdate`, the same rows as plain JSON for an HTTP API. The names follow `Model.Class`. A decoded `insert` or `update` row is a row `insertInto(...).values` or `update(...).set` takes, so request bodies and repositories no longer need Schemas written by hand next to the table.
- da3869d: String expressions add `.contains(value)`, `.startsWith(value)` and `.endsWith(value)`: text search that treats the value as text, not as a LIKE pattern. `%`, `_` and `\` in the value are escaped with a backslash. A string is escaped before it is bound; a param or expression is escaped in SQL with `replace()`. Matching is case-sensitive by default and `{ insensitive: true }` ignores case, on every dialect: ClickHouse and Postgres write `LIKE` / `ILIKE`; SQLite and D1, whose `LIKE` ignores ASCII case and which have no `ILIKE`, write `GLOB` (with `*`, `?` and `[` escaped) / `lower(x) LIKE lower(pattern) ESCAPE '\'`. `escapeLike(text)` is the escape step on its own, for a `.like()` pattern.
- de36b89: A query that cannot compile for its target is now a type error, not only a failure at compile time. A built-in function of one dialect (`CH.countIf`, `PG.countIf`, `SQLite.count`, ...) marks its result with `ClickHouseOnly`, `PostgresOnly` or `SqliteOnly` (SQLite and D1 share one set), and `compile`, `compileUnion` and `run` refuse a query with a function of another dialect (`wrongDialect`), or with functions of two (`mixedDialects`). Row locks (`forUpdate`, `forShare`, ...) are refused the same way for ClickHouse, SQLite and D1 (`unsupportedClause`), as only Postgres writes them. The target is `options.dialect`, else the entry's dialect; `fromSqlClient` now returns a `DatabaseApi<"postgres">`, `DatabaseApi<"clickhouse">` or `DatabaseApi<"sqlite">` whose `run` checks it. A column ref now names its source (`SourceEntry`), and a query refuses a column of a source that is not in its FROM or JOIN (`sourceNotInQuery`); a correlated subquery can use the outer query's accessor. The runtime checks stay. Also, `orderBy(($) => [...])` now carries the params of every sort key, not only the first.
- 90e2065: `excluded(columns)` and `excludedAll(except?)` build an `onConflictDoUpdate` `set` that copies columns from the row proposed for insertion: `set: excluded(["name", "rent"])` writes `SET "name" = "excluded"."name", "rent" = "excluded"."rent"`. `excludedAll` copies every column the insert writes, except the named ones and the conflict target's columns; a column the rows leave out keeps its old value. Names are checked against the table's writable columns. Setting the tenant column from the proposed row (here or in the callback form) now keeps the rows' tenant scope instead of making the insert cross-tenant. Postgres, SQLite and D1.
- a40e5e3: `effect-orm verify --schema` compares the table definitions with a live database, with no migrations folder and no ledger. It exits 3 on drift and prints one line per difference (`--json` for machines), so CI fails on a missing column, a type or nullability change, or a missing index. It reads the config's `schema` and `driver` and runs the same comparison as `verify`, for ClickHouse and Postgres; a SQLite or D1 config is refused, since there is no SQLite catalog reader yet. In code: `verifySchema(config, cwd)` from `/kit`, and `Migrate.verifySnapshot(snapshot)` to compare a database with any snapshot.

### Patch Changes

- 790635b: `ClickhouseHttpClient` escapes bound parameters the way ClickHouse reads them. A string with a
  newline, tab or NUL no longer fails with `BAD_QUERY_PARAMETER`, and a backslash is no longer
  read as the start of an escape sequence, which silently changed the value. Arrays are sent as
  ClickHouse literals, so arrays of strings now bind at all (#38).
- 26fff93: A new guide, `docs/coming-from-drizzle-prisma.md`, maps the common Prisma and Drizzle operations to effect-orm, says what differs by design, and shows a Cloudflare Worker that reaches Postgres through Hyperdrive. Its examples run on PGlite in the doc checks.
- 3b471ab: An upsert is single-tenant only when its conflict-update path also proves the existing row's tenant. A tenant-inclusive column target or an explicit tenant predicate can prove it; otherwise `requireTenantScope` refuses the statement before execution. This prevents an insert for one tenant from updating another tenant through a shared conflicting ID.
- 0f086e1: Generated SQLite rebuilds check live inbound foreign keys before copying or dropping the old table. A referenced table is refused instead of letting a transaction-wrapped DROP fire CASCADE or SET NULL actions. The guard works in a D1 batch and rolls back with the migration; ordinary rebuilds still run. Older generated SQL must be reviewed or regenerated before applying it.

## 0.8.0

### Minor Changes

- ec94fd2: `Db.afterCommit(effect)` queues work, such as an SMS or an HTTP call, to run after the outermost transaction commits, and never after a rollback. It delegates to Effect's `SqlClient.afterCommit` and, like `requireTransaction`, adds `Transaction` to the requirements, so queueing outside a transaction does not compile. A failing hook does not fail the committed transaction: its cause goes to the `ErrorReporter`s in context and to an error log, and the next hook still runs.
- 2ca58aa: Require Effect 4.0.6 (`effect ^4.0.6` peer). Effect now fails a transaction whose COMMIT failed
  with a `SqlError` instead of dying; `transaction` still reports it as `TransactionCommitFailed`.
  `ClickhouseHttpClient` names its driver `"clickhouse-http"` (`SqlClient.driver`), and Effect's own
  statement span is now named after the database (`db.namespace`) rather than `sql.execute`.
- d8bae8c: Add the `/sqlite` query entry with SQLite codecs, functions and positional bindings. Use
  `sqliteDialect` with an Effect SQLite SqlClient, or `d1Dialect` for Cloudflare D1's binding limit
  and explicit refusal of interactive transactions. `timestamp` stores SQLite's own
  `YYYY-MM-DD HH:MM:SS.SSS` UTC text, so it compares correctly with what `strftime` writes; `LIKE`
  escapes with `\` as on every dialect; text with U+0000 and integers past 2^53 are refused rather
  than silently changed.
- 8eb7200: `effect-orm generate` supports `dialect: "sqlite"`. It diffs `SQLite.table` definitions against
  the migrations folder and writes `<timestamp>_<name>/migration.sql` plus `snapshot.json`, the
  drizzle-kit 1.0 layout that Alchemy's D1 resource applies. `ALTER TABLE` adds, drops and renames
  where SQLite allows it; other column, primary key and UNIQUE changes rebuild the table. Renames
  need a `confirm_rename` hint. `generate --baseline --from-drizzle` adopts a drizzle-kit 1.0
  SQLite folder. Snapshots gain a `sqlite` dialect. `/migrate` refuses SQLite folders for now.
- b4b84c3: `SQLite.table(name, { columns, primaryKey, indexes })` declares a SQLite table with its DDL:
  `NOT NULL` from the column type, single and composite primary keys, literal and expression
  defaults (`SQLite.timestampNow` for a `timestamp` column), unique columns, and named indexes and
  unique indexes. `sqliteEntitiesOf` and
  `renderSqliteSchema` from `/schema` check a schema and write its `CREATE TABLE` and
  `CREATE INDEX` statements. `table(name, columns, options?)` and
  `table(name, { external: true, columns })` stay query-only.

### Patch Changes

- a3bd763: On ClickHouse, a `unionAll` ordered by a numeric column whose branches may differ in type (`Id + 1`
  and `Id - 1`, or a `UInt32` and an `Int64` column) no longer fails with "Data types Variant/Dynamic
  are not allowed in ORDER BY keys". The union's ORDER BY sorts such a column by
  `CAST(x AS Nullable(Float64)), accurateCastOrNull(x, 'Int128')`, which keeps integers past 2^53 in exact order; the
  values themselves are not converted.

## 0.7.2

### Patch Changes

- 36499ea: An arithmetic expression passed as an argument keeps its parentheses: `$.a.sub($.b.add(1))` compiles to `a - (b + 1)`, not `a - b + 1`. Chains still follow SQL precedence as documented (`$.a.sub(1).div(2)` is `a - 1 / 2`); passing the group as an argument is how to group.
- 0bf4dbc: On ClickHouse, an array or map compared against a column is cast to the column's type: `$.Ids.eq([0, 4294967296])` writes `CAST([0, 4294967296] AS Array(Nullable(Int64)))`. Uncast, ClickHouse inferred the literal's element type from its values (`Array(UInt64)` here) and could refuse the comparison with `ILLEGAL_TYPE_OF_ARGUMENT`.
- 1aee63f: ClickHouse number literals read back as exactly the value you passed. A subnormal float (`5e-324`) was a syntax error and is now written from its bits; a whole number past 2^53 (`44812297868494010`) was written as its shortest decimal, which ClickHouse parses as a different integer, so `WHERE x = value` could miss the row — it is now written as the double's exact integer value.
- 362e880: A bare `select()` over a subquery or union (`CH.fromQuery(inner, "w").select()`, `CH.fromUnion(union, "u").select()`) selects every alias the source selects, as its type already said. It died with `QueryBuilderDefect: select() is required`, because the derived source has no column list until its own SELECT is evaluated.
- 4f690ed: Two Postgres values the server typed wrong from context now compile correctly. A `param.of(type)` selected on its own is written `CAST($n AS <type>)`, so a boolean or array comes back as itself instead of text that fails to decode. A fractional value compared with an integer column binds as `$n::numeric` instead of failing with `invalid input syntax for type bigint`. Nothing else is cast: whole numbers, params compared with columns, inserts and `real` columns keep untyped placeholders (and their indexes). `param.of` also no longer confuses two types that share a codec (`int8` and `float8`).
- ed8f7b4: Values that cannot become SQL fail compilation with a `QueryBuilderError` (`InvalidLiteral`) instead of throwing: a bigint compared against a non-integer column, a non-string `like`/`notLike`/`ilike` pattern, `lit()` of anything but a string or number (it wrote `[object Object]`), a non-numeric arithmetic operand, an invalid `Date`, and an unparseable string or invalid `Date` for a Postgres timestamp. A non-expression in a `select` record is a `QueryBuilderDefect` naming the alias, like a malformed `orderBy`.

## 0.7.1

### Patch Changes

- 8e74459: Refuse values with no SQL literal instead of writing `String(value)`. A value compared against, or passed to, an expression with no column type (a `defineFn` result, `untypedExpr`, an untyped `dynamicColumn`) used to be written raw when it was not a string, number, boolean or date: an array or object from a request became part of the SQL (`toFloat64OrNull(x) > 1) OR (1=1`). It now fails compilation with a `QueryBuilderError` (`InvalidLiteral`). `null` is written as `NULL` and a bigint as its digits, as before.

## 0.7.0

### Minor Changes

- 8ee504e: A ClickHouse client for Cloudflare Workers and any `fetch` runtime, and OpenTelemetry-shaped spans for every statement.
  
  - `@maple-dev/effect-orm/clickhouse-http` is a ClickHouse `SqlClient` over Effect's `HttpClient`, so `Database` runs where `@effect/sql-clickhouse` (Node only) cannot. Interrupting a statement aborts its request and sends `KILL QUERY` for its `query_id`; failures carry the same `SqlError` reasons as Effect's driver; credentials travel in a header; `asCommand`, `withQueryId` and `withSettings` work as there.
  - `Database` opens one client span per statement, named and attributed per the OpenTelemetry database conventions: `db.system.name`, `db.operation.name`, `db.collection.name`, `db.query.summary`, `db.response.returned_rows` and `error.type`. `withQuerySummary(name)` names the statements an effect runs.
  - `CompiledQuery.collection` is the table a statement targets: a SELECT's `FROM` table, or the table a write changes.
- 6792323: `effect-orm pull` writes table definitions from an existing ClickHouse database, so adopting effect-orm on a database that already has tables no longer means writing every `CH.table` by hand.
  
  - It reads the database the config's `driver` connects to and writes one `CH.table` per table: engine and arguments, keys as declared, partition key, TTL, settings, comments, column defaults, codecs and skipping indexes. The definitions yield exactly what the database holds, so `generate --baseline` adopts them and the next `generate` has nothing to do.
  - Column types map to the built-ins that write the same SQL; others become `CH.custom` with a fitting schema (`UUID`, `Date`, `Decimal`, `Enum8`, …) or `CH.untyped`. Views and non-MergeTree tables are written as `external: true`. Materialized views, `SAMPLE BY` and `EPHEMERAL` columns are listed for review in the file's header.
  - `pull` is also exported from `/kit`.
  
  `verify` reads a table's sorting and primary keys as declared. It had compared `system.tables.sorting_key`, which has a `VersionedCollapsingMergeTree`'s version column appended, so such a table always showed drift.

## 0.6.2

### Patch Changes

- 6bfed00: `ParamEntry`, `OptionalParamEntry`, `OptionalParams` and `ParamsIn` are exported from every dialect entry point. A package that exports a query with a `param.*`, or a `defineFn` helper, failed `tsc --declaration` with TS4023 / TS2742: their types name these, and tsc could only reach them through a hashed internal chunk. The package-consumer check now emits declarations for exported queries with plain, optional (`when` / `whenTrue`) and union-named params, joins, CTEs, subqueries, unions and a `defineFn` helper, on TypeScript 7 and 5.

## 0.6.1

### Patch Changes

- 5bb8bb2: Every entry point can be loaded with `require()`. The export map offered only an `import` condition, so CommonJS code (and CommonJS builds of TypeScript projects) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although the modules themselves load fine through Node's `require(esm)` (Node 20.19+, 22.12+). Each entry now also has a `default` condition pointing at the same `.mjs`, so a CommonJS caller loads the very module an ES module caller does, and shares its Effect. The package-consumer check `require()`s every entry from the packed tarball.

## 0.6.0

### Minor Changes

- a379869: Tenant scoping is now opt-in and enforceable. `fromSqlClient` / `layerSqlClient` take `requireTenantScope: true`, which refuses an undeclared `"cross-tenant"` statement with a `TenantScopeViolation` defect. Compiled queries carry `crossTenantDeclared` when the opt-out was explicit, and unions, inserts, updates and deletes gain `.crossTenant()`. `rawCompiledQuery`'s `tenantScope` is now optional and defaults to `"cross-tenant"`.
- e26a29d: Postgres enum types and unique constraints are first-class. `PG.enumType(name, labels, { schema? })` is a column type (rows decode to its labels; inserts and comparisons take only them; `nullable` and `array` wrap it, and enum arrays decode from the text form drivers send) and a schema object: `generate` creates the type before the tables that use it, adds labels with `ADD VALUE ... BEFORE`, renames one behind a `confirm_rename` hint, asks before dropping the type, and reports removing or reordering labels, or using a label in the migration that adds it, as unsupported. `PG.unique(name, columns, { nullsNotDistinct? })` in a table's `uniqueConstraints`, or `unique` in `PG.column` (named `<table>_<column>_unique` by default), declares an `ADD CONSTRAINT ... UNIQUE` constraint, diffed as a constraint rather than an index. `verify` reads enums from `pg_enum` and unique constraints from `pg_constraint`, and resolves types of the current schema during its scratch rebuild, so `PG.custom("public.x", ...)` enums no longer report false drift. `generate --baseline --from-drizzle` converts drizzle-kit enums, enum columns and unique constraints.

### Patch Changes

- 852429b: A concrete insert is assignable to `Runnable` (from `/database`) and accepted by `compile` under TypeScript 5.x again. Both took `CHInsert<any, ...>`, which TypeScript 5 compares method by method, and the generic `onConflictDoUpdate` failed that comparison; they now take an insert by its tag, state and phantom (`AnyInsert`). A workaround such as `type Runnable = Orm.Runnable | { readonly _tag: "CHInsert" }` can be removed.

## 0.4.0

- **Breaking:** definitions never throw. `CH.table`, `PG.table`, `CH.materializedView`,
  `defineDatasource` and `defineMaterializedView` record what is wrong on `problems`, and
  `S.entitiesOf`, `S.pgEntitiesOf` and `TB.buildProject` are Effects that fail with a
  `SchemaDefinitionError` listing every problem. `SchemaDefinitionDefect` is removed.
- A `/tinybird` materialized view is also a schema view, so `effect-orm generate` migrates it
  with the datasources. It takes one node, without template syntax.
- `backfill` op for a hand-written step in `migration.json`: `INSERT ... SELECT` run one
  epoch-aligned window of `windowDays` at a time, each journaled under its start date, so a
  resumed run skips the windows it finished. See [docs/migrations.md](./docs/migrations.md).
- `Migrate.pendingMigrations`, `planMigration`, `applyStep` and `completeMigration`, the parts
  `run` is built from, for an orchestrator that runs each statement as its own durable step.

- New `@maple-dev/effect-orm/tinybird` entry: `defineDatasource`, `defineMaterializedView`,
  `column`, `t`, `engine`, `node` and `InferRow` with the call shapes of `@tinybirdco/sdk`, and
  `buildProject` writing the same datafiles byte for byte. A datasource is a ClickHouse
  `table`, so the query builder takes it and `renderSchema` writes its DDL. See
  [docs/tinybird.md](./docs/tinybird.md).
- `CH.lowCardinality(t)`, `CH.simpleAggregateFunction(fn, t)` and `CH.precision(t, digits)`:
  storage wrappers that change the DDL and not how the column reads. `CH.nullable` of a
  `LowCardinality` type renders `LowCardinality(Nullable(T))`, which ClickHouse requires.

- Fixes found migrating a large consumer onto the strict params and brands:
  - A param inside `when` / `whenTrue`, or one whose name is a union, is optional in the params
    `compile` asks for: whether it renders is only known at runtime. It used to be required,
    and a union name asked for a value of type `never` under each name.
  - `compile`, `compileUnion` and `Database.run` accept a params object typed by an interface
    (`Given extends object`, not `Record<string, unknown>`).
  - A join alias is no longer refused against a join map that is an open `Record<string, …>`.
  - Export `NeedsSelect` and `ParamsSatisfied`, so a helper generic over a query's output can
    pass the query on to `compile`.

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
