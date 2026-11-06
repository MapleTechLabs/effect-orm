# Running statements and transactions

`@maple-dev/effect-orm/database` runs compiled queries and other statements through an Effect
`SqlClient` you already have, and wraps them in transactions. The package still opens no
connections: a `Database` is a small object over your client.

```sh
npm install @effect/sql-pg@4.0.6   # or @effect/sql-pglite, @effect/sql-clickhouse
```

Transactions are Effect's own `SqlClient.withTransaction`, with four additions:

- **Settings**: isolation level, access mode, deferrable.
- **Typed COMMIT and ROLLBACK failures**: Effect fails with a bare `SqlError` or dies.
- **A guard** against statements that outlive their transaction.
- **Contention retry** for SQLSTATE 40001 and 40P01.

Postgres supports all of it. ClickHouse has no transactions here; see [ClickHouse](#clickhouse).

## A complete example

This runs on PGlite, Postgres compiled to WASM, so it needs no server. Swap
`PgliteClient.layer` for `PgClient.layer` from `@effect/sql-pg` and nothing else changes.

```ts title="database-transaction.ts"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Schema } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Accounts = PG.table("accounts", { columns: { id: PG.int4, balance: PG.int8 }, primaryKey: ["id"] })

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
	account: Schema.Number,
}) {}

const balanceOf = (id: number) =>
	Db.run(
		PG.from(Accounts)
			.select("balance")
			.where(($) => [$.id.eq(id)]),
	).pipe(Effect.map((rows) => rows[0]?.balance ?? 0))

// Must run inside a transaction: it reads, then writes.
const withdraw = Effect.fn("withdraw")(function* (id: number, amount: number) {
	if ((yield* balanceOf(id)) < amount) return yield* new InsufficientFunds({ account: id })
	yield* Db.execute(Db.sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${id}`)
}, Db.requireTransaction)

// Opens a transaction (or a savepoint, inside one).
export const transfer = Effect.fn("transfer")(
	function* (from: number, to: number, amount: number) {
		yield* withdraw(from, amount)
		yield* Db.execute(Db.sql`UPDATE accounts SET balance = balance + ${amount} WHERE id = ${to}`)
	},
	Db.transaction({ isolationLevel: "serializable", retry: "contention" }),
)

const DatabaseLive = Db.layerSqlClient({ dialect: PG.postgresDialect }).pipe(
	Layer.provideMerge(PgliteClient.layer({ postgresqlconf: "timezone = 'UTC'" })),
)

