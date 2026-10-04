// Executing compiled statements, and transactions over them.
//
// The library still never opens a connection: a `Database` is built from the
// `SqlClient` the caller already has. Transactions are Effect's own
// `withTransaction`, which pins the connection through fiber context, plus what
// it does not do: settings, typed COMMIT/ROLLBACK failures, a guard against
// statements outliving their transaction, and contention retry. See
// `design/transactions.md`.

import { Cause, Context, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import { dual } from "effect/Function"
import * as SqlClient from "effect/sql/SqlClient"
import { isSqlError } from "effect/sql/SqlError"
import { compileCH, compileUnion, CompiledQueryDecodeError, type CompiledQuery } from "../ch/compile"
import { noTransactions, type Dialect, type IsolationLevel, type TransactionSettings } from "../ch/dialect"
import type { QueryBuilderError } from "../ch/errors"
import type { CHInsert } from "../ch/insert"
import type { CHDelete, CHUpdate } from "../ch/update"
import type { CHQuery, NeedsSelect } from "../ch/query"
import type { CHUnionQuery } from "../ch/union"
import {
	DatabaseError,
	TransactionClosed,
	TransactionCommitFailed,
	TransactionOptionsRejected,
	TransactionRollbackFailed,
	TransactionUnsupported,
	type TransactionError,
} from "./errors"
import { isSqlTemplate, renderTemplate, type SqlTemplate } from "./sql"
import { firstLine, reasonOf, sqlStateOf, toDatabaseError } from "./sql-error"

/** SQL and the values bound to its placeholders. A `CompiledQuery` is one. */
export interface Statement {
	readonly sql: string
	readonly parameters?: ReadonlyArray<unknown>
}

/** What `query` and `execute` take: a `sql\`...\`` template, or SQL with its parameters. */
export type StatementInput = SqlTemplate | Statement

/** What `run` takes: a built query, a union, an insert, or one already compiled. */
export type Runnable =
	| CHQuery<any, any, any, any>
	| CHUnionQuery<any>
	| CHInsert<any, any, any, any>
	| CHUpdate<any, any, any>
	| CHDelete<any, any>
	| CompiledQuery<any, any>

/**
 * `unknown` when a `Runnable` can run as it is. A query with no SELECT list
 * cannot; a write without `where`/`allRows` is not a `Runnable` at all.
 */
export type RunCheck<Q> = Q extends CHQuery<any, infer Output, any, any> ? NeedsSelect<Output> : unknown

/** The decoded row of a `Runnable`. */
export type RowOf<Q> =
	Q extends CompiledQuery<infer Output, any> ? Output : Q extends { readonly _phantom?: { output: infer Output } } ? Output : never

/** A row codec for `query`. */
export type RowSchema<A> = Schema.Codec<A, unknown, never, never>

export interface RetryOptions {
	/** Retries after the first attempt. Default 3. */
	readonly times?: number
	/** Delay between attempts. Default exponential from 50 ms. */
	readonly schedule?: Schedule.Schedule<unknown>
}

export interface TransactionOptions extends TransactionSettings {
	/**
	 * Re-run the whole transaction, with a fresh BEGIN, on a serialization
	 * failure or deadlock. Outermost transaction only. `"contention"` uses the
	 * defaults of `retryContention`.
	 */
	readonly retry?: "contention" | RetryOptions | undefined
}

/** The open transaction, as `Transaction` describes it inside the body. */
export interface TransactionInfo {
	/** 0 for the outermost transaction, 1 for its first savepoint, ... */
	readonly depth: number
	/** What the outermost transaction set; `undefined` is the server default. */
	readonly isolationLevel: IsolationLevel | undefined
	readonly accessMode: "read write" | "read only" | undefined
}

/**
 * The open transaction. Present only inside `transaction`, which also removes
 * it from the requirements of its body. `requireTransaction` adds it, which is
 * how a helper says it must run inside a transaction. Read it for the depth or
 * the settings of the transaction you are in.
 */
export class Transaction extends Context.Service<Transaction, TransactionInfo>()("@maple-dev/effect-orm/Transaction") {}

export interface DatabaseApi {
	readonly dialect: Dialect
	/**
	 * Compile a query for this database's dialect, run it, and decode its rows.
	 * A write returns its RETURNING rows, or none without `returning`.
	 * `params` fills the query's `param.*` markers. A query compiled elsewhere
	 * runs as it is, if it was compiled for this dialect.
	 */
	readonly run: <Q extends Runnable>(
		query: Q & RunCheck<Q>,
		params?: Record<string, unknown>,
	) => Effect.Effect<ReadonlyArray<RowOf<Q>>, DatabaseError | QueryBuilderError | CompiledQueryDecodeError>
	/** Run a statement and return its rows, decoded through `schema` when given. */
	readonly query: {
		(statement: StatementInput): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DatabaseError>
		<A>(statement: StatementInput, schema: RowSchema<A>): Effect.Effect<ReadonlyArray<A>, DatabaseError | CompiledQueryDecodeError>
	}
	/** Run a statement whose rows are not wanted: DDL, an advisory lock, a write without RETURNING. */
	readonly execute: (statement: StatementInput) => Effect.Effect<void, DatabaseError>
	/**
	 * Run `body` in a transaction. Nested calls become savepoints. A failure,
	 * defect or interruption in `body` rolls back; domain errors pass through
	 * unchanged.
	 */
	readonly transaction: <A, E, R>(
		body: Effect.Effect<A, E, R>,
		options?: TransactionOptions,
	) => Effect.Effect<A, E | DatabaseError | TransactionError, Exclude<R, Transaction>>
	/**
	 * Re-run `effect` when it fails with a serialization failure or deadlock
	 * (SQLSTATE 40001 / 40P01), including one found at COMMIT. Domain errors are
	 * never retried. Inside an open transaction it refuses, because only the
	 * outermost transaction can start again.
	 */
	readonly retryContention: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
		options?: RetryOptions,
	) => Effect.Effect<A, E | TransactionOptionsRejected, R>
}

