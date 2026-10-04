# Running statements and transactions

`@maple-dev/effect-orm/database` runs compiled queries and other statements through an Effect
`SqlClient` you already have, and wraps them in transactions. The package still opens no
connections: a `Database` is a small object over your client.

```sh
npm install @effect/sql-pg@4.0.0   # or @effect/sql-pglite, @effect/sql-clickhouse
```

Transactions are Effect's own `SqlClient.withTransaction`, with four additions:

- **Settings**: isolation level, access mode, deferrable.
- **Typed COMMIT and ROLLBACK failures**: Effect 4.0.0 turns them into defects.
- **A guard** against statements that outlive their transaction.
- **Contention retry** for SQLSTATE 40001 and 40P01.

Postgres supports all of it. ClickHouse has no transactions here; see [ClickHouse](#clickhouse).

## A complete example

This runs on PGlite, Postgres compiled to WASM, so it needs no server. Swap
`PgliteClient.layer` for `PgClient.layer` from `@effect/sql-pg` and nothing else changes.

```ts title="database-transaction.ts"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect, Layer, Schema } from "effect"
import * as CH from "@maple-dev/effect-orm"
import * as Db from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"

const Accounts = CH.table("accounts", { id: PG.int4, balance: PG.int8 })

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
	account: Schema.Number,
}) {}

const balanceOf = (id: number) =>
	Db.run(
		CH.from(Accounts)
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
| `fromSqlClient(sql, options)` | A `DatabaseApi` over a client. `options.dialect` is required |
| `layerSqlClient(options)` | A `Database` layer over the `SqlClient` in context |
| `Database` | The service |
| `run(query, params?)` | Compile a query for the database's dialect, run it, decode its rows |
| `sql\`...\`` | A statement with every `${value}` bound; `sql.identifier(name)` for a table or column name |
| `query(statement, schema?)` | Run a statement and return its rows, decoded when a schema is given |
| `execute(statement)` | Run a statement and discard its rows |
| `transaction(options?)` | Run an effect in a transaction; data-first or pipeable |
| `requireTransaction` | Mark an effect as correct only inside a transaction |
| `retryContention(options?)` | Re-run on serialization failure or deadlock |
| `Transaction` | The open transaction (`depth`, `isolationLevel`, `accessMode`) |
| `isContention(error)` | Whether an error is a serialization failure or deadlock |

`run`, `query`, `execute`, `transaction` and `retryContention` are also methods on
`DatabaseApi`.

### Queries and statements

`run` takes the query you built, a `unionAll`, an `insertInto`, `update` or `deleteFrom`, or a
query compiled elsewhere. It compiles with
the database's dialect, so you never pick a `compile`; `params` fills the query's `param.*`
markers, and a missing one fails with `QueryBuilderError`. A query compiled elsewhere must
have been compiled for the same dialect, or `run` dies: the root `compile` is ClickHouse's.

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

For SQL inside a builder query rather than a whole statement, use
[`CH.sql`](./extending.md#chsql--sql-templates-inside-a-query).

`query` and `execute` also take a plain `{ sql, parameters }` for SQL you have as text.

`FromSqlClientOptions`:

| Option | Meaning |
| --- | --- |
| `dialect` | `postgresDialect` or `clickhouseDialect` |
| `command` | Wraps `execute`. Pass ClickHouse's `asCommand`: DDL has no JSON result |
| `observe` | Called with every statement before it runs, including the `SET TRANSACTION` a transaction's settings become |

`run` refuses a query compiled for another dialect (`CompiledQuery.dialect`), as a defect: a
query built with the root `compile`, which is ClickHouse's, can run on Postgres with the wrong
quoting and inlined params. Rows come back without the client's name transforms, because the
decoder reads the aliases the compiler wrote.

Build the `Database` wherever you build the client. If each request has its own pool, build a
`Database` per request from it: nothing request-scoped is stored in the `Database`, and the
open transaction lives in fiber context.

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

### Settings

| Option | Postgres |
| --- | --- |
| `isolationLevel` | `"read committed"`, `"repeatable read"` or `"serializable"` |
| `accessMode` | `"read write"` or `"read only"` |
| `deferrable` | With `serializable` and `read only`, wait for a safe snapshot |
| `retry` | `"contention"`, or `{ times, schedule }` |

Settings become one `SET TRANSACTION ...` statement, run first. A nested transaction cannot
set any of them, or `retry`, and fails with `TransactionOptionsRejected`: Postgres fixes the
isolation level at the first statement, and a retry has to start the outermost transaction
again. `read uncommitted` is not offered because Postgres runs it as `read committed`.

### Errors

| Error | When |
| --- | --- |
| `DatabaseError` | A statement failed. `reason` is the driver's classification (`UniqueViolation`, `SerializationError`, ...) and `sqlState` the server's code |
| `TransactionCommitFailed` | COMMIT failed: a deferred constraint, a serialization failure at commit, a dropped connection. Carries `reason` and `sqlState` |
| `TransactionRollbackFailed` | ROLLBACK failed after the body failed. `bodyCause` is the body's failure, `cause` the rollback's |
| `TransactionOptionsRejected` | A setting the dialect does not support, or settings on a nested transaction |
| `TransactionUnsupported` | The dialect has no transactions (ClickHouse) |

Effect 4.0.0 turns a failed COMMIT or ROLLBACK into a defect and, when ROLLBACK fails, drops
the body's own failure. `transaction` turns both back into the typed errors above. Defects
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

## Writes

The builder compiles SELECTs, [INSERTs](./inserts.md) and
[UPDATEs and DELETEs](./updates-and-deletes.md). `run` runs a write and returns its `returning`
rows, decoded, or none without `returning`; a write without it goes through `command`, as
`execute` does. Write other statements with `sql`, as above, and read `RETURNING` with `query`
and a schema.
