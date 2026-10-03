# Transactions: one primitive over Effect's SqlClient

Status: phases 1 to 3 built (`@maple-dev/effect-orm/database`, see `docs/database.md`). Section 9 lists
where the build differs from the plan. Phases 4 and 5 are not started.

## Goal

Give effect-orm a transaction primitive that a Postgres application can use instead of
Drizzle's `db.transaction`, built on Effect's own `SqlClient.withTransaction` rather than a
second implementation of connection pinning. One API across dialects: Postgres implements it
fully, ClickHouse says plainly that it does not, and a later dialect (MySQL, SQLite) declares
what it supports through a capability on `Dialect`, the way `Dialect.clauses` already works.

The first consumer is Maple, which wants to leave Drizzle for Postgres. Section 5 is honest
about the other things that move needs: transactions are not the last blocker.

Everything below was read from source at the installed versions: `effect@4.0.0`
(`effect/sql/SqlClient.ts`, `SqlConnection.ts`, `SqlError.ts`, `Migrator.ts`),
`@effect/sql-pg@4.0.0`, `@effect/sql-pglite@4.0.0`, `@effect/sql-clickhouse@4.0.0`, and
`drizzle-orm@1.0.0-rc.5-5935859` (`effect-postgres/session.js`, `pg-core/effect/session.js`)
as installed in Maple. ClickHouse claims were checked against a live
`clickhouse/clickhouse-server:26.8.2.7` (section 3).

## 1. How Effect's `withTransaction` works

`SqlClient.make` builds `withTransaction` from `makeWithTransaction` (SqlClient.ts:372).

**Connection pinning through context.** Each client gets its own context key,
`TransactionConnection(clientId)` (`effect/sql/SqlClient/TransactionConnection/<n>`), exposed
as `sql.transactionService`. Its value is `[connection, depth]`. Every statement resolves its
connection through `getConnection` (SqlClient.ts:180): the transaction connection if the key
is in the fiber's context, otherwise the pool's `acquirer` (or `borrower`). So any statement
built from **the same client instance** inside the transaction's effect runs on the
transaction's connection, with no argument threading. A statement from a different client
instance (a second pool) does not see the key and runs outside the transaction.

**Acquisition.** A top-level transaction opens a fresh `Scope`, takes a connection from
`transactionAcquirer` (a reserved pool connection for `@effect/sql-pg`, `pool.reserve`; a
semaphore permit on the single connection for `@effect/sql-pglite`), runs `BEGIN`, and closes
the scope (returning the connection) after COMMIT or ROLLBACK.

**Nesting.** If the key is already present, the call reuses that connection with
`id = depth + 1` and runs `SAVEPOINT effect_sql_<id>` instead of BEGIN. On success it does
nothing for a savepoint (the outer COMMIT covers it); on failure it runs
`ROLLBACK TO SAVEPOINT effect_sql_<id>`. Either way it runs `RELEASE SAVEPOINT` when the
client configured `releaseSavepoint` (`@effect/sql-pg` and `@effect/sql-pglite` both do).
Nested calls under one transaction are serialized by a per-transaction semaphore, so two
concurrent nested blocks cannot interleave their savepoints. Plain statements inside a
transaction are not serialized; on Postgres they queue on the one connection.

**Failure and interruption.** The whole wrapper is `Effect.uninterruptibleMask`; only the
body is `restore`d. Acquisition and BEGIN cannot be interrupted halfway, and an interrupted
body still reaches the exit handler, which rolls back. Any non-success exit (typed failure,
defect, interruption) rolls back.

**Commit and rollback failures are defects.** The exit handler wraps COMMIT, ROLLBACK and
the savepoint statements in `Effect.orDie` (SqlClient.ts:427-449). A failed COMMIT (a
deferred constraint, a serialization failure detected at commit, `@effect/sql-pg`'s
"COMMIT rolled back an aborted transaction") reaches the caller as a die, not as a
`SqlError` in the error channel. A failed ROLLBACK also replaces the body's original
failure: the handler returns `Effect.flatMap(rollback, () => exit)`, so when the rollback dies
the original exit is dropped. Maple already works around the first of these
(`absorbDriverErrors`, `packages/backend/src/platform/DatabaseLive.ts:104-127`).

**Isolation level and access mode: not supported by Effect.** The BEGIN text is fixed per
client (`beginTransaction`, default `"BEGIN"`; ClickHouse passes `"BEGIN TRANSACTION"`).
`withTransaction` takes no options. The only way to choose an isolation level on Postgres is
a `SET TRANSACTION ...` statement as the first statement inside the transaction, which
Postgres accepts until the first query of the transaction.

**Tracing.** A `sql.transaction` span with `db.transaction.commit`,
`db.transaction.savepoint` and `db.transaction.rollback` events; statements inside are
children of it.