export class Database extends Context.Service<Database, DatabaseApi>()("@maple-dev/effect-orm/Database") {}

export interface FromSqlClientOptions {
	/** The dialect the database speaks: `postgresDialect` or `clickhouseDialect`. */
	readonly dialect: Dialect
	/**
	 * Wraps statements run by `execute`. Pass the ClickHouse client's
	 * `asCommand`, whose query path asks for a JSON result a DDL statement does
	 * not have; leave unset for Postgres.
	 */
	readonly command?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	/**
	 * Called with every statement before it runs, including the `SET
	 * TRANSACTION` a transaction's settings become. For collecting statements
	 * into one span or log line per request.
	 */
	readonly observe?: (statement: Statement) => Effect.Effect<void>
}

// Whether the transaction a fiber's context belongs to is still open. Keyed by
// client so a closed transaction on one database does not flag another.
interface OpenState {
	open: boolean
	readonly client: SqlClient.SqlClient
}
class TransactionOpen extends Context.Service<TransactionOpen, OpenState>()("@maple-dev/effect-orm/TransactionOpen") {}

// A defect from the body, carried through `withTransaction` as a failure so the
// transaction still rolls back and any defect that comes out of it is known to
// be COMMIT's or ROLLBACK's.
class BodyDefect {
	readonly _tag = "@maple-dev/effect-orm/BodyDefect"
	constructor(readonly cause: Cause.Cause<unknown>) {}
}

const CONTENTION_REASONS = new Set(["SerializationError", "DeadlockError"])
const CONTENTION_STATES = new Set(["40001", "40P01"])

/** A serialization failure or deadlock: safe to replay as a fresh transaction. */
export const isContention = (error: unknown): boolean =>
	(error instanceof DatabaseError || error instanceof TransactionCommitFailed) &&
	(CONTENTION_REASONS.has(error.reason) || (error.sqlState !== undefined && CONTENTION_STATES.has(error.sqlState)))

