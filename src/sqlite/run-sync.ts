// Running builder queries on a synchronous SQLite handle: Cloudflare Durable
// Object storage (`ctx.storage.sql`), whose `exec` returns rows at once and is
// no Effect `SqlClient`. Compiles for SQLite, binds, runs, decodes: what
// `Database.run` does, without an Effect around it.

import { Cause, Context, Effect, Exit, Fiber } from "effect"
import { fillDefaults, type RequirementsOf } from "../ch/client-defaults"
import { compileCHRaw, compileUnionRaw, type CompiledQuery } from "../ch/compile"
import type { DialectSatisfied, ParamsSatisfied, SourcesSatisfied } from "../ch/expr"
import { compiledUnsafe } from "../ch/failure"
import type { QueryParams } from "../ch/union"
import type { RowOf, Runnable, RunCheck } from "../database/database"
import { QueryBuilderDefect } from "../ch/errors"
import { traceStatement, type StatementObservation } from "../database/tracing"
import { sqliteDialect } from "./dialect"

/**
 * What `runSync` needs of a synchronous SQLite handle: workerd's `SqlStorage`
 * (`ctx.storage.sql`) has this shape, and a `node:sqlite` database wraps into
 * it in one line (`{ exec: (sql, ...values) => ({ toArray: () => db.prepare(sql).all(...values) }) }`).
 */
export interface SqlStorageLike {
	exec(query: string, ...bindings: Array<unknown>): { toArray(): Array<Record<string, unknown>> }
}

/** What `runSync` does besides running: the context its span runs in, and what it reports. */
export interface RunSyncOptions {
	/**
	 * The services the statement's span and observation run with: a `Tracer`,
	 * a parent span (`Tracer.ParentSpan`), a `QuerySummary`. Defaults to the
	 * context of the Effect fiber calling `runSync`, when there is one (a
	 * `runSync` inside `Effect.sync` nests its span under the caller's), else
	 * none: Effect's default tracer, which records the span nowhere. Pass
	 * `yield* Effect.context()` captured where the Durable Object is built to
	 * trace calls made outside any fiber.
	 */
	readonly context?: Context.Context<never> | undefined
	/** As `FromSqlClientOptions.observeExit`: called with the statement once it has ended. */
	readonly observeExit?: ((observation: StatementObservation) => Effect.Effect<void>) | undefined
	/** As `FromSqlClientOptions.spanParameters`: the bound values as span attributes. */
	readonly spanParameters?: boolean | undefined
}

/** `unknown` when a write's client defaults need no service, so they can run here; otherwise why not. */
export type SyncDefaults<Q> = [RequirementsOf<Q>] extends [never]
	? unknown
	: { readonly clientDefaultsNeedServices: "this write's defaultFn / onUpdate need services; run it with Database.run, or pass every such column" }

/** The thrown value of a failed Effect: its error, or its defect. */
const orThrow = <A>(exit: Exit.Exit<A, unknown>): A => {
	if (Exit.isSuccess(exit)) return exit.value
	throw Cause.squash(exit.cause)
}

/**
 * Compile `query` for SQLite, run it on `storage`, and decode its rows, all
 * synchronously: `Database.run` for Durable Object storage. A write returns
 * its RETURNING rows, or none without `returning`. A write's client defaults
 * (`defaultFn` / `onUpdate`) run first, and must be synchronous Effects that
 * need no service. Throws the `QueryBuilderError`, the
 * `CompiledQueryDecodeError` or the storage's own error. The statement runs
 * in a client span; see `RunSyncOptions` for where the span goes.
 *
 * ```ts
 * const rows = SQLite.runSync(ctx.storage.sql, SQLite.from(Jobs).select().where(($) => [$.id.eq(id)]))
 * ```
 */
export function runSync<Q extends Runnable, const Given extends object = {}>(
	storage: SqlStorageLike,
	query: Q &
		RunCheck<Q> &
		SyncDefaults<Q> &
		ParamsSatisfied<QueryParams<Q>, Given> &
		DialectSatisfied<QueryParams<Q>, "sqlite"> &
		SourcesSatisfied<QueryParams<Q>>,
	params?: Given,
	options?: RunSyncOptions,
): ReadonlyArray<RowOf<Q>> {
	const runnable = query as Runnable
	const values = (params ?? {}) as Record<string, unknown>
	const compiled: CompiledQuery<RowOf<Q>, any> = (() => {
		if ("decodeRows" in runnable) {
			if (runnable.dialect !== undefined && runnable.dialect !== sqliteDialect.name) {
				throw new QueryBuilderDefect({
					message: `runSync: a query compiled for ${runnable.dialect} cannot run on SQLite storage; pass the query instead of compiling it`,
				})
			}
			return runnable as CompiledQuery<RowOf<Q>, any>
		}
		const filled = orThrow(Effect.runSyncExit(fillDefaults(runnable) as Effect.Effect<Runnable>))
		return "_tag" in filled && filled._tag === "CHUnionQuery"
			? compiledUnsafe(() => compileUnionRaw(filled as never, values, { dialect: sqliteDialect }))
			: compiledUnsafe(() => compileCHRaw(filled as never, values, { dialect: sqliteDialect }))
	})()
	// The statement runs in a client span, as `Database.run`'s do (`traceStatement`):
	// a failure is recorded on it (`error.type`, the span's failed exit) before
	// it is thrown, and `observeExit` hears of it. `runSyncExitWith` runs it
	// synchronously, in the caller's fiber context when there is one.
	const context = options?.context ?? Fiber.getCurrent()?.context ?? Context.empty()
	const exec = Effect.try({
		try: () => storage.exec(compiled.sql, ...compiled.parameters).toArray(),
		catch: (error) => error,
	})
	const traced = traceStatement(sqliteDialect, compiled, exec, (wire) => wire.length, {
		observeExit: options?.observeExit,
		spanParameters: options?.spanParameters,
	})
	const rows = orThrow(Effect.runSyncExitWith(context as Context.Context<never>)(traced))
	if (compiled.kind !== "select" && compiled.returning === undefined) return []
	return orThrow(Effect.runSyncExit(compiled.decodeRows(rows)))
}