export const balances = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Db.execute(Db.sql`CREATE TABLE accounts (id int4 PRIMARY KEY, balance int8 NOT NULL)`)
		yield* Db.execute(Db.sql`INSERT INTO accounts VALUES (1, 100), (2, 0)`)
		yield* transfer(1, 2, 30)
		// Fails: the withdrawal rolls back with the transaction.
		const refused = yield* Effect.flip(transfer(1, 2, 500))
		return { from: yield* balanceOf(1), to: yield* balanceOf(2), refused: refused._tag }
	}).pipe(Effect.provide(DatabaseLive)),
)
// { from: 70, to: 30, refused: "InsufficientFunds" }
```

Calling `withdraw(1, 30)` outside `transfer` does not compile: `requireTransaction` puts
`Transaction` in its requirements, and only `transaction` removes it.

## Building a `Database`

| Export | What it is |
| --- | --- |
| `fromSqlClient(sql, options)` | A `DatabaseApi` over a client. `options.dialect` is required, and types it: with `postgresDialect` it is a `DatabaseApi<"postgres">`, whose `run` refuses ClickHouse and SQLite functions in the type (`d1Dialect` and `sqliteDialect` give a `DatabaseApi<"sqlite">`, which also refuses row locks; `mysqlDialect` and `mariadbDialect` a `DatabaseApi<"mysql">`) ([Checked in the type](./params-and-compilation.md#checked-in-the-type)); `options.requireTenantScope` refuses unscoped queries ([Tenant scoping](./tenant-scoping.md#enforcing-it)) |
| `layerSqlClient(options)` | A `Database` layer over the `SqlClient` in context |
| `Database` | The service |
| `run(query, params?)` | Compile a query for the database's dialect, run it, decode its rows. A write first runs its table's [client-side defaults](./inserts.md#client-side-defaults) and requires what they need |
| `runOne`, `runOption`, `runNonEmpty` | `run`, with a check on how many rows came back ([Cardinality](#cardinality)) |
| `stream(query, params?)` | `run` as a `Stream`: each row decoded as it arrives |
| `paginate(query, options, params?)` | One page of a query, by keyset, with a cursor for the next page ([Pagination](#pagination)) |
| `sql\`...\`` | A statement with every `${value}` bound; `sql.identifier(name)` for a table or column name |
| `query(statement, schema?)` | Run a statement and return its rows, decoded when a schema is given |
| `execute(statement)` | Run a statement and discard its rows |
| `transaction(options?)` | Run an effect in a transaction; data-first or pipeable |
| `requireTransaction` | Mark an effect as correct only inside a transaction |
| `afterCommit(effect)` | Queue an effect to run after the outermost transaction commits, never after a rollback |
| `retryContention(options?)` | Re-run on serialization failure or deadlock |
| `Transaction` | The open transaction (`depth`, `isolationLevel`, `accessMode`) |
| `isContention(error)` | Whether an error is a serialization failure or deadlock |
| `layerTest(options)`, `TestDatabase` | A `Database` with no server, for unit tests ([Testing](./testing.md#testing-your-own-code-layertest)) |
| `refineConstraints(effect)` | Fail with a typed `ConstraintViolation` where a statement broke a constraint ([Constraint violations](#constraint-violations)) |
| `constraintViolation(error)` | The `ConstraintViolation` an error reports, as an `Option` |
| `findById(query, { key })` | A batched lookup of one row by a key: N concurrent calls send one statement ([Batching lookups](#batching-lookups)) |
| `findAllBy(query, { key })` | A batched lookup of every row with a key, such as the children of a parent |

`run`, `stream`, `query`, `execute`, `transaction` and `retryContention` are also methods on
`DatabaseApi`.

### Queries and statements

`run` takes the query you built, a `unionAll`, an `insertInto`, `update` or `deleteFrom`, or a
query compiled elsewhere. It compiles with
the database's dialect, so you never pick a `compile`; `params` fills the query's `param.*`
markers, and a missing one fails with `QueryBuilderError`. A query compiled elsewhere must
have been compiled for the same dialect, or `run` dies: `CH.compile` from `/clickhouse` writes
ClickHouse, `PG.compile` from `/postgres` writes Postgres.

`sql` writes the statements the builder does not have yet (DDL, bulk `UPDATE ... FROM`, advisory
locks). Each `${value}` is bound, as `$1, $2, ...` on Postgres and as an escaped literal on
ClickHouse, so nothing in a value becomes SQL. A `sql` inside another is spliced, so
statements compose. Names go through `sql.identifier`, which accepts only plain identifiers
(dotted for `schema.table`) and quotes them:

```ts
const where = Db.sql`org_id = ${orgId} AND revoked = false`
yield* Db.execute(Db.sql`UPDATE ${Db.sql.identifier(table)} SET revoked = true WHERE ${where}`)

const Claimed = Schema.Struct({ org_id: Schema.String, family: Schema.String })
const claimed = yield* Db.query(
	Db.sql`UPDATE api_keys SET revoked = true WHERE id = ${id} AND revoked = false RETURNING org_id, family`,
	Claimed,
)  // ReadonlyArray<{ org_id: string; family: string }>
```

`sql.join(values, separator?)` binds one value per item (or splices a `sql` item), joined by
`sql\`, \`` unless you pass another separator; `sql.raw(text)` splices text you control; and
`sql.empty` writes nothing, for an optional part. A `join` of no values fails when the statement
renders, since `IN ()` is not SQL. Templates, identifiers and raw text are recognised by identity,
so an object parsed from request JSON is bound as a value, never spliced:

```ts
Db.sql`SELECT * FROM t WHERE id IN (${Db.sql.join(ids)})${archived ? Db.sql` AND archived` : Db.sql.empty}`
```

### Cardinality

`run` returns every row. When a query must return a known number of rows, use the helper
that says so. It takes the same arguments as `run`:

| Helper | Returns | Fails with `ResultCardinalityError` when |
| --- | --- | --- |
| `runOne(query, params?)` | The row | Zero rows, or more than one |
| `runOption(query, params?)` | `Option.some(row)`, or `Option.none()` for zero rows | More than one row |
| `runNonEmpty(query, params?)` | Every row, as a `NonEmptyReadonlyArray` | Zero rows |

```ts
const user = yield* Db.runOne(
	PG.from(Users)
		.select("id", "email")
		.where(($) => [$.id.eq(PG.param.string("id"))]),
	{ id },
)  // { id: string; email: string }, or ResultCardinalityError
```

`ResultCardinalityError` is in the error channel, not a defect: the count depends on the data.
`expected` is `"one"`, `"atMostOne"` or `"nonEmpty"`, and `rows` is how many came back. The
query runs as you wrote it, with no `LIMIT` added, so a duplicate row is found, not hidden.
Add a `limit` yourself when you only want the first row; `runOption` then never fails on a
duplicate.

For SQL inside a builder query rather than a whole statement, use
[`CH.sql`](./extending.md#chsql--sql-templates-inside-a-query).

`query` and `execute` also take a plain `{ sql, parameters }` for SQL you have as text.

`FromSqlClientOptions`:

| Option | Meaning |
| --- | --- |
| `dialect` | `postgresDialect` or `clickhouseDialect` |
| `command` | Wraps `execute`. Pass ClickHouse's `asCommand`: DDL has no JSON result |
| `observe` | Called with every statement before it runs, including the `BEGIN ...` or `SET TRANSACTION` a transaction's settings become |
| `observeExit` | Called with every statement after it ends: names, duration, rows or `error.type`. See [Observing statements](#observing-statements) |
| `spanParameters` | Put the bound values on the span as `db.query.parameter.<index>`. Off by default. See [Redaction](#redaction) |

`run` refuses a query compiled for another dialect (`CompiledQuery.dialect`), as a defect: a
query compiled with the `/clickhouse` entry's `compile` would run on Postgres with the wrong
quoting and inlined params. Rows come back without the client's name transforms, because the
decoder reads the aliases the compiler wrote.

### Streaming rows

`stream` takes what `run` takes and returns a `Stream` of the same rows. Each row goes through
the query's row schema when it arrives, so an export or a reconciliation over a large table does
not hold the whole result in memory:

```ts
const rows = Db.stream(PG.from(AccessLogs).select("id", "at", "lock_id").where(($) => [$.at.gte(since)]))
yield* rows.pipe(Stream.grouped(500), Stream.runForEach(writeBatch))
```

The statement is sent when the stream runs, and again each time it runs. A row that does not
match the schema fails the stream with `CompiledQueryDecodeError` and its `rowIndex`, after the
rows before it; a failed statement fails it with `DatabaseError`. Inside `transaction`, the
stream reads on the transaction's connection, so run it to the end before the body returns.

How rows arrive is the driver's: `stream` uses the `SqlClient` statement's `.stream`. The
ClickHouse clients read the response body as it comes. A driver with no streaming read, such as
PGlite, reads the whole result first and then emits it row by row. On `sqliteDialect` and
`d1Dialect` the result is always read whole first, because Effect's SQLite and D1 drivers have no
streaming read at all. A write streams its `RETURNING` rows, and one without `RETURNING` runs and emits nothing.
The statement's span stays open until the stream ends and counts the rows it emitted.

Build the `Database` wherever you build the client. If each request has its own pool, build a
`Database` per request from it: nothing request-scoped is stored in the `Database`, and the
open transaction lives in fiber context.

### Pagination

`paginate` reads a query one page at a time by keyset. It adds a seek on the sort key, the
`ORDER BY` and `LIMIT limit + 1`, then returns `limit` rows and a cursor for the next page. The
extra row only tells if there is a next page. There is no `OFFSET`: the database goes to the
cursor through an index on the key, and does not read and drop all earlier rows. A row added
before the cursor does not move later pages.

```ts
const page = yield* Db.paginate(
	PG.from(Posts)
		.select("id", "createdAt", "title")
		.where(($) => [$.orgId.eq(PG.param.string("orgId"))]),
	{ orderBy: [["createdAt", "desc"], ["id", "desc"]], after: request.cursor, limit: 50 },
	{ orgId },
)  // { rows: ReadonlyArray<{ id; createdAt; title }>, nextCursor: Option<string> }
```

| Option | Meaning |
| --- | --- |
| `orderBy` | One or more selected aliases, each `"asc"` or `"desc"`. A nullable alias is a type error |
| `after` | The `nextCursor` of the previous page; leave it out for the first page |
| `limit` | Rows per page, a positive integer. Anything else fails with `QueryBuilderError` |

The key must be unique, so end it with a unique column such as the primary key. `paginate`
cannot check this: rows that tie on the whole key can be skipped at a page boundary.

With one direction the seek is a row comparison, `("createdAt", "id") < ($2, $3)`, which
Postgres and SQLite (D1 too) serve from an index on `(createdAt, id)` and ClickHouse compares
as a tuple. With mixed directions it is `a >= x AND (a > x OR (a = x AND b < y))`.

A NULL key has no place in the seek, and dialects disagree on where NULLs sort: ascending,
SQLite puts them first, Postgres and ClickHouse last. So a nullable key is a type error,
and a defect at run time when the types were bypassed.

The cursor is base64url text. It holds the sort key and the last row's key values, encoded
through the key columns' schemas, so a `DateTime.Utc` key comes back as the same instant. It
is not encrypted or signed: do not put a value in the key that the reader must not see. A
cursor that does not decode, or that was written for another `orderBy`, fails with
`InvalidCursor`. It usually comes from a request, so answer it as a bad request.

The query keeps its own `where`, so the tenant filter and params still apply. `paginate`
replaces the query's `orderBy` and `limit`. A query with `offset`, `groupBy`, `having` or
`distinctOn`, or a key that is not a selected alias, is a defect.

`paginate` uses the `Database` in context; it is not a method on `DatabaseApi`. Its types are
`PaginateOptions`, `Page`, `KeysetOrder`, `KeysetColumn` (an alias that can be a key) and
`KeysetDirection`.

## Transactions

```ts
Effect.fn("op")(function* () { ... }, Db.transaction())        // as an Effect.fn pipe argument
body.pipe(Db.transaction({ isolationLevel: "serializable" }))  // pipeable
Db.transaction(body)                                           // data-first
```

- **Pinning.** Every statement from the same client inside `body` runs on the transaction's
  connection, found in fiber context. There is no `tx` handle: `run` and `execute` work the
  same inside and outside a transaction. That includes statements made with the client
  directly (`sql\`...\``) and with other libraries over the same client.
- **Rollback.** Any failure, defect or interruption in `body` rolls back. Your errors come
  out unchanged; roll back by failing with one.
- **Nesting.** A `transaction` inside another becomes a savepoint. A failed inner one rolls
  back to its savepoint, and the outer one continues if you catch the error. A nested
  `sql.withTransaction` and a nested `Db.transaction` share one counter.
- **Interruption.** BEGIN cannot be interrupted halfway; the body can, and interruption rolls
  back before the connection goes back to the pool.

### Requiring a transaction

Some helpers are only correct inside a transaction: a read followed by a write, two writes
that must land together. Mark them with `requireTransaction`, the same way `transaction`
marks the operations that open one:

```ts
const revokeFamily = Effect.fn("revokeFamily")(function* (family: string) {
	yield* Db.execute(Db.sql`UPDATE api_keys SET revoked = true WHERE family = ${family}`)
	yield* Db.execute(Db.sql`UPDATE refresh_tokens SET revoked = true WHERE family = ${family}`)
}, Db.requireTransaction)

revokeFamily("f1")                  // Effect<void, DatabaseError, Database | Transaction>
Db.transaction(revokeFamily("f1"))  // Effect<void, DatabaseError | TransactionError, Database>
```

`requireTransaction` adds `Transaction` to the requirements and `transaction` removes it, so a
call outside a transaction is a compile error, not a bug found in production. This is how
Effect's own `Effect.tx` treats `Effect.Transaction`. A helper that works either way, like
most reads, needs no marker. Inside a transaction, `yield* Db.Transaction` gives its `depth`
and settings.

### After commit

A vendor call (an SMS, an HTTP request, a job enqueue) must not run inside a transaction: it
holds the connection while it waits, and it cannot be rolled back. `afterCommit` queues the
call and runs it only after COMMIT succeeds:

```ts
const bookTour = Effect.fn("bookTour")(function* (tour: NewTour) {
	yield* Db.execute(Db.sql`INSERT INTO tours VALUES (${tour.id}, ${tour.phone})`)
	yield* Db.afterCommit(sms.send(tour.phone, "Your tour is booked"))
}, Db.requireTransaction)

Db.transaction(bookTour(tour))  // the SMS goes out after COMMIT, or not at all
```

Like `requireTransaction`, `afterCommit` adds `Transaction` to the requirements, so a helper
deep in the call stack can queue work without knowing where the transaction starts. The
requirements of the queued effect stay in `R`: they must be met where it is queued.

Effect's own `SqlClient.afterCommit` does the queueing; `afterCommit` adds the `Transaction`
requirement and the failure policy below.

- **Order.** Hooks run one at a time, in the order they were queued, after COMMIT and outside
  the transaction. A statement in a hook runs on its own connection, not the transaction's.
- **Rollback.** A rolled-back transaction runs nothing. A savepoint that rolls back drops what
  it queued; a savepoint that is kept hands its hooks to the outer transaction. With `retry`,
  only the attempt that commits runs its hooks.
- **Context.** A hook runs with the services of the place it was queued, minus the
  transaction.
- **Failures.** A hook that fails or dies does not fail the transaction, because the data is
  already committed and a caller that retries would write it twice. The hook's cause goes to
  the `ErrorReporter`s in context (`Effect.withErrorReporting` uses the same ones) and to an
  error log, and the next hook still runs. When the caller must know that the call failed,
  handle the error inside the hook.
- **At most once.** A crash before the hooks run skips them. Hooks run before `transaction`
  returns and uninterruptibly, so keep them short and fork long-running work. When the work
  must happen, write it to an outbox table inside the transaction instead.

`afterCommit` dies when nothing would run the work: a `Transaction` provided by hand, or a
transaction that has already ended (a fiber forked inside it and not joined).

### Settings

| Option | Postgres |
| --- | --- |
| `isolationLevel` | `"read committed"`, `"repeatable read"` or `"serializable"` |
| `accessMode` | `"read write"` or `"read only"` |
| `deferrable` | With `serializable` and `read only`, wait for a safe snapshot |
| `retry` | `"contention"`, or `{ times, schedule }` |

On Postgres, settings go into the statement that starts the transaction,
`BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY`, through Effect's `SqlClient.BeginTransaction`,
which saves the round trip of a separate `SET TRANSACTION`. On SQLite, `serializable` is the
only level, so there is nothing to send and the client keeps its own BEGIN (`BEGIN IMMEDIATE`
for `@effect/sql-sqlite-node`). Inside the body,
`BeginTransaction` is cleared, so a transaction the body starts on another client keeps that
client's own BEGIN. A nested transaction cannot
set any of them, or `retry`, and fails with `TransactionOptionsRejected`: Postgres fixes the
isolation level at the first statement, and a retry has to start the outermost transaction
again. `read uncommitted` is not offered because Postgres runs it as `read committed`.

### Errors

| Error | When |
| --- | --- |
| `DatabaseError` | A statement failed. `reason` is the driver's classification (`UniqueViolation`, `SerializationError`, ...), `sqlState` the server's five-character code (Postgres) and `errorCode` its numeric code (ClickHouse) |
| `TransactionCommitFailed` | COMMIT failed: a deferred constraint, a serialization failure at commit, a dropped connection. Carries `reason`, `sqlState` and `errorCode` |
| `TransactionRollbackFailed` | ROLLBACK failed after the body failed. `bodyCause` is the body's failure, `cause` the rollback's |
| `TransactionOptionsRejected` | A setting the dialect does not support, or settings on a nested transaction |
| `TransactionUnsupported` | The dialect has no transactions (ClickHouse) |

### Constraint violations

`refineConstraints(effect)` turns a `DatabaseError` or `TransactionCommitFailed` for a broken
constraint into one tagged error per kind, so you can `catchTag` a duplicate key instead of
reading SQLSTATEs. Every other failure passes through unchanged.

| Error | Postgres SQLSTATE | ClickHouse code | SQLite and D1 |
| --- | --- | --- | --- |
| `UniqueViolation` | 23505 | — | `SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT_PRIMARYKEY` |
| `ForeignKeyViolation` | 23503 | — | `SQLITE_CONSTRAINT_FOREIGNKEY` |
| `NotNullViolation` | 23502 | — | `SQLITE_CONSTRAINT_NOTNULL` |
| `CheckViolation` | 23514 | 469 (`VIOLATED_CONSTRAINT`) | `SQLITE_CONSTRAINT_CHECK` |

Each carries `message`, `sql`, the server's `sqlState` or `errorCode`, and `cause` (the error it
came from). It also carries `constraint`, `table` and `column` when the server named them:
Postgres names the constraint and the table, and the column for NOT NULL. ClickHouse names the
CHECK constraint and the table (`db.table`) in its message. ClickHouse has no unique, foreign key
or NOT NULL constraints to violate. SQLite names no unique index: a unique or NOT NULL violation
carries the `table` and, when the key has one column, the `column`. A CHECK violation carries
the CHECK's name as `constraint`, or its expression when it has no name. A foreign key violation
names nothing. SQLite's extended code is read from `node:sqlite` and from D1's message; neither
sets `sqlState` or `errorCode`.

```ts title="database-constraints.ts"
import { Effect } from "effect"
import * as Db from "@maple-dev/effect-orm/database"

// An idempotent write: a duplicate email is "already exists", not a failure.
export const register = (email: string) =>
	Db.execute(Db.sql`INSERT INTO users (email) VALUES (${email})`).pipe(
		Db.refineConstraints,
		Effect.as("created" as const),
		Effect.catchTag("@maple-dev/effect-orm/UniqueViolation", () => Effect.succeed("exists" as const)),
	)
// Effect<"created" | "exists", DatabaseError | ForeignKeyViolation | NotNullViolation | CheckViolation, Database>
```

A deferred constraint fails at COMMIT, so put `refineConstraints` outside the `transaction`
to see it.

Effect fails with a bare `SqlError` on a failed COMMIT, dies on a failed ROLLBACK and, when
ROLLBACK fails, drops the body's own failure. `transaction` turns these into the typed errors above. Defects
from `body` stay defects.

`TransactionClosed` is a defect, not an error to handle. A fiber forked inside a transaction
inherits its connection. If it runs a statement after the transaction ended, that statement
would run on a connection already back in the pool, so `run`, `query` and `execute` die with
`TransactionClosed` instead. Join what you fork before the body returns.

### Contention retry

`retryContention(effect)` re-runs `effect` when it fails with `DatabaseError` or
`TransactionCommitFailed` for a serialization failure or deadlock (SQLSTATE 40001 or 40P01).
By default it retries 3 times with exponential backoff from 50 ms. It never retries your own
errors. Use it around a transaction, or around a single statement outside one. Inside an open
transaction it fails with `TransactionOptionsRejected`, because the database has already
aborted the whole transaction. `transaction(body, { retry: "contention" })` is shorthand for
`retryContention(transaction(body))`, so each attempt starts with a fresh BEGIN.

## Batching lookups

Many fibers that each read one row by its id send one statement per fiber: the N+1 problem.
`findById` and `findAllBy` collect the lookups that run at the same time into one batch, with
Effect's `RequestResolver`, and send one statement for the batch: your query with
`key IN (...)` added to its WHERE.

```ts title="batched-lookups.ts"
import { Effect } from "effect"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Users = PG.table("users", {
	columns: { id: PG.int4, org_id: PG.text, name: PG.text },
	primaryKey: ["id"],
	tenantColumn: "org_id",
})
const Posts = PG.table("posts", {
	columns: { id: PG.int4, org_id: PG.text, author_id: PG.int4, title: PG.text },
	primaryKey: ["id"],
	tenantColumn: "org_id",
})

// Built once, for example at module level. The tenant is a param.
const userById = Db.findById(
	PG.from(Users)
		.select("id", "name")
		.where(($) => [$.org_id.eq(PG.param.string("org"))]),
	{ key: "id" },
)
const postsByAuthor = Db.findAllBy(
	PG.from(Posts)
		.select("id", "author_id", "title")
		.where(($) => [$.org_id.eq(PG.param.string("org"))])
		.orderBy(["id", "asc"]),
	{ key: "author_id" },
)

// One SELECT for the users and one for their posts, whatever the number of ids.
export const authors = (org: string, ids: ReadonlyArray<number>) =>
	Effect.forEach(
		ids,
		(id) =>
			Effect.all({ user: userById.with({ org })(id), posts: postsByAuthor.with({ org })(id) }, { concurrency: "unbounded" }),
		{ concurrency: "unbounded" },
	)
```

- **Rows** decode as `run` decodes them. The query must select `key` under its own name, so
  each row can go back to the lookup that asked for it. That is a type error if it does not.
- **Not found.** `findById` fails with `NoSuchElementError` for a key with no row; with more
  than one row, the first one wins. `findAllBy` gives an empty array.
- **Params.** Call the lookup directly when the query has no `param.*` markers. Otherwise
  give them first with `.with(params)`, which checks them as `run` does.
- **What shares a batch.** Lookups through the same `findById` that run at the same time, on
  the same `Database`, in the same transaction (or both outside one), with equal params. A
  lookup inside a transaction never runs on another connection, and one outside never runs
  inside it. A key asked for twice is sent once.
- **Tenant scope.** Put the tenant filter in the query, with a value or a param. Lookups with
  different params never share a batch, so one statement never reads two tenants, and
  [`requireTenantScope`](./tenant-scoping.md#enforcing-it) checks each batch statement as it
  checks `run`.
- **Bound-parameter limits.** On a dialect with a limit on the values one statement may
  bind (D1: 100, Postgres: 65535), a large batch is split into statements that each fit,
  with room for the query's own params. The statements run one after another on the
  batch's connection. Each key is in exactly one of them, so its rows keep the query's
  `ORDER BY`. ClickHouse inlines values and has no such limit.
- **`limit` and `offset`** would apply to the whole batch, not to each key, so a query with
  either fails with `QueryBuilderError` and sends nothing.

The batch waits one `yieldNow`, the same as Effect's own resolvers, so the lookups must start
together: through `Effect.forEach` or `Effect.all` with concurrency, or in fibers forked in the
same step. Lookups in sequence send one statement each.

_(Backed by `Request batching on PGlite`, in `src/database/resolver.test.ts`: one statement for N lookups, tenants and transactions kept apart; and `src/database/resolver.sqlite.test.ts`: a D1 batch over 100 bindings split into statements that fit.)_

## ClickHouse

`clickhouseDialect` declares no transactions, so `transaction` fails with
`TransactionUnsupported` before anything is sent. `run`, `query` and `execute` work as on
Postgres. Pass `command: client.asCommand` so `execute` can run DDL.

This is deliberate. A default ClickHouse server refuses `BEGIN TRANSACTION`
(`NOT_IMPLEMENTED`). Experimental transactions need a server setting and Keeper, and even then:

- **MergeTree only**: no Memory tables, no DDL, no savepoints, no nesting.
- **A session is required.** Over HTTP, a `BEGIN` without a `session_id` succeeds and is
  forgotten. The INSERTs after it are saved immediately, and the COMMIT fails with
  `There is no current transaction`.
- **Readers outside a transaction can see uncommitted rows.**

Effect's ClickHouse client has no session, so its own `withTransaction` cannot be atomic. It
fails at BEGIN today: through the query path with a syntax error, and through `asCommand` with
`NOT_IMPLEMENTED`. The full measurements are in
[`design/transactions.md`](../design/transactions.md).

## Tracing

Each statement `Database` runs is one client span, named and attributed the way the
[OpenTelemetry database conventions](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)
describe. A compiled query knows its operation and table; for plain SQL (`Db.sql`) they are the
leading word and the first table the text names, as the conventions allow:

| Attribute                   | Value                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `db.system.name`            | `clickhouse`, or `postgresql`                                        |
| `db.operation.name`         | `SELECT`, `INSERT`, `UPDATE` or `DELETE`                              |
| `db.collection.name`        | The `FROM` or written table; absent over a subquery, union or CTE    |
| `db.query.summary`          | `SELECT events`, or the name given with `withQuerySummary`           |
| `db.query.text`             | The statement as sent: Postgres keeps `$n`; ClickHouse inlines values |
| `db.response.returned_rows` | The rows it returned                                                 |
| `error.type`                | On failure: the `DatabaseError` reason, such as `SqlSyntaxError`     |
| `db.response.status_code`   | On failure: the SQLSTATE, when the server sent one                   |

The span is named after the summary, so a trace reads `SELECT events` rather than the database
name. It is the only span a statement gets: the SQL driver's own span would repeat the query text,
so the driver runs untraced. Pass `driverSpans: true` to `fromSqlClient` to keep it as a child, for
what only the driver records (`server.address`, connection waits).

Attributes of your own go on the same span from `observe`, which runs inside it:

```ts
Db.fromSqlClient(sql, {
  dialect: postgresDialect,
  observe: () => Effect.annotateCurrentSpan("peer.service", "orders-postgres"),
})
```

To give a group of statements a stable name of your own, wrap them:

```ts
Db.run(query, params).pipe(Db.withQuerySummary("dashboard.revenue_by_day"))
```

The table is also on the compiled query, as `compiled.collection`.

## Repositories

`makeRepository(table, options)` builds the plain CRUD of a table on the `Database` in
context, as `SqlModel.makeRepository` does for a `Model.Class`. The row types come from
[`tableSchemas(table)`](./tables-and-types.md#row-schemas): `insert` takes its `insert` row and
`update` its `update` row.

```ts
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Option } from "effect"

const Tickets = PG.table("tickets", {
	columns: {
		id: PG.column(PG.int4, { identity: "always" }),
		org: PG.text,
		title: PG.text,
		note: PG.nullable(PG.text),
	},
	primaryKey: ["id"],
	tenantColumn: "org",
})

const program = Effect.gen(function* () {
	const tickets = yield* Db.makeRepository(Tickets, { idColumn: "id", tenantColumn: "org" })
	const ticket = yield* tickets.insert("acme", { title: "Board" }) // the stored row, with its id
	yield* tickets.update("acme", ticket.id, { note: "moved" }) // Option of the changed row
	yield* tickets.findById("other", ticket.id) // Option.none(): not this tenant's row
	yield* tickets.delete("acme", ticket.id)
})
```

| Method                       | Does                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `insert(row)`                | INSERT ... RETURNING, and gives back the stored row           |
| `insertVoid(row)`            | INSERT                                                       |
| `update(id, patch)`          | UPDATE ... RETURNING: `Option` of the changed row             |
| `updateVoid(id, patch)`      | UPDATE                                                       |
| `findById(id)`               | SELECT ... LIMIT 1: `Option` of the row                       |
| `delete(id)`                 | DELETE                                                       |

`idColumn` names the column a row is found by. A patch cannot set it. A key left out of a
patch (or `undefined`) keeps its value, as in [`set`](./updates-and-deletes.md#set). A patch
with no keys is a `QueryBuilderError`.

### Tenant tables

When the table declares a [tenant column](./tenant-scoping.md), the repository is a
`TenantRepository`, and every method takes the tenant first:

- `insert` and `insertVoid` write the tenant column from that argument. The row type has no
  tenant column.
- `update`, `updateVoid`, `findById` and `delete` filter on the tenant column and the id. A row
  of another tenant is not found, not changed and not deleted. A patch cannot set the tenant
  column, so it cannot move a row to another tenant.
- Each statement compiles as `"single-tenant"`, so a `Database` with `requireTenantScope` runs
  it.

A method called without the tenant does not type-check. The `Table` type does not carry its
tenant column, so `makeRepository` checks `tenantColumn` against the table when it is built: a
tenant table without it, or a `tenantColumn` on a table without one, is a `QueryBuilderDefect`.

### ClickHouse

ClickHouse has no `RETURNING`, so `insert` and `update` are defects there
(`QueryBuilderDefect`), and nothing is written. Use `insertVoid` and `updateVoid`, and
`findById` to read the row. `updateVoid` is a mutation with `mutations_sync = 2`, and `delete`
a lightweight delete with `lightweight_deletes_sync = 2`: both wait, so a `findById` after them
reads what they wrote. Mutations rewrite whole parts, so keep `updateVoid` for occasional
corrections, as [Updating and deleting rows](./updates-and-deletes.md#clickhouse) says.
`findById` reads without `FINAL`, so on a `ReplacingMergeTree` it can return an older version.
A `ReplacingMergeTree` keeps one row per sorting key whatever its tenant, so put the tenant
column in `ORDER BY`. Otherwise an `insertVoid` for one tenant with another tenant's id
replaces that tenant's row when the parts merge.

### SQLite and D1

Both have `RETURNING`, so every method works as on Postgres. A column SQLite fills in (an
`INTEGER PRIMARY KEY` or a `DEFAULT`) goes in the table's `defaults`, so `insert` can leave it
out.

_(Backed by `src/database/repository.test.ts`, `src/database/repository.test-d.ts`,
`src/database/repository.sqlite.test.ts` and `tests/repository.clickhouse.test.ts`.)_

### Observing statements

`observeExit` gets a `StatementObservation` for each statement when it ends, success or not.
Use it for metrics, a slow-query log, or one log line per request:

```ts
const db = Db.fromSqlClient(sql, {
	dialect: postgresDialect,
	observeExit: (o) =>
		o.durationMillis > 200 ? Effect.logWarning("slow statement", o.summary, o.durationMillis) : Effect.void,
})
```

| Field            | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `sql`            | The statement text                                                       |
| `parameters`     | The bound values; a value given as `Redacted` stays `Redacted`           |
| `system`         | `db.system.name`                                                         |
| `operation`      | `db.operation.name`; for `sql\`...\``, its first word                  |
| `collection`     | `db.collection.name`, when there is one table                            |
| `summary`        | `db.query.summary`, the span name                                        |
| `tenantScope`    | The compiled query's tenant scope; absent for `sql\`...\``              |
| `route`          | The compiled query's `route`, when it has one                            |
| `durationMillis` | From just before the statement is sent until its result is back          |
| `rows`           | The rows it returned; absent for `execute` and for a failure             |
| `errorType`      | On failure: the `DatabaseError` reason, the error's tag, or `Interrupted` |

`observe` still runs before each statement, with the `Statement` as it is sent.

### Redaction

Spans carry no bound values by default. The statement span carries the query text
(`db.query.text`), which has placeholders, not values, on Postgres, SQLite and D1. To put the
values on the span, as `db.query.parameter.<index>`, set `spanParameters: true`.

A value given as `Redacted` never reaches a span or `observeExit` as plain text. Give a column a
`Redacted` type with `brand`; the driver gets the plain value:

```ts
const doorCode = PG.brand(PG.text, Schema.RedactedFromValue(Schema.String))
const Codes = PG.table("door_codes", { columns: { id: PG.int4, code: doorCode }, primaryKey: ["id"] })

yield* Db.run(PG.insertInto(Codes).values({ id: 1, code: Redacted.make("4821") }))
// with spanParameters: db.query.parameter.0 = "1", db.query.parameter.1 = "<redacted>"
```

`compile` marks such values in `CompiledQuery.sensitiveParameters`, whether they are compared
values, `param.*` values, or values an insert or update writes. `sql\`...\`` binds a
`Redacted` value as its plain value and marks it too. This holds on every dialect that binds
values: Postgres, SQLite and D1.

ClickHouse writes values into the statement text, so there the text, and the span's
`db.query.text` with it, carries them, including a `Redacted` column value the builder wrote.
`sql\`...\`` refuses a `Redacted` value on ClickHouse for this reason.

## Writes

The builder compiles SELECTs, [INSERTs](./inserts.md) and
[UPDATEs and DELETEs](./updates-and-deletes.md). `run` runs a write and returns its `returning`
rows, decoded, or none without `returning`; a write without it goes through `command`, as
`execute` does. Write other statements with `sql`, as above, and read `RETURNING` with `query`
and a schema.