const settingsOf = (options: TransactionOptions): TransactionSettings => ({
	isolationLevel: options.isolationLevel,
	accessMode: options.accessMode,
	deferrable: options.deferrable,
})

const hasSettings = (settings: TransactionSettings): boolean =>
	settings.isolationLevel !== undefined || settings.accessMode !== undefined || settings.deferrable !== undefined

const committed = (state: OpenState) =>
	Effect.sync(() => {
		state.open = false
	})

/** A `Database` over an Effect `SqlClient`. */
export const fromSqlClient = (sql: SqlClient.SqlClient, options: FromSqlClientOptions): DatabaseApi => {
	const { dialect } = options
	const capabilities = dialect.transactions ?? noTransactions
	const command = options.command ?? ((effect) => effect)
	const observe = options.observe ?? (() => Effect.void)
	// Result names exactly as the server sent them: the compiled decoder reads
	// the aliases it wrote.
	const raw = sql.withoutTransforms()

	// A statement carrying the context of a transaction that has ended would run
	// on a connection already back in the pool. That is a bug (a fiber forked in
	// the transaction and never joined), so it is a defect, not an error to handle.
	const guard = (statement: Statement) =>
		Effect.flatMap(Effect.serviceOption(TransactionOpen), (state) =>
			Option.isSome(state) && state.value.client === sql && !state.value.open
				? Effect.die(
						new TransactionClosed({
							message: "a statement ran after its transaction ended; join fibers forked inside a transaction before it returns",
							sql: statement.sql,
						}),
					)
				: observe(statement),
		)

	const resolve = (statement: StatementInput): Effect.Effect<Statement, DatabaseError> =>
		isSqlTemplate(statement) ? renderTemplate(statement, dialect) : Effect.succeed(statement)

	const rows = (statement: Statement) =>
		guard(statement).pipe(
			Effect.andThen(raw.unsafe<Record<string, unknown>>(statement.sql, statement.parameters ?? [])),
			Effect.map((rows): ReadonlyArray<Record<string, unknown>> => rows),
			Effect.mapError(toDatabaseError(statement.sql)),
		)

	const decodeWith =
		<A>(schema: RowSchema<A>) =>
		(wire: ReadonlyArray<Record<string, unknown>>) => {
			const decode = Schema.decodeUnknownEffect(schema)
			return Effect.forEach(wire, (row, rowIndex) =>
				decode(row).pipe(
					Effect.mapError(
						(cause) => new CompiledQueryDecodeError({ message: `row ${rowIndex} did not match the schema`, rowIndex, cause }),
					),
				),
			)
		}

	const query = ((statement: StatementInput, schema?: RowSchema<unknown>) =>
		Effect.flatMap(
			resolve(statement),
			(resolved): Effect.Effect<ReadonlyArray<unknown>, DatabaseError | CompiledQueryDecodeError> =>
				schema === undefined ? rows(resolved) : Effect.flatMap(rows(resolved), decodeWith(schema)),
		)) as DatabaseApi["query"]

	const execute: DatabaseApi["execute"] = (statement) =>
		Effect.flatMap(resolve(statement), (resolved) =>
			guard(resolved).pipe(
				Effect.andThen(command(raw.unsafe(resolved.sql, resolved.parameters ?? []))),
				Effect.asVoid,
				Effect.mapError(toDatabaseError(resolved.sql)),
			),
		)

	const compileFor = (
		runnable: Runnable,
		params: Record<string, unknown>,
	): Effect.Effect<CompiledQuery<any, any>, QueryBuilderError> => {
		if ("decodeRows" in runnable) {
			return runnable.dialect !== undefined && runnable.dialect !== dialect.name
				? Effect.die(
						new DatabaseError({
							message: `a query compiled for ${runnable.dialect} cannot run on a ${dialect.name} database; pass the query to run instead of compiling it`,
							sql: runnable.sql,
							reason: "DialectMismatch",
							cause: undefined,
						}),
					)
				: Effect.succeed(runnable)
		}
		if ("_tag" in runnable && runnable._tag === "CHUnionQuery") return compileUnion(runnable, params, { dialect })
		if ("_tag" in runnable && (runnable._tag === "CHInsert" || runnable._tag === "CHUpdate" || runnable._tag === "CHDelete")) {
			return compileCH(runnable, params, { dialect })
		}
		return compileCH(runnable as CHQuery<any, any, any, any>, params, { dialect })
	}

	// A write without RETURNING sends back no rows, so it runs the way `execute`
	// does: through `command`, which a ClickHouse client needs for a statement
	// with no result set.
	const run: DatabaseApi["run"] = (runnable, params = {}) =>
		Effect.flatMap(compileFor(runnable, params), (compiled) =>
			compiled.kind !== "select" && compiled.returning === undefined
				? Effect.as(execute(compiled), [])
				: Effect.flatMap(rows(compiled), (wire) => compiled.decodeRows(wire)),
		)

	const retryContention = <A, E, R>(effect: Effect.Effect<A, E, R>, retry?: RetryOptions) =>
		Effect.flatMap(Effect.serviceOption(sql.transactionService), (open): Effect.Effect<A, E | TransactionOptionsRejected, R> =>
			Option.isSome(open)
				? Effect.fail(
						new TransactionOptionsRejected({
							message:
								"retryContention inside an open transaction cannot retry: a serialization failure aborts the whole transaction. Retry the outermost transaction instead",
						}),
					)
				: Effect.retry(effect, {
						while: isContention,
						times: retry?.times ?? 3,
						schedule: retry?.schedule ?? Schedule.exponential("50 millis"),
					}),
		)

	const once = <A, E, R>(
		body: Effect.Effect<A, E, R>,
		options: TransactionOptions,
	): Effect.Effect<A, E | DatabaseError | TransactionError, Exclude<R, Transaction>> =>
		Effect.gen(function* () {
			if (capabilities.support === "none") {
				return yield* new TransactionUnsupported({
					dialect: dialect.name,
					message: `${dialect.name} has no transactions; nothing was sent`,
				})
			}
			const parent = yield* Effect.serviceOption(sql.transactionService)
			const depth = Option.isSome(parent) ? parent.value[1] + 1 : 0
			const settings = settingsOf(options)
			if (depth > 0) {
				if (hasSettings(settings) || options.retry !== undefined) {
					return yield* new TransactionOptionsRejected({
						message:
							"a nested transaction cannot set isolationLevel, accessMode, deferrable or retry; they belong to the outermost transaction",
					})
				}
				if (!capabilities.savepoints) {
					return yield* new TransactionUnsupported({
						dialect: dialect.name,
						message: `${dialect.name} has no savepoints, so transactions cannot nest`,
					})
				}
			} else {
				if (settings.isolationLevel !== undefined && !capabilities.isolationLevels.includes(settings.isolationLevel)) {
					return yield* new TransactionOptionsRejected({
						message: `${dialect.name} does not support isolation level ${settings.isolationLevel}`,
					})
				}
				if (settings.accessMode !== undefined && !capabilities.accessModes) {
					return yield* new TransactionOptionsRejected({ message: `${dialect.name} does not support access modes` })
				}
				if (settings.deferrable !== undefined && !capabilities.deferrable) {
					return yield* new TransactionOptionsRejected({ message: `${dialect.name} does not support deferrable transactions` })
				}
			}

			const outer = yield* Effect.serviceOption(Transaction)
			const info: TransactionInfo =
				depth === 0 || Option.isNone(outer)
					? { depth, isolationLevel: settings.isolationLevel, accessMode: settings.accessMode }
					: { ...outer.value, depth }
			const setTransaction = depth === 0 ? capabilities.setTransaction(settings) : undefined
			const state: OpenState = { open: true, client: sql }
			let bodyExit: Exit.Exit<unknown, unknown> | undefined

			const inner = Effect.gen(function* () {
				if (setTransaction !== undefined) yield* execute({ sql: setTransaction })
				return yield* body
			}).pipe(
				Effect.provideService(Transaction, info),
				Effect.provideService(TransactionOpen, state),
				Effect.onExit((exit) =>
					Effect.sync(() => {
						bodyExit = exit
					}),
				),
				Effect.catchCause((cause): Effect.Effect<never, unknown> =>
					Cause.hasDies(cause) && !Cause.hasInterrupts(cause) ? Effect.fail(new BodyDefect(cause)) : Effect.failCause(cause),
				),
			)

			const exit = yield* Effect.exit(sql.withTransaction(inner).pipe(Effect.ensuring(committed(state))))
			if (Exit.isSuccess(exit)) return exit.value
			return yield* restoreCause<E>(exit.cause, bodyExit, depth)
		}).pipe(
			Effect.withSpan("effect_orm.transaction", {
				attributes: {
					"db.transaction.isolation_level": options.isolationLevel ?? "default",
					"db.transaction.access_mode": options.accessMode ?? "default",
				},
			}),
		) as Effect.Effect<A, E | DatabaseError | TransactionError, Exclude<R, Transaction>>

	const transaction: DatabaseApi["transaction"] = (body, options = {}) =>
		options.retry === undefined
			? once(body, options)
			: retryContention(once(body, options), options.retry === "contention" ? undefined : options.retry)

	return { dialect, run, query, execute, transaction, retryContention }
}