**`Migrator.ts`** runs all pending migrations inside one `sql.withTransaction(run)`
(Migrator.ts:315), which is why it cannot be used for ClickHouse (see `design/migrations.md`).

### Drizzle's effect transaction, compared

Drizzle's `effect-postgres` session does not implement transactions itself
(`effect-postgres/session.js:25-39`):

```js
transaction(transaction, config) {
  return this.client.withTransaction(Effect.gen(function* () {
    const tx = new EffectPgTransaction(dialect, this, relations)
    if (config) for (const statement of tx.getTransactionConfigStatements(config)) yield* this.client.unsafe(statement)
    return yield* transaction(tx)
  }))
}
// nested: EffectPgTransaction.transaction(cb) => this.session.transaction(cb)   (no config)
```

| | Effect `withTransaction` | Drizzle `db.transaction` |
| --- | --- | --- |
| BEGIN / COMMIT / savepoints | Its own | Delegates to Effect's |
| Connection pinning | Context key per client | Same (queries go through `client.unsafe`) |
| Isolation, access mode, deferrable, snapshot | None | `SET TRANSACTION ...` after BEGIN, top level only |
| Nested options | n/a | Silently dropped |
| Explicit rollback | Fail the effect | `yield* tx.rollback()` returns an `EffectTransactionRollbackError` that propagates to the caller |
| Commit failure | Defect | Defect (inherited) |
| Logging of config statements | n/a | Bypasses Drizzle's logger |

So Drizzle's effect transaction is Effect's transaction plus a `SET TRANSACTION` line and a
`tx` handle. That is the right shape to copy, minus the silent option drop and the
unlogged statement.

## 2. What Maple uses today

From a survey of `~/Documents/GitHub/maple` (all sites in `packages/backend/src`):

- **33 production transactions**, each `database.execute((db) => db.transaction((tx) => ...))`
  or through `makeDbExecute` (`platform/db-execute.ts`). None nested, none with an isolation
  level, access mode or deferrable option, no savepoints, no `tx.rollback()`. Rollback is
  always "fail the Effect with a domain `Schema.TaggedError`". Everything runs at READ
  COMMITTED.
- **Contention retry outside the transaction**: `makeDbExecute` retries SQLSTATE 40001 and
  40P01 up to 3 times with exponential backoff from 50 ms, re-running the whole transaction.
- **Inside transactions**: claim-style `UPDATE ... RETURNING` then branch on row count;
  `INSERT ... ON CONFLICT DO UPDATE / DO NOTHING ... RETURNING`; `SELECT ... FOR UPDATE` and
  `FOR SHARE`; raw `select pg_advisory_xact_lock(hashtext(...))`; raw bulk `UPDATE ... FROM
  (VALUES ...)`; `.returning(txidColumn)` where `txidColumn` is
  `pg_current_xact_id()::xid::text` (Electric sync).
- **Helpers are transaction-agnostic**: they take `tx: MapleDbLike`, the same type as the
  database, so they run inside or outside a transaction.
- **Request-scoped pool** (`platform/pg-connection-scope.ts`): `withPgConnectionScope` installs
  a `PgConnectionScope` `Context.Reference` per invocation; the pool (max 5 connections) is
  opened lazily, closed when the invocation ends, and a call after close fails with
  `PgConnectionScopeClosedError` instead of dialing again. `Database.execute` reads the
  reference at call time. `forkRequestScoped` forks into the request `Scope` so forked work
  cannot outlive the pool. CLAUDE.md: "Request-scoped context (transactions, tenant, actor)
  stays on the invocation, never captured at construction" and "One pool per invocation via
  `withPgConnectionScope`; connections never outlive the invocation."