/**
 * Turn what came out of `withTransaction` back into what the caller should see.
 * Effect dies on a failed COMMIT or ROLLBACK, and a dying ROLLBACK replaces the
 * body's own exit. Body defects were carried through as `BodyDefect`, so any
 * other defect that is a `SqlError` came from transaction control.
 */
const restoreCause = <E>(
	cause: Cause.Cause<unknown>,
	bodyExit: Exit.Exit<unknown, unknown> | undefined,
	depth: number,
): Effect.Effect<never, E | DatabaseError | TransactionCommitFailed | TransactionRollbackFailed> => {
	const failure = Cause.findError(cause)
	if (failure._tag === "Success" && failure.success instanceof BodyDefect) {
		return Effect.failCause(failure.success.cause as Cause.Cause<E>)
	}
	const defect = Cause.findDefect(cause)
	if (defect._tag === "Success" && isSqlError(defect.success)) {
		const error = defect.success
		if (bodyExit !== undefined && Exit.isSuccess(bodyExit)) {
			const sqlState = sqlStateOf(error)
			return Effect.fail(
				new TransactionCommitFailed({
					message: `${depth === 0 ? "COMMIT" : "releasing the savepoint"} failed: ${firstLine(error)}`,
					reason: reasonOf(error),
					...(sqlState === undefined ? undefined : { sqlState }),
					cause: error,
				}),
			)
		}
		// The body never ran: BEGIN or SAVEPOINT died, not ROLLBACK.
		if (bodyExit === undefined) return Effect.fail(toDatabaseError(depth === 0 ? "BEGIN" : "SAVEPOINT")(error))
		// An interrupted transaction whose ROLLBACK died stays interrupted.
		if (Cause.hasInterrupts(bodyExit.cause)) return Effect.failCause(bodyExit.cause as Cause.Cause<E>)
		return Effect.fail(
			new TransactionRollbackFailed({
				message: `ROLLBACK failed after the transaction body failed: ${firstLine(error)}`,
				bodyCause: bodyExit.cause,
				cause: error,
			}),
		)
	}
	// BEGIN or SAVEPOINT failed before the body ran.
	if (bodyExit === undefined && failure._tag === "Success" && isSqlError(failure.success)) {
		return Effect.fail(toDatabaseError(depth === 0 ? "BEGIN" : "SAVEPOINT")(failure.success))
	}
	return Effect.failCause(cause as Cause.Cause<E>)
}

/** A `Database` layer over the `SqlClient` in context. */
export const layerSqlClient = (options: FromSqlClientOptions): Layer.Layer<Database, never, SqlClient.SqlClient> =>
	Layer.effect(
		Database,
		Effect.gen(function* () {
			return fromSqlClient(yield* SqlClient.SqlClient, options)
		}),
	)

/** `run` on the `Database` in context. */
export const run = <Q extends Runnable>(
	query: Q & RunCheck<Q>,
	params?: Record<string, unknown>,
): Effect.Effect<ReadonlyArray<RowOf<Q>>, DatabaseError | QueryBuilderError | CompiledQueryDecodeError, Database> =>
	Effect.flatMap(Effect.service(Database), (db) => db.run(query, params))

/** `query` on the `Database` in context. */
export const query: {
	(statement: StatementInput): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DatabaseError, Database>
	<A>(
		statement: StatementInput,
		schema: RowSchema<A>,
	): Effect.Effect<ReadonlyArray<A>, DatabaseError | CompiledQueryDecodeError, Database>
} = ((statement: StatementInput, schema?: RowSchema<unknown>) =>
	Effect.flatMap(
		Effect.service(Database),
		(db): Effect.Effect<ReadonlyArray<unknown>, DatabaseError | CompiledQueryDecodeError> =>
			schema === undefined ? db.query(statement) : db.query(statement, schema),
	)) as typeof query