- **Errors and spans** (`platform/DatabaseLive.ts`): driver errors and driver defects
  (including the orDie'd COMMIT) are absorbed into one `DatabaseError`; domain errors pass
  through. A statement collector puts every statement of a call, including a whole
  transaction, into one span, and the `@effect/sql` per-statement and `sql.transaction` spans
  are switched off.
- **Tests**: `@effect/sql-pglite` plus `drizzle-orm/effect-pglite`
  (`packages/db/src/pglite.ts`), with tests for a failed deferred-FK COMMIT becoming
  `DatabaseError`, one span per transaction, and domain failures passing through.

What a replacement must preserve: transactions keyed off the per-invocation client, never a
client captured at construction; helpers that do not care whether they run inside a
transaction; domain errors untouched; a failed COMMIT as a typed error; whole-transaction
retry on contention; one observable unit per transaction.

## 3. ClickHouse: what a transaction can and cannot guarantee

Checked on `clickhouse/clickhouse-server:26.8.2.7` over HTTP.

**Default server: no transactions.** `BEGIN TRANSACTION` fails with
`Code: 48 ... Transactions are not supported. (NOT_IMPLEMENTED)`, with or without a session.
So `ClickhouseClient.withTransaction` fails at BEGIN on any normal deployment.

**With `allow_experimental_transactions` and Keeper configured**, inside an HTTP session
(`session_id`), and with `async_insert=0` (26.8 defaults inserts to async, which a
transaction refuses with `Async inserts inside transactions are not supported`):

| Behavior | Result |
| --- | --- |
| INSERT then ROLLBACK on MergeTree | Rolled back |
| INSERT then COMMIT | Visible after commit |
| `ALTER TABLE ... DELETE` (mutation) then ROLLBACK | Rolled back |
| A Memory table in the transaction | `Storage Memory ... does not support transactions` |
| `CREATE TABLE` inside | `Transactions are not supported for this type of query` |
| `SAVEPOINT` | Syntax error: no savepoints |
| `BEGIN` inside a transaction | `Nested transactions are not supported` |
| Any failed statement | Transaction is poisoned; everything but ROLLBACK fails, COMMIT says `Transaction is not in RUNNING state` |
| Two concurrent requests on one session | `SESSION_IS_LOCKED` |
| Session expires before COMMIT | Transaction silently rolled back; COMMIT then fails with `There is no current transaction` |
| Reader in another transaction | Does not see uncommitted rows (snapshot) |
| Reader outside any transaction | A plain `SELECT count()` **did** see an uncommitted row |
| Concurrent mutations on the same part | Second one fails with a serialization error; its COMMIT then fails |
| Isolation choice | None; snapshot only (`SET TRANSACTION SNAPSHOT n` exists) |

**The dangerous case is a stateless BEGIN.** On a server with transactions enabled, a
`BEGIN TRANSACTION` with no `session_id` *succeeds*, the transaction dies with the request,
the following INSERT autocommits, and `COMMIT` / `ROLLBACK` fail with
`There is no current transaction`. `@effect/sql-clickhouse` has no session either: its
acquirer is one stateless HTTP connection (`Effect.succeed(connection)`). Its
`withTransaction` is saved from this today only by accident. BEGIN goes through the query
path, which appends `FORMAT JSON`, and `BEGIN TRANSACTION FORMAT JSON` is a syntax error on
any server. Wrapped in `asCommand`, BEGIN reaches the server: a default server refuses it, and
one with transactions enabled accepts and forgets it, so the body's writes land immediately
and the COMMIT failure becomes a defect after the data is written.
`tests/database.clickhouse.test.ts` pins both BEGIN paths on the CI matrix (26.2 and 26.8).

**Decision.** The ClickHouse dialect declares `transactions: { support: "none" }`, and
`transaction` under it fails with `TransactionUnsupported` before sending anything. Pretending
parity would turn the stateless BEGIN above into silent partial writes. An experimental
opt-in is possible later (section 7, phase 5) but it needs all of: a dedicated client with
its own `session_id` per transaction, statements strictly serialized on it, `async_insert=0`,
MergeTree-family tables only, no DDL, no savepoints (nesting fails), a server with the
experimental flag and Keeper, and an explicit acknowledgement that readers outside a
transaction can see uncommitted rows. It would be a separate capability value
(`"experimental-session"`) that the caller must request by name, never the default.

## 4. The proposed primitive

### 4.1 Shape

A new subpath, `@maple-dev/effect-orm/database`, with one service that executes compiled
statements and runs transactions. The library still never opens a connection: the service is
built from a `SqlClient` the caller already has, exactly like `MigrationDriver`.

```ts
import { Database } from "@maple-dev/effect-orm/database"

export interface DatabaseApi {
	readonly dialect: Dialect
	/** Run a compiled SELECT (or a write with RETURNING) and decode its rows. */
	readonly run: <O>(compiled: CompiledQuery<O>) => Effect.Effect<ReadonlyArray<O>, DatabaseError | CompiledQueryDecodeError>
	/** Run a statement whose rows are not decoded: raw SQL, DDL, an advisory lock. */
	readonly execute: (statement: Statement) => Effect.Effect<void, DatabaseError>
	/** Run `body` in a transaction; nested calls become savepoints. Provides `Database.Transaction`. */
	readonly transaction: <A, E, R>(
		body: Effect.Effect<A, E, R>,
		options?: TransactionOptions,
	) => Effect.Effect<A, E | DatabaseError | TransactionError, Exclude<R, Database.Transaction>>
	/** Re-run `effect` on serialization failure or deadlock (SQLSTATE 40001 / 40P01). */
	readonly retryContention: <A, E, R>(effect: Effect.Effect<A, E, R>, options?: RetryOptions) => Effect.Effect<A, E, R>
}

export class Database extends Context.Service<Database, DatabaseApi>()("@maple-dev/effect-orm/Database") {}

Database.fromSqlClient(sql, { dialect: postgresDialect })          // DatabaseApi
Database.layerSqlClient({ dialect: postgresDialect })              // Layer<Database, never, SqlClient>
Database.run(compiled) / Database.execute(s) / Database.transaction(body, options)  // read the service
Database.Transaction                                               // service, present only inside a transaction
Database.retryContention(effect)                                   // standalone retry combinator
```

The name `Database` is settled. Maple has its own `Database` service and aliases this one on
import (`import { Database as Orm } from "@maple-dev/effect-orm/database"`).

`Statement` is `{ sql: string; parameters: ReadonlyArray<unknown> }`, which `CompiledQuery`
already satisfies, so raw SQL and compiled queries share one path.

### 4.2 UX: context only, shaped like Effect's own transactions

Effect 4 has two transaction APIs, and both pass the transaction through context with no
handle:

- **`sql.withTransaction(effect)`**: a plain wrapper. Statements inside find the connection
  in context. The type does not change (`R` in, `R` out), so nothing in the types says
  whether a helper needs a transaction.
- **`Effect.tx(effect)`** (in-memory STM over `TxRef`, Effect.ts:24708): also a wrapper,
  and also composes when nested (an inner `tx` joins the outer one). Two details are worth
  copying. Every `TxRef` operation wraps *itself* in `Effect.tx`, so it works alone or
  inside a bigger transaction, and nobody threads a handle. And the transaction state is a
  real service, `Effect.Transaction`, with `tx` typed as
  `Effect<A, E, R> => Effect<A, E, Exclude<R, Transaction>>`. So a function that
  `yield*`s `Effect.Transaction` carries it in `R`, and the compiler will not run it until
  something wraps it in `tx`.

effect-orm takes both ideas:

1. **No handle.** `Database.run` and `Database.execute` work inside or outside a
   transaction, like `TxRef.get`. Helpers keep one signature, which is what Maple's
   `MapleDbLike` helpers rely on today.
2. **"Must be atomic" is a requirement in `R`.** `Database.Transaction` is a service that
   only `Database.transaction` provides. Its value describes the open transaction
   (`depth`, `isolationLevel`, `accessMode`), so it replaces a separate
   `transactionDepth`. `transaction` returns
   `Effect<A, E | DatabaseError | TransactionError, Exclude<R, Database.Transaction>>`.
   A helper that is only correct inside a transaction `yield*`s it, and a caller that forgets
   the wrapper gets a type error. A runtime `requireTransaction` check is not needed.
3. **Pipeable and dual**, like `Effect.withSpan`. `Database.transaction(effect, options?)`
   and `effect.pipe(Database.transaction(options?))` both work. The data-last form also fits
   `Effect.fn`'s trailing pipe arguments, so a service method is declared transactional
   where it is defined, the same way `Effect.fn` methods get spans.

```ts
// Correct alone, correct inside a transaction: no Database.Transaction in R.
const insertApiKey = (row: NewApiKey) => Database.run(Q.insertApiKey(row))

// Only correct inside a transaction: Database.Transaction is in R.
const revokeRefreshFamily = Effect.fn("revokeRefreshFamily")(function* (familyId: string) {
	yield* Database.Transaction
	yield* Database.run(Q.revokeFamily(familyId))
	yield* Database.run(Q.revokeFamilyKeys(familyId))
})

// A transactional service method. The trailing pipe argument removes the requirement.
const rotate = Effect.fn("McpOAuth.rotate")(
	function* (token: string) {
		const claimed = yield* Database.run(Q.claimRefreshToken(token))   // UPDATE ... RETURNING
		if (claimed.length === 0) {
			yield* revokeRefreshFamily(familyOf(token))  // would roll back with the failure below; see note
			return "reused" as const
		}
		yield* insertApiKey(newKey)
		return "rotated" as const
	},
	Database.transaction({ retry: "contention" }),
)

// Calling revokeRefreshFamily(id) outside a transaction is a compile error:
//   Type 'Database.Transaction' is not assignable to type 'never'.
```

(The note: in Maple, a reused token revokes the family and *returns* `"reused"` rather than
failing, so the revocation commits. Rolling back is always "fail the effect", as today.)

A transaction on one `Database` removes the requirement for helpers on any `Database`. That
is only wrong for an application with two transactional databases in one fiber, which is not
a case Maple has; per-database marker types can come later if one does.

### 4.3 Built on `withTransaction`, not beside it

`transaction` is `sql.withTransaction(body')` plus three things Effect does not do:
options, typed commit errors, and a closed-transaction guard. It does not reserve its own
connection or issue its own BEGIN, for one decisive reason: a nested `sql.withTransaction`
reads a per-transaction semaphore from a context key private to `makeWithTransaction`
(`Context.getUnsafe(services, transactionSemaphore)`). A hand-rolled top-level transaction
that only provides `sql.transactionService` would make any nested `withTransaction` (from
user code, a library, or Drizzle during a gradual migration) throw. Delegating keeps
effect-orm transactions, raw `sql\`...\`` statements and other `SqlClient` users on one
connection and one nesting counter.

Because pinning travels in context, `run` and `execute` are transaction-aware for free: they
call `sql.withoutTransforms().unsafe(statement.sql, statement.parameters)` on the same client,
which picks up the transaction connection. (`withoutTransforms` keeps result names exactly as
the compiled decoder expects; `docs/running-queries.md` already asks callers to disable name
transforms.) ClickHouse statements without rows go through the `command` wrapper, as in
`MigrationDriver`.

The depth in `Database.Transaction` comes from `Effect.serviceOption(sql.transactionService)`,
so it stays correct when an outer `sql.withTransaction` (or Drizzle) opened the transaction.

### 4.4 Options

```ts
export interface TransactionOptions {
	readonly isolationLevel?: "read committed" | "repeatable read" | "serializable"
	readonly accessMode?: "read write" | "read only"
	/** Postgres: only meaningful with serializable + read only. */
	readonly deferrable?: boolean
	/** Re-run the whole transaction on serialization failure or deadlock. Top level only. */
	readonly retry?: "contention" | { readonly schedule: Schedule.Schedule<unknown, unknown> }
}
```

- Options become one statement, built by the dialect (`transactions.setTransaction`), run as
  the first statement inside `withTransaction`:
  `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE`. It goes through
  `execute`, so it is traced and observed like any other statement (Drizzle's bypasses its
  logger).
- `read uncommitted` is left out: Postgres runs it as read committed, and offering a level
  that does not exist is the kind of parity this plan avoids. A dialect lists the levels it
  accepts; an unlisted one fails with `TransactionOptionsRejected` before BEGIN.
- **Nested calls with options fail** with `TransactionOptionsRejected` before the savepoint.
  Postgres cannot change isolation once the transaction has run a query, and Drizzle's
  silent drop hides a real bug. Nested `retry` is refused for the same reason: after a
  serialization failure the whole transaction is aborted, so retrying a savepoint cannot
  succeed.
- `snapshot` (Drizzle's `set transaction snapshot`) is out until a consumer needs it.

### 4.5 Errors

New `Schema.TaggedError`s, namespaced like the migration errors:

| Error | When |
| --- | --- |
| `@maple-dev/effect-orm/DatabaseError` | A statement failed: wraps the `SqlError` (`cause`), with `message`, `sql`, and `reason` copied from `SqlError.reason._tag` (`SerializationError`, `DeadlockError`, `UniqueViolation`, ...) so callers can branch without digging |
| `@maple-dev/effect-orm/TransactionUnsupported` | The dialect has no transactions (ClickHouse) |
| `@maple-dev/effect-orm/TransactionOptionsRejected` | An option the dialect does not support, or options on a nested call |
| `@maple-dev/effect-orm/TransactionCommitFailed` | COMMIT failed; carries `reason` like `DatabaseError` |
| `@maple-dev/effect-orm/TransactionRollbackFailed` | ROLLBACK failed; carries the body's original `Cause` as well as the rollback error |
| `@maple-dev/effect-orm/TransactionClosed` | A statement ran with a transaction's context after that transaction ended (4.7) |

`TransactionError` is the union of the transaction ones. A compiled query whose dialect does
not match the database's (needs a `CompiledQuery.dialect` name, added in phase 1) fails as
`DatabaseError` with reason `DialectMismatch` before sending.

**Recovering typed commit and rollback errors.** Effect dies on a failed COMMIT or ROLLBACK
(section 1). `transaction` turns those back into typed errors without guessing:

1. The body runs as `body.pipe(Effect.catchCause(...))` that re-fails any defect from the
   body as a private `BodyDefect` failure (still a failure, so Effect still rolls back) and
   records whether the body succeeded.
2. Outside `withTransaction`, a `BodyDefect` is turned back into the original die. Any other
   die whose defect is a `SqlError` came from transaction control: COMMIT if the body
   succeeded, ROLLBACK otherwise.
3. An interrupted transaction whose ROLLBACK died stays interrupted (Maple's rule).

This is a translation of Effect 4.0.0 behavior. The right fix is upstream: COMMIT failure as a
`SqlError` in the error channel, and ROLLBACK failure that keeps the original cause. Filing
that is part of phase 2; when it lands, steps 1 and 2 become a no-op. Decided: ship the
translation and file upstream in parallel, not one after the other.

**Retry.** `Database.retryContention(effect, options?)` re-runs `effect` when it fails with
`DatabaseError` or `TransactionCommitFailed` whose reason is `SerializationError` or
`DeadlockError`, three times with exponential backoff from 50 ms by default, matching
`makeDbExecute`. Domain errors are never retried. It works on single statements outside a
transaction too. Inside an open transaction it refuses to retry (fails with
`TransactionOptionsRejected`), because after a serialization failure the whole transaction is
aborted and only the outermost boundary can start again. `transaction(body, { retry:
"contention" })` is shorthand for `retryContention(transaction(body))`, so each attempt gets a
fresh BEGIN. Decided: both forms.

### 4.6 Interruption

Inherited from Effect: BEGIN and connection acquisition are uninterruptible, the body is
interruptible, and interruption rolls back before the connection is returned. Nothing extra.
Two points the docs must state:

- A fiber forked inside the transaction inherits the transaction connection. If it outlives
  the transaction, its statements would run on a connection that has gone back to the pool,
  possibly inside someone else's transaction. Join forks before the body returns. In Maple
  terms: never `forkRequestScoped` from inside a transaction.
- Concurrent statements inside one transaction (`Effect.all(..., { concurrency })`) share one
  connection and queue on it; a failure in one aborts the transaction for all of them.

### 4.7 The closed-transaction guard

`transaction` also provides a small private reference holding `{ open: boolean }`, set to
false in the exit handler. `run` and `execute` check it when `sql.transactionService` is in
context: a statement carrying a closed transaction's context fails with `TransactionClosed`
instead of running on a recycled connection. This is the effect-orm equivalent of Maple's
`PgConnectionScopeClosedError` for the transaction level. It only covers statements that go
through `Database`; a raw `sql\`...\`` on the client is not guarded.

### 4.8 Dialect capability

```ts
export interface DialectTransactions {
	/** `none`: `transaction` fails with TransactionUnsupported. */
	readonly support: "none" | "full"
	/** Nested `transaction` calls become savepoints. Without it, nesting fails. */
	readonly savepoints: boolean
	readonly isolationLevels: ReadonlyArray<IsolationLevel>
	readonly accessModes: boolean
	readonly deferrable: boolean
	/** The statement that applies `options` as the first statement of a transaction. */
	readonly setTransaction: (options: TransactionOptions) => string | undefined
}

export interface Dialect extends SqlSyntax {
	// ...
	readonly transactions: DialectTransactions
}
```

- `postgresDialect`: `full`, savepoints, the three levels, access modes, deferrable,
  `SET TRANSACTION ...`.
- `clickhouseDialect`: `none`. A later `"experimental-session"` value would be added only with
  the session-bound executor from section 3.
- MySQL later: `full`, savepoints, four levels; it needs `SET TRANSACTION` **before** BEGIN,
  so the hook may need a `placement: "before-begin" | "after-begin"`, which Effect's
  `withTransaction` cannot do for a pooled client. That is the point to revisit, not now.
- SQLite later: `full`, savepoints, no isolation levels (it is serializable), access mode via
  `BEGIN DEFERRED/IMMEDIATE` rather than options.

Capability is runtime, checked before any statement. A type-level split (no `transaction`
method on a ClickHouse database) was considered and deferred: the `Dialect` value is not a
literal type today, so it would need a generic on `Database`, and it can be added later
without breaking callers.

### 4.9 Relation to `MigrationDriver`

Share the core, not the interface. `MigrationDriver` is deliberately tiny (raw text, rows as
records) and assumes nothing is atomic; that is right for ClickHouse and should stay. The
transaction logic lives in one internal function (`src/database/transaction.ts`) that both
use:

- `Database.transaction` calls it.
- Postgres migrations (migrations phase 6: "one transaction per migration,
  `pg_advisory_xact_lock`") add an optional `transaction` member to `MigrationDriverApi`,
  filled by `fromSqlClient` when the dialect supports it. The runner wraps each migration in
  it when present, and keeps the step journal when absent.
- `MigrationDriver.fromDatabase(db)` adapts a `Database` so a consumer builds one thing.

### 4.10 How Maple would wire it

Maple builds its `PgClient` per invocation inside `withPgConnectionScope`. `Database` is a
plain object over that client (`Database.fromSqlClient(pgClient, { dialect })`), so it is built
per invocation in the same place `makeMapleEffectDb` is today, and the transaction connection
lives in fiber context, never in a service. Nothing request-scoped is captured at
construction. During a gradual migration both Drizzle and effect-orm can run over the same
`PgClient`: they share `sql.transactionService`, so a Drizzle `db.transaction` and an
effect-orm `Database.run` inside it hit the same connection.

### 4.11 Tracing and observation

An `effect_orm.transaction` span with `db.transaction.isolation_level`,
`db.transaction.access_mode`, `effect_orm.transaction.depth` and
`effect_orm.transaction.attempt`, around Effect's own `sql.transaction`. An optional
`observe: (statement) => Effect<void>` on `fromSqlClient` lets a consumer collect every
statement, including `SET TRANSACTION`, which is what Maple's statement collector needs.

## 5. What else blocks replacing Drizzle in Maple

Transactions are **not** the last blocker. Today effect-orm compiles SELECTs only.

| Needed by Maple | Maple usage (approx.) | effect-orm today |
| --- | --- | --- |
| `INSERT`, incl. multi-row | ~101 | None |
| `UPDATE` with `SET` expressions (`count + 1`) | ~120 | None |
| `DELETE` | ~79 | None |
| `RETURNING` (columns, expressions such as the txid) | 118 | None |
| `ON CONFLICT (target) DO UPDATE SET ... excluded.x` / `DO NOTHING`, `setWhere` | 25 / 43, 66 `excluded.` refs, 6 `setWhere` | None |
| `SELECT ... FOR UPDATE / FOR SHARE / SKIP LOCKED` | 7 | None |
| `SELECT DISTINCT` | 10 | None |
| Inner / left joins, `offset`, `having`, subqueries | 15 / 6 / 8 | Yes |
| `sql` template interop, `sql.join`, `sql.raw` | ~163, 2, 2 | `rawExpr`; no Drizzle-style template in statements |
| jsonb operators, `@>` with a typed param | ~12 | `->>` only |
| Raw statements (advisory locks, bulk `UPDATE ... FROM (VALUES ...)`) | 6 | `execute` in this plan |
| `timestamp` columns as JS `Date` (`mode: "date"`) | 226 columns | `PG.timestamptz` decodes to `DateTime.Utc`; either a `Date` codec or call-site changes |
| `jsonb` with `$type<T>` | 50 columns | `PG.jsonb()`; needs a schema-typed variant |
| Table definitions | 68 `pgTable`, 90 indexes, 47 unique, ~2 FKs | Query-side `table()` exists; Postgres `defineTable` DDL does not |
| Migrations | 75 drizzle-kit folders, applied by the prd alchemy deploy; PGlite tests use Drizzle's migrator | ClickHouse only; Postgres is migrations phase 6, not started |

Not needed: relational queries (`db.query.*`), CTEs, `$count`, `alias`, `db.batch`, enums,
checks, views, RLS.

**Migrations are separable.** The runtime switch does not require effect-orm migrations:
drizzle-kit can keep authoring and applying `packages/db/drizzle` (the alchemy deploy and the
PGlite test migrator both work on the folder, not on the ORM), while query code moves to
effect-orm. Removing drizzle-kit is a later, independent step.

**Order of work for Maple**, by what unblocks the most call sites: write builders
(INSERT / UPDATE / DELETE with RETURNING) first, then ON CONFLICT, then the transaction
primitive (only 33 sites, but each needs the write builders anyway), then `FOR UPDATE`,
DISTINCT and the `Date` codec. The write builders are their own design note
(`design/writes.md`); this plan only fixes the interface they must meet: a write compiles to a
`CompiledQuery` whose `decodeRows` decodes the RETURNING list (empty schema without one), so
`Database.run` executes writes and reads alike.

## 6. Tests

**Postgres, in process.** Add `@effect/sql-pglite@4.0.0` as a dev dependency and bump the
direct `@electric-sql/pglite` dev dependency from 0.3.15 to the same 0.5 line, so
`src/pg/postgres.test.ts` and the transaction suite run on one build. Every test builds `Database.fromSqlClient(pgliteClient)`, so it
exercises the real `withTransaction`, not a fake:

- commit makes writes visible; a typed failure rolls back and passes through unchanged;
- a defect in the body rolls back and stays the same defect (not `TransactionCommitFailed`);
- interruption mid-body rolls back (fork, interrupt, assert nothing written, connection free);
- nested: inner failure caught by the outer keeps outer writes and drops inner ones;
  inner success is kept; three levels deep; concurrent nested blocks are serialized;
- nested call with options fails with `TransactionOptionsRejected` and sends no savepoint;
- `SET TRANSACTION` is the first statement; `current_setting('transaction_isolation')` and
  `transaction_read_only` read back inside; a write under `read only` fails;
- a deferred FK violation fails at COMMIT as `TransactionCommitFailed`, not a defect (this
  mirrors Maple's `DatabaseLive.test.ts`);
- `retry: "contention"` re-runs on a forced 40001 and never on a domain error;
- a forked fiber that outlives the transaction gets `TransactionClosed`;
- a Drizzle-free raw `sql.withTransaction` nested inside `Database.transaction`, and the
  reverse, share one connection and nest correctly;
- `run` decodes rows from a compiled query inside and outside a transaction, and refuses a
  ClickHouse-compiled query.

**Postgres over the wire.** PGlite has one connection, so it cannot show isolation between
two transactions or real serialization failures. Add a small `@effect/sql-pg` suite against a
Postgres container (the CI service pattern the ClickHouse matrix uses): two concurrent
serializable transactions produce 40001 and the retry resolves it; READ COMMITTED does not
see an uncommitted write from another connection.

**ClickHouse matrix.** `Database.transaction` under the ClickHouse dialect fails with
`TransactionUnsupported` and sends nothing (assert via `observe`). `run` and `execute` work
against every matrix server. One test documents the stateless-BEGIN hazard from section 3 on a
default server (BEGIN refused), so a future server or driver change that alters it is noticed.

**Types.** `.test-d.ts`: the error channel of `transaction` is `E | DatabaseError |
TransactionError`; `run` infers the row type from the compiled query; a helper that
`yield*`s `Database.Transaction` fails to type-check until wrapped, and `transaction` removes
the requirement both data-first and as an `Effect.fn` pipe argument.

## 7. Phases

1. **Execution seam.** `@maple-dev/effect-orm/database`: `Database` service,
   `fromSqlClient`, `layerSqlClient`, `run`, `execute`, `DatabaseError`, `observe`.
   `CompiledQuery.dialect`. Docs page; `running-queries.md` points to it. No transactions yet.
2. **Transactions on Postgres.** `Dialect.transactions`, `transaction` over `withTransaction`,
   options, typed commit and rollback errors, closed guard, retry, spans. PGlite suite and the
   wire suite. File the upstream Effect issue for orDie'd COMMIT and ROLLBACK.
3. **ClickHouse declared unsupported.** `clickhouseDialect.transactions = { support: "none" }`,
   the matrix tests, a docs section with the table from section 3.
4. **Migrations share the core.** Optional `MigrationDriverApi.transaction`,
   `MigrationDriver.fromDatabase`; used by migrations phase 6 when it starts.
5. **Maybe: ClickHouse experimental sessions.** Only if a consumer asks. A session-bound
   executor (own client with `session_id`, serialized, `async_insert=0`) and the
   `"experimental-session"` capability, behind an explicit opt-in.

Write builders, ON CONFLICT, locking clauses and the `Date` codec (section 5) are separate
plans and can run in parallel with phases 1 to 3.

## 8. Open questions

Decided:

- **Name**: `@maple-dev/effect-orm/database`, `Database` service; Maple aliases it.
- **No `tx` handle**: context only, with "must be atomic" as `Database.Transaction` in `R`
  (4.2).
- **Commit and rollback errors**: translate in effect-orm and file upstream in parallel.
- **Retry**: `Database.retryContention` plus the `retry` option as shorthand.
- **ClickHouse capability**: checked at runtime (`TransactionUnsupported`), one `Database`
  type for every dialect. A `Database<D>` split can come later without breaking callers.
- **PGlite**: align the existing direct PGlite 0.3.15 tests on the 0.5 line that
  `@effect/sql-pglite` brings (phase 2), so one build runs every Postgres test.
- **`outsideTransaction`**: not now. Maple has no write that must survive a rollback; add it
  when a consumer needs one.

Nothing is open. Phase 1 can start.

## 9. Implementation notes (phases 1 to 3)

What landed differently from the sections above:

- **Namespace import, not static members.** The subpath exports flat names, used as
  `import * as Db from "@maple-dev/effect-orm/database"`: `Db.Database` (the service),
  `Db.run`, `Db.transaction`, `Db.Transaction`. This matches `Migrate.run` /
  `Migrate.MigrationDriver`. The examples above that say `Database.run` read as `Db.run`.
- **`query` was added** beside `run` and `execute`, for raw statements whose rows are wanted
  undecoded (advisory locks, `RETURNING` before the write builders exist).
- **`TransactionClosed` and dialect mismatch are defects**, not typed errors. Both are
  programming bugs (an unjoined fork, the wrong `compile`), and as typed errors they would sit
  in the error channel of every `run`. This follows the rule `compile` already uses: expected
  failures are typed, bugs die. `TransactionClosed` is therefore not in `TransactionError`. A
  dialect mismatch dies with a `DatabaseError` whose `reason` is `DialectMismatch`.
- **`Dialect.transactions` is optional**, absent meaning none (`noTransactions`), so dialects
  defined outside the package keep compiling. `clickhouseDialect` sets it explicitly.
- **`CompiledQuery.dialect` is optional**: set by every builder compile, and an option on
  `rawCompiledQuery`. `run` checks it only when present.
- **SQLSTATE from the cause chain.** `@effect/sql-pglite` does not classify 40001 or 40P01
  into `SerializationError` or `DeadlockError` the way `@effect/sql-pg` does. So
  `DatabaseError` and `TransactionCommitFailed` carry `sqlState` read from the cause chain,
  and `isContention` accepts either signal.
- **Retry options** are `{ times, schedule }` (defaults 3 and exponential from 50 ms), fed to
  `Effect.retry` with `while: isContention`.
- **PGlite 0.5 uses the host time zone** for its sessions, where 0.3 used UTC. Every PGlite in
  the tests is created with `postgresqlconf: "timezone = 'UTC'"`.
- **Not yet done from phase 2:** the over-the-wire `@effect/sql-pg` suite (two connections,
  real serialization failures), and filing the upstream Effect issue for orDie'd COMMIT and
  ROLLBACK. The PGlite suite simulates contention with `RAISE ... USING ERRCODE`.