/** `execute` on the `Database` in context. */
export const execute = (statement: StatementInput): Effect.Effect<void, DatabaseError, Database> =>
	Effect.flatMap(Effect.service(Database), (db) => db.execute(statement))

/**
 * Mark an effect as correct only inside a transaction. It adds `Transaction`
 * to the requirements, so it does not compile until `transaction` wraps it, as
 * an `Effect.fn` pipe argument or with `.pipe`:
 *
 * ```ts
 * const revokeFamily = Effect.fn("revokeFamily")(function* (family: string) { ... }, Db.requireTransaction)
 * ```
 */
export const requireTransaction = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Transaction> =>
	Effect.andThen(Effect.service(Transaction), self)

/**
 * `transaction` on the `Database` in context. Data-first or pipeable, so it
 * also fits as an `Effect.fn` pipe argument:
 *
 * ```ts
 * const rotate = Effect.fn("rotate")(function* () { ... }, Db.transaction({ retry: "contention" }))
 * ```
 */
export const transaction: {
	(
		options?: TransactionOptions,
	): <A, E, R>(
		body: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | DatabaseError | TransactionError, Exclude<R, Transaction> | Database>
	<A, E, R>(
		body: Effect.Effect<A, E, R>,
		options?: TransactionOptions,
	): Effect.Effect<A, E | DatabaseError | TransactionError, Exclude<R, Transaction> | Database>
} = dual(
	(args) => Effect.isEffect(args[0]),
	<A, E, R>(body: Effect.Effect<A, E, R>, options?: TransactionOptions) =>
		Effect.flatMap(Effect.service(Database), (db) => db.transaction(body, options)),
)

/** `retryContention` on the `Database` in context. Data-first or pipeable. */
export const retryContention: {
	(
		options?: RetryOptions,
	): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TransactionOptionsRejected, R | Database>
	<A, E, R>(effect: Effect.Effect<A, E, R>, options?: RetryOptions): Effect.Effect<A, E | TransactionOptionsRejected, R | Database>
} = dual(
	(args) => Effect.isEffect(args[0]),
	<A, E, R>(effect: Effect.Effect<A, E, R>, options?: RetryOptions) =>
		Effect.flatMap(Effect.service(Database), (db) => db.retryContention(effect, options)),
)
